/**
 * Formatting of AI-written messages that leave UNIK towards a customer
 * (WhatsApp / SMS / Telegram). Pure, unit-tested.
 *
 * - Markdown → WhatsApp: **bold** becomes *bold*, headers and code marks are
 *   dropped, "- item" becomes "• item", [label](url) becomes "label: url".
 * - Placeholders the model tends to leave ("[Tu Nombre]", "[Empresa]") are
 *   replaced by the real sender / company or removed.
 * - Internal data never meant for customers ("(stock: 40.1)") is stripped
 *   unless the caller explicitly keeps it.
 */

export interface CustomerFormatOptions {
  senderName?: string | null;
  companyName?: string | null;
  /** Keep stock/inventory fragments (the user explicitly asked to share them). */
  keepInternalData?: boolean;
}

export interface CustomerFormatResult {
  text: string;
  changes: string[];
}

const PLACEHOLDER_NAME = /\[\s*(tu\s+nombre|nombre(\s+del\s+(vendedor|asesor|agente|remitente))?|your\s+name|firma)\s*\]|\{\{\s*(nombre|name|sender)\s*\}\}|<\s*(tu\s+)?nombre\s*>/gi;
const PLACEHOLDER_COMPANY = /\[\s*(tu\s+)?(empresa|compañ[ií]a|negocio|company)(\s+nombre)?\s*\]|\{\{\s*(empresa|company)\s*\}\}/gi;
const GENERIC_PLACEHOLDER = /\[\s*(tu\s+)?(puesto|cargo|tel[eé]fono|correo|email|posici[oó]n|title)\s*\]/gi;
const STOCK_FRAGMENT = /\s*[\(（]\s*(stock|existencias?|inventario|disponibles?|en\s+almac[eé]n)\s*[:=]?\s*-?[\d.,]+\s*[^)）]*[\)）]/gi;
const STOCK_LINE = /^\s*[•\-*]?\s*(stock|existencias?|inventario)\s*[:=]\s*-?[\d.,]+.*$/gim;

export function markdownToWhatsApp(input: string): string {
  let text = input.replace(/\r\n?/g, '\n');
  // Links: [label](url) → "label: url" (a trailing period would break the link on some clients)
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)([.,;:!?])?/g, (_m, label: string, url: string, p?: string) => `${label.trim()}: ${url}${p ? ` ${p}` : ''}`);
  // Headers → plain bold line
  text = text.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '*$1*');
  // Bold / italic / strike / code
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/__(.+?)__/g, '*$1*');
  text = text.replace(/~~(.+?)~~/g, '~$1~');
  text = text.replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/`{3}\w*\n?/g, '')).replace(/`([^`]+)`/g, '$1');
  // Horizontal rules and separators the model uses to frame drafts
  text = text.replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '');
  // Bullets
  text = text.replace(/^(\s*)[-*]\s+/gm, '$1• ');
  // Blockquotes
  text = text.replace(/^\s*>\s?/gm, '');
  // Tables: keep cells separated by " | " without the alignment row
  text = text.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '');
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_m, row: string) => row.split('|').map((c) => c.trim()).filter(Boolean).join(' · '));
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function formatForCustomerChannel(body: string, options: CustomerFormatOptions = {}): CustomerFormatResult {
  const changes: string[] = [];
  let text = markdownToWhatsApp(body ?? '');
  if (text !== (body ?? '').trim()) changes.push('markdown');

  const sender = options.senderName?.trim() || options.companyName?.trim() || '';
  if (PLACEHOLDER_NAME.test(text)) {
    text = text.replace(PLACEHOLDER_NAME, sender);
    changes.push('placeholder_name');
  }
  PLACEHOLDER_NAME.lastIndex = 0;
  if (PLACEHOLDER_COMPANY.test(text)) {
    text = text.replace(PLACEHOLDER_COMPANY, options.companyName?.trim() || '');
    changes.push('placeholder_company');
  }
  PLACEHOLDER_COMPANY.lastIndex = 0;
  if (GENERIC_PLACEHOLDER.test(text)) {
    text = text.replace(GENERIC_PLACEHOLDER, '');
    changes.push('placeholder_other');
  }
  GENERIC_PLACEHOLDER.lastIndex = 0;

  if (!options.keepInternalData) {
    const before = text;
    text = text.replace(STOCK_LINE, '').replace(STOCK_FRAGMENT, '');
    if (text !== before) changes.push('internal_data');
  }

  // A closing left without a name ("Saludos," at the very end) gets the real sender.
  text = text.replace(/(saludos|atentamente|cordialmente|quedo atent[oa])\s*,?\s*$/i, (_m, greeting: string) => (sender ? `${greeting},\n${sender}` : `${greeting}.`));
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, changes };
}

const ARTIFACT_DOWNLOAD_RE = /https?:\/\/[^\s)]+?\/app\/assistant\/api\/artifacts\/([a-z0-9]+)\/download[^\s)]*|\/app\/assistant\/api\/artifacts\/([a-z0-9]+)\/download[^\s)]*/gi;
const SHARED_LINK_RE = /https?:\/\/[^\s)]+?\/api\/files\/shared\/([a-z0-9]+)\.\d+\.[A-Za-z0-9_-]+[.,;:!?)]*|\/api\/files\/shared\/([a-z0-9]+)\.\d+\.[A-Za-z0-9_-]+[.,;:!?)]*/gi;

/** Artifact ids referenced by download / share links inside a message body. */
export function extractArtifactIdsFromLinks(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(ARTIFACT_DOWNLOAD_RE)) ids.add(m[1] ?? m[2]);
  for (const m of body.matchAll(SHARED_LINK_RE)) ids.add(m[1] ?? m[2]);
  return [...ids].filter(Boolean);
}

/** Removes artifact links from a body that will carry the file as a real attachment. */
export function stripArtifactLinks(body: string): string {
  let text = body.replace(ARTIFACT_DOWNLOAD_RE, '').replace(SHARED_LINK_RE, '');
  // "Descargar PDF - Ventas: " left without its URL, or "aquí: " dangling
  text = text.replace(/([^\n:]{0,80}):\s*(?=\n|$)/g, (m, label: string) => (/descarg|enlace|link|aqu[ií]|url/i.test(label) ? '' : m));
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return text;
}
