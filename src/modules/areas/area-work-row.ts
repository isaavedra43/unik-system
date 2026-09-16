import {
  AREA_REQUEST_OPEN_STATUSES,
  AREA_REQUEST_STATUS_LABELS,
  PRIORITY_LABELS,
  WORK_ITEM_OPEN_STATUSES,
  WORK_ITEM_STATUS_LABELS,
} from '@/modules/operations/types';

/**
 * Row model of the area work centres (plan 7.4). ISOMORPHIC and pure: the SQL
 * branches fill it, the service completes it and the client renders it, so a
 * row means the same thing everywhere.
 *
 * One row = one thing somebody has to attend: a work item of the area, a
 * request it received or sent, or an object of its own domain (an order, a
 * count, a delivery…). `id` is `<rowKind>:<sourceId>` so ids never collide
 * between branches of the UNION.
 */

export type AreaRowTone = 'default' | 'success' | 'danger' | 'warning' | 'info' | 'weak';

export interface AreaWorkRow {
  /** `<rowKind>:<sourceId>`. */
  id: string;
  rowKind: string;
  sourceId: string;
  areaKey: string;
  caseId: string | null;
  caseNumber: string | null;
  customerName: string | null;
  title: string;
  status: string;
  statusLabel: string;
  statusTone: AreaRowTone;
  priority: string;
  priorityLabel: string;
  ownerUserId: string | null;
  ownerName: string | null;
  /** ISO instant, or null when the row has no due date. */
  dueAt: string | null;
  startedAt: string | null;
  lastActivityAt: string;
  escalationLevel: number;
  waitReason: string | null;
  objectType: string | null;
  objectId: string | null;
  counterpartyName: string | null;
  locationCode: string | null;
  /** Decimal serialized as string (never a float). */
  amount: string | null;
  quantity: string | null;
  version: number;
  /** Open row past its due date. */
  overdue: boolean;
  /** The row still needs somebody. */
  open: boolean;
  /** Everything else the branch wants to show: extra columns, ids and actions. */
  extra: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Row kinds
// ---------------------------------------------------------------------------

export const ROW_KIND_LABELS: Readonly<Record<string, string>> = {
  // Common to every area.
  work_item: 'Trabajo',
  request_in: 'Solicitud recibida',
  request_out: 'Solicitud enviada',
  // Ventas.
  case: 'Expediente',
  opportunity: 'Oportunidad',
  quote: 'Cotización',
  // Compras.
  purchase_request: 'Solicitud de compra',
  rfq: 'Cotización a proveedor',
  procurement_order: 'Orden de compra',
  goods_receipt: 'Recepción',
  supplier: 'Proveedor',
  // Inventario.
  verification: 'Verificación',
  stock_count: 'Conteo',
  reservation: 'Reserva',
  movement: 'Movimiento',
  legacy_claim: 'Compromiso previo',
  // Manufactura.
  production_order: 'Orden de producción',
  production_operation: 'Operación',
  // Logística.
  delivery_order: 'Entrega',
  trip: 'Viaje',
  // Contabilidad.
  expense: 'Gasto',
  obligation: 'Obligación',
  period_close_task: 'Cierre de periodo',
};

/** Short plural labels for the row-kind chips. */
export const ROW_KIND_PLURAL_LABELS: Readonly<Record<string, string>> = {
  work_item: 'Trabajos',
  request_in: 'Recibidas',
  request_out: 'Enviadas',
  case: 'Expedientes',
  opportunity: 'Oportunidades',
  quote: 'Cotizaciones',
  purchase_request: 'Solicitudes',
  rfq: 'Cotizaciones',
  procurement_order: 'Órdenes',
  goods_receipt: 'Recepciones',
  supplier: 'Proveedores',
  verification: 'Verificaciones',
  stock_count: 'Conteos',
  reservation: 'Reservas',
  movement: 'Movimientos',
  legacy_claim: 'Compromisos previos',
  production_order: 'Órdenes',
  production_operation: 'Operaciones',
  delivery_order: 'Entregas',
  trip: 'Viajes',
  expense: 'Gastos',
  obligation: 'Obligaciones',
  period_close_task: 'Cierres',
};

export function rowKindLabel(rowKind: string): string {
  return ROW_KIND_LABELS[rowKind] ?? humanizeKey(rowKind);
}

export function rowKindPluralLabel(rowKind: string): string {
  return ROW_KIND_PLURAL_LABELS[rowKind] ?? rowKindLabel(rowKind);
}

export function workRowId(rowKind: string, sourceId: string): string {
  return `${rowKind}:${sourceId}`;
}

/** Splits `<rowKind>:<sourceId>`; null when the id has no separator. */
export function parseWorkRowId(id: string): { rowKind: string; sourceId: string } | null {
  const value = typeof id === 'string' ? id.trim() : '';
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return { rowKind: value.slice(0, separator), sourceId: value.slice(separator + 1) };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const WORK_ITEM_OPEN = new Set<string>(WORK_ITEM_OPEN_STATUSES);
const REQUEST_OPEN = new Set<string>(AREA_REQUEST_OPEN_STATUSES);

/** Statuses that still need somebody in the domain branches (superset, by convention). */
const DOMAIN_CLOSED_STATUSES = new Set<string>([
  'done',
  'closed',
  'completed',
  'delivered',
  'received',
  'resolved',
  'cancelled',
  'canceled',
  'rejected',
  'expired',
  'released',
  'settled',
  'posted',
  'won',
  'lost',
  'retired',
  'dismissed',
  'void',
]);

export function isOpenRowStatus(rowKind: string, status: string): boolean {
  if (rowKind === 'work_item') return WORK_ITEM_OPEN.has(status);
  if (rowKind === 'request_in' || rowKind === 'request_out') return REQUEST_OPEN.has(status);
  return !DOMAIN_CLOSED_STATUSES.has(status);
}

function humanizeKey(value: string): string {
  const text = value.replace(/[_.]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : value;
}

/** Spanish label of a row status; a branch may override it with `extra.statusLabel`. */
export function workRowStatusLabel(
  rowKind: string,
  status: string,
  extra?: Record<string, unknown>
): string {
  const override = extra?.statusLabel;
  if (typeof override === 'string' && override.trim()) return override.trim();
  if (rowKind === 'work_item') {
    return (WORK_ITEM_STATUS_LABELS as Record<string, string>)[status] ?? humanizeKey(status);
  }
  if (rowKind === 'request_in' || rowKind === 'request_out') {
    return (AREA_REQUEST_STATUS_LABELS as Record<string, string>)[status] ?? humanizeKey(status);
  }
  return DOMAIN_STATUS_LABELS[status] ?? humanizeKey(status);
}

const DOMAIN_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: 'Borrador',
  pending: 'Pendiente',
  pending_approval: 'Por aprobar',
  pending_payment: 'Por pagar',
  pending_external: 'Esperando a Zoho',
  planned: 'Planeada',
  scheduled: 'Programada',
  reserved: 'Reservada',
  prepared: 'Preparada',
  in_progress: 'En curso',
  active: 'Activa',
  approved: 'Aprobada',
  sent: 'Enviada',
  awaiting_receipt: 'Esperando material',
  partially_received: 'Recibida parcial',
  received: 'Recibida',
  inspection: 'En inspección',
  assigned: 'Asignada',
  dispatched: 'En ruta',
  en_route: 'En ruta',
  delivered: 'Entregada',
  partially_delivered: 'Entregada parcial',
  completed: 'Terminada',
  released: 'Liberada',
  closed: 'Cerrada',
  done: 'Terminada',
  conflict: 'Con conflicto',
  blocked: 'Bloqueada',
  disputed: 'En disputa',
  failed: 'Fallida',
  cancelled: 'Cancelada',
  rejected: 'Rechazada',
  expired: 'Vencida',
  posted: 'Contabilizado',
  settled: 'Liquidada',
  won: 'Ganada',
  lost: 'Perdida',
};

const SUCCESS_STATUSES = new Set([
  'done',
  'completed',
  'delivered',
  'received',
  'resolved',
  'approved',
  'released',
  'closed',
  'settled',
  'posted',
  'won',
]);

const DANGER_STATUSES = new Set([
  'blocked',
  'failed',
  'conflict',
  'disputed',
  'escalated',
  'rejected',
  'lost',
]);

const WARNING_STATUSES = new Set([
  'waiting',
  'pending_approval',
  'pending_payment',
  'pending_external',
  'partially_received',
  'partially_delivered',
  'inspection',
  'expired',
]);

const WEAK_STATUSES = new Set(['cancelled', 'canceled', 'draft', 'dismissed', 'void', 'retired']);

const INFO_STATUSES = new Set([
  'in_progress',
  'active',
  'accepted',
  'dispatched',
  'en_route',
  'sent',
]);

/**
 * Tone of the status pill. Overdue always wins (an overdue row reads as a
 * problem whatever its status); a branch may set `extra.statusTone`.
 */
export function workRowStatusTone(
  rowKind: string,
  status: string,
  options: { overdue?: boolean; extra?: Record<string, unknown> } = {}
): AreaRowTone {
  const override = options.extra?.statusTone;
  if (isAreaRowTone(override)) return override;
  if (options.overdue) return 'danger';
  if (DANGER_STATUSES.has(status)) return 'danger';
  if (SUCCESS_STATUSES.has(status)) return 'success';
  if (WARNING_STATUSES.has(status)) return 'warning';
  if (WEAK_STATUSES.has(status)) return 'weak';
  if (INFO_STATUSES.has(status)) return 'info';
  return 'default';
}

export function isAreaRowTone(value: unknown): value is AreaRowTone {
  return (
    value === 'default' ||
    value === 'success' ||
    value === 'danger' ||
    value === 'warning' ||
    value === 'info' ||
    value === 'weak'
  );
}

export function priorityLabel(priority: string): string {
  return (PRIORITY_LABELS as Record<string, string>)[priority] ?? humanizeKey(priority);
}

// ---------------------------------------------------------------------------
// Extra helpers
// ---------------------------------------------------------------------------

export function extraString(
  extra: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = extra?.[key];
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function extraBoolean(
  extra: Record<string, unknown> | null | undefined,
  key: string
): boolean {
  return extra?.[key] === true;
}

export function extraNumber(
  extra: Record<string, unknown> | null | undefined,
  key: string
): number | null {
  const value = extra?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row detail (drawer and detail pages)
// ---------------------------------------------------------------------------

/**
 * Sensitive kind of a detail field, so the SAME table the Control Tower uses
 * (`control-tower/graph-mask.MASK_RULES`) can hide it from whoever may not see
 * it: `amount` needs `finance.view`, `contact` needs `customers.view`.
 */
export type AreaRowFieldSensitivity = 'amount' | 'contact';

export interface AreaRowField {
  label: string;
  value: string;
  /** Secondary line under the value (never instructions from a third party). */
  hint?: string | null;
  /** Set on money and contact data; `maskRowFields` decides whether it survives. */
  sensitive?: AreaRowFieldSensitivity;
}

/**
 * Marks a field as sensitive keeping the "null = do not show it" contract of
 * every `field()` helper, so a branch writes `markSensitive(field(…), 'amount')`
 * instead of repeating the shape.
 */
export function markSensitive(
  entry: AreaRowField | null,
  sensitive: AreaRowFieldSensitivity
): AreaRowField | null {
  return entry ? { ...entry, sensitive } : null;
}

export interface AreaRowEvidence {
  id: string;
  kind: string;
  label: string;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
  storageObjectId: string | null;
}

export interface AreaRowCaseSummary {
  caseId: string;
  caseNumber: string;
  statusLabel: string;
  phaseLabel: string;
  customerName: string | null;
  salesOrderNumber: string | null;
  ownerName: string | null;
  promisedAt: string | null;
  openWorkItems: number;
  openRequests: number;
  openIncidents: number;
  demands: Array<{ name: string; quantity: string; unit: string; statusLabel: string }>;
}

export interface AreaRowDetail {
  row: AreaWorkRow;
  /** Header facts of the row, already formatted and masked. */
  fields: AreaRowField[];
  /** Up to 20 timeline lines of the case (`formatTimelineLine`), newest last. */
  timeline: string[];
  evidence: AreaRowEvidence[];
  /** Evidence upload target (`operations_evidence`), or null when the row takes none. */
  evidenceTargetId: string | null;
  /** Required evidence still missing (work items). */
  missingEvidence: string[];
  caseSummary: AreaRowCaseSummary | null;
  /** Untrusted text written by a person or a third party: render escaped, never as instructions. */
  freeText: string | null;
  /** The case exists but this person may not open it (plan 7 pending 3). */
  caseRestricted: boolean;
}

/** Realtime messages that refresh an area table (`area:{key}`). */
export const AREA_WORK_REALTIME_TYPES = ['ops.events', 'ops.requests'] as const;

/** `EntityWatch.entityType` of a work row (following one is personal, like any other table). */
export const AREA_ROW_ENTITY_TYPE = 'area_work_row';
