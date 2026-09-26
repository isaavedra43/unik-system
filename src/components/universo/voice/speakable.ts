/**
 * What the voice says — pure, unit tested.
 *
 * The agent writes one answer (markdown) for the chat. Voice mode reads the
 * SAME answer aloud as it streams: sentence by sentence, without markdown,
 * code, tables, links, follow-up chips or the confidence line — and when it
 * skipped something visual, it says once that the detail is on screen.
 */

const HALLUCINATIONS = [
  'subtitulos realizados por la comunidad de amara org',
  'subtitulos por la comunidad de amara org',
  'gracias por ver el video',
  'gracias por ver',
  'suscribete',
  'musica',
  'www mooji org',
];

/** Whisper invents these on silence/noise (well known in Spanish). */
export function isLikelyHallucination(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 2) return true;
  return HALLUCINATIONS.some((h) => t === h || t.startsWith(`${h} `) || t.endsWith(` ${h}`));
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

export interface Speakable {
  text: string;
  /** A table, code block or image was left out (it stays in the chat). */
  skippedVisual: boolean;
}

export function toSpeakable(md: string): Speakable {
  let skippedVisual = false;
  let text = md;
  // Code blocks and tables are for the screen.
  text = text.replace(/```[\s\S]*?(```|$)/g, () => {
    skippedVisual = true;
    return ' ';
  });
  const lines = text.split('\n').filter((line) => {
    const l = line.trim();
    if (/^\|.*\|$/.test(l) || /^\|?\s*:?-{3,}/.test(l)) {
      skippedVisual = true;
      return false;
    }
    // Follow-up chips and the confidence line are UI, not speech.
    if (/^[*_]*(sugerencias|siguientes pasos|siguiente paso|confianza)[*_]*\s*:/i.test(l))
      return false;
    return true;
  });
  text = lines
    .map((line) => {
      let l = line.trim();
      if (!l) return '';
      l = l.replace(/^#{1,6}\s+(.*)$/, '$1.');
      l = l.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '');
      l = l.replace(/^>\s?/, '');
      l = l.replace(/!\[[^\]]*\]\([^)]*\)/g, () => {
        skippedVisual = true;
        return '';
      });
      l = l.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1');
      l = l.replace(/https?:\/\/[^\s)]+?(?=[.,;:!?)]*(?:\s|$))/g, 'el enlace').trim();
      if (!l) return '';
      // A list item without punctuation still needs a pause.
      if (!/[.!?:;…]$/.test(l)) l = `${l}.`;
      return l;
    })
    .filter(Boolean)
    .join(' ');
  text = text.replace(/(\*\*|__|\*|_|`|~~)/g, '');
  text = text.replace(EMOJI_RE, '');
  text = text.replace(/\s+([.,;:!?])/g, '$1').replace(/\.{2,}/g, '.');
  text = text.replace(/\s+/g, ' ').trim();
  if (text === '.') text = '';
  return { text, skippedVisual };
}

/** Sentence units for TTS: split on end punctuation, merge very short pieces. */
export function splitSentences(text: string, minLength = 28): string[] {
  const parts = text.match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map((s) => s.trim()) ?? [];
  const out: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    const last = out[out.length - 1];
    if (last && last.length < minLength) out[out.length - 1] = `${last} ${p}`;
    else out.push(p);
  }
  return out;
}

/**
 * Follows a streaming answer and hands out the sentences that are complete
 * and not yet spoken. `flush` speaks the rest once the answer is done.
 */
export class SentenceStream {
  private offset = 0;
  private skipped = false;
  private announced = false;
  private first = true;

  push(content: string): string[] {
    if (content.length < this.offset) this.offset = content.length; // answer was replaced
    let pending = content.slice(this.offset);
    // Never read half a code block: wait until it closes.
    const fences = pending.match(/```/g)?.length ?? 0;
    if (fences % 2 === 1) pending = pending.slice(0, pending.lastIndexOf('```'));
    const boundary = lastBoundary(pending);
    if (boundary <= 0) return [];
    const chunk = pending.slice(0, boundary);
    this.offset += chunk.length;
    return this.speak(chunk, false);
  }

  flush(content: string): string[] {
    const rest = content.slice(Math.min(this.offset, content.length));
    this.offset = content.length;
    const out = this.speak(rest, true);
    if (this.skipped && !this.announced) {
      this.announced = true;
      out.push('Te dejé el detalle en el chat.');
    }
    return out;
  }

  reset(): void {
    this.offset = 0;
    this.skipped = false;
    this.announced = false;
    this.first = true;
  }

  private speak(chunk: string, final: boolean): string[] {
    const { text, skippedVisual } = toSpeakable(chunk);
    if (skippedVisual) this.skipped = true;
    if (!text) return [];
    // The very first sentence goes out alone (fast start); later ones merge.
    const sentences = splitSentences(text, this.first ? 0 : 28);
    if (sentences.length > 0) this.first = false;
    void final;
    return sentences;
  }
}

/** Index right after the last complete sentence / line in `text` (0 = none). */
function lastBoundary(text: string): number {
  let best = 0;
  const re = /[.!?…](?=\s)|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) best = m.index + m[0].length;
  return best;
}
