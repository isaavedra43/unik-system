import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireChatUser, chatCopilotErrorResponse, readJson } from '../../../_copilot-shared';
import { runAssistant } from '@/modules/ai/ai-orchestrator';
import { getConversation as getAiConversation } from '@/modules/ai/ai-sessions-service';
import { listPendingProposals, toProposalDTO } from '@/modules/extensions/proposals-service';
import {
  autoTriggerMessage,
  getOrCreateSurfaceConversation,
  getSurfaceMode,
  listSurfaceConversations,
  shouldRunAutoTurn,
} from '@/modules/ai/copilot-surfaces';
import { chatAutoAnchor, requireChannelForActor } from '@/modules/chat/chat-copilot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** GET — the copilot thread of this internal-chat channel for the current user. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireChatUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    await requireChannelForActor(auth.user, id);
    const q = request.nextUrl.searchParams;
    if (q.get('list') === '1') {
      return NextResponse.json({ threads: await listSurfaceConversations(auth.user, { kind: 'chat', id }) });
    }
    const [{ id: aiConversationId }, mode] = await Promise.all([
      getOrCreateSurfaceConversation(auth.user, { kind: 'chat', id }, { threadId: q.get('thread'), createNew: q.get('new') === '1' }),
      getSurfaceMode(auth.user.id, 'chat'),
    ]);
    const [thread, proposals] = await Promise.all([
      getAiConversation(aiConversationId, auth.user.id),
      listPendingProposals(auth.user.id, aiConversationId),
    ]);
    return NextResponse.json({
      conversationId: aiConversationId,
      mode,
      messages: thread.messages,
      proposals: proposals.map(toProposalDTO),
    });
  } catch (err) {
    return chatCopilotErrorResponse(err);
  }
}

const postSchema = z
  .object({
    message: z.string().min(1).max(8000).optional(),
    trigger: z.enum(['open', 'inbound', 'action_failed']).optional(),
    /** For action_failed: which tool and what error, so the copilot fixes it on its own. */
    detail: z.object({ tool: z.string().max(80).optional(), error: z.string().max(800).optional() }).optional(),
    model: z.string().optional(),
    threadId: z.string().optional(),
  })
  .refine((v) => Boolean(v.message) !== Boolean(v.trigger), { message: 'Envía "message" o "trigger", no ambos' });

/** POST { message } | { trigger } — a copilot turn for this channel, streamed as SSE. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireChatUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;

  let input: z.infer<typeof postSchema>;
  let aiConversationId: string;
  let text: string;
  try {
    input = postSchema.parse(await readJson(request));
    await requireChannelForActor(auth.user, id);
    const mode = await getSurfaceMode(auth.user.id, 'chat');
    if (mode === 'paused') {
      return NextResponse.json({ error: 'El copiloto del chat está apagado', code: 'paused' }, { status: 409 });
    }
    aiConversationId = (await getOrCreateSurfaceConversation(auth.user, { kind: 'chat', id }, { threadId: input.threadId })).id;
    if (input.trigger === 'action_failed') {
      // A failed approved action: the copilot diagnoses and retries regardless of proactivity.
      text = autoTriggerMessage('action_failed', 'chat', input.detail);
    } else if (input.trigger) {
      if (mode !== 'active') return NextResponse.json({ skipped: true, reason: 'mode' });
      const anchor = await chatAutoAnchor(id, auth.user.id);
      if (!(await shouldRunAutoTurn(aiConversationId, anchor))) {
        return NextResponse.json({ skipped: true, reason: 'up_to_date' });
      }
      text = autoTriggerMessage(input.trigger, 'chat');
    } else {
      text = input.message as string;
    }
  } catch (err) {
    return chatCopilotErrorResponse(err);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let clientGone = false;
      const send = (event: unknown) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          clientGone = true;
        }
      };
      // Keep long copilot turns alive through proxies (an SSE comment every 15 s).
      const heartbeat = setInterval(() => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          clientGone = true;
        }
      }, 15_000);
      try {
        send({ type: 'meta', data: { conversationId: aiConversationId } });
        for await (const event of runAssistant({
          conversationId: aiConversationId,
          message: text,
          actor: auth.user,
          context: { page: '/app/chat', chatChannelId: id },
          model: input.model,
        })) {
          send(event);
        }
      } catch (e) {
        send({ type: 'error', data: { message: e instanceof Error ? e.message : 'Error desconocido' } });
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
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
