export interface QuoteStatusConfig { raw: string; label: string; tone: 'success' | 'info' | 'warning' | 'danger' | 'muted'; }

/** Zoho Books estimate statuses. */
export const QUOTE_STATUS = {
  DRAFT: 'draft',
  SENT: 'sent',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  INVOICED: 'invoiced',
  EXPIRED: 'expired',
} as const;

const STATUS_MAP: Record<string, QuoteStatusConfig> = {
  draft: { raw: 'draft', label: 'Borrador', tone: 'muted' },
  sent: { raw: 'sent', label: 'Enviada', tone: 'info' },
  accepted: { raw: 'accepted', label: 'Aceptada', tone: 'success' },
  declined: { raw: 'declined', label: 'Rechazada', tone: 'danger' },
  invoiced: { raw: 'invoiced', label: 'Facturada', tone: 'success' },
  expired: { raw: 'expired', label: 'Vencida', tone: 'warning' },
  viewed: { raw: 'viewed', label: 'Vista por cliente', tone: 'info' },
};

/** Statuses that Zoho still allows to be edited. */
export const EDITABLE_STATUSES = new Set<string>(['draft', 'sent', 'expired']);
/** Statuses where Zoho allows changing to accepted/declined. */
export const DECISION_STATUSES = new Set<string>(['sent', 'expired', 'viewed']);

function normalizeRaw(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return raw.trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
}

function humanizeRaw(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '—';
  return raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getQuoteStatusConfig(raw: string | null | undefined): QuoteStatusConfig {
  const normalized = normalizeRaw(raw);
  if (!normalized) return { raw: raw ?? '', label: '—', tone: 'muted' };
  return STATUS_MAP[normalized] ?? { raw: raw ?? '', label: humanizeRaw(raw), tone: 'muted' };
}

export function getQuoteStatusLabel(raw: string | null | undefined): string { return getQuoteStatusConfig(raw).label; }
export function getQuoteStatusOptions(): { value: string; label: string }[] {
  return Object.values(STATUS_MAP).filter((s) => s.raw !== 'viewed').map((config) => ({ value: config.raw, label: config.label }));
}

export function isQuoteEditable(status: string | null | undefined): boolean {
  const normalized = normalizeRaw(status);
  return normalized !== null && EDITABLE_STATUSES.has(normalized);
}

export function canMarkSent(status: string | null | undefined): boolean {
  return normalizeRaw(status) === 'draft';
}

export function canDecide(status: string | null | undefined): boolean {
  const normalized = normalizeRaw(status);
  return normalized !== null && DECISION_STATUSES.has(normalized);
}

/**
 * Expiry information relative to today (UTC date only).
 * Returns null when the quote is closed (accepted/declined/invoiced) or has no expiry.
 */
export function getQuoteExpiryInfo(
  expiryDate: string | Date | null | undefined,
  status: string | null | undefined
): { daysLeft: number; label: string; tone: 'success' | 'warning' | 'danger' | 'muted' } | null {
  if (!expiryDate) return null;
  const normalized = normalizeRaw(status);
  if (normalized === 'accepted' || normalized === 'declined' || normalized === 'invoiced') return null;
  const d = expiryDate instanceof Date ? expiryDate : new Date(expiryDate);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const expiryUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const daysLeft = Math.round((expiryUtc - todayUtc) / 86_400_000);
  if (daysLeft < 0) return { daysLeft, label: `Venció hace ${Math.abs(daysLeft)} d`, tone: 'danger' };
  if (daysLeft === 0) return { daysLeft, label: 'Vence hoy', tone: 'danger' };
  if (daysLeft <= 7) return { daysLeft, label: `Vence en ${daysLeft} d`, tone: 'warning' };
  return { daysLeft, label: `Vence en ${daysLeft} d`, tone: 'success' };
}

export function formatDateOnly(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  let year: number, month: number, day: number;
  if (value instanceof Date) { year = value.getUTCFullYear(); month = value.getUTCMonth(); day = value.getUTCDate(); }
  else {
    const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
    if (!match) return String(value);
    const parts = match[0].split('-').map(Number);
    year = parts[0]; month = parts[1] - 1; day = parts[2];
  }
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return String(value);
  const d = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  return d.toLocaleDateString('es-MX', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}

/** yyyy-mm-dd for date inputs and Zoho payloads. */
export function toDateInputValue(value: string | Date | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return match ? match[0] : '';
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
}

export function formatCurrency(value: string | number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) return String(value);
  const formatted = num.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `$${formatted} ${currency}` : `$${formatted}`;
}

export function formatNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) return String(value);
  return num.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}
