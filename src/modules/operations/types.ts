/**
 * Shared vocabulary of the operations core: areas, the states of every core
 * model (kept identical to the `///` comments in prisma/schema.prisma, where
 * every state is a String), the event taxonomy and actor types.
 *
 * Pure module (no Prisma, no server imports): safe for client components.
 */

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export const AREA_KEYS = [
  'ventas',
  'compras',
  'inventario',
  'manufactura',
  'logistica',
  'contabilidad',
  'administracion',
] as const;

export type AreaKey = (typeof AREA_KEYS)[number];

export const AREA_LABELS: Record<AreaKey, string> = {
  ventas: 'Ventas',
  compras: 'Compras',
  inventario: 'Inventario',
  manufactura: 'Manufactura',
  logistica: 'Logística',
  contabilidad: 'Contabilidad',
  administracion: 'Administración',
};

export function isAreaKey(value: unknown): value is AreaKey {
  return typeof value === 'string' && (AREA_KEYS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export const ACTOR_TYPES = ['user', 'ai', 'system', 'zoho'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface OperationsActor {
  type: ActorType;
  /** User id (user / ai bot), a job or scheduler name (system) or 'zoho'. */
  id: string;
}

/** Who created an AreaRequest (`zoho` actors are recorded as `system`). */
export const REQUEST_CREATOR_TYPES = ['user', 'ai', 'system'] as const;
export type RequestCreatorType = (typeof REQUEST_CREATOR_TYPES)[number];

// ---------------------------------------------------------------------------
// OperationalCase
// ---------------------------------------------------------------------------

export const CASE_KINDS = ['sales_fulfillment'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export const CASE_SOURCE_TYPES = ['sales_order'] as const;
export type CaseSourceType = (typeof CASE_SOURCE_TYPES)[number];

export const CASE_STATUSES = [
  'open',
  'waiting',
  'blocked',
  'ready_to_close',
  'closed',
  'cancelled',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CASE_OPEN_STATUSES = ['open', 'waiting', 'blocked', 'ready_to_close'] as const;

export const CASE_PHASES = ['planning', 'sourcing', 'preparing', 'delivering', 'closing'] as const;
export type CasePhase = (typeof CASE_PHASES)[number];

export const PRIORITIES = ['normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'Abierto',
  waiting: 'En espera',
  blocked: 'Bloqueado',
  ready_to_close: 'Listo para cerrar',
  closed: 'Cerrado',
  cancelled: 'Cancelado',
};

export const CASE_PHASE_LABELS: Record<CasePhase, string> = {
  planning: 'Planeación',
  sourcing: 'Abastecimiento',
  preparing: 'Preparación',
  delivering: 'Entrega',
  closing: 'Cierre',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente',
};

// ---------------------------------------------------------------------------
// CaseDemand / DemandAllocation
// ---------------------------------------------------------------------------

export const DEMAND_STATUSES = [
  'pending',
  'verifying',
  'planned',
  'allocated',
  'fulfilled',
  'cancelled',
] as const;
export type DemandStatus = (typeof DEMAND_STATUSES)[number];

export const ALLOCATION_SOURCES = ['stock', 'purchase', 'manufacture', 'direct_supplier'] as const;
export type AllocationSource = (typeof ALLOCATION_SOURCES)[number];

export const ALLOCATION_STATUSES = [
  'planned',
  'reserved',
  'requested',
  'in_progress',
  'ready',
  'released',
  'delivered',
  'reopened',
  'cancelled',
] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

export const ALLOCATION_SOURCE_LABELS: Record<AllocationSource, string> = {
  stock: 'Inventario',
  purchase: 'Compra',
  manufacture: 'Manufactura',
  direct_supplier: 'Proveedor directo',
};

// ---------------------------------------------------------------------------
// CaseStep
// ---------------------------------------------------------------------------

export const STEP_SCOPES = ['case', 'demand', 'allocation'] as const;
export type StepScope = (typeof STEP_SCOPES)[number];

export const STEP_KINDS = ['action', 'wait', 'approval', 'verification', 'external_sync'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_STATUSES = [
  'pending',
  'ready',
  'active',
  'waiting',
  'done',
  'skipped',
  'failed',
  'cancelled',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

// ---------------------------------------------------------------------------
// WorkItem
// ---------------------------------------------------------------------------

export const WORK_ITEM_KINDS = [...STEP_KINDS, 'incident_followup'] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

export const WORK_ITEM_STATUSES = [
  'open',
  'in_progress',
  'waiting',
  'escalated',
  'done',
  'cancelled',
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/** States in which a work item still needs somebody. */
export const WORK_ITEM_OPEN_STATUSES = ['open', 'in_progress', 'waiting', 'escalated'] as const;

export const WORK_ITEM_KIND_LABELS: Record<WorkItemKind, string> = {
  action: 'Acción',
  wait: 'Espera',
  approval: 'Aprobación',
  verification: 'Verificación',
  external_sync: 'Sincronización externa',
  incident_followup: 'Seguimiento de incidencia',
};

export const WORK_ITEM_STATUS_LABELS: Record<WorkItemStatus, string> = {
  open: 'Abierto',
  in_progress: 'En curso',
  waiting: 'En espera',
  escalated: 'Escalado',
  done: 'Terminado',
  cancelled: 'Cancelado',
};

export const ESCALATION_RUNGS = ['backup', 'area_lead', 'administracion'] as const;
export type EscalationRung = (typeof ESCALATION_RUNGS)[number];

// ---------------------------------------------------------------------------
// AreaRequest
// ---------------------------------------------------------------------------

export const AREA_REQUEST_KINDS = [
  'availability_check',
  'purchase_shortfall',
  'direct_delivery',
  'payment_authorization',
  'vendor_pickup',
  'transformation',
  'material_shortfall',
  'finished_goods',
  'delivery_update',
  'create_package_in_zoho',
  'resolve_difference',
  'customer_notice',
  'cancel',
  'escalation',
  'info',
] as const;
export type AreaRequestKind = (typeof AREA_REQUEST_KINDS)[number];

export const AREA_REQUEST_STATUSES = [
  'sent',
  'acknowledged',
  'accepted',
  'blocked',
  'resolved',
  'rejected',
  'cancelled',
  'expired',
] as const;
export type AreaRequestStatus = (typeof AREA_REQUEST_STATUSES)[number];
export const AREA_REQUEST_OPEN_STATUSES = ['sent', 'acknowledged', 'accepted', 'blocked'] as const;

export const AREA_REQUEST_STATUS_LABELS: Record<AreaRequestStatus, string> = {
  sent: 'Enviada',
  acknowledged: 'Recibida',
  accepted: 'Aceptada',
  blocked: 'Bloqueada',
  resolved: 'Resuelta',
  rejected: 'Rechazada',
  cancelled: 'Cancelada',
  expired: 'Vencida',
};

// ---------------------------------------------------------------------------
// Incident
// ---------------------------------------------------------------------------

export const INCIDENT_KINDS = [
  'sla_breach',
  'orphan_case',
  'stock_conflict',
  'count_dispute',
  'zoho_conflict',
  'zoho_failure',
  'partial_delivery',
  'owner_absent',
  'order_change_conflict',
  'cancellation_compensation',
  'ai_failure',
  'purchase_difference',
  'excess_scrap',
  'quality_failure',
  'production_substitution',
  'zoho_readback_mismatch',
  'sales_order_readback_mismatch',
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const INCIDENT_OPEN_STATUSES = ['open', 'acknowledged'] as const;

export const INCIDENT_SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
  critical: 'Crítica',
};

export const INCIDENT_KIND_LABELS: Record<IncidentKind, string> = {
  sla_breach: 'Vencimiento de SLA',
  orphan_case: 'Expediente sin responsable',
  stock_conflict: 'Conflicto de inventario',
  count_dispute: 'Diferencia de conteo',
  zoho_conflict: 'Conflicto con Zoho',
  zoho_failure: 'Falla de Zoho',
  partial_delivery: 'Entrega parcial',
  owner_absent: 'Responsable ausente',
  order_change_conflict: 'Cambio de orden en conflicto',
  cancellation_compensation: 'Compensación por cancelación',
  ai_failure: 'Falla de la IA',
  purchase_difference: 'Diferencia en compra',
  excess_scrap: 'Merma excesiva',
  quality_failure: 'Falla de calidad',
  production_substitution: 'Sustitución en producción',
  zoho_readback_mismatch: 'Zoho devolvió otro valor',
  sales_order_readback_mismatch: 'Orden de venta distinta en Zoho',
};

// ---------------------------------------------------------------------------
// OperationalCommand / external sync
// ---------------------------------------------------------------------------

export const COMMAND_STATUSES = [
  'accepted',
  'completed',
  'pending_external',
  'rejected',
  'failed',
] as const;
export type CommandLedgerStatus = (typeof COMMAND_STATUSES)[number];

export const EXTERNAL_SYNC_STATUSES = [
  'none',
  'queued',
  'confirmed',
  'conflict',
  'failed',
] as const;
export type ExternalSyncStatus = (typeof EXTERNAL_SYNC_STATUSES)[number];

// ---------------------------------------------------------------------------
// EvidenceLink
// ---------------------------------------------------------------------------

export const EVIDENCE_KINDS = [
  'photo',
  'signature',
  'document',
  'note',
  'count',
  'zoho_readback',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

// ---------------------------------------------------------------------------
// Approvals (section 6.0)
// ---------------------------------------------------------------------------

export const APPROVAL_SCOPES = [
  'expense',
  'procurement',
  'payment',
  'payroll',
  'production_incident',
  'inventory_adjustment',
] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

export const APPROVAL_SCOPE_LABELS: Record<ApprovalScope, string> = {
  expense: 'Gasto',
  procurement: 'Compra',
  payment: 'Pago',
  payroll: 'Nómina',
  production_incident: 'Incidencia de producción',
  inventory_adjustment: 'Ajuste de inventario',
};

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_DECISIONS = ['approve', 'reject'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

// ---------------------------------------------------------------------------
// Event taxonomy
// ---------------------------------------------------------------------------

/**
 * Canonical event types of the operational log. Modules outside the core
 * (purchases, finance, CRM...) may emit their own `<module>.<fact>` types;
 * the core ones live here so producers, the dispatcher, templates and
 * projections never drift apart.
 */
export const OPS_EVENTS = {
  case: {
    created: 'case.created',
    started: 'case.started',
    statusChanged: 'case.status_changed',
    phaseChanged: 'case.phase_changed',
    ownerChanged: 'case.owner_changed',
    replanned: 'case.replanned',
    stuck: 'case.stuck',
    delivered: 'case.delivered',
    operationalClosed: 'case.operational_closed',
    financialClosed: 'case.financial_closed',
    cancelled: 'case.cancelled',
  },
  demand: {
    created: 'demand.created',
    verified: 'demand.verified',
    shortfallConfirmed: 'demand.shortfall_confirmed',
    allocated: 'demand.allocated',
    changed: 'demand.changed',
    fulfilled: 'demand.fulfilled',
    cancelled: 'demand.cancelled',
  },
  allocation: {
    planned: 'allocation.planned',
    reserved: 'allocation.reserved',
    requested: 'allocation.requested',
    inProgress: 'allocation.in_progress',
    ready: 'allocation.ready',
    released: 'allocation.released',
    delivered: 'allocation.delivered',
    reopened: 'allocation.reopened',
    reduced: 'allocation.reduced',
    cancelled: 'allocation.cancelled',
  },
  step: {
    ready: 'step.ready',
    started: 'step.started',
    waiting: 'step.waiting',
    completed: 'step.completed',
    skipped: 'step.skipped',
    failed: 'step.failed',
    cancelled: 'step.cancelled',
    reopened: 'step.reopened',
    reverted: 'step.reverted',
    engineFailed: 'step.engine_failed',
  },
  workitem: {
    created: 'workitem.created',
    assigned: 'workitem.assigned',
    reassigned: 'workitem.reassigned',
    started: 'workitem.started',
    waiting: 'workitem.waiting',
    completed: 'workitem.completed',
    cancelled: 'workitem.cancelled',
    overdue: 'workitem.overdue',
    escalated: 'workitem.escalated',
  },
  request: {
    created: 'request.created',
    acknowledged: 'request.acknowledged',
    accepted: 'request.accepted',
    blocked: 'request.blocked',
    resolved: 'request.resolved',
    rejected: 'request.rejected',
    cancelled: 'request.cancelled',
    expired: 'request.expired',
    overdue: 'request.overdue',
  },
  incident: {
    opened: 'incident.opened',
    acknowledged: 'incident.acknowledged',
    resolved: 'incident.resolved',
    dismissed: 'incident.dismissed',
  },
  stock: {
    counted: 'stock.counted',
    reserved: 'stock.reserved',
    reservedProvisional: 'stock.reserved_provisional',
    released: 'stock.released',
    received: 'stock.received',
    issued: 'stock.issued',
    adjusted: 'stock.adjusted',
    transferred: 'stock.transferred',
  },
  order: {
    prepared: 'order.prepared',
  },
  production: {
    started: 'production.started',
    finished: 'production.finished',
  },
  delivery: {
    planned: 'delivery.planned',
    dispatched: 'delivery.dispatched',
    confirmed: 'delivery.confirmed',
    partial: 'delivery.partial',
    failed: 'delivery.failed',
    addressUpdated: 'delivery.address_updated',
  },
  evidence: {
    attached: 'evidence.attached',
  },
  zoho: {
    shipmentQueued: 'zoho.shipment_queued',
    shipmentConfirmed: 'zoho.shipment_confirmed',
    shipmentConflict: 'zoho.shipment_conflict',
    shipmentFailed: 'zoho.shipment_failed',
    shipmentCancelled: 'zoho.shipment_cancelled',
    deliveredMarked: 'zoho.delivered_marked',
  },
  approval: {
    requested: 'approval.requested',
    voted: 'approval.voted',
    approved: 'approval.approved',
    rejected: 'approval.rejected',
    expired: 'approval.expired',
    cancelled: 'approval.cancelled',
  },
  supervisor: {
    tick: 'supervisor.tick',
  },
  ai: {
    turn: 'ai.turn',
    turnSkipped: 'ai.turn_skipped',
    turnFailed: 'ai.turn_failed',
    /** An AI identity posted an approval card in a room (so the case timeline shows what the chat shows). */
    proposalCreated: 'ai.proposal_created',
    /** An AI identity paused by budget posted its notice in a room. */
    budgetExhausted: 'ai.budget_exhausted',
  },
} as const;

/**
 * Spanish labels of the structured evidence keys of the blueprint steps and verifications (they are
 * produced by a flow — count, reservation, receipt… — not uploaded as files).
 */
export const STRUCTURED_EVIDENCE_LABELS: Readonly<Record<string, string>> = {
  availability_result: 'Resultado de disponibilidad',
  allocation_plan: 'Plan de abastecimiento',
  stock_reservation: 'Reserva de material',
  purchase_request_ref: 'Solicitud de compra',
  receipt_movement: 'Recepción del material',
  production_order_ref: 'Orden de producción',
  produce_movement: 'Producción terminada',
  supplier_confirmation: 'Confirmación del proveedor',
  delivery_evidence: 'Evidencia de entrega',
  issue_movements: 'Salida del material',
  count: 'Conteo',
  zoho_readback: 'Confirmación de Zoho',
};

/** Audit events of the AI decisions (turn, skip, failure): never part of a business timeline. */
export const AI_TURN_EVENT_TYPES: readonly string[] = [OPS_EVENTS.ai.turn, OPS_EVENTS.ai.turnSkipped, OPS_EVENTS.ai.turnFailed];

type ValuesOf<T> = T[keyof T];
type NestedValues<T> = ValuesOf<{ [K in keyof T]: ValuesOf<T[K]> }>;

/** Every canonical core event type. */
export type OperationalEventType = NestedValues<typeof OPS_EVENTS>;

/** Accepts the canonical types with autocompletion plus module-specific ones. */
export type OperationalEventTypeInput = OperationalEventType | (string & {});

export const OPS_EVENT_TYPES: readonly OperationalEventType[] = Object.values(OPS_EVENTS).flatMap(
  (group) => Object.values(group)
) as OperationalEventType[];

const EVENT_TYPE_SET = new Set<string>(OPS_EVENT_TYPES);

export function isOperationalEventType(value: string): value is OperationalEventType {
  return EVENT_TYPE_SET.has(value);
}

/** Event types follow `<group>.<fact>` in snake_case. */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
