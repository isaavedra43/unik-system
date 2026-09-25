/**
 * Historical AI threads of the (removed) side-panel copilots: an inbox
 * (Bandeja externa) conversation or an internal-chat channel. Those threads
 * stay tagged with `context.kind` so the assistant sidebar keeps hiding them
 * and the summaries can still label them.
 *
 * Automatic analyses were ordinary user turns whose content starts with
 * AUTO_PREFIX; the UI renders them as system events instead of bubbles.
 */

export const COPILOT_KIND_BY_SURFACE = {
  inbox: 'inbox_copilot',
  chat: 'chat_copilot',
} as const;

/** Conversation kinds that live inside their host surface, not in the assistant sidebar. */
export const HIDDEN_CONVERSATION_KINDS: ReadonlySet<string> = new Set(
  Object.values(COPILOT_KIND_BY_SURFACE)
);

export const AUTO_PREFIX = '⟦auto:';

export function isAutoTurn(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.startsWith(AUTO_PREFIX);
}
