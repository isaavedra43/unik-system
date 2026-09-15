import { Prisma, type AreaRequest, type ProductionOrder, type WorkCenter } from '@prisma/client';
import { z } from 'zod';
import { inventoryError } from '@/modules/inventory/inventory-types';
import { reserveStock } from '@/modules/inventory/inventory-service';
import { resolveWarehouseForZohoLocation } from '@/modules/inventory/warehouses-service';
import { transitionAreaRequestInTx } from '@/modules/operations/area-requests-service';
import { requireCommandContext, type CommandContext } from '@/modules/operations/commands';
import { OperationsError, isOperationsError } from '@/modules/operations/errors';
import { toOperationalJson } from '@/modules/operations/events-service';
import { AREA_REQUEST_PAYLOAD_SCHEMAS } from '@/modules/operations/request-kinds';
import { nextNumber } from '@/modules/operations/sequence-service';
import { AREA_REQUEST_OPEN_STATUSES, OPS_EVENTS, PRIORITIES } from '@/modules/operations/types';
import { getActiveBom, loadBomWithRouting } from './bom-service';
import {
  capacityLoad,
  parseStoredShifts,
  perOrderLoads,
  planSlot,
  plannedOperationMinutes,
  type ShiftLoad,
} from './capacity-rules';
import {
  addDays,
  assertActiveWarehouse,
  closeWorkItems,
  convertToBase,
  dayKey,
  itemLabel,
  loadOperations,
  loadWorkCenter,
  num,
  openWorkItemsFor,
  orderEventOptions,
  orderRef,
  productInfo,
  publishOrderChange,
  qtyText,
  resolveDemandLink,
  resolveItemRef,
  truncate,
  unitFactor,
  unitsResolver,
  type Db,
  type DemandLink,
  type ProductInfo,
} from './manufacturing-helpers';
import {
  CAPACITY_UNIT_LABELS,
  DEFAULT_BOM_OPERATION,
  DEFAULT_OPERATION_MINUTES,
  DEFAULT_TRANSFORMATION_OPERATION,
  MANUFACTURING_AREA_KEY,
  MANUFACTURING_EVENTS,
  MANUFACTURING_FLOOR_CHANNEL,
  MANUFACTURING_OBJECT_TYPES,
  MANUFACTURING_REALTIME_TYPES,
  RELEASE_TARGETS,
  SCHEDULING_HORIZON_DAYS,
  manufacturingError,
  type CapacityUnit,
} from './manufacturing-types';
import {
  computeRequirements,
  loadProductionFacts,
  loadRecipe,
  releaseFactsOf,
} from './production-facts';
import {
  ASSIGNMENT_REASON_LABELS,
  assignMaterials,
  heldQuantity,
  materialWarehouses,
  moveAssignmentsToWarehouse,
  releaseAssignments,
  type AssignmentLineOutcome,
} from './production-materials';
import { evaluateRelease, orderActionError, type ReleaseBlocker } from './production-state';
import { requestScrapApprovalInTx } from './production-floor-service';

/**
 * Production orders (OP-): creation, scheduling against the capacity of the
 * work centers, material reservation, preparation, release and cancellation
 * (plan 6.2). The shop-floor part (operations, consumption, inspection,
 * outputs) lives in `production-floor-service.ts`.
 *
 * - `createTransformationOrderInTx`: the default order. Input material → output
 *   product + scrap with an implicit BOM kept in `inputs` and one "Corte/acabado"
 *   operation. The output warehouse is mandatory: the given one, the warehouse of
 *   the allocation or demand, or the default inventory warehouse.
 * - `createProductionOrderFromBomInTx`: repeatable products with an active BOM.
 * - `intakeTransformationRequestInTx`: an AreaRequest `transformation` (step
 *   `ordenar_produccion` of the case engine, or another area) becomes an order
 *   linked to the demand/allocation; the request is accepted and later resolved
 *   by the release.
 * - `reserveMaterialsInTx`: commits the inputs; a shortage blocks the order and
 *   asks Compras (`material_shortfall`), uncounted stock asks Inventario for a
 *   count. A later reservation unblocks it and withdraws those asks.
 * - `prepareInTx`: pick list to Inventario and transfer to the center's warehouse.
 * - `releaseInTx`: gates (quality, output, substitutions, scrap approval, material
 *   balance), gives back the unused assignment, reserves the finished goods for
 *   the demand (allocation `ready`), plans the delivery for `logistics`, resolves
 *   the request and emits `production.finished` (case advance).
 */

const idText = z.string().trim().min(1).max(120);
const positiveQty = z
  .number()
  .finite()
  .positive('La cantidad debe ser mayor que cero')
  .max(1_000_000_000);
const unitText = z.string().trim().min(1).max(40);
const instantText = z
  .string()
  .trim()
  .min(10)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Fecha inválida (usa formato ISO)');

export const transformationInputSchema = z.object({
  zohoItemId: idText,
  qty: positiveQty,
  unit: unitText.optional(),
  substituteZohoItemIds: z.array(idText).max(10).optional(),
  variantKey: z.string().trim().max(200).optional(),
});

const linkFields = {
  caseId: idText.nullish(),
  demandId: idText.nullish(),
  demandAllocationId: idText.nullish(),
};

const planningFields = {
  workCenterId: idText.nullish(),
  plannedStartAt: instantText.nullish(),
  priority: z.enum(PRIORITIES).optional(),
  releaseTarget: z.enum(RELEASE_TARGETS).optional(),
  outputWarehouseId: idText.nullish(),
  outputLocationId: idText.nullish(),
  /** Commit the materials right away (a shortage blocks the order). */
  reserveNow: z.boolean().optional(),
};

export const createTransformationOrderSchema = z.object({
  outputZohoItemId: idText.optional(),
  outputName: z.string().trim().max(300).nullish(),
  plannedQty: positiveQty.optional(),
  plannedUnit: unitText.optional(),
  inputs: z.array(transformationInputSchema).min(1, 'Indica el material de entrada').max(20),
  /** Explicit confirmation that the input is the output item itself (a cut to size of the same article). */
  allowSameItem: z.boolean().optional(),
  scrapAllowancePct: z.number().finite().min(0).max(100).optional(),
  operationName: z.string().trim().min(1).max(120).optional(),
  plannedMinutes: z.number().int().min(0).max(100_000).nullish(),
  ...linkFields,
  ...planningFields,
});
export type CreateTransformationOrderInput = z.input<typeof createTransformationOrderSchema>;

export const createOrderFromBomSchema = z
  .object({
    bomId: idText.optional(),
    outputZohoItemId: idText.optional(),
    plannedQty: positiveQty,
    plannedUnit: unitText.optional(),
    ...linkFields,
    ...planningFields,
  })
  .refine((value) => Boolean(value.bomId || value.outputZohoItemId), {
    message: 'Indica la lista de materiales o el producto',
    path: ['bomId'],
  });
export type CreateOrderFromBomInput = z.input<typeof createOrderFromBomSchema>;

export const intakeRequestSchema = z.object({ requestId: idText });

export const scheduleOrderSchema = z.object({
  productionOrderId: idText,
  workCenterId: idText.nullish(),
  plannedStartAt: instantText.nullish(),
});
export type ScheduleOrderInput = z.input<typeof scheduleOrderSchema>;

export const reserveMaterialsSchema = z.object({
  productionOrderId: idText,
  /** Explicit human decision to commit PROVISIONAL stock. */
  allowProvisional: z.boolean().optional(),
});
export type ReserveMaterialsInput = z.input<typeof reserveMaterialsSchema>;

export const prepareOrderSchema = z.object({ productionOrderId: idText });
export type PrepareOrderInput = z.input<typeof prepareOrderSchema>;

export const releaseOrderSchema = z.object({
  productionOrderId: idText,
  /** Release although the material balance does not close (`manufacturing.approve_incidents`). */
  acceptBalanceDifference: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});
export type ReleaseOrderInput = z.input<typeof releaseOrderSchema>;

export const cancelOrderSchema = z.object({
  productionOrderId: idText,
  reason: z.string().trim().min(1, 'Indica el motivo').max(500),
});
export type CancelOrderInput = z.input<typeof cancelOrderSchema>;

// ---------------------------------------------------------------------------
// Result DTOs
// ---------------------------------------------------------------------------

export interface MaterialLineResult {
  zohoItemId: string;
  label: string;
  baseUnit: string;
  required: string;
  assigned: string;
  missing: string;
  reason: string;
}

export interface ScheduleResult {
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  overloaded: boolean;
  alertWorkItemIds: string[];
}

export interface ReserveMaterialsResult {
  productionOrderId: string;
  status: string;
  complete: boolean;
  lines: MaterialLineResult[];
  requestIds: string[];
  workItemIds: string[];
}

export interface CreateOrderResult {
  productionOrderId: string;
  number: string;
  kind: string;
  status: string;
  workCenterId: string | null;
  outputWarehouseId: string;
  schedule: ScheduleResult | null;
  materials: ReserveMaterialsResult | null;
}

export interface IntakeResult {
  outcome: 'created' | 'existing' | 'skipped' | 'request_blocked';
  requestId: string;
  productionOrderId: string | null;
  reason: string | null;
}

export interface PrepareResult {
  productionOrderId: string;
  status: string;
  workItemId: string;
  transfers: number;
}

export interface ReleaseResult {
  productionOrderId: string;
  released: boolean;
  status: string;
  blockers: ReleaseBlocker[];
  scrapApprovalRequestId: string | null;
  reservationId: string | null;
  deliveryOrderId: string | null;
  finishedGoodsRequestId: string | null;
  materialsReleased: number;
}

export interface CancelResult {
  productionOrderId: string;
  status: string;
  materialsReleased: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLOSED_ORDER_STATUSES = ['cancelled'];

async function assertNoOrderForAllocation(tx: Db, allocationId: string): Promise<void> {
  const existing = await tx.productionOrder.findFirst({
    where: { demandAllocationId: allocationId, status: { notIn: CLOSED_ORDER_STATUSES } },
    select: { id: true, number: true },
  });
  if (existing) {
    throw new OperationsError('duplicate', `La asignación ya tiene la orden ${existing.number}`, {
      details: { productionOrderId: existing.id },
    });
  }
}

async function resolveOutputWarehouse(
  tx: Db,
  explicit: string | null | undefined,
  link: DemandLink
): Promise<string> {
  if (explicit) {
    await assertActiveWarehouse(tx, explicit);
    return explicit;
  }
  if (link.allocation?.warehouseId) return link.allocation.warehouseId;
  const warehouse = await resolveWarehouseForZohoLocation(
    tx,
    link.demand?.locationId ?? link.opCase?.locationId ?? null
  );
  return warehouse.id;
}

async function assertOutputLocation(tx: Db, warehouseId: string, locationId: string | null | undefined): Promise<string | null> {
  if (!locationId) return null;
  const location = await tx.storageLocation.findUnique({ where: { id: locationId } });
  if (!location || location.warehouseId !== warehouseId) {
    throw new OperationsError('invalid_payload', 'La ubicación de salida no pertenece a la bodega');
  }
  if (!location.active) throw new OperationsError('invalid_state', `La ubicación ${location.code} está desactivada`);
  return location.id;
}

async function defaultWorkCenter(tx: Db): Promise<WorkCenter | null> {
  return tx.workCenter.findFirst({ where: { status: 'active' }, orderBy: [{ key: 'asc' }, { id: 'asc' }] });
}

interface NewOrderSpec {
  kind: 'transformation' | 'bom';
  bomId: string | null;
  link: DemandLink;
  outputZohoItemId: string;
  outputName: string | null;
  plannedQty: number;
  plannedUnit: string;
  priority: string;
  releaseTarget: string;
  outputWarehouseId: string;
  outputLocationId: string | null;
  workCenterId: string | null;
  inputs: Array<Record<string, unknown>> | null;
  operations: Array<{ seq: number; workCenterId: string; name: string; plannedMinutes: number | null }>;
  plannedStartAt: Date | null;
  areaRequestId: string | null;
  /**
   * Link the demand allocation to the order now (the order is committed: materials reserved right
   * away). A draft only records the allocation it is for; the case's allocation is linked when the
   * order is scheduled or its materials reserved, so a draft never advances the case.
   */
  commitAllocation: boolean;
}

/**
 * Links the manufacture allocation of an order (planned → requested) unless a
 * `transformation` request already tracks it. Idempotent.
 */
export async function commitAllocationLinkInTx(tx: Db, ctx: CommandContext, order: ProductionOrder): Promise<void> {
  if (!order.demandAllocationId) return;
  const allocation = await tx.demandAllocation.findUnique({ where: { id: order.demandAllocationId } });
  if (!allocation || ['cancelled', 'delivered', 'released'].includes(allocation.status)) return;
  if (allocation.linkedType === 'area_request' && allocation.linkedId) return;
  if (allocation.linkedType === MANUFACTURING_OBJECT_TYPES.productionOrder && allocation.linkedId === order.id) return;
  const updated = await tx.demandAllocation.update({
    where: { id: allocation.id },
    data: {
      linkedType: MANUFACTURING_OBJECT_TYPES.productionOrder,
      linkedId: order.id,
      ...(allocation.status === 'planned' ? { status: 'requested' } : {}),
      version: { increment: 1 },
    },
  });
  if (allocation.status === 'planned') {
    ctx.emit(
      OPS_EVENTS.allocation.requested,
      { allocationId: updated.id, demandId: updated.demandId, source: 'manufacture', status: updated.status, productionOrderId: order.id },
      { caseId: updated.caseId, areaKey: MANUFACTURING_AREA_KEY, objectType: 'demand_allocation', objectId: updated.id }
    );
  }
}

async function insertOrder(tx: Db, ctx: CommandContext, spec: NewOrderSpec): Promise<ProductionOrder> {
  const number = await nextNumber(tx, 'production_order', 'OP');
  const order = await tx.productionOrder.create({
    data: {
      number,
      kind: spec.kind,
      bomId: spec.bomId,
      caseId: spec.link.opCase?.id ?? null,
      demandId: spec.link.demand?.id ?? null,
      demandAllocationId: spec.link.allocation?.id ?? null,
      outputZohoItemId: spec.outputZohoItemId,
      outputName: spec.outputName,
      plannedQty: new Prisma.Decimal(spec.plannedQty),
      plannedUnit: spec.plannedUnit,
      status: 'draft',
      priority: spec.priority,
      plannedStartAt: spec.plannedStartAt,
      workCenterId: spec.workCenterId,
      releaseTarget: spec.releaseTarget,
      outputWarehouseId: spec.outputWarehouseId,
      outputLocationId: spec.outputLocationId,
      ...(spec.inputs ? { inputs: toOperationalJson(spec.inputs) } : {}),
      createdByUserId: ctx.actor.id,
    },
  });
  if (spec.operations.length > 0) {
    await tx.productionOperation.createMany({
      data: spec.operations.map((op) => ({
        productionOrderId: order.id,
        seq: op.seq,
        workCenterId: op.workCenterId,
        name: op.name,
        status: 'pending',
        plannedMinutes: op.plannedMinutes,
      })),
    });
  }
  const { opCase, demand, allocation } = spec.link;
  if (opCase) await ctx.relate(orderRef(order.id), { type: 'operational_case', id: opCase.id }, 'for_case');
  if (demand) await ctx.relate(orderRef(order.id), { type: 'case_demand', id: demand.id }, 'produces_for');
  if (allocation) {
    await ctx.relate(orderRef(order.id), { type: 'demand_allocation', id: allocation.id }, 'fulfills');
    if (spec.commitAllocation) await commitAllocationLinkInTx(tx, ctx, order);
  }
  if (spec.areaRequestId) {
    await ctx.relate(orderRef(order.id), { type: 'area_request', id: spec.areaRequestId }, 'answers');
  }
  ctx.emit(
    MANUFACTURING_EVENTS.orderCreated,
    {
      productionOrderId: order.id,
      number: order.number,
      kind: order.kind,
      bomId: order.bomId,
      outputZohoItemId: order.outputZohoItemId,
      plannedQty: qtyText(order.plannedQty),
      plannedUnit: order.plannedUnit,
      demandId: order.demandId,
      allocationId: order.demandAllocationId,
      areaRequestId: spec.areaRequestId,
      workCenterId: order.workCenterId,
      outputWarehouseId: order.outputWarehouseId,
    },
    orderEventOptions(order)
  );
  publishOrderChange(ctx, order);
  return order;
}

function lineResults(outcomes: AssignmentLineOutcome[], products: Map<string, ProductInfo>): MaterialLineResult[] {
  return outcomes.map((line) => ({
    zohoItemId: line.zohoItemId,
    label: itemLabel(products, line.zohoItemId),
    baseUnit: line.baseUnit,
    required: qtyText(line.required),
    assigned: qtyText(line.assignedBefore + line.assignedNow),
    missing: qtyText(line.missing),
    reason: line.reason,
  }));
}

async function finishCreation(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  options: { reserveNow: boolean; plannedStartAt: Date | null }
): Promise<CreateOrderResult> {
  let schedule: ScheduleResult | null = null;
  if (order.workCenterId) {
    schedule = await scheduleOrderInTx(tx, ctx, order, { plannedStartAt: options.plannedStartAt, commitLink: options.reserveNow });
  }
  let materials: ReserveMaterialsResult | null = null;
  if (options.reserveNow) {
    materials = await reserveMaterialsInTx(tx, ctx, await loadOrderRow(tx, order.id), { allowProvisional: false });
  }
  const final = await loadOrderRow(tx, order.id);
  return {
    productionOrderId: final.id,
    number: final.number,
    kind: final.kind,
    status: final.status,
    workCenterId: final.workCenterId,
    outputWarehouseId: final.outputWarehouseId,
    schedule,
    materials,
  };
}

async function loadOrderRow(tx: Db, id: string): Promise<ProductionOrder> {
  const order = await tx.productionOrder.findUnique({ where: { id } });
  if (!order) throw new OperationsError('not_found', 'No se encontró la orden de producción');
  return order;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export async function createTransformationOrderInTx(
  tx: Db,
  input: z.output<typeof createTransformationOrderSchema>,
  options: { areaRequestId?: string | null } = {}
): Promise<CreateOrderResult> {
  const ctx = requireCommandContext(tx);
  const units = unitsResolver(tx, 'write');
  const link = await resolveDemandLink(tx, input);
  if (link.allocation) await assertNoOrderForAllocation(tx, link.allocation.id);
  const outputZohoItemId = input.outputZohoItemId ?? link.demand?.zohoItemId ?? null;
  if (!outputZohoItemId) {
    throw new OperationsError('invalid_payload', 'Indica el producto de salida');
  }
  if (input.inputs.some((entry) => entry.zohoItemId === outputZohoItemId) && input.allowSameItem !== true) {
    // Committing the finished product as its own raw material would ask Compras to buy what should be made.
    throw new OperationsError(
      'invalid_payload',
      'El material de entrada no puede ser el mismo producto de salida; si es un corte a medida del mismo artículo, confírmalo expresamente'
    );
  }
  if (link.demand?.zohoItemId && link.demand.zohoItemId !== outputZohoItemId) {
    throw new OperationsError('invalid_payload', 'La partida del expediente es de otro artículo');
  }
  const output = await units(outputZohoItemId);
  const plannedUnit = input.plannedUnit ?? link.demand?.baseUnit ?? output.baseUnit;
  const plannedQty = input.plannedQty ?? (link.allocation ? num(link.allocation.quantity) : null);
  if (plannedQty === null || plannedQty <= 0) {
    throw new OperationsError('invalid_payload', 'Indica la cantidad a producir');
  }
  convertToBase(plannedQty, plannedUnit, output);

  const seen = new Set<string>();
  const inputs: Array<Record<string, unknown>> = [];
  for (const entry of input.inputs) {
    if (seen.has(entry.zohoItemId)) {
      throw new OperationsError('invalid_payload', `El material ${entry.zohoItemId} está repetido`);
    }
    seen.add(entry.zohoItemId);
    const item = await units(entry.zohoItemId);
    const unit = entry.unit ?? item.baseUnit;
    convertToBase(entry.qty, unit, item);
    const substitutes = [...new Set(entry.substituteZohoItemIds ?? [])].filter(
      (id) => id !== entry.zohoItemId
    );
    inputs.push({
      zohoItemId: entry.zohoItemId,
      qty: entry.qty,
      unit,
      substituteZohoItemIds: substitutes,
      ...(entry.variantKey ? { variantKey: entry.variantKey } : {}),
      ...(input.scrapAllowancePct !== undefined ? { scrapAllowancePct: input.scrapAllowancePct } : {}),
    });
  }

  const outputWarehouseId = await resolveOutputWarehouse(tx, input.outputWarehouseId, link);
  const outputLocationId = await assertOutputLocation(tx, outputWarehouseId, input.outputLocationId);
  const workCenter = input.workCenterId
    ? await loadWorkCenter(tx, input.workCenterId, { requireActive: true })
    : await defaultWorkCenter(tx);
  const products = await productInfo(tx, [outputZohoItemId]);
  const plannedStartAt = input.plannedStartAt ? new Date(input.plannedStartAt) : null;

  const order = await insertOrder(tx, ctx, {
    kind: 'transformation',
    bomId: null,
    link,
    outputZohoItemId,
    outputName: truncate(input.outputName ?? link.demand?.name ?? products.get(outputZohoItemId)?.name ?? null, 300),
    plannedQty,
    plannedUnit,
    priority: input.priority ?? link.opCase?.priority ?? 'normal',
    releaseTarget: input.releaseTarget ?? 'inventory',
    outputWarehouseId,
    outputLocationId,
    workCenterId: workCenter?.id ?? null,
    inputs,
    operations: workCenter
      ? [
          {
            seq: 1,
            workCenterId: workCenter.id,
            name: input.operationName ?? DEFAULT_TRANSFORMATION_OPERATION,
            plannedMinutes: input.plannedMinutes ?? null,
          },
        ]
      : [],
    plannedStartAt,
    areaRequestId: options.areaRequestId ?? null,
    commitAllocation: input.reserveNow === true,
  });
  return finishCreation(tx, ctx, order, { reserveNow: input.reserveNow === true, plannedStartAt });
}

export async function createProductionOrderFromBomInTx(
  tx: Db,
  input: z.output<typeof createOrderFromBomSchema>,
  options: { areaRequestId?: string | null } = {}
): Promise<CreateOrderResult> {
  const ctx = requireCommandContext(tx);
  const units = unitsResolver(tx, 'write');
  const bom = input.bomId
    ? await loadBomWithRouting(tx, input.bomId)
    : await getActiveBom(tx, input.outputZohoItemId as string);
  if (!bom) {
    throw manufacturingError('bom_invalid', 'El producto no tiene una lista de materiales activa');
  }
  if (bom.status !== 'active') {
    throw new OperationsError('invalid_state', 'La lista de materiales no está activa');
  }
  if (input.outputZohoItemId && input.outputZohoItemId !== bom.outputZohoItemId) {
    throw new OperationsError('invalid_payload', 'La lista de materiales es de otro producto');
  }
  const link = await resolveDemandLink(tx, input);
  if (link.allocation) await assertNoOrderForAllocation(tx, link.allocation.id);
  if (link.demand?.zohoItemId && link.demand.zohoItemId !== bom.outputZohoItemId) {
    throw new OperationsError('invalid_payload', 'La partida del expediente es de otro artículo');
  }
  const output = await units(bom.outputZohoItemId);
  const plannedUnit = input.plannedUnit ?? bom.outputUnit;
  const plannedBase = convertToBase(input.plannedQty, plannedUnit, output);
  const plannedInBomUnit = num(plannedBase.dividedBy(unitFactor(bom.outputUnit, output)));
  const outputWarehouseId = await resolveOutputWarehouse(tx, input.outputWarehouseId, link);
  const outputLocationId = await assertOutputLocation(tx, outputWarehouseId, input.outputLocationId);

  let operations = [...bom.operations]
    .sort((a, b) => a.seq - b.seq)
    .map((op) => ({
      seq: op.seq,
      workCenterId: op.workCenterId,
      name: op.name,
      plannedMinutes: plannedOperationMinutes(op.stdMinutes, op.setupMinutes, plannedInBomUnit, num(bom.outputQty)),
    }));
  if (input.workCenterId && operations.length > 0) {
    await loadWorkCenter(tx, input.workCenterId, { requireActive: true });
  }
  if (operations.length === 0) {
    const center = input.workCenterId
      ? await loadWorkCenter(tx, input.workCenterId, { requireActive: true })
      : await defaultWorkCenter(tx);
    operations = center ? [{ seq: 1, workCenterId: center.id, name: DEFAULT_BOM_OPERATION, plannedMinutes: 0 }] : [];
  }
  const products = await productInfo(tx, [bom.outputZohoItemId]);
  const plannedStartAt = input.plannedStartAt ? new Date(input.plannedStartAt) : null;
  const order = await insertOrder(tx, ctx, {
    kind: 'bom',
    bomId: bom.id,
    link,
    outputZohoItemId: bom.outputZohoItemId,
    outputName: truncate(link.demand?.name ?? products.get(bom.outputZohoItemId)?.name ?? null, 300),
    plannedQty: input.plannedQty,
    plannedUnit,
    priority: input.priority ?? link.opCase?.priority ?? 'normal',
    releaseTarget: input.releaseTarget ?? 'inventory',
    outputWarehouseId,
    outputLocationId,
    workCenterId: operations[0]?.workCenterId ?? null,
    inputs: null,
    operations,
    plannedStartAt,
    areaRequestId: options.areaRequestId ?? null,
    commitAllocation: input.reserveNow === true,
  });
  return finishCreation(tx, ctx, order, { reserveNow: input.reserveNow === true, plannedStartAt });
}

/**
 * A `transformation` request for Manufactura becomes a production order linked
 * to the case, demand and allocation it names (idempotent per request). A
 * request that cannot be turned into an order (unknown item, unit without
 * conversion, closed case) is blocked with the reason instead.
 */
export async function intakeTransformationRequestInTx(
  tx: Db,
  requestId: string
): Promise<IntakeResult> {
  const request = await tx.areaRequest.findUnique({ where: { id: requestId } });
  const result = (outcome: IntakeResult['outcome'], productionOrderId: string | null, reason: string | null): IntakeResult => ({
    outcome,
    requestId,
    productionOrderId,
    reason,
  });
  if (!request) return result('skipped', null, 'La solicitud no existe');
  if (request.kind !== 'transformation' || request.toAreaKey !== MANUFACTURING_AREA_KEY) {
    return result('skipped', null, 'La solicitud no es una transformación para Manufactura');
  }
  if (!(AREA_REQUEST_OPEN_STATUSES as readonly string[]).includes(request.status)) {
    return result('skipped', null, 'La solicitud ya está cerrada');
  }
  const answered = await tx.objectRelation.findFirst({
    where: { fromType: MANUFACTURING_OBJECT_TYPES.productionOrder, toType: 'area_request', toId: request.id, relation: 'answers', validTo: null },
    select: { fromId: true },
  });
  if (answered) {
    const order = await tx.productionOrder.findUnique({ where: { id: answered.fromId }, select: { id: true, status: true } });
    if (order && order.status !== 'cancelled') return result('existing', order.id, null);
  }
  const block = async (reason: string): Promise<IntakeResult> => {
    await transitionAreaRequestInTx(tx, request, 'block', { reason });
    return result('request_blocked', null, reason);
  };
  const parsed = AREA_REQUEST_PAYLOAD_SCHEMAS.transformation.safeParse(request.payload);
  if (!parsed.success) return block('La solicitud de transformación no trae los datos completos');
  const payload = parsed.data;

  let allocationId: string | null = null;
  let demandId: string | null = null;
  if (request.objectType === 'demand_allocation') {
    const allocation = await tx.demandAllocation.findUnique({ where: { id: request.objectId } });
    allocationId = allocation?.id ?? null;
    demandId = allocation?.demandId ?? null;
  } else if (request.objectType === 'case_demand') {
    demandId = request.objectId;
    const allocation = await tx.demandAllocation.findFirst({
      where: { demandId: request.objectId, source: 'manufacture', status: { notIn: ['cancelled', 'released', 'delivered'] } },
      orderBy: { createdAt: 'asc' },
    });
    allocationId = allocation?.id ?? null;
  }
  if (allocationId) {
    const existing = await tx.productionOrder.findFirst({
      where: { demandAllocationId: allocationId, status: { notIn: CLOSED_ORDER_STATUSES } },
      select: { id: true },
    });
    if (existing) {
      const ctx = requireCommandContext(tx);
      await ctx.relate(orderRef(existing.id), { type: 'area_request', id: request.id }, 'answers');
      return result('existing', existing.id, null);
    }
  }
  const demand = demandId ? await tx.caseDemand.findUnique({ where: { id: demandId } }) : null;
  const targetId = await resolveItemRef(tx, payload.targetSku, demand);
  const sourceId = await resolveItemRef(tx, payload.sourceSku, demand);
  if (!targetId) return block(`No se encontró en el catálogo el producto a fabricar (${payload.targetSku})`);
  if (!sourceId) return block(`No se encontró en el catálogo el material de entrada (${payload.sourceSku})`);

  const priority = (PRIORITIES as readonly string[]).includes(request.priority) ? (request.priority as (typeof PRIORITIES)[number]) : undefined;
  // A repeatable product with an active BOM is made from its BOM (plan 6.2), never as a transformation of itself.
  const bom = await getActiveBom(tx, targetId);
  if (!bom && sourceId === targetId) {
    return block(
      `La solicitud pide fabricar ${payload.targetSku} a partir de sí mismo y el producto no tiene lista de materiales activa: define el material de entrada y crea la orden de transformación`
    );
  }
  let order: CreateOrderResult;
  try {
    const units = unitsResolver(tx, 'write');
    convertToBase(payload.qty, payload.unit, await units(targetId));
    if (bom) {
      order = await createProductionOrderFromBomInTx(
        tx,
        {
          bomId: bom.id,
          plannedQty: payload.qty,
          plannedUnit: payload.unit,
          caseId: request.caseId,
          demandId,
          demandAllocationId: allocationId,
          priority,
          reserveNow: true,
        },
        { areaRequestId: request.id }
      );
    } else {
    convertToBase(payload.qty, payload.unit, await units(sourceId));
    order = await createTransformationOrderInTx(
      tx,
      {
        outputZohoItemId: targetId,
        outputName: demand?.name ?? null,
        plannedQty: payload.qty,
        plannedUnit: payload.unit,
        inputs: [{ zohoItemId: sourceId, qty: payload.qty, unit: payload.unit }],
        caseId: request.caseId,
        demandId,
        demandAllocationId: allocationId,
        priority,
        reserveNow: true,
      },
      { areaRequestId: request.id }
    );
    }
  } catch (err) {
    if (isOperationsError(err) && err.code !== 'concurrency_conflict') {
      return block(`No se pudo crear la orden de producción: ${err.message}`);
    }
    throw err;
  }
  const fresh = await tx.areaRequest.findUnique({ where: { id: request.id } });
  if (fresh && (fresh.status === 'sent' || fresh.status === 'acknowledged')) {
    await transitionAreaRequestInTx(tx, fresh, 'accept', { note: `Orden ${order.number} creada` });
  }
  return result('created', order.productionOrderId, null);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Plans the pending operations one after another against the shifts and the
 * load of their centers. An overloaded shift raises the capacity work item.
 * Writes the order row without touching its version (the caller's aggregate).
 */
export async function scheduleOrderInTx(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  input: { workCenterId?: string | null; plannedStartAt?: Date | null; commitLink?: boolean }
): Promise<ScheduleResult> {
  let current = order;
  if (input.commitLink !== false) await commitAllocationLinkInTx(tx, ctx, current);
  if (input.workCenterId && input.workCenterId !== current.workCenterId) {
    if (current.kind === 'bom') {
      throw new OperationsError('invalid_state', 'En una orden con lista de materiales el centro de trabajo se cambia en cada operación');
    }
    if (current.status === 'prepared') {
      throw new OperationsError('invalid_state', 'El material ya se surtió al centro actual: no se cambia de centro una orden preparada');
    }
    const center = await loadWorkCenter(tx, input.workCenterId, { requireActive: true });
    current = await tx.productionOrder.update({ where: { id: current.id }, data: { workCenterId: center.id } });
    if (current.kind === 'transformation') {
      await tx.productionOperation.updateMany({
        where: { productionOrderId: current.id, status: { in: ['pending', 'paused'] } },
        data: { workCenterId: center.id },
      });
    }
  }
  let operations = await loadOperations(tx, current.id);
  if (current.workCenterId && operations.length === 0 && current.kind === 'transformation') {
    await tx.productionOperation.create({
      data: {
        productionOrderId: current.id,
        seq: 1,
        workCenterId: current.workCenterId,
        name: DEFAULT_TRANSFORMATION_OPERATION,
        status: 'pending',
      },
    });
    operations = await loadOperations(tx, current.id);
  }
  const pending = operations.filter((op) => op.status === 'pending' || op.status === 'paused');
  let earliest =
    input.plannedStartAt ??
    (current.plannedStartAt && current.plannedStartAt > ctx.now ? current.plannedStartAt : ctx.now);
  if (pending.length === 0) {
    await tx.productionOrder.update({ where: { id: current.id }, data: { plannedStartAt: earliest } });
    return { plannedStartAt: earliest.toISOString(), plannedEndAt: null, overloaded: false, alertWorkItemIds: [] };
  }
  const centers = new Map<string, WorkCenter>();
  const loadedCenters = new Set<string>();
  let first: Date | null = null;
  let last: Date | null = null;
  let overloaded = false;
  const alertWorkItemIds: string[] = [];
  for (const op of pending) {
    let center = centers.get(op.workCenterId);
    if (!center) {
      center = await loadWorkCenter(tx, op.workCenterId);
      centers.set(center.id, center);
    }
    const capacityUnit = center.capacityUnit as CapacityUnit;
    const horizonEnd = addDays(earliest, SCHEDULING_HORIZON_DAYS);
    const planned = await tx.productionOperation.findMany({
      where: {
        workCenterId: center.id,
        status: { in: ['pending', 'running', 'paused'] },
        productionOrderId: { not: current.id },
        plannedStartAt: { gte: addDays(earliest, -1), lt: horizonEnd },
      },
      include: { productionOrder: { select: { plannedQty: true, plannedUnit: true, status: true } } },
    });
    const items = perOrderLoads(
      capacityUnit,
      planned
        .filter((row) => row.plannedStartAt && row.productionOrder && !['cancelled', 'released'].includes(row.productionOrder.status))
        .map((row) => ({
          id: row.id,
          productionOrderId: row.productionOrderId,
          seq: row.seq,
          start: row.plannedStartAt as Date,
          load: capacityLoad(capacityUnit, {
            minutes: row.plannedMinutes,
            defaultMinutes: DEFAULT_OPERATION_MINUTES,
            quantity: num(row.productionOrder.plannedQty),
            unit: row.productionOrder.plannedUnit,
          }),
        }))
    );
    // This order loads a quantity center once: only its first operation in the center counts.
    const alreadyLoaded = capacityUnit !== 'minutes' && loadedCenters.has(center.id);
    loadedCenters.add(center.id);
    const slot = planSlot({
      shifts: parseStoredShifts(center.shifts),
      capacityPerShift: num(center.capacityPerShift),
      capacityUnit,
      existing: items,
      request: {
        load: alreadyLoaded
          ? 0
          : capacityLoad(capacityUnit, {
              minutes: op.plannedMinutes,
              defaultMinutes: DEFAULT_OPERATION_MINUTES,
              quantity: num(current.plannedQty),
              unit: current.plannedUnit,
            }),
        minutes: op.plannedMinutes ?? DEFAULT_OPERATION_MINUTES,
      },
      earliestStart: earliest,
      horizonDays: SCHEDULING_HORIZON_DAYS,
    });
    await tx.productionOperation.update({ where: { id: op.id }, data: { plannedStartAt: slot.start } });
    first = first ?? slot.start;
    last = slot.end;
    if (slot.overloaded && slot.window) {
      overloaded = true;
      const alert = await raiseCapacityAlert(tx, ctx, center, slot.window, { productionOrderId: current.id, number: current.number });
      if (alert.workItemId) alertWorkItemIds.push(alert.workItemId);
    }
    earliest = slot.end.getTime() > slot.start.getTime() ? slot.end : slot.start;
  }
  const updated = await tx.productionOrder.update({
    where: { id: current.id },
    data: { plannedStartAt: first, plannedEndAt: last },
  });
  ctx.emit(
    MANUFACTURING_EVENTS.scheduled,
    {
      productionOrderId: updated.id,
      number: updated.number,
      workCenterId: updated.workCenterId,
      plannedStartAt: first?.toISOString() ?? null,
      plannedEndAt: last?.toISOString() ?? null,
      overloaded,
    },
    orderEventOptions(updated)
  );
  publishOrderChange(ctx, updated, { plannedStartAt: first?.toISOString() ?? null });
  return {
    plannedStartAt: first?.toISOString() ?? null,
    plannedEndAt: last?.toISOString() ?? null,
    overloaded,
    alertWorkItemIds,
  };
}

function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Overload warning of one shift of a center: a work item for Manufactura (one
 * open per center and shift), the event and the floor realtime.
 */
export async function raiseCapacityAlert(
  tx: Db,
  ctx: CommandContext,
  center: WorkCenter,
  window: ShiftLoad,
  context: { productionOrderId?: string | null; number?: string | null } = {}
): Promise<{ workItemId: string | null; created: boolean }> {
  const objectId = `${center.id}@${window.start.toISOString()}`;
  const open = await openWorkItemsFor(tx, MANUFACTURING_OBJECT_TYPES.workCenterShift, objectId, {
    areaKey: MANUFACTURING_AREA_KEY,
  });
  if (open.length > 0) return { workItemId: open[0].id, created: false };
  const unitLabel = CAPACITY_UNIT_LABELS[center.capacityUnit as CapacityUnit] ?? center.capacityUnit;
  const item = await ctx.createWorkItem({
    areaKey: MANUFACTURING_AREA_KEY,
    kind: 'action',
    title: `Sobrecarga en ${center.name}: turno ${window.shiftName} del ${window.day}`,
    description: `Carga de ${fmt(window.load)} ${unitLabel} para una capacidad de ${fmt(window.capacity)} (${window.utilizationPct} %). Reprograma o mueve órdenes a otro centro.${context.number ? ` La orden ${context.number} lo sobrepasó.` : ''}`,
    objectType: MANUFACTURING_OBJECT_TYPES.workCenterShift,
    objectId,
  });
  const payload = {
    workCenterId: center.id,
    workCenterName: center.name,
    shiftName: window.shiftName,
    day: window.day,
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    load: window.load,
    capacity: window.capacity,
    utilizationPct: window.utilizationPct,
    productionOrderId: context.productionOrderId ?? null,
    workItemId: item.id,
  };
  ctx.emit(MANUFACTURING_EVENTS.capacityOverloaded, payload, {
    areaKey: MANUFACTURING_AREA_KEY,
    objectType: MANUFACTURING_OBJECT_TYPES.workCenter,
    objectId: center.id,
  });
  ctx.realtime(MANUFACTURING_FLOOR_CHANNEL, MANUFACTURING_REALTIME_TYPES.capacity, { commandId: ctx.commandId, ...payload });
  return { workItemId: item.id, created: true };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

async function requestShortfall(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  line: AssignmentLineOutcome,
  products: Map<string, ProductInfo>
): Promise<{ requestId: string | null; workItemId: string | null }> {
  const label = itemLabel(products, line.zohoItemId);
  const sku = (products.get(line.zohoItemId)?.sku ?? line.zohoItemId).slice(0, 120);
  if (order.caseId) {
    const open = await tx.areaRequest.findMany({
      where: {
        kind: 'material_shortfall',
        objectType: MANUFACTURING_OBJECT_TYPES.productionOrder,
        objectId: order.id,
        status: { in: [...AREA_REQUEST_OPEN_STATUSES] },
      },
    });
    const existing = open.find((request) => (request.payload as Record<string, unknown> | null)?.sku === sku);
    if (existing) return { requestId: existing.id, workItemId: existing.workItemId };
    const { request, workItem } = await ctx.createAreaRequest({
      caseId: order.caseId,
      fromAreaKey: MANUFACTURING_AREA_KEY,
      toAreaKey: 'compras',
      kind: 'material_shortfall',
      objectType: MANUFACTURING_OBJECT_TYPES.productionOrder,
      objectId: order.id,
      title: `Faltan ${qtyText(line.missing)} ${line.baseUnit} de ${label} para ${order.number}`.slice(0, 200),
      payload: {
        productionOrderId: order.id,
        sku,
        missingQty: line.missing,
        unit: line.baseUnit,
        neededBy: dayKey(order.plannedStartAt && order.plannedStartAt > ctx.now ? order.plannedStartAt : addDays(ctx.now, 2)),
      },
    });
    return { requestId: request.id, workItemId: workItem.id };
  }
  const objectId = `${order.id}:${line.zohoItemId}`;
  const open = await openWorkItemsFor(tx, MANUFACTURING_OBJECT_TYPES.productionMaterial, objectId, { areaKey: 'compras' });
  if (open.length > 0) return { requestId: null, workItemId: open[0].id };
  const item = await ctx.createWorkItem({
    areaKey: 'compras',
    kind: 'action',
    title: `Conseguir ${qtyText(line.missing)} ${line.baseUnit} de ${label} para ${order.number}`.slice(0, 200),
    description: `La orden de producción ${order.number} está bloqueada por falta de material.`,
    objectType: MANUFACTURING_OBJECT_TYPES.productionMaterial,
    objectId,
  });
  return { requestId: null, workItemId: item.id };
}

async function requestCount(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  line: AssignmentLineOutcome,
  products: Map<string, ProductInfo>
): Promise<string> {
  const objectId = `${order.id}:${line.zohoItemId}`;
  const open = await openWorkItemsFor(tx, MANUFACTURING_OBJECT_TYPES.productionMaterial, objectId, {
    areaKey: 'inventario',
  });
  if (open.length > 0) return open[0].id;
  const item = await ctx.createWorkItem({
    areaKey: 'inventario',
    kind: 'verification',
    title: `Contar ${itemLabel(products, line.zohoItemId)} para ${order.number}`.slice(0, 200),
    description: `${line.message ?? 'La existencia no se puede comprometer'}. La orden necesita ${qtyText(line.missing)} ${line.baseUnit} más.`,
    caseId: order.caseId,
    objectType: MANUFACTURING_OBJECT_TYPES.productionMaterial,
    objectId,
  });
  return item.id;
}

/**
 * Closes what a blocked order asked for (purchase requests, count and sourcing
 * work items): `resolve` when the material is now committed (Compras sees its
 * request fulfilled, never a cancellation of something it already bought),
 * `cancel` when the order itself is cancelled.
 */
async function withdrawShortfalls(tx: Db, order: ProductionOrder, reason: string, action: 'resolve' | 'cancel'): Promise<void> {
  const requests = await tx.areaRequest.findMany({
    where: {
      kind: 'material_shortfall',
      objectType: MANUFACTURING_OBJECT_TYPES.productionOrder,
      objectId: order.id,
      status: { in: [...AREA_REQUEST_OPEN_STATUSES] },
    },
  });
  for (const request of requests) {
    if (action === 'resolve') await transitionAreaRequestInTx(tx, request, 'resolve', { answer: reason });
    else await transitionAreaRequestInTx(tx, request, 'cancel', { reason });
  }
  const items = await tx.workItem.findMany({
    where: {
      objectType: MANUFACTURING_OBJECT_TYPES.productionMaterial,
      objectId: { startsWith: `${order.id}:` },
      status: { in: ['open', 'in_progress', 'waiting', 'escalated'] },
    },
  });
  await closeWorkItems(tx, items, 'cancel', reason);
}

export async function reserveMaterialsInTx(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  input: { allowProvisional: boolean }
): Promise<ReserveMaterialsResult> {
  const error = orderActionError('reserve_materials', order.status);
  if (error) throw new OperationsError('invalid_state', error);
  await commitAllocationLinkInTx(tx, ctx, order);
  if (input.allowProvisional && ctx.actor.type !== 'user') {
    throw inventoryError('provisional_requires_human', 'Sólo una persona puede decidir comprometer existencia provisional');
  }
  const units = unitsResolver(tx, 'write');
  const recipe = await loadRecipe(tx, order, units);
  const requirements = await computeRequirements(recipe, units);
  const center = order.workCenterId ? await loadWorkCenter(tx, order.workCenterId) : null;
  const outcomes = await assignMaterials(tx, ctx, order, requirements, {
    allowProvisional: input.allowProvisional,
    warehouseIds: materialWarehouses(order, center),
  });
  const products = await productInfo(tx, requirements.map((line) => line.zohoItemId));
  const lines = lineResults(outcomes, products);
  const missing = outcomes.filter((line) => line.missing > 0);

  if (missing.length === 0) {
    const wasBlocked = order.status === 'blocked';
    const updated =
      order.status === 'reserved'
        ? order
        : await tx.productionOrder.update({ where: { id: order.id }, data: { status: 'reserved', blockedReason: null } });
    await withdrawShortfalls(tx, order, `Material comprometido para ${order.number}`, 'resolve');
    if (order.status !== 'reserved' || outcomes.some((line) => line.assignedNow > 0)) {
      ctx.emit(MANUFACTURING_EVENTS.materialsReserved, { productionOrderId: order.id, number: order.number, lines }, orderEventOptions(order));
    }
    if (wasBlocked) {
      ctx.emit(MANUFACTURING_EVENTS.unblocked, { productionOrderId: order.id, number: order.number }, orderEventOptions(order));
    }
    publishOrderChange(ctx, updated);
    return { productionOrderId: order.id, status: updated.status, complete: true, lines, requestIds: [], workItemIds: [] };
  }

  const reason = truncate(
    `Faltan materiales: ${missing
      .map((line) => `${qtyText(line.missing)} ${line.baseUnit} de ${itemLabel(products, line.zohoItemId)} (${ASSIGNMENT_REASON_LABELS[line.reason]})`)
      .join('; ')}`,
    500
  );
  const updated = await tx.productionOrder.update({
    where: { id: order.id },
    data: { status: 'blocked', blockedReason: reason },
  });
  const requestIds: string[] = [];
  const workItemIds: string[] = [];
  for (const line of missing) {
    if (line.reason === 'insufficient') {
      const asked = await requestShortfall(tx, ctx, order, line, products);
      if (asked.requestId) requestIds.push(asked.requestId);
      if (asked.workItemId) workItemIds.push(asked.workItemId);
    } else {
      workItemIds.push(await requestCount(tx, ctx, order, line, products));
    }
  }
  if (order.status !== 'blocked' || order.blockedReason !== reason) {
    ctx.emit(
      MANUFACTURING_EVENTS.blocked,
      { productionOrderId: order.id, number: order.number, reason, lines, requestIds, workItemIds },
      orderEventOptions(order)
    );
  }
  publishOrderChange(ctx, updated, { blockedReason: reason });
  return { productionOrderId: order.id, status: 'blocked', complete: false, lines, requestIds, workItemIds };
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

export async function prepareInTx(tx: Db, ctx: CommandContext, order: ProductionOrder): Promise<PrepareResult> {
  const error = orderActionError('prepare', order.status);
  if (error) throw new OperationsError('invalid_state', error);
  if (!order.workCenterId) {
    throw manufacturingError('no_work_center', 'Asigna un centro de trabajo antes de preparar la orden');
  }
  const operations = await loadOperations(tx, order.id);
  if (operations.length === 0) {
    throw manufacturingError('no_work_center', 'La orden no tiene operaciones; prográmala en un centro de trabajo');
  }
  const center = await loadWorkCenter(tx, order.workCenterId, { requireActive: true });
  const transfers = center.warehouseId ? await moveAssignmentsToWarehouse(tx, ctx, order, center.warehouseId) : [];
  const planned = await tx.materialConsumption.findMany({
    where: { productionOrderId: order.id, kind: 'planned' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const stockRows = await tx.stockItem.findMany({
    where: { id: { in: planned.map((row) => row.stockItemId).filter((id): id is string => Boolean(id)) } },
  });
  const locations = await tx.storageLocation.findMany({
    where: { id: { in: stockRows.map((row) => row.locationId) } },
    select: { id: true, code: true },
  });
  const products = await productInfo(tx, planned.map((row) => row.inputZohoItemId));
  const lines = planned
    .filter((row) => heldQuantity(row).gt(0))
    .map((row) => {
      const stock = stockRows.find((candidate) => candidate.id === row.stockItemId);
      const code = locations.find((location) => location.id === stock?.locationId)?.code ?? 'GENERAL';
      const container = stock?.containerKey ? ` · ${stock.containerKey}` : '';
      return `• ${qtyText(heldQuantity(row))} ${row.unit} de ${itemLabel(products, row.inputZohoItemId)} (${code}${container})`;
    });
  const existing = await openWorkItemsFor(tx, MANUFACTURING_OBJECT_TYPES.productionOrder, order.id, {
    areaKey: 'inventario',
    kind: 'action',
  });
  const workItemId =
    existing[0]?.id ??
    (
      await ctx.createWorkItem({
        areaKey: 'inventario',
        kind: 'action',
        title: `Surtir materiales de ${order.number} a ${center.name}`.slice(0, 200),
        description: lines.length > 0 ? lines.join('\n') : 'La orden no tiene materiales asignados pendientes de surtir.',
        caseId: order.caseId,
        objectType: MANUFACTURING_OBJECT_TYPES.productionOrder,
        objectId: order.id,
      })
    ).id;
  const updated = await tx.productionOrder.update({ where: { id: order.id }, data: { status: 'prepared' } });
  ctx.emit(
    MANUFACTURING_EVENTS.prepared,
    { productionOrderId: order.id, number: order.number, workCenterId: center.id, workItemId, transfers, pickList: lines },
    orderEventOptions(order)
  );
  publishOrderChange(ctx, updated);
  return { productionOrderId: order.id, status: updated.status, workItemId, transfers: transfers.length };
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

async function transformationRequestOf(tx: Db, order: ProductionOrder): Promise<AreaRequest | null> {
  const relation = await tx.objectRelation.findFirst({
    where: { fromType: MANUFACTURING_OBJECT_TYPES.productionOrder, fromId: order.id, toType: 'area_request', relation: 'answers', validTo: null },
    select: { toId: true },
  });
  let requestId = relation?.toId ?? null;
  if (!requestId && order.demandAllocationId) {
    const allocation = await tx.demandAllocation.findUnique({ where: { id: order.demandAllocationId } });
    if (allocation?.linkedType === 'area_request' && allocation.linkedId) requestId = allocation.linkedId;
  }
  if (!requestId) return null;
  const request = await tx.areaRequest.findUnique({ where: { id: requestId } });
  if (!request || request.kind !== 'transformation') return null;
  return (AREA_REQUEST_OPEN_STATUSES as readonly string[]).includes(request.status) ? request : null;
}

export async function releaseInTx(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  input: { acceptBalanceDifference?: boolean; note?: string | null }
): Promise<ReleaseResult> {
  const error = orderActionError('release', order.status);
  if (error) throw new OperationsError('invalid_state', error);
  if (input.acceptBalanceDifference) {
    const user = ctx.user;
    const { hasPermission } = await import('@/modules/auth/authorization');
    if (ctx.actor.type !== 'system' && (!user || !hasPermission(user, 'manufacturing.approve_incidents'))) {
      throw new OperationsError('forbidden', 'Liberar con diferencia de balance requiere permiso para aprobar incidencias de producción');
    }
  }
  const units = unitsResolver(tx, 'write');
  const facts = await loadProductionFacts(tx, order, units);
  let evaluation = evaluateRelease(releaseFactsOf(facts, { acceptBalanceDifference: input.acceptBalanceDifference }));
  const base = {
    productionOrderId: order.id,
    reservationId: null,
    deliveryOrderId: null,
    finishedGoodsRequestId: null,
    materialsReleased: 0,
  };
  if (evaluation.requestScrapApproval) {
    const outcome = await requestScrapApprovalInTx(tx, ctx, order, facts, input.note ?? null);
    if (outcome.status === 'approved') {
      evaluation = evaluateRelease(
        releaseFactsOf(facts, { acceptBalanceDifference: input.acceptBalanceDifference, scrapApproval: 'approved' })
      );
    } else if (outcome.status === 'no_approvers') {
      throw new OperationsError('no_approvers', 'La merma supera la tolerancia y no hay quién apruebe incidencias de producción');
    } else {
      publishOrderChange(ctx, order, { scrapApprovalRequestId: outcome.approvalRequestId });
      return {
        ...base,
        released: false,
        status: order.status,
        blockers: evaluation.blockers,
        scrapApprovalRequestId: outcome.approvalRequestId,
      };
    }
  }
  if (!evaluation.ready) {
    throw manufacturingError(
      'release_blocked',
      `No se puede liberar ${order.number}: ${evaluation.blockers.map((blocker) => blocker.message).join('; ')}`,
      { blockers: evaluation.blockers }
    );
  }

  const released = await releaseAssignments(tx, order);
  if (released.length > 0) {
    ctx.emit(MANUFACTURING_EVENTS.materialsReleased, { productionOrderId: order.id, number: order.number, released, reason: 'release' }, orderEventOptions(order));
  }
  const movementIds = facts.outputs
    .filter((output) => output.kind === 'finished' && output.stockMovementId)
    .map((output) => output.stockMovementId as string);
  const products = await productInfo(tx, [order.outputZohoItemId]);
  const label = order.outputName ?? itemLabel(products, order.outputZohoItemId);
  const produced = qtyText(facts.producedBase);
  const baseUnit = facts.outputUnits.baseUnit;

  let reservationId: string | null = null;
  const deliveryOrderId: string | null = null;
  let allocationId: string | null = null;
  if (order.demandAllocationId) {
    const allocation = await tx.demandAllocation.findUnique({ where: { id: order.demandAllocationId } });
    const demand = allocation ? await tx.caseDemand.findUnique({ where: { id: allocation.demandId } }) : null;
    if (
      allocation &&
      demand &&
      !['cancelled', 'delivered', 'released'].includes(allocation.status) &&
      demand.zohoItemId === order.outputZohoItemId
    ) {
      const quantity = Math.min(facts.producedBase, facts.requiredBase ?? facts.producedBase);
      const reservation = await reserveStock(
        tx,
        {
          caseId: allocation.caseId,
          demandId: demand.id,
          allocationId: allocation.id,
          zohoItemId: order.outputZohoItemId,
          warehouseId: order.outputWarehouseId,
          variantKey: demand.variantKey,
          quantity,
          unit: baseUnit,
          receiptMovementIds: movementIds,
          note: `Producido en ${order.number}`,
        },
        ctx
      );
      reservationId = reservation.primaryReservationId;
      allocationId = allocation.id;
      const ready = await tx.demandAllocation.update({
        where: { id: allocation.id },
        data: {
          status: 'ready',
          readyAt: allocation.readyAt ?? ctx.now,
          stockReservationId: reservation.primaryReservationId,
          warehouseId: order.outputWarehouseId,
          version: { increment: 1 },
        },
      });
      ctx.emit(
        OPS_EVENTS.allocation.ready,
        {
          allocationId: ready.id,
          demandId: ready.demandId,
          source: ready.source,
          status: ready.status,
          quantity: qtyText(quantity),
          productionOrderId: order.id,
          reservationIds: reservation.reservations.map((row) => row.id),
        },
        { caseId: ready.caseId, areaKey: MANUFACTURING_AREA_KEY, objectType: 'demand_allocation', objectId: ready.id }
      );
      // `releaseTarget = logistics` is only a hint: the case engine plans the delivery (plan_delivery) with every
      // eligible allocation of the case and the shipping data of the sales order, in its turn.
    }
  } else if (order.demandId) {
    // An order for a demand without a manufacture allocation still reserves what it made for that sale.
    const demand = await tx.caseDemand.findUnique({ where: { id: order.demandId } });
    const open = demand ? Math.max(0, num(demand.baseQuantity) - num(demand.fulfilledQuantity)) : 0;
    if (demand && demand.zohoItemId === order.outputZohoItemId && !['fulfilled', 'cancelled'].includes(demand.status) && open > 0) {
      try {
        const reservation = await reserveStock(
          tx,
          {
            caseId: demand.caseId,
            demandId: demand.id,
            allocationId: null,
            zohoItemId: order.outputZohoItemId,
            warehouseId: order.outputWarehouseId,
            variantKey: demand.variantKey,
            quantity: Math.min(facts.producedBase, open),
            unit: baseUnit,
            receiptMovementIds: movementIds,
            note: `Producido en ${order.number}`,
          },
          ctx
        );
        reservationId = reservation.primaryReservationId;
      } catch (err) {
        if (!isOperationsError(err)) throw err;
        await ctx.openIncident({
          kind: 'stock_conflict',
          areaKey: 'inventario',
          severity: 'medium',
          title: `No se pudo reservar lo producido en ${order.number} para ${demand.name}`.slice(0, 200),
          dedupeKey: `mfg.release_reserve:${order.id}`,
          caseId: demand.caseId,
          detail: { productionOrderId: order.id, demandId: demand.id, code: err.code, message: err.message },
        });
      }
    }
  }

  const request = await transformationRequestOf(tx, order);
  if (request) {
    await transitionAreaRequestInTx(tx, request, 'resolve', {
      answer: `${order.number} liberada: ${produced} ${baseUnit} de ${label}`,
      data: { productionOrderId: order.id, producedQty: produced, unit: baseUnit, movementIds, reservationId },
    });
  }

  let finishedGoodsRequestId: string | null = null;
  if (order.caseId && order.releaseTarget === 'inventory') {
    const warehouse = await tx.warehouse.findUnique({ where: { id: order.outputWarehouseId }, select: { name: true } });
    const location = order.outputLocationId
      ? await tx.storageLocation.findUnique({ where: { id: order.outputLocationId }, select: { code: true } })
      : null;
    const { request: finished } = await ctx.createAreaRequest({
      caseId: order.caseId,
      fromAreaKey: MANUFACTURING_AREA_KEY,
      toAreaKey: 'inventario',
      kind: 'finished_goods',
      objectType: MANUFACTURING_OBJECT_TYPES.productionOrder,
      objectId: order.id,
      title: `Producto terminado de ${order.number}: ${produced} ${baseUnit} de ${label}`.slice(0, 200),
      payload: {
        productionOrderId: order.id,
        sku: (products.get(order.outputZohoItemId)?.sku ?? order.outputZohoItemId).slice(0, 120),
        qty: facts.producedBase,
        unit: baseUnit,
        location: `${warehouse?.name ?? 'Bodega'} · ${location?.code ?? 'GENERAL'}`.slice(0, 200),
        ...(facts.lastOrderCheck?.notes ? { qualityNote: facts.lastOrderCheck.notes.slice(0, 500) } : {}),
      },
    });
    finishedGoodsRequestId = finished.id;
  }

  const openItems = await openWorkItemsFor(tx, MANUFACTURING_OBJECT_TYPES.productionOrder, order.id, {
    areaKey: MANUFACTURING_AREA_KEY,
  });
  await closeWorkItems(tx, openItems, 'complete', `Orden ${order.number} liberada`);

  const updated = await tx.productionOrder.update({
    where: { id: order.id },
    data: { status: 'released', completedAt: order.completedAt ?? ctx.now, blockedReason: null },
  });
  const payload = {
    productionOrderId: order.id,
    number: order.number,
    outputZohoItemId: order.outputZohoItemId,
    producedQty: produced,
    unit: baseUnit,
    scrapQty: qtyText(order.scrapQty),
    leftoverQty: qtyText(order.leftoverQty),
    allocationId,
    reservationId,
    deliveryOrderId,
    releaseTarget: order.releaseTarget,
    movementIds,
    acceptedBalanceDifference: input.acceptBalanceDifference === true && !facts.balance.balanced,
    note: input.note ?? null,
  };
  ctx.emit(MANUFACTURING_EVENTS.released, payload, orderEventOptions(order));
  ctx.emit(MANUFACTURING_EVENTS.finished, payload, orderEventOptions(order));
  publishOrderChange(ctx, updated);
  return {
    ...base,
    released: true,
    status: updated.status,
    blockers: [],
    scrapApprovalRequestId: null,
    reservationId,
    deliveryOrderId,
    finishedGoodsRequestId,
    materialsReleased: released.length,
  };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/** Pending substitution and excess-scrap approvals of an order (their approvers no longer have anything to decide). */
async function cancelPendingIncidentApprovals(tx: Db, ctx: CommandContext, order: ProductionOrder, reason: string): Promise<void> {
  const consumptionIds = (
    await tx.materialConsumption.findMany({ where: { productionOrderId: order.id }, select: { id: true } })
  ).map((row) => row.id);
  const approvals = await tx.approvalRequest.findMany({
    where: {
      status: 'pending',
      OR: [
        { targetType: MANUFACTURING_OBJECT_TYPES.scrapReview, targetId: order.id },
        ...(consumptionIds.length > 0 ? [{ targetType: MANUFACTURING_OBJECT_TYPES.materialConsumption, targetId: { in: consumptionIds } }] : []),
      ],
    },
  });
  for (const approval of approvals) {
    await tx.approvalRequest.update({
      where: { id: approval.id },
      data: { status: 'cancelled', decidedAt: ctx.now, version: { increment: 1 } },
    });
    const items = await tx.workItem.findMany({
      where: { objectType: 'approval_request', objectId: approval.id, status: { in: ['open', 'in_progress', 'waiting', 'escalated'] } },
    });
    await closeWorkItems(tx, items, 'cancel', reason);
    ctx.emit(
      OPS_EVENTS.approval.cancelled,
      { approvalRequestId: approval.id, scope: approval.scope, targetType: approval.targetType, targetId: approval.targetId, reason },
      { caseId: approval.caseId, areaKey: approval.areaKey, objectType: 'approval_request', objectId: approval.id }
    );
  }
}

export async function cancelInTx(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  input: { reason: string }
): Promise<CancelResult> {
  const error = orderActionError('cancel', order.status);
  if (error) throw new OperationsError('invalid_state', error);
  const reason = input.reason.trim();
  const released = await releaseAssignments(tx, order);
  await withdrawShortfalls(tx, order, `Orden ${order.number} cancelada: ${reason}`, 'cancel');
  await cancelPendingIncidentApprovals(tx, ctx, order, `Orden ${order.number} cancelada: ${reason}`);
  const openItems = await tx.workItem.findMany({
    where: {
      objectType: { in: [MANUFACTURING_OBJECT_TYPES.productionOrder, MANUFACTURING_OBJECT_TYPES.productionOperation] },
      objectId: { in: [order.id, ...(await loadOperations(tx, order.id)).map((op) => op.id)] },
      status: { in: ['open', 'in_progress', 'waiting', 'escalated'] },
    },
  });
  await closeWorkItems(tx, openItems, 'cancel', `Orden ${order.number} cancelada`);
  await tx.productionOperation.updateMany({
    where: { productionOrderId: order.id, status: { in: ['pending', 'running', 'paused'] } },
    data: { status: 'skipped' },
  });
  const request = await transformationRequestOf(tx, order);
  if (request) {
    await transitionAreaRequestInTx(tx, request, 'reject', { reason: `Orden ${order.number} cancelada: ${reason}` });
  } else if (order.demandAllocationId && order.caseId) {
    const allocation = await tx.demandAllocation.findUnique({ where: { id: order.demandAllocationId } });
    if (allocation && allocation.linkedId === order.id && !['cancelled', 'delivered', 'released'].includes(allocation.status)) {
      await ctx.openIncident({
        kind: 'cancellation_compensation',
        areaKey: MANUFACTURING_AREA_KEY,
        title: `Producción cancelada: replanifica ${order.outputName ?? order.outputZohoItemId} (${order.number})`.slice(0, 200),
        dedupeKey: `mfg:cancel:${order.id}`,
        severity: 'high',
        caseId: order.caseId,
        detail: { productionOrderId: order.id, allocationId: allocation.id, reason },
      });
    }
  }
  const consumed = await tx.materialConsumption.count({
    where: { productionOrderId: order.id, kind: { in: ['actual', 'substitution'] }, stockMovementId: { not: null } },
  });
  const updated = await tx.productionOrder.update({
    where: { id: order.id },
    data: { status: 'cancelled', blockedReason: truncate(`Cancelada: ${reason}`, 500) },
  });
  ctx.emit(
    MANUFACTURING_EVENTS.cancelled,
    {
      productionOrderId: order.id,
      number: order.number,
      previousStatus: order.status,
      reason,
      materialsReleased: released,
      postedConsumptions: consumed,
    },
    orderEventOptions(order)
  );
  publishOrderChange(ctx, updated);
  return { productionOrderId: order.id, status: updated.status, materialsReleased: released.length };
}
