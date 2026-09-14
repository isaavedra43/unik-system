import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInboxUser, commsErrorResponse, readJson } from '../../../_shared';
import { runAssistant } from '@/modules/ai/ai-orchestrator';
import { getConversation as getAiConversation } from '@/modules/ai/ai-sessions-service';
import { listPendingProposals, toProposalDTO } from '@/modules/extensions/proposals-service';
import {
  autoTriggerMessage,
  getInboxCopilotMode,
  getOrCreateCopilotConversation,
  listCopilotConversations,
  shouldRunAutoAnalysis,
} from '@/modules/comms/inbox-copilot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET — the copilot thread of this inbox conversation for the current user.
 * `?thread=<id>` opens a previous thread, `?new=1` starts a fresh one,
 * `?list=1` returns the thread history instead.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const q = request.nextUrl.searchParams;
    if (q.get('list') === '1') {
      return NextResponse.json({ threads: await listCopilotConversations(auth.user, id) });
    }
    const [{ id: aiConversationId }, mode] = await Promise.all([
      getOrCreateCopilotConversation(auth.user, id, { threadId: q.get('thread'), createNew: q.get('new') === '1' }),
      getInboxCopilotMode(auth.user.id),
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
    return commsErrorResponse(err);
  }
}

const postSchema = z
  .object({
    message: z.string().min(1).max(8000).optional(),
    trigger: z.enum(['open', 'inbound', 'action_failed']).optional(),
    /** For action_failed: which tool and what error, so the copilot fixes it on its own. */
    detail: z.object({ tool: z.string().max(80).optional(), error: z.string().max(800).optional() }).optional(),
    model: z.string().optional(),
    /** Thread to continue (a previous one); default: the latest. */
    threadId: z.string().optional(),
  })
  .refine((v) => Boolean(v.message) !== Boolean(v.trigger), {
    message: 'Envía "message" o "trigger", no ambos',
  });

/**
 * POST { message } | { trigger } — a turn of the copilot, streamed as SSE.
 * Triggers are automatic analyses: they only run in "active" mode and only
 * when the copilot has not spoken since the customer's last message.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;

  let input: z.infer<typeof postSchema>;
  let aiConversationId: string;
  let text: string;
  try {
    input = postSchema.parse(await readJson(request));
    const mode = await getInboxCopilotMode(auth.user.id);
    if (mode === 'paused') {
      return NextResponse.json({ error: 'El copiloto está en pausa', code: 'paused' }, { status: 409 });
    }
    aiConversationId = (await getOrCreateCopilotConversation(auth.user, id, { threadId: input.threadId })).id;
    if (input.trigger === 'action_failed') {
      // A failed approved action: the copilot diagnoses and retries regardless of proactivity.
      text = autoTriggerMessage('action_failed', input.detail);
    } else if (input.trigger) {
      if (mode !== 'active') return NextResponse.json({ skipped: true, reason: 'mode' });
      if (!(await shouldRunAutoAnalysis(aiConversationId, id))) {
        return NextResponse.json({ skipped: true, reason: 'up_to_date' });
      }
      text = autoTriggerMessage(input.trigger);
    } else {
      text = input.message as string;
    }
  } catch (err) {
    return commsErrorResponse(err);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        send({ type: 'meta', data: { conversationId: aiConversationId } });
        for await (const event of runAssistant({
          conversationId: aiConversationId,
          message: text,
          actor: auth.user,
          context: { page: '/app/inbox', inboxConversationId: id },
          model: input.model,
        })) {
          send(event);
        }
      } catch (e) {
        send({
          type: 'error',
          data: { message: e instanceof Error ? e.message : 'Error desconocido' },
        });
      } finally {
        controller.close();
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
