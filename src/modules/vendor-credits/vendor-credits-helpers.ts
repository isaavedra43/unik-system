/**
 * Shared formatting and status helpers for the Vendor Credits module.
 *
 * IMPORTANT — Date semantics:
 * - `date` is a COMMERCIAL date stored as a timestamp; it is formatted WITHOUT
 *   timezone shifting so a date always displays consistently.
 * - `sourceRemoteModifiedAt`, `createdAt`, `updatedAt` are real timestamps and
 *   use normal locale formatting.
 */

export interface VendorCreditStatusConfig {
  raw: string;
  label: string;
  tone: 'success' | 'info' | 'warning' | 'danger' | 'muted';
}

const STATUS_MAP: Record<string, VendorCreditStatusConfig> = {
  open: { raw: 'open', label: 'Abierto', tone: 'info' },
  applied: { raw: 'applied', label: 'Aplicado', tone: 'success' },
  partially_applied: { raw: 'partially_applied', label: 'Parcial', tone: 'warning' },
  unapplied: { raw: 'unapplied', label: 'Sin aplicar', tone: 'muted' },
  cancelled: { raw: 'cancelled', label: 'Cancelado', tone: 'danger' },
  void: { raw: 'void', label: 'Anulado', tone: 'danger' },
  draft: { raw: 'draft', label: 'Borrador', tone: 'warning' },
  closed: { raw: 'closed', label: 'Cerrado', tone: 'success' },
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

export function getVendorCreditStatusConfig(
  raw: string | null | undefined
): VendorCreditStatusConfig {
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

export function getVendorCreditStatusLabel(raw: string | null | undefined): string {
  return getVendorCreditStatusConfig(raw).label;
}

export function getVendorCreditStatusOptions(): { value: string; label: string }[] {
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
