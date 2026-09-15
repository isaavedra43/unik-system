import { OperationsError } from '@/modules/operations/errors';
import { ALLOCATION_SOURCES, OPS_EVENTS, type AreaKey } from '@/modules/operations/types';

/**
 * Shared vocabulary of the progressive inventory module: confidence levels,
 * movement kinds and every other String state of the inventory models (kept
 * identical to the `///` comments in prisma/schema.prisma), event types and
 * domain error codes.
 *
 * Pure module (no Prisma client, no server imports): safe for client components.
 */

export const INVENTORY_AREA_KEY: AreaKey = 'inventario';

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

export const CONFIDENCE_LEVELS = ['UNCOUNTED', 'PROVISIONAL', 'CONTROLLED', 'DISPUTED'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  UNCOUNTED: 'Sin contar',
  PROVISIONAL: 'Provisional',
  CONTROLLED: 'Controlado',
  DISPUTED: 'En disputa',
};

export function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
  return typeof value === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

/** Unknown stored values are treated as never counted. */
export function toConfidenceLevel(value: unknown): ConfidenceLevel {
  return isConfidenceLevel(value) ? value : 'UNCOUNTED';
}

/** Consecutive counts within tolerance (without open disputes) that make an item CONTROLLED. */
export const PROMOTION_GOOD_COUNTS = 2;

/** Count tolerance given to new item profiles (percent). */
export const DEFAULT_TOLERANCE_PCT = 2;

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

export const MOVEMENT_KINDS = [
  'baseline',
  'receipt',
  'issue',
  'transfer_in',
  'transfer_out',
  'adjust',
  'consume',
  'produce',
  'return',
  'block',
  'unblock',
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export const MOVEMENT_KIND_LABELS: Record<MovementKind, string> = {
  baseline: 'Conteo inicial',
  receipt: 'Entrada',
  issue: 'Salida',
  transfer_in: 'Traspaso (entrada)',
  transfer_out: 'Traspaso (salida)',
  adjust: 'Ajuste',
  consume: 'Consumo de producción',
  produce: 'Producción',
  return: 'Devolución',
  block: 'Bloqueo',
  unblock: 'Desbloqueo',
};

export function isMovementKind(value: unknown): value is MovementKind {
  return typeof value === 'string' && (MOVEMENT_KINDS as readonly string[]).includes(value);
}

/** Kinds that add physical stock. */
export const INBOUND_MOVEMENT_KINDS = ['receipt', 'return', 'produce', 'transfer_in'] as const;
/** Kinds that remove physical stock. */
export const OUTBOUND_MOVEMENT_KINDS = ['issue', 'consume', 'transfer_out'] as const;
/** Kinds whose quantity carries a sign. */
export const SIGNED_MOVEMENT_KINDS = ['adjust', 'baseline'] as const;

export function isOutboundKind(kind: MovementKind): boolean {
  return (OUTBOUND_MOVEMENT_KINDS as readonly string[]).includes(kind);
}

export function isInboundKind(kind: MovementKind): boolean {
  return (INBOUND_MOVEMENT_KINDS as readonly string[]).includes(kind);
}

export function isSignedKind(kind: MovementKind): boolean {
  return (SIGNED_MOVEMENT_KINDS as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// Reservations, counts, legacy claims
// ---------------------------------------------------------------------------

export const RESERVATION_STATUSES = ['active', 'released', 'consumed', 'expired'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  active: 'Activa',
  released: 'Liberada',
  consumed: 'Consumida',
  expired: 'Vencida',
};

export const COUNT_SCOPES = ['spot', 'cycle', 'full'] as const;
export type CountScope = (typeof COUNT_SCOPES)[number];

export const COUNT_SCOPE_LABELS: Record<CountScope, string> = {
  spot: 'Puntual',
  cycle: 'Cíclico',
  full: 'Completo',
};

export const COUNT_STATUSES = ['draft', 'in_progress', 'closed', 'cancelled'] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];
export const COUNT_OPEN_STATUSES = ['draft', 'in_progress'] as const;

export const COUNT_STATUS_LABELS: Record<CountStatus, string> = {
  draft: 'Borrador',
  in_progress: 'En curso',
  closed: 'Cerrado',
  cancelled: 'Cancelado',
};

export const COUNT_LINE_RESOLUTIONS = ['pending', 'accepted', 'adjusted', 'disputed'] as const;
export type CountLineResolution = (typeof COUNT_LINE_RESOLUTIONS)[number];

export const COUNT_LINE_RESOLUTION_LABELS: Record<CountLineResolution, string> = {
  pending: 'Pendiente',
  accepted: 'Aceptada',
  adjusted: 'Ajustada',
  disputed: 'En disputa',
};

export const LEGACY_CLAIM_SOURCES = ['pre_cutover_order', 'verbal', 'other'] as const;
export type LegacyClaimSource = (typeof LEGACY_CLAIM_SOURCES)[number];

export const LEGACY_CLAIM_SOURCE_LABELS: Record<LegacyClaimSource, string> = {
  pre_cutover_order: 'Orden anterior al corte',
  verbal: 'Acuerdo verbal',
  other: 'Otro',
};

export const LEGACY_CLAIM_STATUSES = ['claimed', 'confirmed', 'released', 'expired'] as const;
export type LegacyClaimStatus = (typeof LEGACY_CLAIM_STATUSES)[number];

export const LEGACY_CLAIM_STATUS_LABELS: Record<LegacyClaimStatus, string> = {
  claimed: 'Reclamado',
  confirmed: 'Confirmado',
  released: 'Liberado',
  expired: 'Vencido',
};

// ---------------------------------------------------------------------------
// Warehouses, locations, profiles
// ---------------------------------------------------------------------------

export const LOCATION_KINDS = ['rack', 'bin', 'floor', 'yard', 'virtual'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const LOCATION_KIND_LABELS: Record<LocationKind, string> = {
  rack: 'Rack',
  bin: 'Casillero',
  floor: 'Piso',
  yard: 'Patio',
  virtual: 'Virtual',
};

/** Location every warehouse has; stock without an explicit location lands here. */
export const GENERAL_LOCATION_CODE = 'GENERAL';
/** Virtual location for production scrap: its stock is always blocked. */
export const SCRAP_LOCATION_CODE = 'SCRAP';
export const SYSTEM_LOCATION_CODES = [GENERAL_LOCATION_CODE, SCRAP_LOCATION_CODE] as const;

export const TRACKING_POLICIES = ['none', 'lot', 'roll', 'sheet', 'container'] as const;
export type TrackingPolicy = (typeof TRACKING_POLICIES)[number];

export const TRACKING_POLICY_LABELS: Record<TrackingPolicy, string> = {
  none: 'Sin seguimiento',
  lot: 'Por lote',
  roll: 'Por rollo',
  sheet: 'Por placa',
  container: 'Por contenedor',
};

/** Suggested variant axes (profiles may use other snake_case axes). */
export const SUGGESTED_VARIANT_AXES = [
  'medida',
  'color',
  'acabado',
  'lote',
  'rollo',
  'placa',
] as const;

export const DEFAULT_SOURCES = ALLOCATION_SOURCES;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Event types emitted by the inventory module. The canonical `stock.*` types
 * of the core are reused; the rest follow the `<group>.<fact>` convention.
 */
export const INVENTORY_EVENTS = {
  counted: OPS_EVENTS.stock.counted,
  reserved: OPS_EVENTS.stock.reserved,
  reservedProvisional: OPS_EVENTS.stock.reservedProvisional,
  released: OPS_EVENTS.stock.released,
  received: OPS_EVENTS.stock.received,
  issued: OPS_EVENTS.stock.issued,
  adjusted: OPS_EVENTS.stock.adjusted,
  transferred: OPS_EVENTS.stock.transferred,
  baseline: 'stock.baseline',
  returned: 'stock.returned',
  produced: 'stock.produced',
  consumed: 'stock.consumed',
  blocked: 'stock.blocked',
  unblocked: 'stock.unblocked',
  reservationConsumed: 'stock.reservation_consumed',
  controlled: 'stock.controlled',
  countStarted: 'stock.count_started',
  countClosed: 'stock.count_closed',
  countCancelled: 'stock.count_cancelled',
  countDisputed: 'stock.count_disputed',
  adjustmentPending: 'stock.adjustment_pending',
  adjustmentDecided: 'stock.adjustment_decided',
  disputeLineResolved: 'stock.dispute_line_resolved',
  disputeResolved: 'stock.dispute_resolved',
  negative: 'stock.negative',
  containerCreated: 'stock.container_created',
  legacyClaimed: 'stock.legacy_claimed',
  legacyConfirmed: 'stock.legacy_confirmed',
  legacyReleased: 'stock.legacy_released',
  legacyExpired: 'stock.legacy_expired',
  profileUpdated: 'inventory.profile_updated',
  warehouseCreated: 'inventory.warehouse_created',
  warehouseUpdated: 'inventory.warehouse_updated',
  locationCreated: 'inventory.location_created',
  locationUpdated: 'inventory.location_updated',
} as const;

export const MOVEMENT_EVENT: Record<MovementKind, string> = {
  baseline: INVENTORY_EVENTS.baseline,
  receipt: INVENTORY_EVENTS.received,
  issue: INVENTORY_EVENTS.issued,
  transfer_in: INVENTORY_EVENTS.transferred,
  transfer_out: INVENTORY_EVENTS.transferred,
  adjust: INVENTORY_EVENTS.adjusted,
  consume: INVENTORY_EVENTS.consumed,
  produce: INVENTORY_EVENTS.produced,
  return: INVENTORY_EVENTS.returned,
  block: INVENTORY_EVENTS.blocked,
  unblock: INVENTORY_EVENTS.unblocked,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const INVENTORY_ERROR_HTTP_STATUS = {
  insufficient_stock: 409,
  stock_uncounted: 409,
  stock_disputed: 409,
  provisional_not_allowed: 409,
  provisional_verification_stale: 409,
  provisional_requires_human: 403,
  invalid_quantity: 422,
  invalid_unit: 422,
  invalid_variant: 422,
  duplicate: 409,
  module_disabled: 409,
  empty_count: 409,
  legacy_claim_expired: 409,
  negative_stock: 409,
  demand_over_reserved: 409,
} as const;

export type InventoryErrorCode = keyof typeof INVENTORY_ERROR_HTTP_STATUS;

/** HTTP status for an inventory rejection code (other codes: the core mapping, else 400). */
export function inventoryHttpStatus(code: string): number {
  return (INVENTORY_ERROR_HTTP_STATUS as Record<string, number>)[code] ?? 400;
}

/** OperationsError with the HTTP status of the inventory code. */
export function inventoryError(
  code: InventoryErrorCode,
  message: string,
  details?: Record<string, unknown>
): OperationsError {
  return new OperationsError(code, message, {
    httpStatus: INVENTORY_ERROR_HTTP_STATUS[code],
    details,
  });
}
