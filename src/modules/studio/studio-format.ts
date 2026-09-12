/**
 * Pure formatting helpers shared by the exporters, the verification step and
 * the browser editor. No Node-only imports here: this file is bundled for the
 * client too.
 *
 * All renderers MUST format cells through `renderCellText` so the verification
 * step can predict exactly which string a value becomes in every format.
 */

export type StudioCellValue = string | number | boolean | null;
export type StudioColumnFormat = 'text' | 'number' | 'currency' | 'percentage' | 'date';

/** Parses "1,234.50", "$1,234.50 MXN", "12%" or numbers. Returns null when not numeric. */
export function parseStudioNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[$€\s]|MXN|USD|%/g, '').replace(/,/g, '');
  if (cleaned.length === 0 || !/^-?\d*(?:\.\d+)?$/.test(cleaned) || !/\d/.test(cleaned)) {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Locale-independent thousands grouping ("1,234.5"). `decimals` fixes the fraction length. */
export function formatStudioNumber(n: number, decimals?: number): string {
  const negative = n < 0;
  const abs = Math.abs(n);
  let intPart: string;
  let fracPart: string;
  if (decimals === undefined) {
    // Up to 2 decimals, trailing zeros removed, integers stay integers.
    const rounded = Math.round(abs * 100) / 100;
    const [i, f = ''] = rounded.toString().includes('e')
      ? [Math.trunc(rounded).toString(), '']
      : rounded.toString().split('.');
    intPart = i;
    fracPart = f;
  } else {
    const fixed = abs.toFixed(decimals);
    const [i, f = ''] = fixed.split('.');
    intPart = i;
    fracPart = f;
  }
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = fracPart.length > 0 ? `${grouped}.${fracPart}` : grouped;
  return negative ? `-${body}` : body;
}

/** Formats a DATE string "YYYY-MM-DD" as "DD/MM/YYYY"; anything else is returned as-is. */
function formatDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value);
  if (!m) return value;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * The ONLY cell → text conversion used by every renderer. Numbers keep their
 * digits (never scientific notation, never silent truncation beyond 2 decimals
 * of rounding for formatted numbers).
 */
export function renderCellText(
  value: StudioCellValue | undefined,
  format?: StudioColumnFormat
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  switch (format) {
    case 'currency': {
      const n = parseStudioNumber(value);
      return n === null ? String(value) : `$${formatStudioNumber(n, 2)}`;
    }
    case 'percentage': {
      if (typeof value === 'string' && value.trim().endsWith('%')) return value.trim();
      const n = parseStudioNumber(value);
      return n === null ? String(value) : `${formatStudioNumber(n)}%`;
    }
    case 'date':
      return formatDate(String(value));
    case 'number': {
      const n = parseStudioNumber(value);
      return n === null ? String(value) : formatStudioNumber(n);
    }
    case 'text':
      return String(value);
    default:
      return typeof value === 'number' ? formatStudioNumber(value) : String(value);
  }
}

/**
 * Normalizes any rendered text for figure search: removes whitespace, currency
 * symbols, thousands separators and percent signs so "$ 1,234.50" and
 * "1234.50" compare equal.
 */
export function normalizeFigureText(text: string): string {
  return text.replace(/MXN|USD/g, '').replace(/[\s ,$€%]/g, '');
}

/** Every string form a figure may legitimately take once rendered. */
export function figureCandidates(raw: string): string[] {
  const out = new Set<string>();
  const normalized = normalizeFigureText(raw).replace(/\.$/, '');
  if (normalized.length > 0) out.add(normalized);
  const n = parseStudioNumber(raw);
  if (n !== null) {
    out.add(normalizeFigureText(formatStudioNumber(n)));
    out.add(normalizeFigureText(formatStudioNumber(n, 2)));
    if (Number.isInteger(n)) out.add(String(Math.abs(n)));
  }
  return [...out].map((c) => c.replace(/^-/, '')).filter((c) => /\d/.test(c));
}
