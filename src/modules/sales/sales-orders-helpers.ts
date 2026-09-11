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

type StatusCategory = 'order' | 'payment' | 'invoice' | 'shipping' | 'sub_status' | 'ticket';

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
  on_hold: { raw: 'on_hold', label: 'En espera', tone: 'warning' },
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
  fulfilled: { raw: 'fulfilled', label: 'Entregado', tone: 'success' },
  not_shipped: { raw: 'not_shipped', label: 'No enviado', tone: 'muted' },
  pending: { raw: 'pending', label: 'Pendiente', tone: 'warning' },
  partially_shipped: { raw: 'partially_shipped', label: 'Parcial', tone: 'warning' },
  packaged: { raw: 'packaged', label: 'Empaquetado', tone: 'info' },
};

const SUB_STATUS_MAP: Record<string, SalesOrderStatusConfig> = {
  accepted: { raw: 'accepted', label: 'Aceptado', tone: 'info' },
  processing: { raw: 'processing', label: 'Procesando', tone: 'info' },
  picking: { raw: 'picking', label: 'Seleccionando', tone: 'info' },
  packing: { raw: 'packing', label: 'Empaquetando', tone: 'info' },
  ready_to_ship: { raw: 'ready_to_ship', label: 'Listo para envío', tone: 'info' },
  shipped: { raw: 'shipped', label: 'Enviado', tone: 'success' },
  delivered: { raw: 'delivered', label: 'Entregado', tone: 'success' },
  returned: { raw: 'returned', label: 'Devuelto', tone: 'danger' },
  cancelled: { raw: 'cancelled', label: 'Cancelado', tone: 'danger' },
  draft: { raw: 'draft', label: 'Borrador', tone: 'warning' },
};

const TICKET_STATUS_MAP: Record<string, SalesOrderStatusConfig> = {
  closed: { raw: 'closed', label: 'Cerrado', tone: 'success' },
  void: { raw: 'void', label: 'Anulado', tone: 'danger' },
  draft: { raw: 'draft', label: 'Borrador', tone: 'warning' },
  on_hold: { raw: 'on_hold', label: 'En espera', tone: 'warning' },
  delivered: { raw: 'delivered', label: 'Entregado', tone: 'success' },
  in_transit: { raw: 'in_transit', label: 'En tránsito', tone: 'info' },
  pending_shipment: { raw: 'pending_shipment', label: 'Pendiente de envío', tone: 'warning' },
  payment_pending: { raw: 'payment_pending', label: 'Pago pendiente', tone: 'warning' },
  not_invoiced: { raw: 'not_invoiced', label: 'Sin facturar', tone: 'muted' },
  open: { raw: 'open', label: 'Abierto', tone: 'info' },
};

const CATEGORY_MAPS: Record<StatusCategory, Record<string, SalesOrderStatusConfig>> = {
  order: ORDER_STATUS_MAP,
  payment: PAYMENT_STATUS_MAP,
  invoice: INVOICE_STATUS_MAP,
  shipping: SHIPPING_STATUS_MAP,
  sub_status: SUB_STATUS_MAP,
  ticket: TICKET_STATUS_MAP,
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

export function getSalesOrderStatusOptions(
  category: StatusCategory
): { value: string; label: string }[] {
  const seen = new Set<string>();
  return Object.values(CATEGORY_MAPS[category])
    .map((config) => ({ value: config.raw, label: config.label }))
    .filter((opt) => {
      if (seen.has(opt.value)) return false;
      seen.add(opt.value);
      return true;
    });
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

// ---------------------------------------------------------------------------
// Ticket status — computed from order + payment + invoice + shipping status.
// Answers the question: "Is this ticket closed, pending delivery, or open?"
// ---------------------------------------------------------------------------

export interface TicketStatusInput {
  status: string | null;
  subStatus: string | null;
  paidStatus: string | null;
  invoicedStatus: string | null;
  shippedStatus: string | null;
}

export function getTicketStatus(order: TicketStatusInput): SalesOrderStatusConfig {
  const status = normalizeRaw(order.status);
  const paid = normalizeRaw(order.paidStatus);
  const invoiced = normalizeRaw(order.invoicedStatus);
  const shipped = normalizeRaw(order.shippedStatus);

  if (status === 'closed') return TICKET_STATUS_MAP.closed;
  if (status === 'void') return TICKET_STATUS_MAP.void;
  if (status === 'draft') return TICKET_STATUS_MAP.draft;
  if (status === 'on_hold') return TICKET_STATUS_MAP.on_hold;

  if (shipped === 'fulfilled' || shipped === 'delivered')
    return TICKET_STATUS_MAP.delivered;
  if (shipped === 'shipped') return TICKET_STATUS_MAP.in_transit;

  if (invoiced === 'invoiced' && (paid === 'paid' || paid === 'partially_paid' || paid === 'partial') && (shipped === 'not_shipped' || shipped === 'pending' || shipped === null))
    return TICKET_STATUS_MAP.pending_shipment;
  if (invoiced === 'invoiced' && (paid === 'unpaid' || paid === 'pending' || paid === null))
    return TICKET_STATUS_MAP.payment_pending;
  if (invoiced === 'not_invoiced' || invoiced === null)
    return TICKET_STATUS_MAP.not_invoiced;

  return TICKET_STATUS_MAP.open;
}

// ---------------------------------------------------------------------------
// Ticket lifecycle steps — visual progress bar data.
// ---------------------------------------------------------------------------

export type LifecycleStepStatus = 'done' | 'current' | 'pending' | 'partial';

export interface LifecycleStep {
  label: string;
  status: LifecycleStepStatus;
}

export function getTicketLifecycleSteps(order: TicketStatusInput): LifecycleStep[] {
  const status = normalizeRaw(order.status);
  const subStatus = normalizeRaw(order.subStatus);
  const paid = normalizeRaw(order.paidStatus);
  const invoiced = normalizeRaw(order.invoicedStatus);
  const shipped = normalizeRaw(order.shippedStatus);

  const isClosed = status === 'closed';
  const isVoid = status === 'void' || status === 'cancelled';

  // Step 1: Confirmado
  const step1: LifecycleStepStatus = isVoid
    ? 'pending'
    : status === 'confirmed' || isClosed
      ? 'done'
      : status === 'draft'
        ? 'current'
        : 'done';

  // Step 2: Aceptado (sub_status)
  const step2: LifecycleStepStatus = isVoid
    ? 'pending'
    : subStatus === 'accepted' || subStatus === 'processing' || subStatus === 'picking' || subStatus === 'packing' || subStatus === 'ready_to_ship' || isClosed
      ? 'done'
      : step1 === 'done'
        ? 'current'
        : 'pending';

  // Step 3: Facturado
  const step3: LifecycleStepStatus = isVoid
    ? 'pending'
    : invoiced === 'invoiced' || isClosed
      ? 'done'
      : invoiced === 'partially_invoiced'
        ? 'partial'
        : step2 === 'done'
          ? 'current'
          : 'pending';

  // Step 4: Pagado
  const step4: LifecycleStepStatus = isVoid
    ? 'pending'
    : paid === 'paid' || isClosed
      ? 'done'
      : paid === 'partially_paid' || paid === 'partial'
        ? 'partial'
        : step3 === 'done'
          ? 'current'
          : 'pending';

  // Step 5: Enviado
  const step5: LifecycleStepStatus = isVoid
    ? 'pending'
    : shipped === 'shipped' || shipped === 'fulfilled' || shipped === 'delivered' || isClosed
      ? 'done'
      : shipped === 'partially_shipped'
        ? 'partial'
        : step4 === 'done'
          ? 'current'
          : 'pending';

  // Step 6: Entregado
  const step6: LifecycleStepStatus = isVoid
    ? 'pending'
    : shipped === 'fulfilled' || shipped === 'delivered' || isClosed
      ? 'done'
      : step5 === 'done'
        ? 'current'
        : 'pending';

  // Step 7: Cerrado
  const step7: LifecycleStepStatus = isVoid
    ? 'pending'
    : isClosed
      ? 'done'
      : step6 === 'done'
        ? 'current'
        : 'pending';

  return [
    { label: 'Confirmado', status: step1 },
    { label: 'Aceptado', status: step2 },
    { label: 'Facturado', status: step3 },
    { label: 'Pagado', status: step4 },
    { label: 'Enviado', status: step5 },
    { label: 'Entregado', status: step6 },
    { label: 'Cerrado', status: step7 },
  ];
}
