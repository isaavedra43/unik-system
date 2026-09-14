/**
 * Text extraction helpers for the approved library (pure: no Prisma, no network).
 *
 * - Tables (Excel, CSV, HTML tables) keep their headers on EVERY row
 *   ("Producto: X · Precio: $Y"): a fragment cut from the middle of a price list
 *   still says what each number means, so the assistant never mixes columns.
 * - Web pages keep headings, list items and table rows.
 * - Shareable-document matching ranks approved publishable files for requests
 *   like "mándale el PDF de promociones".
 */

export const KNOWLEDGE_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  json: 'application/json',
} as const;

export type KnowledgeFileKind = 'pdf' | 'word' | 'excel' | 'csv' | 'text' | 'web';

export const KNOWLEDGE_CATEGORY_VALUES = [
  'promociones',
  'catalogos',
  'precios',
  'fichas_tecnicas',
  'politicas',
  'manuales',
  'procesos',
  'capacitacion',
  'otro',
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORY_VALUES)[number];
export const KNOWLEDGE_CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  promociones: 'Promociones',
  catalogos: 'Catálogos',
  precios: 'Listas de precios',
  fichas_tecnicas: 'Fichas técnicas',
  politicas: 'Políticas y garantías',
  manuales: 'Manuales',
  procesos: 'Procesos internos',
  capacitacion: 'Capacitación',
  otro: 'Otro',
};

export function fileKindOf(mime: string | null | undefined, fileName?: string | null): KnowledgeFileKind {
  const m = (mime ?? '').toLowerCase();
  const ext = (fileName ?? '').toLowerCase().split('.').pop() ?? '';
  if (m === KNOWLEDGE_MIME.pdf || ext === 'pdf') return 'pdf';
  if (m === KNOWLEDGE_MIME.docx || ext === 'docx') return 'word';
  if (m === KNOWLEDGE_MIME.xlsx || ext === 'xlsx') return 'excel';
  if (m === 'text/csv' || m === 'application/csv' || ext === 'csv') return 'csv';
  if (m === 'text/html' || ext === 'html' || ext === 'htm') return 'web';
  return 'text';
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  iexcl: '¡', iquest: '¿', copy: '©', reg: '®', deg: '°', middot: '·', hellip: '…', mdash: '—', ndash: '–',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[code] ?? whole;
  });
}

function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? inlineText(m[1]) : '';
  return t || null;
}

/** HTML → readable text that keeps headings ("# …"), list items and table rows ("a | b"). */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head>/i, '');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const text = inlineText(inner);
    return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : '\n';
  });
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_m, inner: string) => {
    const cells = [...inner.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => inlineText(c[1]));
    return cells.some(Boolean) ? `\n${cells.join(' | ')}` : '';
  });
  s = s
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|ul|ol|table|blockquote|header|footer|main|nav|aside|form)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ASSET_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|pdf|zip|rar|7z|mp4|webm|mp3|wav|woff2?|ttf|otf|eot|xml|json|rss)$/i;

/** Same-host page links of an HTML document, absolute and without fragments (for crawling a website). */
export function extractSameSiteLinks(html: string, pageUrl: string, limit = 200): string[] {
  const base = new URL(pageUrl);
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    if (out.size >= limit) break;
    const raw = decodeEntities(m[1].trim());
    if (/^(mailto|tel|javascript|data|whatsapp|sms):/i.test(raw)) continue;
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (url.hostname !== base.hostname) continue;
    if (ASSET_EXT.test(url.pathname)) continue;
    url.hash = '';
    out.add(url.toString());
  }
  return [...out];
}

/** RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF, and , ; tab | delimiters. */
export function parseCsv(text: string, maxRows = 50_000): string[][] {
  const clean = text.replace(/^﻿/, '');
  const newline = clean.indexOf('\n');
  const firstLine = newline === -1 ? clean : clean.slice(0, newline);
  const delimiter = [',', ';', '\t', '|']
    .map((d) => [d, firstLine.split(d).length] as const)
    .sort((a, b) => b[1] - a[1])[0][0];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      field = '';
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      endRow();
      if (rows.length >= maxRows) return rows;
    } else {
      field += ch;
    }
  }
  endRow();
  return rows;
}

export interface SheetData {
  name: string;
  rows: string[][];
}

function cleanCell(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Table rows → text for the index. The first row with content is the header; every data row
 * repeats the headers. Rows are grouped in blocks (blank line between blocks) under a
 * "# Hoja: …" heading so the chunker keeps each fragment inside its sheet.
 */
export function sheetsToText(sheets: SheetData[], rowsPerBlock = 15): string {
  const parts: string[] = [];
  for (const sheet of sheets) {
    const rows = sheet.rows.map((r) => r.map(cleanCell)).filter((r) => r.some(Boolean));
    if (rows.length === 0) continue;
    const headers = rows[0].map((h, i) => h || `Columna ${i + 1}`);
    const body = rows.slice(1);
    parts.push(`# ${sheet.name ? `Hoja: ${sheet.name}` : 'Tabla'} (${body.length} filas)`);
    parts.push(`Columnas: ${headers.join(' | ')}`);
    for (let i = 0; i < body.length; i += rowsPerBlock) {
      parts.push(
        body
          .slice(i, i + rowsPerBlock)
          .map((r) =>
            r
              .map((c, j) => (c ? `${headers[j] ?? `Columna ${j + 1}`}: ${c}` : ''))
              .filter(Boolean)
              .join(' · ')
          )
          .join('\n')
      );
    }
  }
  return parts.join('\n\n');
}

export interface SheetPreview {
  name: string;
  headers: string[];
  rows: string[][];
  totalRows: number;
}

export function sheetPreview(sheet: SheetData, maxRows = 200): SheetPreview {
  const rows = sheet.rows.map((r) => r.map(cleanCell)).filter((r) => r.some(Boolean));
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill('')];
  return {
    name: sheet.name,
    headers: rows[0] ? pad(rows[0]) : [],
    rows: rows.slice(1, maxRows + 1).map(pad),
    totalRows: Math.max(0, rows.length - 1),
  };
}

/* ------------------------------------------------------------------ */
/* Shareable documents ("mándale el PDF de promociones al cliente")   */
/* ------------------------------------------------------------------ */

export interface ShareableCandidate {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  category: string | null;
  useWhen: string | null;
  fileName: string | null;
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const REQUEST_STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'del', 'al', 'un', 'una', 'unos', 'unas', 'que', 'con', 'por', 'para', 'sus', 'este', 'esta',
  'ese', 'esa', 'estos', 'estas', 'pdf', 'archivo', 'archivos', 'documento', 'documentos', 'manda', 'mandale', 'mandar',
  'mandales', 'envia', 'enviale', 'enviar', 'enviales', 'pasa', 'pasale', 'pasar', 'comparte', 'compartele', 'compartir',
  'cliente', 'clientes', 'nuestro', 'nuestra', 'nuestros', 'nuestras', 'favor', 'porfa', 'por', 'whatsapp', 'correo',
]);

function stem(term: string): string {
  return term.length > 4 ? term.replace(/(es|s)$/, '') : term;
}

export function requestTerms(request: string): string[] {
  return [...new Set(fold(request).split(/[^a-z0-9ñ]+/).filter((t) => t.length >= 3 && !REQUEST_STOPWORDS.has(t)).map(stem))];
}

/** Relevance of one document for a request; 0 = unrelated. Title/tags/category weigh more than free text. */
export function scoreShareable(request: string, doc: ShareableCandidate): number {
  const terms = requestTerms(request);
  if (terms.length === 0) return 0;
  const fields: Array<[string, number]> = [
    [fold(doc.title), 5],
    [fold(doc.tags.join(' ')), 4],
    [fold(doc.category ?? ''), 4],
    [fold(doc.useWhen ?? ''), 3],
    [fold(doc.description ?? ''), 2],
    [fold(doc.fileName ?? ''), 2],
  ];
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    let best = 0;
    for (const [text, weight] of fields) if (text.includes(term)) best = Math.max(best, weight);
    if (best > 0) matched += 1;
    score += best;
  }
  return matched === 0 ? 0 : Math.round(((score * matched) / terms.length) * 100) / 100;
}

export type ShareableDecision = 'single' | 'ambiguous' | 'none';

/** Ranks candidates and decides whether one document is clearly the one asked for. */
export function rankShareable<T extends ShareableCandidate>(
  request: string,
  docs: T[]
): { decision: ShareableDecision; ranked: Array<T & { score: number }> } {
  const ranked = docs
    .map((d) => ({ ...d, score: scoreShareable(request, d) }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return { decision: 'none', ranked };
  const [top, second] = ranked;
  const decision: ShareableDecision = !second || top.score >= second.score * 1.5 ? 'single' : 'ambiguous';
  return { decision, ranked };
}
