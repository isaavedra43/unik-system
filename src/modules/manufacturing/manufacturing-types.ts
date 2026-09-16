import { OperationsError } from '@/modules/operations/errors';
import { OPS_EVENTS, type AreaKey } from '@/modules/operations/types';

/**
 * Shared vocabulary of the manufacturing module (plan 6.2): states of the
 * models (identical to the `///` comments in prisma/schema.prisma), commands,
 * events, jobs, realtime channel and error codes.
 *
 * Pure module (no Prisma client, no server imports).
 */

export const MANUFACTURING_AREA_KEY: AreaKey = 'manufactura';
export const MANUFACTURING_SYSTEM_ACTOR_ID = 'manufacturing';
export const MANUFACTURING_TIMEZONE = 'America/Mexico_City';

/** Realtime channel of the floor board (authorized with `manufacturing.view`). */
export const MANUFACTURING_FLOOR_CHANNEL = 'manufacturing:floor';
export const MANUFACTURING_REALTIME_TYPES = {
  orders: 'manufacturing.orders',
  workCenters: 'manufacturing.work_centers',
  boms: 'manufacturing.boms',
  capacity: 'manufacturing.capacity',
} as const;

export const MANUFACTURING_OBJECT_TYPES = {
  productionOrder: 'production_order',
  productionOperation: 'production_operation',
  materialConsumption: 'material_consumption',
  productionOutput: 'production_output',
  qualityCheck: 'quality_check',
  workCenter: 'work_center',
  bom: 'bom',
  /** Target of the excess-scrap approval of an order. */
  scrapReview: 'production_order_scrap',
  /** Object of the capacity overload work items (`{workCenterId}@{windowStart}`). */
  workCenterShift: 'work_center_shift',
  /** Object of the count requests of a blocked order (`{orderId}:{zohoItemId}`). */
  productionMaterial: 'production_material',
} as const;

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export const PRODUCTION_ORDER_KINDS = ['transformation', 'bom'] as const;
export type ProductionOrderKind = (typeof PRODUCTION_ORDER_KINDS)[number];

export const PRODUCTION_ORDER_KIND_LABELS: Record<ProductionOrderKind, string> = {
  transformation: 'Transformación',
  bom: 'Lista de materiales',
};

export const PRODUCTION_ORDER_STATUSES = [
  'draft',
  'reserved',
  'prepared',
  'in_progress',
  'inspection',
  'completed',
  'released',
  'cancelled',
  'blocked',
] as const;
export type ProductionOrderStatus = (typeof PRODUCTION_ORDER_STATUSES)[number];

export const PRODUCTION_ORDER_OPEN_STATUSES: readonly ProductionOrderStatus[] = [
  'draft',
  'reserved',
  'prepared',
  'in_progress',
  'inspection',
  'completed',
  'blocked',
];

export const PRODUCTION_ORDER_STATUS_LABELS: Record<ProductionOrderStatus, string> = {
  draft: 'Borrador',
  reserved: 'Materiales reservados',
  prepared: 'Preparada',
  in_progress: 'En proceso',
  inspection: 'En inspección',
  completed: 'Inspeccionada',
  released: 'Liberada',
  cancelled: 'Cancelada',
  blocked: 'Bloqueada',
};

export function isProductionOrderStatus(value: unknown): value is ProductionOrderStatus {
  return (
    typeof value === 'string' && (PRODUCTION_ORDER_STATUSES as readonly string[]).includes(value)
  );
}

export const RELEASE_TARGETS = ['inventory', 'logistics'] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export const RELEASE_TARGET_LABELS: Record<ReleaseTarget, string> = {
  inventory: 'Inventario',
  logistics: 'Logística',
};

export const OPERATION_STATUSES = ['pending', 'running', 'paused', 'done', 'skipped'] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const OPERATION_STATUS_LABELS: Record<OperationStatus, string> = {
  pending: 'Pendiente',
  running: 'En curso',
  paused: 'En pausa',
  done: 'Terminada',
  skipped: 'Omitida',
};

export const CONSUMPTION_KINDS = ['planned', 'actual', 'substitution'] as const;
export type ConsumptionKind = (typeof CONSUMPTION_KINDS)[number];

export const CONSUMPTION_KIND_LABELS: Record<ConsumptionKind, string> = {
  planned: 'Asignado',
  actual: 'Consumido',
  substitution: 'Sustitución',
};

export const OUTPUT_KINDS = ['finished', 'scrap', 'leftover'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export const OUTPUT_KIND_LABELS: Record<OutputKind, string> = {
  finished: 'Producto terminado',
  scrap: 'Merma',
  leftover: 'Sobrante',
};

export const QUALITY_RESULTS = ['pass', 'fail', 'conditional'] as const;
export type QualityResult = (typeof QUALITY_RESULTS)[number];

export const QUALITY_RESULT_LABELS: Record<QualityResult, string> = {
  pass: 'Aprobada',
  fail: 'Rechazada',
  conditional: 'Aprobada con observaciones',
};

export const BOM_KINDS = ['transformation', 'assembly'] as const;
export type BomKind = (typeof BOM_KINDS)[number];

export const BOM_KIND_LABELS: Record<BomKind, string> = {
  transformation: 'Transformación',
  assembly: 'Ensamble',
};

export const BOM_STATUSES = ['draft', 'active', 'retired'] as const;
export type BomStatus = (typeof BOM_STATUSES)[number];

export const BOM_STATUS_LABELS: Record<BomStatus, string> = {
  draft: 'Borrador',
  active: 'Activa',
  retired: 'Retirada',
};

export const WORK_CENTER_STATUSES = ['active', 'inactive'] as const;
export type WorkCenterStatus = (typeof WORK_CENTER_STATUSES)[number];

export const WORK_CENTER_STATUS_LABELS: Record<WorkCenterStatus, string> = {
  active: 'Activo',
  inactive: 'Inactivo',
};

export const CAPACITY_UNITS = ['m2', 'pieces', 'minutes'] as const;
export type CapacityUnit = (typeof CAPACITY_UNITS)[number];

export const CAPACITY_UNIT_LABELS: Record<CapacityUnit, string> = {
  m2: 'm²',
  pieces: 'piezas',
  minutes: 'minutos',
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Single operation of the implicit transformation BOM. */
export const DEFAULT_TRANSFORMATION_OPERATION = 'Corte/acabado';
/**
 * Minutes assumed for an operation planned without minutes (a transformation
 * from a request): a minutes-measured work center always sees some load, so
 * its capacity alerts work; the planner corrects it when scheduling.
 */
export const DEFAULT_OPERATION_MINUTES = 60;
/** Operation created for a BOM without routing. */
export const DEFAULT_BOM_OPERATION = 'Producción';
/** Scrap allowance of a transformation order when none is given (percent of the input). */
export const DEFAULT_SCRAP_ALLOWANCE_PCT = 5;
/** Days ahead searched for a free shift when scheduling. */
export const SCHEDULING_HORIZON_DAYS = 30;
/** Days ahead watched by `manufacturing.capacity_alerts`. */
export const CAPACITY_ALERT_HORIZON_DAYS = 7;
export const CAPACITY_ALERTS_EVERY_MS = 60 * 60_000;
/** Max orders re-evaluated by one retry job. */
export const RETRY_BLOCKED_BATCH = 50;

// ---------------------------------------------------------------------------
// Commands, events, jobs
// ---------------------------------------------------------------------------

export const MANUFACTURING_COMMANDS = {
  workCenterCreate: 'manufacturing.work_center.create',
  workCenterUpdate: 'manufacturing.work_center.update',
  bomCreate: 'manufacturing.bom.create',
  bomUpdate: 'manufacturing.bom.update',
  bomActivate: 'manufacturing.bom.activate',
  bomRetire: 'manufacturing.bom.retire',
  orderCreateTransformation: 'manufacturing.order.create_transformation',
  orderCreateFromBom: 'manufacturing.order.create_from_bom',
  orderIntakeRequest: 'manufacturing.order.intake_request',
  orderSchedule: 'manufacturing.order.schedule',
  orderReserveMaterials: 'manufacturing.order.reserve_materials',
  orderPrepare: 'manufacturing.order.prepare',
  operationStart: 'manufacturing.operation.start',
  operationPause: 'manufacturing.operation.pause',
  operationFinish: 'manufacturing.operation.finish',
  consumptionRecord: 'manufacturing.order.record_consumption',
  inspect: 'manufacturing.order.inspect',
  outputRecord: 'manufacturing.order.record_output',
  scrapReview: 'manufacturing.order.request_scrap_review',
  release: 'manufacturing.order.release',
  cancel: 'manufacturing.order.cancel',
  capacityAlert: 'manufacturing.capacity.alert',
} as const;

export type ManufacturingCommandType =
  (typeof MANUFACTURING_COMMANDS)[keyof typeof MANUFACTURING_COMMANDS];

export const MANUFACTURING_EVENTS = {
  orderCreated: 'production.order_created',
  scheduled: 'production.scheduled',
  materialsReserved: 'production.materials_reserved',
  blocked: 'production.blocked',
  unblocked: 'production.unblocked',
  prepared: 'production.prepared',
  started: OPS_EVENTS.production.started,
  operationStarted: 'production.operation_started',
  operationResumed: 'production.operation_resumed',
  operationPaused: 'production.operation_paused',
  operationFinished: 'production.operation_finished',
  inspectionReady: 'production.inspection_ready',
  consumptionRecorded: 'production.consumption_recorded',
  substitutionRequested: 'production.substitution_requested',
  substitutionPosted: 'production.substitution_posted',
  substitutionRejected: 'production.substitution_rejected',
  inspected: 'production.inspected',
  reworkAdded: 'production.rework_added',
  outputRecorded: 'production.output_recorded',
  scrapExceeded: 'production.scrap_exceeded',
  scrapApproved: 'production.scrap_approved',
  scrapRejected: 'production.scrap_rejected',
  materialsReleased: 'production.materials_released',
  /** Canonical core event (case advance trigger and exit of `esperar_produccion`). */
  finished: OPS_EVENTS.production.finished,
  released: 'production.released',
  cancelled: 'production.cancelled',
  workCenterCreated: 'manufacturing.work_center_created',
  workCenterUpdated: 'manufacturing.work_center_updated',
  bomCreated: 'manufacturing.bom_created',
  bomUpdated: 'manufacturing.bom_updated',
  bomActivated: 'manufacturing.bom_activated',
  bomRetired: 'manufacturing.bom_retired',
  capacityOverloaded: 'manufacturing.capacity_overloaded',
} as const;

/** Events whose `objectId` is a production operation (segment start of the real minutes). */
export const OPERATION_SEGMENT_EVENTS: readonly string[] = [
  MANUFACTURING_EVENTS.operationStarted,
  MANUFACTURING_EVENTS.operationResumed,
];

export const MANUFACTURING_JOB_TYPES = {
  /** `{requestId}`: a transformation AreaRequest becomes a production order. */
  intakeRequest: 'manufacturing.intake_request',
  /** `{zohoItemId?, requestId?, productionOrderId?}`: blocked orders try to reserve again. */
  retryBlocked: 'manufacturing.retry_blocked',
  /** Hourly overload watch of the work centers. */
  capacityAlerts: 'manufacturing.capacity_alerts',
} as const;

/** Stock facts that may unblock an order waiting for material. */
export const STOCK_ARRIVAL_EVENTS: readonly string[] = [
  'stock.received',
  'stock.produced',
  'stock.returned',
  'stock.adjusted',
  'stock.transferred',
  'stock.released',
  'stock.unblocked',
  'stock.controlled',
  'stock.count_closed',
  'stock.dispute_resolved',
  'stock.legacy_released',
  'stock.legacy_expired',
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const MANUFACTURING_ERROR_HTTP_STATUS = {
  material_shortfall: 409,
  release_blocked: 409,
  operation_sequence: 409,
  bom_invalid: 422,
  no_work_center: 409,
  approval_pending: 409,
  item_unresolved: 422,
} as const;

export type ManufacturingErrorCode = keyof typeof MANUFACTURING_ERROR_HTTP_STATUS;

/** OperationsError with the HTTP status of a manufacturing code. */
export function manufacturingError(
  code: ManufacturingErrorCode,
  message: string,
  details?: Record<string, unknown>
): OperationsError {
  return new OperationsError(code, message, {
    httpStatus: MANUFACTURING_ERROR_HTTP_STATUS[code],
    details,
  });
}

export function manufacturingHttpStatus(code: string | undefined): number | null {
  if (!code) return null;
  return (MANUFACTURING_ERROR_HTTP_STATUS as Record<string, number>)[code] ?? null;
}

export const productionOrderUrl = (orderId: string) => `/app/areas/manufactura/ordenes/${orderId}`;

/**
 * Páginas de gestión de Manufactura que viven FUERA de `/app/areas` (plan 6.2).
 * Estaban escritas a mano en tres lugares (las server actions que revalidan, el
 * tablero y las propias páginas); aquí son una sola constante para que un
 * cambio de ruta no deje un enlace muerto.
 */
export const MANUFACTURING_BOM_PATH = '/app/areas/manufactura/bom';
export const MANUFACTURING_WORK_CENTERS_PATH = '/app/areas/manufactura/centros';
export const MANUFACTURING_NEW_ORDER_PATH = '/app/areas/manufactura/ordenes/nueva';
