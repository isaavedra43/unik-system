import { notifyUser } from '@/modules/notifications/notification-service';

/**
 * "The assistant finished" notifications. A turn that took longer than
 * AI_NOTIFY_MIN_SECONDS (default 20s) — long reports, multi-tool work, plans —
 * notifies its owner so they can come back from another app or a locked phone.
 * Quick answers never notify: the reply is already on screen.
 */

const DEFAULT_MIN_SECONDS = 20;

export function aiTaskNotifyThresholdMs(): number {
  const raw = Number.parseInt(process.env.AI_NOTIFY_MIN_SECONDS ?? '', 10);
  const seconds = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_SECONDS;
  return seconds * 1000;
}

export interface AiTaskDoneInput {
  userId: string;
  conversationId: string;
  messageId: string;
  /** Final answer text (a preview is used as the notification body). */
  content: string;
  elapsedMs: number;
  toolCalls: number;
  /** Forces the notification regardless of elapsed time (client asked for it). */
  force?: boolean;
}

function firstMeaningfulLine(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 140 ? `${cleaned.slice(0, 137)}…` : cleaned;
}

export function surfaceUrl(input: Pick<AiTaskDoneInput, 'conversationId'>): string {
  return `/app/assistant?c=${encodeURIComponent(input.conversationId)}`;
}

export async function notifyAiTaskDone(input: AiTaskDoneInput): Promise<boolean> {
  if (!input.force && input.elapsedMs < aiTaskNotifyThresholdMs()) return false;
  const seconds = Math.round(input.elapsedMs / 1000);
  const result = await notifyUser({
    userId: input.userId,
    category: 'ai_task_done',
    title:
      input.toolCalls > 0
        ? `El asistente terminó (${input.toolCalls} ${input.toolCalls === 1 ? 'acción' : 'acciones'}, ${seconds}s)`
        : 'El asistente terminó tu solicitud',
    body: firstMeaningfulLine(input.content) || 'Tu respuesta está lista.',
    url: surfaceUrl(input),
    entityType: 'ai_conversation',
    entityId: input.conversationId,
    dedupeKey: `ai_done:${input.messageId}`,
    metadata: { conversationId: input.conversationId, messageId: input.messageId, elapsedMs: input.elapsedMs },
    push: { tag: `ai:${input.conversationId}`, renotify: true },
  });
  return !result.suppressed;
}
