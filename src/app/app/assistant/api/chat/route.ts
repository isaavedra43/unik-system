import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { runAssistant } from '@/modules/ai/ai-orchestrator';
import { executeAgentTurn } from '@/modules/agents/agent-runtime';
import { assignConversationAgent } from '@/modules/agents/agent-service';
import { parseEffort } from '@/modules/ai/effort-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const chatRequestSchema = z.object({
  conversationId: z.string().min(1),
  message: z.string().min(1).max(50_000),
  context: z
    .object({
      page: z.string().optional(),
      voice: z.boolean().optional(),
    })
    .optional(),
  model: z.string().optional(),
  /** Effort level from the composer (instant | light | medium | high | ultra). */
  effort: z.string().max(20).optional(),
  /** Capability ids picked in the composer (mapped to tools server-side). */
  capabilities: z.array(z.string().max(120)).max(12).optional(),
  /** Plan-then-execute for this message: the assistant proposes steps and waits for confirmation. */
  planFirst: z.boolean().optional(),
  /** Notify (bell + push) when the answer is ready even if the turn is short. */
  notifyWhenDone: z.boolean().optional(),
  /** UNIVERSO: agente del sidebar que atiende esta conversación. */
  agentId: z.string().max(80).optional(),
  // Attachments are referenced by ID only. Older clients may still send objects
  // with fileName/mimeType/storagePath: only the id is used, the rest is ignored.
  attachments: z
    .array(
      z.union([
        z.string().min(1),
        z
          .object({ id: z.string().min(1) })
          .passthrough()
          .transform((a) => a.id),
      ])
    )
    .max(20)
    .optional(),
});

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // When the phone locks or the user switches app, the SSE connection drops.
      // The run keeps going to completion (its result is persisted and the
      // "assistant finished" notification fires) — we just stop writing frames.
      let clientGone = false;
      const write = (payload: unknown) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          clientGone = true;
        }
      };
      request.signal.addEventListener('abort', () => {
        clientGone = true;
      });
      // Long turns (GPT-5 reasoning, several tools, a reviewed answer) can go minutes without
      // a frame; proxies and browsers drop idle streams ("network error"). An SSE comment
      // every 15 s keeps the connection alive; parsers ignore lines that are not "data:".
      const heartbeat = setInterval(() => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          clientGone = true;
        }
      }, 15_000);
      try {
        // UNIVERSO B2: el turno corre con identidad de agente (persona,
        // allowlist, routing envelope). Con UNIK_AGENT_RUNTIME_V2=false vuelve
        // al asistente clásico, byte a byte.
        // On by default: agents (persona, tool allowlist, delegation, team
        // consolidation) only exist on this path. Opt out with =false.
        const runtimeV2 = process.env.UNIK_AGENT_RUNTIME_V2 !== 'false';
        if (parsed.data.agentId) {
          await assignConversationAgent(parsed.data.conversationId, session.user.id, parsed.data.agentId);
        }
        const effort = parseEffort(parsed.data.effort) ?? undefined;
        const events = runtimeV2
          ? executeAgentTurn({
              conversationId: parsed.data.conversationId,
              message: parsed.data.message,
              actor: session.user,
              agentId: parsed.data.agentId,
              context: parsed.data.context,
              model: parsed.data.model,
              effort,
              capabilities: parsed.data.capabilities,
              planFirst: parsed.data.planFirst,
              notifyWhenDone: parsed.data.notifyWhenDone,
              attachmentIds: parsed.data.attachments,
            })
          : runAssistant({
              conversationId: parsed.data.conversationId,
              message: parsed.data.message,
              actor: session.user,
              context: parsed.data.context,
              model: parsed.data.model,
              effort,
              capabilities: parsed.data.capabilities,
              planFirst: parsed.data.planFirst,
              notifyWhenDone: parsed.data.notifyWhenDone,
              attachmentIds: parsed.data.attachments,
            });
        for await (const event of events) {
          write(event);
        }
      } catch (e) {
        write({
          type: 'error',
          data: { message: e instanceof Error ? e.message : 'Error desconocido' },
        });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
