/**
 * Shared formatting and status helpers for the Sales Orders module.
 *
 * IMPORTANT — Date semantics:
 * - `orderDate` is a COMMERCIAL date (YYYY-MM-DD) stored as PostgreSQL DATE.
 *   It must be formatted WITHOUT timezone shifting so that 2026-09-01 always
 *   displays as "01 sep 2026" regardless of the user's local zone.
 * - `createdAt`, `updatedAt`, `sourceRemoteModifiedAt` are real timestamps and
 *   use normal locale formatting.
 */

export type StatusCategory = 'order' | 'payment' | 'invoice' | 'shipping';

export interface SalesOrderStatusConfig {
  raw: string;
  label: string;
  tone: 'success' | 'info' | 'warning' | 'danger' | 'muted';
}

const ORDER_STATUS_MAP: Record<string, SalesOrderStatusConfig> = {
  confirmed: { raw: 'confirmed', label: 'Confirmada', tone: 'info' },
  closed: { raw: 'closed', label: 'Cerrada', tone: 'success' },
  void: { raw: 'void', label: 'Anulada', tone: 'danger' },
  cancelled: { raw: 'cancelled', label: 'Cancelada', tone: 'danger' },
  draft: { raw: 'draft', label: 'Borrador', tone: 'warning' },
  open: { raw: 'open', label: 'Abierta', tone: 'info' },
};

const PAYMENT_STATUS_MAP: Record<string, SalesOrderStatusConfig> = {
  paid: { raw: 'paid', label: 'Pagada', tone: 'success' },
  partially_paid: { raw: 'partially_paid', label: 'Parcial', tone: 'warning' },
  partial: { raw: 'partial', label: 'Parcial', tone: 'warning' },
  unpaid: { raw: 'unpaid', label: 'Pendiente', tone: 'warning' },
  pending: { raw: 'pending', label: 'Pendiente', tone: 'warning' },
  overdue: { raw: 'overdue', label: 'Vencida', tone: 'danger' },
};

const INVOICE_STATUS_MAP: Record<string, SalesOrderStatusConfig> = {
  invoiced: { raw: 'invoiced', label: 'Facturada', tone: 'success' },
  not_invoiced: { raw: 'not_invoiced', label: 'No facturada', tone: 'muted' },
  partially_invoiced: { raw: 'partially_invoiced', label: 'Parcial', tone: 'warning' },
  pending: { raw: 'pending', label: 'Pendiente', tone: 'warning' },
};

const SHIPPING_STATUS_MAP: Record<string, SalesOrderStatusConfig> = {
  shipped: { raw: 'shipped', label: 'Enviado', tone: 'success' },
  delivered: { raw: 'delivered', label: 'Entregado', tone: 'success' },
  not_shipped: { raw: 'not_shipped', label: 'No enviado', tone: 'muted' },
  pending: { raw: 'pending', label: 'Pendiente', tone: 'warning' },
  partially_shipped: { raw: 'partially_shipped', label: 'Parcial', tone: 'warning' },
  packaged: { raw: 'packaged', label: 'Empaquetado', tone: 'info' },
};

const CATEGORY_MAPS: Record<StatusCategory, Record<string, SalesOrderStatusConfig>> = {
  order: ORDER_STATUS_MAP,
  payment: PAYMENT_STATUS_MAP,
  invoice: INVOICE_STATUS_MAP,
  shipping: SHIPPING_STATUS_MAP,
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

export function getSalesOrderStatusConfig(
  raw: string | null | undefined,
  category: StatusCategory = 'order'
): SalesOrderStatusConfig {
  const normalized = normalizeRaw(raw);
  if (!normalized) {
    return { raw: raw ?? '', label: '—', tone: 'muted' };
  }
  const map = CATEGORY_MAPS[category];
  return (
    map[normalized] ?? {
      raw: raw ?? '',
      label: humanizeRaw(raw),
      tone: 'muted',
    }
  );
}

export function getSalesOrderStatusLabel(
  raw: string | null | undefined,
  category: StatusCategory = 'order'
): string {
  return getSalesOrderStatusConfig(raw, category).label;
}

/**
 * Formats a commercial date (YYYY-MM-DD) for display without timezone shifting.
 * Accepts ISO date strings (`2026-09-01`) or JS Date objects.
 */
export function formatDateOnly(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';

  let year: number;
  let month: number;
  let day: number;

  if (value instanceof Date) {
    // Use UTC components to avoid local timezone shifting for a date-only value.
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

/**
 * Formats a real timestamp for display in the user's locale.
 */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Converts a date to an ISO date-only string `YYYY-MM-DD` using UTC parts.
 */
export function dateToIsoDateOnly(value: Date | null | undefined): string | null {
  if (!value) return null;
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Formats a currency value consistently.
 * Result: `$9,488.16 MXN` when currency is provided, `$9,488.16` otherwise.
 */
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

/**
 * Formats a quantity with unit.
 */
export function formatQuantity(
  quantity: string | number | null | undefined,
  unit: string | null | undefined
): string {
  if (quantity === null || quantity === undefined) return '—';
  const num = typeof quantity === 'number' ? quantity : Number(quantity);
  if (Number.isNaN(num)) return String(quantity);
  const formatted = num.toLocaleString('es-MX', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
  if (unit) return `${formatted} ${unit}`;
  return formatted;
}
