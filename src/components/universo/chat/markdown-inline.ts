/**
 * Inline markdown renderer shared by every block of the UNIVERSO Markdown.
 * Kept pure (no React) so the link sanitizer is unit-testable in node.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SAFE_SCHEME_RE = /^(https?|mailto|tel):/i;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Decodes every HTML entity a browser would honor inside an attribute —
 * named, decimal and hex. `renderInline` runs AFTER escapeHtml, so an
 * attacker-controlled URL can smuggle characters as entities
 * (`&#106;avascript:` parses as `javascript:` once the browser decodes it).
 */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[code]) return named[code];
    if (code[0] === '#') {
      const n =
        code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

/**
 * True for hrefs we meant to generate: relative app links and a small set of
 * safe schemes. javascript:/data:/vbscript:/file: (case, whitespace and
 * entity tricks included) return false — the caller then emits the link
 * text without an anchor. The model can be fed hostile URLs from web
 * content and must not turn them into live <a> tags.
 */
export function isSafeHref(escapedUrl: string): boolean {
  const decoded = decodeEntities(escapedUrl);
  // An entity we didn't resolve could still be one the browser knows
  // (&colon;, &Tab;, &NewLine;) — decode happens again inside the attribute,
  // so any surviving entity makes the href untrusted.
  if (/&[#a-zA-Z][a-zA-Z0-9#]*;/.test(decoded)) return false;
  // Browsers ignore whitespace/control chars inside the scheme — strip them too.
  const compact = decoded
    // eslint-disable-next-line no-control-regex
    .replace(/[\s\u0000-\u001F\u007F-\u009F\u00AD\u200B\uFEFF]+/g, '')
    .toLowerCase();
  if (!SCHEME_RE.test(compact)) return true; // relative (/app/…, ./x, ?q, #a, foo/bar)
  return SAFE_SCHEME_RE.test(compact);
}

export function renderInline(text: string): string {
  let html = escapeHtml(text);
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="assistant-md-code">$1</code>');
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  // Links [text](url) — url is already entity-escaped; safe schemes only.
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    const trimmed = url.trim();
    if (!isSafeHref(trimmed)) return label;
    return `<a href="${trimmed}" target="_blank" rel="noopener noreferrer nofollow" class="assistant-md-link">${label}</a>`;
  });
  return html;
}
