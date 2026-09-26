import type { MessageData } from './types';

/**
 * One answer per turn. The orchestrator persists every model round of a turn
 * as its own assistant message (tool calls, then text, then more tools after
 * an approval…), which the chat used to show as a stack of "1 paso" blocks
 * with repeated headers. Consecutive assistant messages from the same author
 * become ONE answer: all steps in one work log, every card, the text in order
 * and the footer (feedback, model, cost) of the last round. Pure — unit tested.
 */

export type ShownMessage = MessageData & {
  /** Ids of the persisted messages this answer stands for (approvals, delegation). */
  mergedIds: string[];
};

function author(m: MessageData): string {
  return m.meta?.agent?.name ?? '';
}

function merge(a: ShownMessage, b: MessageData): ShownMessage {
  const content = [a.content, b.content]
    .map((c) => (c ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
  const artifacts = [...(a.artifacts ?? []), ...(b.artifacts ?? [])].filter(
    (x, i, all) => all.findIndex((y) => y.artifactId === x.artifactId) === i
  );
  const reasoning = [a.meta?.reasoning, b.meta?.reasoning].filter(Boolean).join('\n\n');
  return {
    ...b,
    // The text of the whole turn, the metadata (model, cost, follow-ups) of its last round.
    content: content || null,
    toolCalls: [...(a.toolCalls ?? []), ...(b.toolCalls ?? [])],
    toolCallRecords: [...(a.toolCallRecords ?? []), ...(b.toolCallRecords ?? [])],
    artifacts,
    meta:
      b.meta || a.meta
        ? { ...(a.meta ?? {}), ...(b.meta ?? {}), ...(reasoning ? { reasoning } : {}) }
        : null,
    feedback: b.feedback ?? a.feedback ?? null,
    mergedIds: [...a.mergedIds, b.id],
  } as ShownMessage;
}

export function mergeAssistantRuns(messages: MessageData[]): ShownMessage[] {
  const out: ShownMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool' || m.role === 'system') continue;
    const prev = out[out.length - 1];
    if (m.role === 'assistant' && prev?.role === 'assistant' && author(prev) === author(m)) {
      out[out.length - 1] = merge(prev, m);
      continue;
    }
    out.push({ ...m, mergedIds: [m.id] });
  }
  return out;
}
