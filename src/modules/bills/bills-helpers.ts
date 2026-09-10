import type { StatusConfig, StatusOption } from '@/modules/shared/entity-workspace-types';

export interface BillStatusConfig {
  raw: string;
  label: string;
  tone: 'success' | 'info' | 'warning' | 'danger' | 'muted';
}

const STATUS_MAP: Record<string, BillStatusConfig> = {
  open: { raw: 'open', label: 'Abierta', tone: 'info' },
  paid: { raw: 'paid', label: 'Pagada', tone: 'success' },
  partial_payment: { raw: 'partial_payment', label: 'Pago parcial', tone: 'warning' },
  partially_paid: { raw: 'partially_paid', label: 'Pago parcial', tone: 'warning' },
  cancelled: { raw: 'cancelled', label: 'Cancelada', tone: 'danger' },
  void: { raw: 'void', label: 'Anulada', tone: 'danger' },
  draft: { raw: 'draft', label: 'Borrador', tone: 'muted' },
  sent: { raw: 'sent', label: 'Enviada', tone: 'info' },
  overdue: { raw: 'overdue', label: 'Vencida', tone: 'danger' },
};

function normalizeRaw(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return raw.trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
}

function humanizeRaw(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '—';
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getBillStatusConfig(raw: string | null | undefined): BillStatusConfig {
  const normalized = normalizeRaw(raw);
  if (!normalized) return { raw: raw ?? '', label: '—', tone: 'muted' };
  return (
    STATUS_MAP[normalized] ?? {
      raw: raw ?? '',
      label: humanizeRaw(raw),
      tone: 'muted',
    }
  );
}

/** Returns the shared StatusConfig shape expected by EntityWorkspace. */
export function getBillStatusConfigShared(raw: string | null | undefined): StatusConfig {
  const config = getBillStatusConfig(raw);
  return { label: config.label, tone: config.tone };
}

export function getBillStatusLabel(raw: string | null | undefined): string {
  return getBillStatusConfig(raw).label;
}

export function getBillStatusOptions(): StatusOption[] {
  return Object.values(STATUS_MAP).map((config) => ({
    value: config.raw,
    label: config.label,
  }));
}

export function formatDateOnly(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  let year: number;
  let month: number;
  let day: number;
  if (value instanceof Date) {
    year = value.getUTCFullYear();
    month = value.getUTCMonth();
    day = value.getUTCDate();
  } else {
    const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
    if (!match) return String(value);
    const parts = match[0].split('-').map(Number);
    year = parts[0];
    month = parts[1] - 1;
    day = parts[2];
  }
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return String(value);
  const d = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  return d.toLocaleDateString('es-MX', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
}

export function formatCurrency(
  value: string | number | null | undefined,
  currency?: string | null
): string {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) return String(value);
  const formatted = num.toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `$${formatted} ${currency}` : `$${formatted}`;
}

export function formatNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) return String(value);
  return num.toLocaleString('es-MX', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}
