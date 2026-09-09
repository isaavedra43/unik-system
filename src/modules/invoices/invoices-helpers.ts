export interface InvoiceStatusConfig { raw: string; label: string; tone: 'success' | 'info' | 'warning' | 'danger' | 'muted'; }

const STATUS_MAP: Record<string, InvoiceStatusConfig> = {
  paid: { raw: 'paid', label: 'Pagada', tone: 'success' },
  sent: { raw: 'sent', label: 'Enviada', tone: 'info' },
  overdue: { raw: 'overdue', label: 'Vencida', tone: 'danger' },
  draft: { raw: 'draft', label: 'Borrador', tone: 'muted' },
  partially_paid: { raw: 'partially_paid', label: 'Parcialmente pagada', tone: 'warning' },
  void: { raw: 'void', label: 'Anulada', tone: 'danger' },
  deleted: { raw: 'deleted', label: 'Eliminada', tone: 'danger' },
};

function normalizeRaw(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return raw.trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
}

function humanizeRaw(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '—';
  return raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getInvoiceStatusConfig(raw: string | null | undefined): InvoiceStatusConfig {
  const normalized = normalizeRaw(raw);
  if (!normalized) return { raw: raw ?? '', label: '—', tone: 'muted' };
  return STATUS_MAP[normalized] ?? { raw: raw ?? '', label: humanizeRaw(raw), tone: 'muted' };
}

export function getInvoiceStatusLabel(raw: string | null | undefined): string { return getInvoiceStatusConfig(raw).label; }
export function getInvoiceStatusOptions(): { value: string; label: string }[] {
  return Object.values(STATUS_MAP).map((config) => ({ value: config.raw, label: config.label }));
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
