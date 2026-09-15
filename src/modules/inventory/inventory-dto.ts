import type {
  LegacyCommitmentClaim,
  ProductInventoryProfile,
  StockCount,
  StockCountLine,
  StockItem,
  StockMovement,
  StockReservation,
  StorageLocation,
  Warehouse,
} from '@prisma/client';
import {
  CONFIDENCE_LABELS,
  COUNT_LINE_RESOLUTION_LABELS,
  COUNT_SCOPE_LABELS,
  COUNT_STATUS_LABELS,
  LEGACY_CLAIM_SOURCE_LABELS,
  LEGACY_CLAIM_STATUS_LABELS,
  LOCATION_KIND_LABELS,
  MOVEMENT_KIND_LABELS,
  RESERVATION_STATUS_LABELS,
  TRACKING_POLICY_LABELS,
  toConfidenceLevel,
  type ConfidenceLevel,
} from './inventory-types';
import { dec, itemAvailable, parseConversions, roundQty, type DecimalLike } from './stock-math';
import { describeVariant } from './variant-key';

/**
 * JSON-safe DTOs of the inventory models for routes, server actions, tools
 * and the UI: quantities as decimal strings in base unit, dates as ISO
 * strings and Spanish labels next to every state. Pure mappers.
 */

/** Decimal → canonical string with the column scale ("10.5", "-2"). */
export function qty(value: DecimalLike | null | undefined): string {
  return roundQty(dec(value)).toString();
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function lookup<T extends string>(labels: Record<T, string>, value: string): string {
  return (labels as Record<string, string>)[value] ?? value;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface StockItemDTO {
  id: string;
  zohoItemId: string;
  warehouseId: string;
  locationId: string;
  locationCode: string | null;
  warehouseName: string | null;
  productName: string | null;
  sku: string | null;
  variantKey: string;
  variantLabel: string;
  containerKey: string;
  known: string;
  reserved: string;
  blocked: string;
  assignedToProduction: string;
  available: string;
  counters: {
    baseline: string;
    receipts: string;
    returns: string;
    produced: string;
    issued: string;
    consumed: string;
    adjustments: string;
  };
  lastCountedAt: string | null;
  originProductionOrderId: string | null;
  dimensions: Record<string, unknown> | null;
  version: number;
}

export function toStockItemDTO(
  item: StockItem,
  extra: {
    locationCode?: string | null;
    warehouseName?: string | null;
    productName?: string | null;
    sku?: string | null;
  } = {}
): StockItemDTO {
  return {
    id: item.id,
    zohoItemId: item.zohoItemId,
    warehouseId: item.warehouseId,
    locationId: item.locationId,
    locationCode: extra.locationCode ?? null,
    warehouseName: extra.warehouseName ?? null,
    productName: extra.productName ?? null,
    sku: extra.sku ?? null,
    variantKey: item.variantKey,
    variantLabel: describeVariant(item.variantKey, jsonRecord(item.variantJson)),
    containerKey: item.containerKey,
    known: qty(item.knownQty),
    reserved: qty(item.reserved),
    blocked: qty(item.blocked),
    assignedToProduction: qty(item.assignedToProduction),
    available: qty(itemAvailable(item)),
    counters: {
      baseline: qty(item.baseline),
      receipts: qty(item.receipts),
      returns: qty(item.returns),
      produced: qty(item.produced),
      issued: qty(item.issued),
      consumed: qty(item.consumed),
      adjustments: qty(item.adjustments),
    },
    lastCountedAt: iso(item.lastCountedAt),
    originProductionOrderId: item.originProductionOrderId,
    dimensions: jsonRecord(item.dimensions),
    version: item.version,
  };
}

export interface ProfileDTO {
  id: string;
  zohoItemId: string;
  baseUnit: string;
  conversions: Array<{ unit: string; factor: string; decimals?: number }>;
  tolerancePct: string;
  isBulk: boolean;
  trackingPolicy: string;
  trackingPolicyLabel: string;
  variantAxes: string[];
  defaultSource: string;
  confidence: ConfidenceLevel;
  confidenceLabel: string;
  consecutiveGoodCounts: number;
  lastCountAt: string | null;
  controlledAt: string | null;
  weightKgPerBaseUnit: string | null;
  areaM2PerBaseUnit: string | null;
  version: number;
}

export function toProfileDTO(profile: ProductInventoryProfile): ProfileDTO {
  const confidence = toConfidenceLevel(profile.confidence);
  return {
    id: profile.id,
    zohoItemId: profile.zohoItemId,
    baseUnit: profile.baseUnit,
    conversions: parseConversions(profile.conversions).map((c) => ({
      unit: c.unit,
      factor: String(c.factor),
      ...(c.decimals !== undefined ? { decimals: c.decimals } : {}),
    })),
    tolerancePct: dec(profile.tolerancePct).toString(),
    isBulk: profile.isBulk,
    trackingPolicy: profile.trackingPolicy,
    trackingPolicyLabel: lookup(TRACKING_POLICY_LABELS, profile.trackingPolicy),
    variantAxes: profile.variantAxes,
    defaultSource: profile.defaultSource,
    confidence,
    confidenceLabel: CONFIDENCE_LABELS[confidence],
    consecutiveGoodCounts: profile.consecutiveGoodCounts,
    lastCountAt: iso(profile.lastCountAt),
    controlledAt: iso(profile.controlledAt),
    weightKgPerBaseUnit: profile.weightKgPerBaseUnit ? qty(profile.weightKgPerBaseUnit) : null,
    areaM2PerBaseUnit: profile.areaM2PerBaseUnit ? qty(profile.areaM2PerBaseUnit) : null,
    version: profile.version,
  };
}

export interface MovementDTO {
  id: string;
  stockItemId: string;
  zohoItemId: string;
  warehouseId: string;
  kind: string;
  kindLabel: string;
  quantity: string;
  originalQuantity: string;
  originalUnit: string;
  referenceType: string | null;
  referenceId: string | null;
  commandId: string | null;
  actorId: string;
  note: string | null;
  occurredAt: string;
}

export function toMovementDTO(movement: StockMovement): MovementDTO {
  return {
    id: movement.id,
    stockItemId: movement.stockItemId,
    zohoItemId: movement.zohoItemId,
    warehouseId: movement.warehouseId,
    kind: movement.kind,
    kindLabel: lookup(MOVEMENT_KIND_LABELS, movement.kind),
    quantity: qty(movement.quantity),
    originalQuantity: qty(movement.originalQuantity),
    originalUnit: movement.originalUnit,
    referenceType: movement.referenceType,
    referenceId: movement.referenceId,
    commandId: movement.commandId,
    actorId: movement.actorId,
    note: movement.note,
    occurredAt: movement.occurredAt.toISOString(),
  };
}

export interface ReservationDTO {
  id: string;
  stockItemId: string;
  zohoItemId: string;
  warehouseId: string;
  caseId: string;
  demandId: string;
  allocationId: string | null;
  quantity: string;
  status: string;
  statusLabel: string;
  confidenceAtReserve: string;
  expiresAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  version: number;
}

export function toReservationDTO(reservation: StockReservation): ReservationDTO {
  return {
    id: reservation.id,
    stockItemId: reservation.stockItemId,
    zohoItemId: reservation.zohoItemId,
    warehouseId: reservation.warehouseId,
    caseId: reservation.caseId,
    demandId: reservation.demandId,
    allocationId: reservation.allocationId,
    quantity: qty(reservation.quantity),
    status: reservation.status,
    statusLabel: lookup(RESERVATION_STATUS_LABELS, reservation.status),
    confidenceAtReserve: reservation.confidenceAtReserve,
    expiresAt: iso(reservation.expiresAt),
    releasedAt: iso(reservation.releasedAt),
    createdAt: reservation.createdAt.toISOString(),
    version: reservation.version,
  };
}

export interface CountDTO {
  id: string;
  warehouseId: string;
  scope: string;
  scopeLabel: string;
  status: string;
  statusLabel: string;
  startedBy: string;
  closedAt: string | null;
  createdAt: string;
  version: number;
}

export function toCountDTO(count: StockCount): CountDTO {
  return {
    id: count.id,
    warehouseId: count.warehouseId,
    scope: count.scope,
    scopeLabel: lookup(COUNT_SCOPE_LABELS, count.scope),
    status: count.status,
    statusLabel: lookup(COUNT_STATUS_LABELS, count.status),
    startedBy: count.startedBy,
    closedAt: iso(count.closedAt),
    createdAt: count.createdAt.toISOString(),
    version: count.version,
  };
}

export interface CountLineDTO {
  id: string;
  countId: string;
  stockItemId: string;
  expectedQty: string;
  countedQty: string;
  unit: string;
  diffQty: string;
  withinTolerance: boolean;
  resolution: string;
  resolutionLabel: string;
  countedBy: string;
  countedAt: string;
}

export function toCountLineDTO(line: StockCountLine): CountLineDTO {
  return {
    id: line.id,
    countId: line.countId,
    stockItemId: line.stockItemId,
    expectedQty: qty(line.expectedQty),
    countedQty: qty(line.countedQty),
    unit: line.unit,
    diffQty: qty(line.diffQty),
    withinTolerance: line.withinTolerance,
    resolution: line.resolution,
    resolutionLabel: lookup(COUNT_LINE_RESOLUTION_LABELS, line.resolution),
    countedBy: line.countedBy,
    countedAt: line.countedAt.toISOString(),
  };
}

export interface LegacyClaimDTO {
  id: string;
  zohoItemId: string;
  warehouseId: string;
  variantKey: string;
  quantity: string;
  unit: string;
  source: string;
  sourceLabel: string;
  reference: string | null;
  caseId: string | null;
  status: string;
  statusLabel: string;
  claimedBy: string;
  expiresAt: string;
  resolvedAt: string | null;
  createdAt: string;
  version: number;
}

export function toLegacyClaimDTO(claim: LegacyCommitmentClaim): LegacyClaimDTO {
  return {
    id: claim.id,
    zohoItemId: claim.zohoItemId,
    warehouseId: claim.warehouseId,
    variantKey: claim.variantKey,
    quantity: qty(claim.quantity),
    unit: claim.unit,
    source: claim.source,
    sourceLabel: lookup(LEGACY_CLAIM_SOURCE_LABELS, claim.source),
    reference: claim.reference,
    caseId: claim.caseId,
    status: claim.status,
    statusLabel: lookup(LEGACY_CLAIM_STATUS_LABELS, claim.status),
    claimedBy: claim.claimedBy,
    expiresAt: claim.expiresAt.toISOString(),
    resolvedAt: iso(claim.resolvedAt),
    createdAt: claim.createdAt.toISOString(),
    version: claim.version,
  };
}

export interface WarehouseDTO {
  id: string;
  key: string;
  name: string;
  zohoLocationId: string | null;
  active: boolean;
}

export function toWarehouseDTO(warehouse: Warehouse): WarehouseDTO {
  return {
    id: warehouse.id,
    key: warehouse.key,
    name: warehouse.name,
    zohoLocationId: warehouse.zohoLocationId,
    active: warehouse.active,
  };
}

export interface LocationDTO {
  id: string;
  warehouseId: string;
  code: string;
  label: string | null;
  kind: string;
  kindLabel: string;
  active: boolean;
}

export function toLocationDTO(location: StorageLocation): LocationDTO {
  return {
    id: location.id,
    warehouseId: location.warehouseId,
    code: location.code,
    label: location.label,
    kind: location.kind,
    kindLabel: lookup(LOCATION_KIND_LABELS, location.kind),
    active: location.active,
  };
}
