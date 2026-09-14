/**
 * Removes <think>…</think> reasoning blocks that some open models (MiniMax, Qwen, DeepSeek R1
 * style) emit inside `content`, so the user only sees the answer. Works on streamed deltas: a tag
 * split across chunks ("<thi" + "nk>") is held back until it can be classified. Pure.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

/** Length of the longest suffix of `text` that is a proper prefix of `tag` ("<th" for "<think>"). */
function partialTagSuffix(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (tag.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

export interface ThinkFilter {
  /** Feeds a delta; returns the visible text that can be emitted now. */
  push(delta: string): string;
  /** End of stream: returns any held-back visible text. */
  flush(): string;
}

export function createThinkFilter(): ThinkFilter {
  let buffer = '';
  let inThink = false;
  let emitted = false;

  const visible = (text: string): string => {
    // Answers usually start with blank lines right after </think>; drop them once.
    const out = emitted ? text : text.replace(/^\s+/, '');
    if (out.length > 0) emitted = true;
    return out;
  };

  return {
    push(delta: string): string {
      buffer += delta;
      let out = '';
      while (buffer.length > 0) {
        if (inThink) {
          const end = buffer.indexOf(CLOSE);
          if (end === -1) {
            buffer = buffer.slice(buffer.length - partialTagSuffix(buffer, CLOSE));
            break;
          }
          buffer = buffer.slice(end + CLOSE.length);
          inThink = false;
          continue;
        }
        const start = buffer.indexOf(OPEN);
        if (start === -1) {
          const keep = partialTagSuffix(buffer, OPEN);
          out += buffer.slice(0, buffer.length - keep);
          buffer = buffer.slice(buffer.length - keep);
          break;
        }
        out += buffer.slice(0, start);
        buffer = buffer.slice(start + OPEN.length);
        inThink = true;
      }
      return visible(out);
    },
    flush(): string {
      const rest = inThink ? '' : buffer;
      buffer = '';
      return visible(rest);
    },
  };
}

/** Non-streamed variant. */
export function stripThink(text: string): string {
  const filter = createThinkFilter();
  return filter.push(text) + filter.flush();
}
