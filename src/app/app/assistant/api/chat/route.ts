import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { runAssistant } from '@/modules/ai/ai-orchestrator';

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
  /** Plan-then-execute for this message: the assistant proposes steps and waits for confirmation. */
  planFirst: z.boolean().optional(),
  /** Notify (bell + push) when the answer is ready even if the turn is short. */
  notifyWhenDone: z.boolean().optional(),
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
      try {
        for await (const event of runAssistant({
          conversationId: parsed.data.conversationId,
          message: parsed.data.message,
          actor: session.user,
          context: parsed.data.context,
          model: parsed.data.model,
          planFirst: parsed.data.planFirst,
          notifyWhenDone: parsed.data.notifyWhenDone,
          attachmentIds: parsed.data.attachments,
        })) {
          write(event);
        }
      } catch (e) {
        write({
          type: 'error',
          data: { message: e instanceof Error ? e.message : 'Error desconocido' },
        });
      } finally {
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
