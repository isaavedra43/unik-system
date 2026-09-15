import type {
  Bom,
  BomLine,
  BomOperation,
  MaterialConsumption,
  Prisma,
  ProductionOperation,
  ProductionOrder,
  ProductionOutput,
  QualityCheck,
  WorkCenter,
} from '@prisma/client';
import { qty } from '@/modules/inventory/inventory-dto';
import { dec } from '@/modules/inventory/stock-math';
import { parseStoredShifts, type ShiftDefinition } from './capacity-rules';
import {
  BOM_KIND_LABELS,
  BOM_STATUS_LABELS,
  CAPACITY_UNIT_LABELS,
  CONSUMPTION_KIND_LABELS,
  OPERATION_STATUS_LABELS,
  OUTPUT_KIND_LABELS,
  PRODUCTION_ORDER_KIND_LABELS,
  PRODUCTION_ORDER_STATUS_LABELS,
  QUALITY_RESULT_LABELS,
  RELEASE_TARGET_LABELS,
  WORK_CENTER_STATUS_LABELS,
} from './manufacturing-types';
import { parseTransformationInputs, type TransformationInput } from './production-state';

/**
 * JSON-safe DTOs of the manufacturing models for routes, server actions, tools
 * and the UI: quantities as decimal strings, dates as ISO strings and Spanish
 * labels next to every state. Pure mappers.
 */

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function labelOf(labels: Record<string, string>, key: string): string {
  return labels[key] ?? key;
}

function optionalQty(value: Prisma.Decimal | null | undefined): string | null {
  return value === null || value === undefined ? null : qty(value);
}

function record(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface WorkCenterDTO {
  id: string;
  key: string;
  name: string;
  warehouseId: string | null;
  capacityPerShift: string;
  capacityUnit: string;
  capacityUnitLabel: string;
  shifts: ShiftDefinition[];
  costPerHour: string | null;
  currency: string;
  status: string;
  statusLabel: string;
  createdAt: string;
  updatedAt: string;
}

export function toWorkCenterDTO(row: WorkCenter): WorkCenterDTO {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    warehouseId: row.warehouseId,
    capacityPerShift: qty(row.capacityPerShift),
    capacityUnit: row.capacityUnit,
    capacityUnitLabel: labelOf(CAPACITY_UNIT_LABELS, row.capacityUnit),
    shifts: parseStoredShifts(row.shifts),
    costPerHour: optionalQty(row.costPerHour),
    currency: row.currency,
    status: row.status,
    statusLabel: labelOf(WORK_CENTER_STATUS_LABELS, row.status),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface BomLineDTO {
  id: string;
  inputZohoItemId: string;
  qtyPerOutput: string;
  unit: string;
  substituteZohoItemIds: string[];
  scrapPct: string | null;
  sortOrder: number;
}

export interface BomOperationDTO {
  id: string;
  seq: number;
  workCenterId: string;
  name: string;
  stdMinutes: number;
  setupMinutes: number;
  qcRequired: boolean;
}

export interface BomDTO {
  id: string;
  outputZohoItemId: string;
  version: number;
  kind: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  outputQty: string;
  outputUnit: string;
  expectedYield: string | null;
  scrapAllowancePct: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  lines: BomLineDTO[];
  operations: BomOperationDTO[];
}

export function toBomLineDTO(line: BomLine): BomLineDTO {
  return {
    id: line.id,
    inputZohoItemId: line.inputZohoItemId,
    qtyPerOutput: dec(line.qtyPerOutput).toDecimalPlaces(6).toString(),
    unit: line.unit,
    substituteZohoItemIds: [...line.substituteZohoItemIds],
    scrapPct: line.scrapPct === null ? null : dec(line.scrapPct).toDecimalPlaces(3).toString(),
    sortOrder: line.sortOrder,
  };
}

export function toBomOperationDTO(op: BomOperation): BomOperationDTO {
  return {
    id: op.id,
    seq: op.seq,
    workCenterId: op.workCenterId,
    name: op.name,
    stdMinutes: op.stdMinutes,
    setupMinutes: op.setupMinutes,
    qcRequired: op.qcRequired,
  };
}

export function toBomDTO(row: Bom & { lines?: BomLine[]; operations?: BomOperation[] }): BomDTO {
  return {
    id: row.id,
    outputZohoItemId: row.outputZohoItemId,
    version: row.version,
    kind: row.kind,
    kindLabel: labelOf(BOM_KIND_LABELS, row.kind),
    status: row.status,
    statusLabel: labelOf(BOM_STATUS_LABELS, row.status),
    outputQty: qty(row.outputQty),
    outputUnit: row.outputUnit,
    expectedYield:
      row.expectedYield === null ? null : dec(row.expectedYield).toDecimalPlaces(4).toString(),
    scrapAllowancePct:
      row.scrapAllowancePct === null ? null : dec(row.scrapAllowancePct).toDecimalPlaces(3).toString(),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lines: [...(row.lines ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map(toBomLineDTO),
    operations: [...(row.operations ?? [])]
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
      .map(toBomOperationDTO),
  };
}

export interface ProductionOrderDTO {
  id: string;
  number: string;
  kind: string;
  kindLabel: string;
  bomId: string | null;
  caseId: string | null;
  demandId: string | null;
  demandAllocationId: string | null;
  outputZohoItemId: string;
  outputName: string | null;
  plannedQty: string;
  plannedUnit: string;
  producedQty: string;
  scrapQty: string;
  leftoverQty: string;
  status: string;
  statusLabel: string;
  priority: string;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  workCenterId: string | null;
  releaseTarget: string;
  releaseTargetLabel: string;
  outputWarehouseId: string;
  outputLocationId: string | null;
  blockedReason: string | null;
  inputs: TransformationInput[];
  createdByUserId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toProductionOrderDTO(row: ProductionOrder): ProductionOrderDTO {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    kindLabel: labelOf(PRODUCTION_ORDER_KIND_LABELS, row.kind),
    bomId: row.bomId,
    caseId: row.caseId,
    demandId: row.demandId,
    demandAllocationId: row.demandAllocationId,
    outputZohoItemId: row.outputZohoItemId,
    outputName: row.outputName,
    plannedQty: qty(row.plannedQty),
    plannedUnit: row.plannedUnit,
    producedQty: qty(row.producedQty),
    scrapQty: qty(row.scrapQty),
    leftoverQty: qty(row.leftoverQty),
    status: row.status,
    statusLabel: labelOf(PRODUCTION_ORDER_STATUS_LABELS, row.status),
    priority: row.priority,
    plannedStartAt: iso(row.plannedStartAt),
    plannedEndAt: iso(row.plannedEndAt),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    workCenterId: row.workCenterId,
    releaseTarget: row.releaseTarget,
    releaseTargetLabel: labelOf(RELEASE_TARGET_LABELS, row.releaseTarget),
    outputWarehouseId: row.outputWarehouseId,
    outputLocationId: row.outputLocationId,
    blockedReason: row.blockedReason,
    inputs: parseTransformationInputs(row.inputs),
    createdByUserId: row.createdByUserId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ProductionOperationDTO {
  id: string;
  productionOrderId: string;
  seq: number;
  workCenterId: string;
  name: string;
  status: string;
  statusLabel: string;
  assignedUserId: string | null;
  plannedStartAt: string | null;
  plannedMinutes: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  actualMinutes: number | null;
}

export function toOperationDTO(row: ProductionOperation): ProductionOperationDTO {
  return {
    id: row.id,
    productionOrderId: row.productionOrderId,
    seq: row.seq,
    workCenterId: row.workCenterId,
    name: row.name,
    status: row.status,
    statusLabel: labelOf(OPERATION_STATUS_LABELS, row.status),
    assignedUserId: row.assignedUserId,
    plannedStartAt: iso(row.plannedStartAt),
    plannedMinutes: row.plannedMinutes,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    actualMinutes: row.actualMinutes,
  };
}

export interface MaterialConsumptionDTO {
  id: string;
  productionOrderId: string;
  operationId: string | null;
  inputZohoItemId: string;
  stockItemId: string | null;
  reservationId: string | null;
  qtyPlanned: string;
  qtyActual: string;
  unit: string;
  kind: string;
  kindLabel: string;
  substitutedForZohoItemId: string | null;
  stockMovementId: string | null;
  approvalRequestId: string | null;
  /** A real movement was posted (always false for assignment rows). */
  posted: boolean;
  recordedByUserId: string;
  createdAt: string;
}

export function toConsumptionDTO(row: MaterialConsumption): MaterialConsumptionDTO {
  return {
    id: row.id,
    productionOrderId: row.productionOrderId,
    operationId: row.operationId,
    inputZohoItemId: row.inputZohoItemId,
    stockItemId: row.stockItemId,
    reservationId: row.reservationId,
    qtyPlanned: qty(row.qtyPlanned),
    qtyActual: qty(row.qtyActual),
    unit: row.unit,
    kind: row.kind,
    kindLabel: labelOf(CONSUMPTION_KIND_LABELS, row.kind),
    substitutedForZohoItemId: row.substitutedForZohoItemId,
    stockMovementId: row.stockMovementId,
    approvalRequestId: row.approvalRequestId,
    posted: row.kind !== 'planned' && Boolean(row.stockMovementId),
    recordedByUserId: row.recordedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ProductionOutputDTO {
  id: string;
  productionOrderId: string;
  kind: string;
  kindLabel: string;
  zohoItemId: string;
  qty: string;
  unit: string;
  dimensions: Record<string, unknown> | null;
  stockMovementId: string | null;
  stockItemId: string | null;
  locationId: string | null;
  qualityCheckId: string | null;
  recordedByUserId: string;
  createdAt: string;
}

export function toOutputDTO(row: ProductionOutput): ProductionOutputDTO {
  return {
    id: row.id,
    productionOrderId: row.productionOrderId,
    kind: row.kind,
    kindLabel: labelOf(OUTPUT_KIND_LABELS, row.kind),
    zohoItemId: row.zohoItemId,
    qty: qty(row.qty),
    unit: row.unit,
    dimensions: record(row.dimensions),
    stockMovementId: row.stockMovementId,
    stockItemId: row.stockItemId,
    locationId: row.locationId,
    qualityCheckId: row.qualityCheckId,
    recordedByUserId: row.recordedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface QualityChecklistEntry {
  item: string;
  ok: boolean;
  note: string | null;
}

export interface QualityCheckDTO {
  id: string;
  productionOrderId: string;
  operationId: string | null;
  result: string;
  resultLabel: string;
  checklist: QualityChecklistEntry[];
  notes: string | null;
  evidenceObjectIds: string[];
  inspectedByUserId: string;
  inspectedAt: string;
}

export function parseChecklist(value: Prisma.JsonValue | null | undefined): QualityChecklistEntry[] {
  if (!Array.isArray(value)) return [];
  const out: QualityChecklistEntry[] = [];
  for (const entry of value) {
    const row = record(entry as Prisma.JsonValue);
    if (!row || typeof row.item !== 'string') continue;
    out.push({
      item: row.item,
      ok: row.ok === true,
      note: typeof row.note === 'string' ? row.note : null,
    });
  }
  return out;
}

export function toQualityCheckDTO(row: QualityCheck): QualityCheckDTO {
  return {
    id: row.id,
    productionOrderId: row.productionOrderId,
    operationId: row.operationId,
    result: row.result,
    resultLabel: labelOf(QUALITY_RESULT_LABELS, row.result),
    checklist: parseChecklist(row.checklist),
    notes: row.notes,
    evidenceObjectIds: [...row.evidenceObjectIds],
    inspectedByUserId: row.inspectedByUserId,
    inspectedAt: row.inspectedAt.toISOString(),
  };
}
