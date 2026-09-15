/**
 * Follow-up suggestions: the assistant closes an answer with one line
 * `Sugerencias: [acción 1] · [acción 2] · [acción 3]` — short requests written
 * the way the user would type them. The orchestrator strips the line, stores
 * the items in the message meta and the UI renders them as one-click chips
 * ("se adelanta"). Pure and client-safe.
 */

const MAX_ITEMS = 4;
const MAX_LEN = 80;
const LINE_RE = /(?:^|\n)[ \t]*(?:[*_]{0,2})(?:sugerencias|siguientes pasos|siguiente paso)(?:[*_]{0,2})[ \t]*:[ \t]*([^\n]*)$/i;

export interface ParsedFollowUps {
  content: string;
  followUps: string[];
}

export function parseFollowUps(content: string | null | undefined): ParsedFollowUps {
  const text = (content ?? '').replace(/\s+$/, '');
  const match = LINE_RE.exec(text);
  if (!match) return { content: text, followUps: [] };
  const raw = match[1] ?? '';
  const bracketed = [...raw.matchAll(/\[([^\]]{2,})\]/g)].map((m) => m[1]);
  const items = (bracketed.length > 0 ? bracketed : raw.split(/\s*[·|]\s*/))
    .map((s) => s.replace(/[*_]+/g, '').replace(/[.\s]+$/, '').trim())
    .filter((s) => s.length >= 3)
    .map((s) => (s.length > MAX_LEN ? `${s.slice(0, MAX_LEN - 1)}…` : s));
  const unique = [...new Set(items)].slice(0, MAX_ITEMS);
  if (unique.length === 0) return { content: text, followUps: [] };
  return { content: text.slice(0, match.index).replace(/\s+$/, ''), followUps: unique };
}
