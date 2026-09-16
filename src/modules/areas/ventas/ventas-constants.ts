/**
 * Constantes isomórficas del área Ventas (plan 7.3, 7.4 y 7.6): tipos de fila,
 * etiquetas y enlaces estables. Módulo puro (sin Prisma y sin React) para que
 * las ramas SQL, el registro de cliente, las páginas y las pruebas lean lo
 * mismo.
 */

export const VENTAS_AREA_KEY = 'ventas' as const;

/** Tipos de fila propios del centro de trabajo de Ventas (declarados en AREA_REGISTRY.ventas). */
export const VENTAS_ROW_KINDS = {
  case: 'case',
  opportunity: 'opportunity',
  quote: 'quote',
} as const;

export type VentasRowKind = (typeof VENTAS_ROW_KINDS)[keyof typeof VENTAS_ROW_KINDS];

/** Cotizaciones que siguen vivas: aún pueden convertirse o vencer. */
export const QUOTE_OPEN_STATUSES = ['sent', 'viewed', 'accepted'] as const;

/** Cotizaciones cerradas que seguimos mostrando un tiempo (scope "cerrados"). */
export const QUOTE_CLOSED_STATUSES = ['declined', 'expired', 'invoiced'] as const;

/** Días de historia de cotizaciones cerradas en el centro de trabajo. */
export const QUOTE_CLOSED_WINDOW_DAYS = 90;

/** Cotizaciones enviadas que esperan decisión del cliente. */
export const QUOTE_WAITING_STATUSES = ['sent', 'viewed'] as const;

/** Estados de orden de venta que no cuentan como venta real. */
export const EXCLUDED_SALES_ORDER_STATUSES = ['void', 'draft', 'cancelled'] as const;

export const QUOTE_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: 'Borrador',
  sent: 'Enviada',
  viewed: 'Vista por el cliente',
  accepted: 'Aceptada',
  declined: 'Rechazada',
  expired: 'Vencida',
  invoiced: 'Facturada',
};

export const OPPORTUNITY_ROW_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: 'Abierta',
  won: 'Ganada',
  lost: 'Perdida',
  dormant: 'Dormida',
};

// ---------------------------------------------------------------------------
// Enlaces
// ---------------------------------------------------------------------------

const AREA_BASE = `/app/areas/${VENTAS_AREA_KEY}`;

export function ventasSpaceHref(slug: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  const base = `${AREA_BASE}/${slug}`;
  return query ? `${base}?${query}` : base;
}

export function ventasWorkHref(params: Record<string, string> = {}): string {
  return ventasSpaceHref('trabajo', params);
}

export function ventasDashboardHref(): string {
  return ventasSpaceHref('dashboard');
}

export function ventasRadarHref(params: Record<string, string> = {}): string {
  return ventasSpaceHref('radar', params);
}

/**
 * Bandeja externa del área, la pestaña donde vive el redactor de `InboxEmbedded`.
 * Es a donde lleva «Llevar a la bandeja» del Radar de cierre: el borrador NO
 * viaja en la URL (ver `modules/areas/comms-draft.ts`), sólo la pestaña.
 */
export function ventasCommsHref(tab: 'chat' | 'solicitudes' | 'externos' = 'externos'): string {
  return ventasSpaceHref('comunicaciones', { tab });
}

/** Embudo comercial (tablero por etapa). */
export function ventasPipelineHref(): string {
  return `${AREA_BASE}/pipeline`;
}

/** Lista de oportunidades (subpágina del registro). */
export function ventasOpportunitiesHref(params: Record<string, string> = {}): string {
  return ventasSpaceHref('oportunidades', params);
}

/** Detalle de una oportunidad. */
export function opportunityHref(opportunityId: string): string {
  return `${AREA_BASE}/oportunidades/${encodeURIComponent(opportunityId)}`;
}

export function quoteHref(quoteId: string): string {
  return `/app/quotes/${encodeURIComponent(quoteId)}`;
}

export const SALES_ORDERS_HREF = '/app/sales/orders';

export function salesOrderHref(salesOrderId: string): string {
  return `${SALES_ORDERS_HREF}/${encodeURIComponent(salesOrderId)}`;
}

export const INBOX_HREF = '/app/inbox';

// ---------------------------------------------------------------------------
// APIs del área (todas bajo /app/areas/ventas/api/ventas)
// ---------------------------------------------------------------------------

const API_BASE = `${AREA_BASE}/api/${VENTAS_AREA_KEY}`;

export const VENTAS_API = {
  radar: (params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    return query ? `${API_BASE}/radar?${query}` : `${API_BASE}/radar`;
  },
  explainSignal: (signalId: string) => `${API_BASE}/radar/${encodeURIComponent(signalId)}/explain`,
  pipeline: () => `${API_BASE}/pipeline`,
  opportunity: (opportunityId: string) =>
    `${API_BASE}/opportunities/${encodeURIComponent(opportunityId)}`,
  conversation: (conversationId: string) =>
    `${API_BASE}/conversations/${encodeURIComponent(conversationId)}`,
  quoteSalesOrder: (quoteId: string) =>
    `${API_BASE}/quotes/${encodeURIComponent(quoteId)}/sales-order`,
} as const;

// ---------------------------------------------------------------------------
// Formatos
// ---------------------------------------------------------------------------

/** Importe en pesos, ya redondeado; "—" cuando no hay dato. */
export function formatMoney(value: number | string | null | undefined, currency = 'MXN'): string {
  if (value === null || value === undefined || value === '') return '—';
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency,
      maximumFractionDigits: amount >= 1000 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString('es-MX')} ${currency}`;
  }
}

export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('es-MX') : '0';
}

/** Probabilidad 0–1 como porcentaje entero. */
export function formatProbability(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)} %`;
}
