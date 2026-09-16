import { Prisma, type ProductionOperation, type ProductionOrder } from '@prisma/client';
import { z } from 'zod';
import { recordInventoryMovement } from '@/modules/inventory/inventory-service';
import { SCRAP_LOCATION_CODE } from '@/modules/inventory/inventory-types';
import { requestApproval, type ApprovalDecidedEvent } from '@/modules/operations/approvals-service';
import type { CommandContext, DomainCommand } from '@/modules/operations/commands';
import { OperationsError, isOperationsError } from '@/modules/operations/errors';
import { toOperationalJson } from '@/modules/operations/events-service';
import { OPS_EVENTS } from '@/modules/operations/types';
import {
  closeWorkItems,
  convertToBase,
  instantOf,
  itemLabel,
  loadOperations,
  loadWorkCenter,
  notifyProductionUpdate,
  num,
  openWorkItemsFor,
  orderEventOptions,
  productInfo,
  publishOrderChange,
  qtyText,
  touchOrder,
  unitFactor,
  unitsResolver,
  type Db,
  type ProductInfo,
} from './manufacturing-helpers';
import {
  MANUFACTURING_AREA_KEY,
  MANUFACTURING_EVENTS,
  MANUFACTURING_OBJECT_TYPES,
  OPERATION_SEGMENT_EVENTS,
  OUTPUT_KINDS,
  QUALITY_RESULTS,
  manufacturingError,
} from './manufacturing-types';
import {
  loadProductionFacts,
  loadRecipe,
  operationFactsOf,
  type ProductionFacts,
} from './production-facts';
import {
  consumeUnassigned,
  drawAssigned,
  materialWarehouses,
  type PostedConsumption,
} from './production-materials';
import {
  accumulatedMinutes,
  classifyConsumption,
  isOpenOrderStatus,
  nextStartableOperation,
  operationFinishError,
  operationPauseError,
  operationStartError,
  orderActionError,
  orderStatusAfterOperations,
  reworkPlacement,
  sortOperations,
} from './production-state';

/**
 * Shop floor of production orders (plan 6.2): operations with real minutes,
 * material consumption (against the assignment, declared substitutes and
 * substitutions outside the BOM with approval before posting), quality
 * inspection with rework, and outputs (finished goods with traceability,
 * saleable leftovers with dimensions, scrap into the SCRAP location) with the
 * excess-scrap approval.
 */

const idText = z.string().trim().min(1).max(120);
const positiveQty = z
  .number()
  .finite()
  .positive('La cantidad debe ser mayor que cero')
  .max(1_000_000_000);
const unitText = z.string().trim().min(1).max(40);

export const startOperationSchema = z.object({
  productionOrderId: idText,
  /** Default: the next operation that can start or resume. */
  operationId: idText.optional(),
  assignedUserId: idText.nullish(),
});
export type StartOperationInput = z.input<typeof startOperationSchema>;

export const pauseOperationSchema = z.object({
  productionOrderId: idText,
  operationId: idText,
  reason: z.string().trim().max(500).optional(),
});
export type PauseOperationInput = z.input<typeof pauseOperationSchema>;

export const finishOperationSchema = z.object({
  productionOrderId: idText,
  operationId: idText,
  /** Real minutes reported by the operator (replaces the measured ones). */
  actualMinutes: z.number().int().min(0).max(100_000).optional(),
  note: z.string().trim().max(500).optional(),
});
export type FinishOperationInput = z.input<typeof finishOperationSchema>;

export const consumptionLineSchema = z.object({
  zohoItemId: idText,
  qty: positiveQty,
  unit: unitText.optional(),
  stockItemId: idText.nullish(),
  operationId: idText.nullish(),
  /** Input this material replaces (required for a substitution outside the BOM). */
  substituteFor: idText.nullish(),
});

export const recordConsumptionSchema = z.object({
  productionOrderId: idText,
  lines: z.array(consumptionLineSchema).min(1).max(50),
  note: z.string().trim().max(500).optional(),
});
export type RecordConsumptionInput = z.input<typeof recordConsumptionSchema>;

export const inspectSchema = z
  .object({
    productionOrderId: idText,
    /** Inspection of one finished operation; omitted = the order-level inspection. */
    operationId: idText.nullish(),
    result: z.enum(QUALITY_RESULTS),
    checklist: z
      .array(
        z.object({
          item: z.string().trim().min(1).max(200),
          ok: z.boolean(),
          note: z.string().trim().max(500).nullish(),
        })
      )
      .max(50)
      .optional(),
    notes: z.string().trim().max(2000).nullish(),
    evidenceObjectIds: z.array(idText).max(20).optional(),
    reworkOperationName: z.string().trim().min(1).max(120).optional(),
    reworkMinutes: z.number().int().min(0).max(100_000).optional(),
  })
  .superRefine((value, issue) => {
    if (value.result !== 'pass' && !value.notes) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notes'],
        message:
          value.result === 'fail' ? 'Describe la falla de calidad' : 'Describe las observaciones',
      });
    }
  });
export type InspectInput = z.input<typeof inspectSchema>;

export const dimensionsSchema = z.object({
  largo: z.number().finite().positive(),
  ancho: z.number().finite().positive().optional(),
  espesor: z.number().finite().positive().optional(),
  unidad: z.string().trim().min(1).max(10),
});

export const recordOutputSchema = z
  .object({
    productionOrderId: idText,
    kind: z.enum(OUTPUT_KINDS),
    /** Finished: the output item; leftover/scrap: the material (default: the single input). */
    zohoItemId: idText.optional(),
    qty: positiveQty,
    unit: unitText.optional(),
    /** Saleable leftover measures (required for `leftover`). */
    dimensions: dimensionsSchema.optional(),
    /** Location code for finished goods or leftovers (scrap always goes to SCRAP). */
    locationCode: z.string().trim().min(1).max(40).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, issue) => {
    if (value.kind === 'leftover' && !value.dimensions) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions'],
        message: 'Registra las medidas del sobrante',
      });
    }
  });
export type RecordOutputInput = z.input<typeof recordOutputSchema>;

export const scrapReviewSchema = z.object({
  productionOrderId: idText,
  reason: z.string().trim().min(1, 'Indica el motivo de la merma').max(500),
});
export type ScrapReviewInput = z.input<typeof scrapReviewSchema>;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface OperationResult {
  productionOrderId: string;
  operationId: string;
  operationStatus: string;
  orderStatus: string;
  actualMinutes: number | null;
  resumed?: boolean;
  inspectionWorkItemId?: string | null;
}

async function operationFacts(tx: Db, order: ProductionOrder, operations: ProductionOperation[]) {
  const units = unitsResolver(tx, 'write');
  const recipe = await loadRecipe(tx, order, units);
  const checks = await tx.qualityCheck.findMany({ where: { productionOrderId: order.id } });
  return operationFactsOf(operations, checks, recipe);
}

async function loadOrderOperation(
  tx: Db,
  order: ProductionOrder,
  operationId: string
): Promise<ProductionOperation | null> {
  const op = await tx.productionOperation.findUnique({ where: { id: operationId } });
  return op && op.productionOrderId === order.id ? op : null;
}

/** Start of the running segment of an operation: its last start/resume event, else `startedAt`. */
async function segmentStartOf(tx: Db, op: ProductionOperation): Promise<Date | null> {
  const event = await tx.operationalEvent.findFirst({
    where: {
      objectType: MANUFACTURING_OBJECT_TYPES.productionOperation,
      objectId: op.id,
      type: { in: [...OPERATION_SEGMENT_EVENTS] },
    },
    orderBy: [{ occurredAt: 'desc' }],
    select: { occurredAt: true },
  });
  return event?.occurredAt ?? op.startedAt;
}

function operationEventOptions(order: ProductionOrder, op: Pick<ProductionOperation, 'id'>) {
  return {
    caseId: order.caseId,
    areaKey: MANUFACTURING_AREA_KEY,
    objectType: MANUFACTURING_OBJECT_TYPES.productionOperation,
    objectId: op.id,
  };
}

export async function startOperationInTx(
  tx: Db,
  ctx: CommandContext,
  cmd: Pick<DomainCommand, 'occurredAt'>,
  order: ProductionOrder,
  input: z.output<typeof startOperationSchema>
): Promise<OperationResult> {
  const error = orderActionError('start_operation', order.status);
  if (error) throw new OperationsError('invalid_state', error);
  const operations = await loadOperations(tx, order.id);
  if (operations.length === 0) {
    throw manufacturingError(
      'no_work_center',
      'La orden no tiene operaciones; prográmala en un centro de trabajo'
    );
  }
  const facts = await operationFacts(tx, order, operations);
  const target = input.operationId
    ? facts.find((op) => op.id === input.operationId)
    : (nextStartableOperation(facts) ??
      sortOperations(facts).find((op) => op.status === 'pending' || op.status === 'paused'));
  if (!target)
    throw new OperationsError('invalid_state', 'La orden no tiene operaciones pendientes');
  const sequenceError = operationStartError(facts, target.id);
  if (sequenceError) throw manufacturingError('operation_sequence', sequenceError);
  const op = operations.find((candidate) => candidate.id === target.id) as ProductionOperation;
  if (input.assignedUserId) {
    const user = await tx.user.findUnique({
      where: { id: input.assignedUserId },
      select: { isActive: true, isBot: true },
    });
    if (!user?.isActive || user.isBot) {
      throw new OperationsError(
        'invalid_payload',
        'La persona asignada no existe o no está activa'
      );
    }
  }
  const at = instantOf(cmd, ctx.now);
  const resumed = op.status === 'paused';
  const assignedUserId =
    input.assignedUserId ?? op.assignedUserId ?? (ctx.actor.type === 'user' ? ctx.actor.id : null);
  const updatedOp = await tx.productionOperation.update({
    where: { id: op.id },
    data: { status: 'running', startedAt: op.startedAt ?? at, assignedUserId },
  });
  const firstStart = !order.startedAt;
  const updated = await tx.productionOrder.update({
    where: { id: order.id },
    data: { status: 'in_progress', startedAt: order.startedAt ?? at },
  });
  ctx.emit(
    resumed ? MANUFACTURING_EVENTS.operationResumed : MANUFACTURING_EVENTS.operationStarted,
    {
      productionOrderId: order.id,
      number: order.number,
      operationId: op.id,
      seq: op.seq,
      name: op.name,
      workCenterId: op.workCenterId,
      assignedUserId,
      at: at.toISOString(),
    },
    operationEventOptions(order, op)
  );
  if (firstStart) {
    ctx.emit(
      MANUFACTURING_EVENTS.started,
      {
        productionOrderId: order.id,
        number: order.number,
        workCenterId: order.workCenterId,
        outputZohoItemId: order.outputZohoItemId,
        plannedQty: qtyText(order.plannedQty),
        plannedUnit: order.plannedUnit,
      },
      orderEventOptions(order)
    );
    if (order.demandAllocationId) {
      const allocation = await tx.demandAllocation.findUnique({
        where: { id: order.demandAllocationId },
      });
      if (allocation && (allocation.status === 'planned' || allocation.status === 'requested')) {
        const moved = await tx.demandAllocation.update({
          where: { id: allocation.id },
          data: { status: 'in_progress', version: { increment: 1 } },
        });
        ctx.emit(
          OPS_EVENTS.allocation.inProgress,
          {
            allocationId: moved.id,
            demandId: moved.demandId,
            source: moved.source,
            status: moved.status,
            productionOrderId: order.id,
          },
          {
            caseId: moved.caseId,
            areaKey: MANUFACTURING_AREA_KEY,
            objectType: 'demand_allocation',
            objectId: moved.id,
          }
        );
      }
    }
  }
  publishOrderChange(ctx, updated, { operationId: op.id, operationStatus: 'running' });
  return {
    productionOrderId: order.id,
    operationId: updatedOp.id,
    operationStatus: updatedOp.status,
    orderStatus: updated.status,
    actualMinutes: updatedOp.actualMinutes,
    resumed,
  };
}

export async function pauseOperationInTx(
  tx: Db,
  ctx: CommandContext,
  cmd: Pick<DomainCommand, 'occurredAt'>,
  order: ProductionOrder,
  input: z.output<typeof pauseOperationSchema>
): Promise<OperationResult> {
  const error = orderActionError('pause_operation', order.status);
  if (error) throw new OperationsError('invalid_state', error);
  const op = await loadOrderOperation(tx, order, input.operationId);
  const pauseError = operationPauseError(op);
  if (pauseError || !op)
    throw new OperationsError('invalid_state', pauseError ?? 'Operación inválida');
  const at = instantOf(cmd, ctx.now);
  const minutes = accumulatedMinutes(op.actualMinutes, await segmentStartOf(tx, op), at);
  const updatedOp = await tx.productionOperation.update({
    where: { id: op.id },
    data: { status: 'paused', actualMinutes: minutes },
  });
  ctx.emit(
    MANUFACTURING_EVENTS.operationPaused,
    {
      productionOrderId: order.id,
      number: order.number,
      operationId: op.id,
      seq: op.seq,
      actualMinutes: minutes,
      reason: input.reason ?? null,
      at: at.toISOString(),
    },
    operationEventOptions(order, op)
  );
  publishOrderChange(ctx, order, { operationId: op.id, operationStatus: 'paused' });
  return {
    productionOrderId: order.id,
    operationId: op.id,
    operationStatus: updatedOp.status,
    orderStatus: order.status,
    actualMinutes: minutes,
  };
}

export async function finishOperationInTx(
  tx: Db,
  ctx: CommandContext,
  cmd: Pick<DomainCommand, 'occurredAt'>,
  order: ProductionOrder,
  input: z.output<typeof finishOperationSchema>
): Promise<OperationResult> {
  const error = orderActionError('finish_operation', order.status);
  if (error) throw new OperationsError('invalid_state', error);
  const op = await loadOrderOperation(tx, order, input.operationId);
  const finishError = operationFinishError(op);
  if (finishError || !op)
    throw new OperationsError('invalid_state', finishError ?? 'Operación inválida');
  const at = instantOf(cmd, ctx.now);
  const measured =
    op.status === 'running'
      ? accumulatedMinutes(op.actualMinutes, await segmentStartOf(tx, op), at)
      : (op.actualMinutes ?? 0);
  const minutes = input.actualMinutes ?? measured;
  await tx.productionOperation.update({
    where: { id: op.id },
    data: { status: 'done', finishedAt: at, actualMinutes: minutes },
  });
  const operations = await loadOperations(tx, order.id);
  const nextStatus = orderStatusAfterOperations(operations);
  const updated =
    nextStatus !== order.status
      ? await tx.productionOrder.update({ where: { id: order.id }, data: { status: nextStatus } })
      : order;
  ctx.emit(
    MANUFACTURING_EVENTS.operationFinished,
    {
      productionOrderId: order.id,
      number: order.number,
      operationId: op.id,
      seq: op.seq,
      name: op.name,
      plannedMinutes: op.plannedMinutes,
      actualMinutes: minutes,
      measuredMinutes: measured,
      reported: input.actualMinutes !== undefined,
      note: input.note ?? null,
      at: at.toISOString(),
    },
    operationEventOptions(order, op)
  );
  let inspectionWorkItemId: string | null = null;
  if (nextStatus === 'inspection') {
    ctx.emit(
      MANUFACTURING_EVENTS.inspectionReady,
      { productionOrderId: order.id, number: order.number },
      orderEventOptions(order)
    );
    const open = await openWorkItemsFor(tx, MANUFACTURING_OBJECT_TYPES.productionOrder, order.id, {
      areaKey: MANUFACTURING_AREA_KEY,
      kind: 'verification',
    });
    inspectionWorkItemId =
      open[0]?.id ??
      (
        await ctx.createWorkItem({
          areaKey: MANUFACTURING_AREA_KEY,
          kind: 'verification',
          title: `Inspeccionar ${order.number}`,
          description: `${order.outputName ?? order.outputZohoItemId}: ${qtyText(order.plannedQty)} ${order.plannedUnit}`,
          caseId: order.caseId,
          objectType: MANUFACTURING_OBJECT_TYPES.productionOrder,
          objectId: order.id,
        })
      ).id;
  } else {
    const facts = await operationFacts(tx, order, operations);
    if (facts.find((candidate) => candidate.id === op.id)?.qcRequired) {
      const open = await openWorkItemsFor(
        tx,
        MANUFACTURING_OBJECT_TYPES.productionOperation,
        op.id,
        {
          areaKey: MANUFACTURING_AREA_KEY,
          kind: 'verification',
        }
      );
      inspectionWorkItemId =
        open[0]?.id ??
        (
          await ctx.createWorkItem({
            areaKey: MANUFACTURING_AREA_KEY,
            kind: 'verification',
            title: `Inspeccionar operación ${op.seq} (${op.name}) de ${order.number}`.slice(0, 200),
            caseId: order.caseId,
            objectType: MANUFACTURING_OBJECT_TYPES.productionOperation,
            objectId: op.id,
          })
        ).id;
    }
  }
  publishOrderChange(ctx, updated, { operationId: op.id, operationStatus: 'done' });
  return {
    productionOrderId: order.id,
    operationId: op.id,
    operationStatus: 'done',
    orderStatus: updated.status,
    actualMinutes: minutes,
    inspectionWorkItemId,
  };
}

// ---------------------------------------------------------------------------
// Consumption
// ---------------------------------------------------------------------------

export interface ConsumptionLineResult {
  zohoItemId: string;
  label: string;
  role: 'planned' | 'declared_substitute' | 'unplanned_substitute';
  quantity: string;
  unit: string;
  posted: PostedConsumption[];
  /** Consumed beyond the assignment (planned inputs). */
  overAssignment: string;
  /** Substitution outside the BOM waiting for approval. */
  approvalRequestId: string | null;
  approvalStatus: string | null;
}

export interface ConsumptionResult {
  productionOrderId: string;
  lines: ConsumptionLineResult[];
}

function valueOf(
  products: Map<string, ProductInfo>,
  zohoItemId: string,
  quantity: Prisma.Decimal
): Prisma.Decimal {
  const rate = products.get(zohoItemId)?.purchaseRate;
  return rate ? quantity.times(rate).toDecimalPlaces(4) : new Prisma.Decimal(0);
}

export async function recordConsumptionInTx(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  input: z.output<typeof recordConsumptionSchema>
): Promise<ConsumptionResult> {
  const error = orderActionError('record_consumption', order.status);
  if (error) throw new OperationsError('invalid_state', error);
  const units = unitsResolver(tx, 'write');
  const recipe = await loadRecipe(tx, order, units);
  const center = order.workCenterId ? await loadWorkCenter(tx, order.workCenterId) : null;
  const warehouseIds = materialWarehouses(order, center);
  const operationIds = new Set((await loadOperations(tx, order.id)).map((op) => op.id));
  const products = await productInfo(tx, [
    ...input.lines.map((line) => line.zohoItemId),
    ...input.lines.map((line) => line.substituteFor).filter((id): id is string => Boolean(id)),
    ...recipe.lines.map((line) => line.inputZohoItemId),
  ]);
  const results: ConsumptionLineResult[] = [];
  for (const line of input.lines) {
    const role = classifyConsumption(recipe.lines, line.zohoItemId, line.substituteFor);
    const label = itemLabel(products, line.zohoItemId);
    if (role.role === 'invalid')
      throw new OperationsError('invalid_payload', `${label}: ${role.message}`);
    if (line.operationId && !operationIds.has(line.operationId)) {
      throw new OperationsError('invalid_payload', 'La operación indicada no pertenece a la orden');
    }
    const item = await units(line.zohoItemId);
    const quantity = convertToBase(line.qty, line.unit, item);
    const base = {
      zohoItemId: line.zohoItemId,
      label,
      role: role.role,
      quantity: qtyText(quantity),
      unit: item.baseUnit,
    };
    if (role.role === 'planned') {
      const drawn = await drawAssigned(tx, ctx, order, {
        zohoItemId: line.zohoItemId,
        quantity,
        baseUnit: item.baseUnit,
        stockItemId: line.stockItemId,
        preferWarehouseId: center?.warehouseId ?? null,
        operationId: line.operationId,
        note: input.note ?? `Consumo de ${order.number}`,
      });
      const extra = drawn.remaining.gt(0)
        ? await consumeUnassigned(tx, ctx, order, {
            zohoItemId: line.zohoItemId,
            quantity: drawn.remaining,
            baseUnit: item.baseUnit,
            warehouseIds,
            kind: 'actual',
            stockItemId: line.stockItemId,
            operationId: line.operationId,
            note: input.note ?? `Consumo adicional de ${order.number}`,
            label,
          })
        : [];
      results.push({
        ...base,
        posted: [...drawn.posted, ...extra],
        overAssignment: qtyText(drawn.remaining),
        approvalRequestId: null,
        approvalStatus: null,
      });
      continue;
    }
    if (role.role === 'declared_substitute') {
      const posted = await consumeUnassigned(tx, ctx, order, {
        zohoItemId: line.zohoItemId,
        quantity,
        baseUnit: item.baseUnit,
        warehouseIds,
        kind: 'substitution',
        substitutedForZohoItemId: role.inputZohoItemId,
        stockItemId: line.stockItemId,
        operationId: line.operationId,
        note: input.note ?? `Sustituto permitido en ${order.number}`,
        label,
      });
      results.push({
        ...base,
        posted,
        overAssignment: '0',
        approvalRequestId: null,
        approvalStatus: null,
      });
      continue;
    }
    // Outside the BOM: recorded as pending, an incident and a business approval BEFORE posting.
    if (line.stockItemId) {
      const stock = await tx.stockItem.findUnique({
        where: { id: line.stockItemId },
        select: { zohoItemId: true },
      });
      if (!stock || stock.zohoItemId !== line.zohoItemId) {
        throw new OperationsError(
          'invalid_payload',
          'La existencia indicada no es de ese material'
        );
      }
    }
    const row = await tx.materialConsumption.create({
      data: {
        productionOrderId: order.id,
        operationId: line.operationId ?? null,
        inputZohoItemId: line.zohoItemId,
        stockItemId: line.stockItemId ?? null,
        qtyPlanned: new Prisma.Decimal(0),
        qtyActual: quantity,
        unit: item.baseUnit,
        kind: 'substitution',
        substitutedForZohoItemId: role.inputZohoItemId,
        recordedByUserId: ctx.actor.id,
      },
    });
    const originalLabel = itemLabel(products, role.inputZohoItemId);
    const { incident } = await ctx.openIncident({
      kind: 'production_substitution',
      areaKey: MANUFACTURING_AREA_KEY,
      title: `Sustitución fuera de lista en ${order.number}: ${label} por ${originalLabel}`.slice(
        0,
        200
      ),
      dedupeKey: `mfg:substitution:${row.id}`,
      severity: 'medium',
      caseId: order.caseId,
      detail: {
        productionOrderId: order.id,
        consumptionId: row.id,
        zohoItemId: line.zohoItemId,
        substitutedForZohoItemId: role.inputZohoItemId,
        quantity: qtyText(quantity),
        unit: item.baseUnit,
      },
    });
    const outcome = await requestApproval(tx, {
      scope: 'production_incident',
      targetType: MANUFACTURING_OBJECT_TYPES.materialConsumption,
      targetId: row.id,
      amount: valueOf(products, line.zohoItemId, quantity),
      currency: 'MXN',
      caseId: order.caseId,
      areaKey: MANUFACTURING_AREA_KEY,
      requestedByUserId: ctx.actor.id,
      title:
        `Sustitución en ${order.number}: ${qtyText(quantity)} ${item.baseUnit} de ${label} en lugar de ${originalLabel}`.slice(
          0,
          200
        ),
      description:
        'Material fuera de la lista de materiales; se descuenta del inventario al aprobarse.',
    });
    await tx.materialConsumption.update({
      where: { id: row.id },
      data: { approvalRequestId: outcome.approvalRequest.id },
    });
    ctx.emit(
      MANUFACTURING_EVENTS.substitutionRequested,
      {
        productionOrderId: order.id,
        number: order.number,
        consumptionId: row.id,
        zohoItemId: line.zohoItemId,
        substitutedForZohoItemId: role.inputZohoItemId,
        quantity: qtyText(quantity),
        unit: item.baseUnit,
        approvalRequestId: outcome.approvalRequest.id,
        approvalStatus: outcome.status,
        incidentId: incident.id,
      },
      orderEventOptions(order)
    );
    results.push({
      ...base,
      posted: [],
      overAssignment: '0',
      approvalRequestId: outcome.approvalRequest.id,
      approvalStatus: outcome.status,
    });
  }
  ctx.emit(
    MANUFACTURING_EVENTS.consumptionRecorded,
    {
      productionOrderId: order.id,
      number: order.number,
      lines: results.map((line) => ({
        zohoItemId: line.zohoItemId,
        role: line.role,
        quantity: line.quantity,
        unit: line.unit,
        movements: line.posted.map((posted) => posted.movementId),
        overAssignment: line.overAssignment,
        approvalRequestId: line.approvalRequestId,
      })),
      note: input.note ?? null,
    },
    orderEventOptions(order)
  );
  publishOrderChange(ctx, order, { consumption: true });
  return { productionOrderId: order.id, lines: results };
}

/** Reaction to the decision on a substitution outside the BOM (inside the deciding transaction). */
export async function handleSubstitutionDecision(
  tx: Db,
  event: ApprovalDecidedEvent
): Promise<void> {
  const row = await tx.materialConsumption.findUnique({
    where: { id: event.approvalRequest.targetId },
  });
  if (!row || row.kind !== 'substitution' || row.stockMovementId) return;
  const order = await tx.productionOrder.findUnique({ where: { id: row.productionOrderId } });
  if (!order) return;
  const ctx = event.ctx;
  if (!event.auto) await touchOrder(tx, order.id);
  await tx.materialConsumption.update({
    where: { id: row.id },
    data: { approvalRequestId: event.approvalRequest.id },
  });
  const payload = {
    productionOrderId: order.id,
    number: order.number,
    consumptionId: row.id,
    approvalRequestId: event.approvalRequest.id,
    zohoItemId: row.inputZohoItemId,
    substitutedForZohoItemId: row.substitutedForZohoItemId,
    quantity: qtyText(row.qtyActual),
    unit: row.unit,
    decidedByUserId: event.decidedByUserId,
  };
  if (event.status === 'rejected') {
    ctx.emit(
      MANUFACTURING_EVENTS.substitutionRejected,
      { ...payload, reason: 'rejected' },
      orderEventOptions(order)
    );
    publishOrderChange(ctx, order, { substitution: 'rejected' });
    return;
  }
  if (!isOpenOrderStatus(order.status)) {
    ctx.emit(
      MANUFACTURING_EVENTS.substitutionRejected,
      { ...payload, reason: 'order_closed' },
      orderEventOptions(order)
    );
    return;
  }
  const center = order.workCenterId ? await loadWorkCenter(tx, order.workCenterId) : null;
  const products = await productInfo(tx, [row.inputZohoItemId]);
  try {
    const posted = await consumeUnassigned(tx, ctx, order, {
      zohoItemId: row.inputZohoItemId,
      quantity: new Prisma.Decimal(row.qtyActual),
      baseUnit: row.unit,
      warehouseIds: materialWarehouses(order, center),
      kind: 'substitution',
      stockItemId: row.stockItemId,
      substitutedForZohoItemId: row.substitutedForZohoItemId,
      operationId: row.operationId,
      approvalRequestId: event.approvalRequest.id,
      consumptionId: row.id,
      note: `Sustitución aprobada en ${order.number}`,
      label: itemLabel(products, row.inputZohoItemId),
    });
    ctx.emit(
      MANUFACTURING_EVENTS.substitutionPosted,
      { ...payload, movements: posted.map((part) => part.movementId) },
      orderEventOptions(order)
    );
    publishOrderChange(ctx, order, { substitution: 'posted' });
  } catch (err) {
    // The plan is validated before any movement is written, so nothing partial remains.
    if (!isOperationsError(err)) throw err;
    await ctx.openIncident({
      kind: 'production_substitution',
      areaKey: MANUFACTURING_AREA_KEY,
      title: `No se pudo descontar la sustitución aprobada en ${order.number}`.slice(0, 200),
      dedupeKey: `mfg:substitution-post:${row.id}`,
      severity: 'high',
      caseId: order.caseId,
      detail: { ...payload, error: err.message },
    });
    ctx.emit(
      MANUFACTURING_EVENTS.substitutionRejected,
      { ...payload, reason: 'posting_failed', error: err.message },
      orderEventOptions(order)
    );
  }
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export interface InspectionResult {
  productionOrderId: string;
  qualityCheckId: string;
  result: string;
  orderStatus: string;
  incidentId: string | null;
  reworkOperationId: string | null;
}

export async function inspectInTx(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  input: z.output<typeof inspectSchema>
): Promise<InspectionResult> {
  const error = orderActionError('inspect', order.status);
  if (error) throw new OperationsError('invalid_state', error);
  const operations = await loadOperations(tx, order.id);
  const op = input.operationId
    ? operations.find((candidate) => candidate.id === input.operationId)
    : null;
  if (input.operationId) {
    if (!op) throw new OperationsError('not_found', 'La operación no pertenece a la orden');
    if (op.status !== 'done')
      throw new OperationsError('invalid_state', 'Inspecciona la operación cuando esté terminada');
  } else if (order.status !== 'inspection') {
    throw new OperationsError(
      'invalid_state',
      'La orden se inspecciona cuando todas sus operaciones terminaron'
    );
  }
  const evidence = [...new Set(input.evidenceObjectIds ?? [])];
  if (evidence.length > 0) {
    const found = await tx.storageObject.findMany({
      where: { id: { in: evidence } },
      select: { id: true },
    });
    if (found.length !== evidence.length) {
      throw new OperationsError('evidence_invalid', 'Alguna evidencia de la inspección no existe');
    }
  }
  const check = await tx.qualityCheck.create({
    data: {
      productionOrderId: order.id,
      operationId: op?.id ?? null,
      result: input.result,
      ...(input.checklist ? { checklist: toOperationalJson(input.checklist) } : {}),
      notes: input.notes ?? null,
      evidenceObjectIds: evidence,
      inspectedByUserId: ctx.actor.id,
      inspectedAt: ctx.now,
    },
  });
  const pendingChecks = op
    ? await openWorkItemsFor(tx, MANUFACTURING_OBJECT_TYPES.productionOperation, op.id, {
        kind: 'verification',
      })
    : await openWorkItemsFor(tx, MANUFACTURING_OBJECT_TYPES.productionOrder, order.id, {
        areaKey: MANUFACTURING_AREA_KEY,
        kind: 'verification',
      });
  await closeWorkItems(tx, pendingChecks, 'complete', `Inspección ${input.result}`);

  let incidentId: string | null = null;
  let reworkOperationId: string | null = null;
  let orderStatus = order.status;
  if (input.result === 'fail') {
    const failed = (input.checklist ?? []).filter((entry) => !entry.ok).map((entry) => entry.item);
    const { incident } = await ctx.openIncident({
      kind: 'quality_failure',
      areaKey: MANUFACTURING_AREA_KEY,
      title: `Falla de calidad en ${order.number}${op ? ` (operación ${op.seq})` : ''}`.slice(
        0,
        200
      ),
      dedupeKey: `mfg:qc:${check.id}`,
      severity: 'high',
      caseId: order.caseId,
      detail: {
        productionOrderId: order.id,
        qualityCheckId: check.id,
        operationId: op?.id ?? null,
        notes: input.notes ?? null,
        failed,
      },
    });
    incidentId = incident.id;
    const placement = reworkPlacement(operations, op?.id ?? null);
    for (const change of placement.renumber) {
      await tx.productionOperation.update({ where: { id: change.id }, data: { seq: change.seq } });
    }
    const reference = op ?? sortOperations(operations)[operations.length - 1];
    const rework = await tx.productionOperation.create({
      data: {
        productionOrderId: order.id,
        seq: placement.seq,
        workCenterId: reference.workCenterId,
        name: `Retrabajo: ${input.reworkOperationName ?? reference.name}`.slice(0, 120),
        status: 'pending',
        plannedMinutes: input.reworkMinutes ?? null,
        plannedStartAt: ctx.now,
      },
    });
    reworkOperationId = rework.id;
    if (order.status !== 'in_progress') {
      await tx.productionOrder.update({ where: { id: order.id }, data: { status: 'in_progress' } });
      orderStatus = 'in_progress';
    }
    ctx.emit(
      MANUFACTURING_EVENTS.reworkAdded,
      {
        productionOrderId: order.id,
        number: order.number,
        reworkOperationId: rework.id,
        seq: rework.seq,
        qualityCheckId: check.id,
        incidentId,
      },
      orderEventOptions(order)
    );
  } else if (!op) {
    await tx.productionOrder.update({
      where: { id: order.id },
      data: { status: 'completed', completedAt: order.completedAt ?? ctx.now },
    });
    orderStatus = 'completed';
  }
  ctx.emit(
    MANUFACTURING_EVENTS.inspected,
    {
      productionOrderId: order.id,
      number: order.number,
      qualityCheckId: check.id,
      operationId: op?.id ?? null,
      result: input.result,
      orderStatus,
      incidentId,
      reworkOperationId,
      evidence: evidence.length,
    },
    orderEventOptions(order)
  );
  publishOrderChange(
    ctx,
    { ...order, status: orderStatus },
    { qualityCheckId: check.id, result: input.result }
  );
  return {
    productionOrderId: order.id,
    qualityCheckId: check.id,
    result: input.result,
    orderStatus,
    incidentId,
    reworkOperationId,
  };
}

// ---------------------------------------------------------------------------
// Outputs and scrap
// ---------------------------------------------------------------------------

export interface ScrapReviewOutcome {
  approvalRequestId: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'no_approvers';
  incidentId: string | null;
}

/** Opens the excess-scrap incident and business approval of an order (reused while pending). */
export async function requestScrapApprovalInTx(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  facts: ProductionFacts,
  note: string | null
): Promise<ScrapReviewOutcome> {
  const products = await productInfo(
    tx,
    facts.scrap.lines.map((line) => line.zohoItemId)
  );
  const exceeded = facts.scrap.lines.filter((line) => line.exceeded);
  const summary = exceeded
    .map(
      (line) =>
        `${itemLabel(products, line.zohoItemId)}: ${qtyText(line.scrap)} de ${qtyText(line.basis)} (${line.pct ?? '—'} %)`
    )
    .join('; ');
  const amount = facts.scrap.lines.reduce(
    (sum, line) => sum.plus(valueOf(products, line.zohoItemId, new Prisma.Decimal(line.scrap))),
    new Prisma.Decimal(0)
  );
  const maxPct = facts.scrap.maxPct ?? 0;
  // Plan 6.6: "merma fuera de tolerancia" avisa a quien espera la orden; los
  // aprobadores reciben aparte su `approval_requested`.
  await notifyProductionUpdate(ctx, order, {
    type: 'production_scrap_exceeded',
    title: `Merma fuera de tolerancia en ${order.number}: ${maxPct} %`,
    body: `Tolerancia ${facts.scrap.allowancePct} %. ${summary || 'La liberación queda detenida hasta que se apruebe la merma.'}`,
  });
  const { incident } = await ctx.openIncident({
    kind: 'excess_scrap',
    areaKey: MANUFACTURING_AREA_KEY,
    title:
      `Merma fuera de tolerancia en ${order.number}: ${maxPct} % (tolerancia ${facts.scrap.allowancePct} %)`.slice(
        0,
        200
      ),
    dedupeKey: `mfg:scrap:${order.id}:${facts.scrapApprovals.length + 1}`,
    severity: 'high',
    caseId: order.caseId,
    detail: {
      productionOrderId: order.id,
      allowancePct: facts.scrap.allowancePct,
      lines: facts.scrap.lines,
      note,
    },
  });
  try {
    const outcome = await requestApproval(tx, {
      scope: 'production_incident',
      targetType: MANUFACTURING_OBJECT_TYPES.scrapReview,
      targetId: order.id,
      amount,
      currency: 'MXN',
      caseId: order.caseId,
      areaKey: MANUFACTURING_AREA_KEY,
      requestedByUserId: ctx.actor.id,
      title:
        `Merma de ${order.number}: ${maxPct} % sobre una tolerancia de ${facts.scrap.allowancePct} %`.slice(
          0,
          200
        ),
      description: [summary, note].filter(Boolean).join('. ').slice(0, 1000) || null,
    });
    ctx.emit(
      MANUFACTURING_EVENTS.scrapExceeded,
      {
        productionOrderId: order.id,
        number: order.number,
        approvalRequestId: outcome.approvalRequest.id,
        approvalStatus: outcome.status,
        incidentId: incident.id,
        maxPct,
        allowancePct: facts.scrap.allowancePct,
        lines: exceeded,
      },
      orderEventOptions(order)
    );
    return {
      approvalRequestId: outcome.approvalRequest.id,
      status: outcome.status,
      incidentId: incident.id,
    };
  } catch (err) {
    // Nobody can approve: the incident stays open and the release remains blocked.
    if (!isOperationsError(err) || err.code !== 'no_approvers') throw err;
    ctx.emit(
      MANUFACTURING_EVENTS.scrapExceeded,
      {
        productionOrderId: order.id,
        number: order.number,
        approvalRequestId: null,
        approvalStatus: 'no_approvers',
        incidentId: incident.id,
        maxPct,
        allowancePct: facts.scrap.allowancePct,
        lines: exceeded,
      },
      orderEventOptions(order)
    );
    return { approvalRequestId: null, status: 'no_approvers', incidentId: incident.id };
  }
}

/** Reaction to the decision on excess scrap: the release gate reads the approval itself. */
export async function handleScrapDecision(tx: Db, event: ApprovalDecidedEvent): Promise<void> {
  const order = await tx.productionOrder.findUnique({
    where: { id: event.approvalRequest.targetId },
  });
  if (!order) return;
  if (!event.auto) await touchOrder(tx, order.id);
  const approved = event.status === 'approved';
  event.ctx.emit(
    approved ? MANUFACTURING_EVENTS.scrapApproved : MANUFACTURING_EVENTS.scrapRejected,
    {
      productionOrderId: order.id,
      number: order.number,
      approvalRequestId: event.approvalRequest.id,
      decidedByUserId: event.decidedByUserId,
      auto: event.auto,
    },
    orderEventOptions(order)
  );
  publishOrderChange(event.ctx, order, { scrapApproval: event.status });
}

export interface OutputResult {
  productionOrderId: string;
  outputId: string;
  kind: string;
  zohoItemId: string;
  quantity: string;
  unit: string;
  movementId: string;
  stockItemId: string;
  containerKey: string;
  producedQty: string;
  scrapQty: string;
  leftoverQty: string;
  scrap: {
    exceeded: boolean;
    pending: boolean;
    maxPct: number | null;
    approvalRequestId: string | null;
    approvalStatus: string | null;
  } | null;
}

export async function recordOutputInTx(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  input: z.output<typeof recordOutputSchema>
): Promise<OutputResult> {
  const finished = input.kind === 'finished';
  const error = orderActionError(
    finished ? 'record_finished_output' : 'record_other_output',
    order.status
  );
  if (error) throw new OperationsError('invalid_state', error);
  const units = unitsResolver(tx, 'write');
  const recipe = await loadRecipe(tx, order, units);
  const inputIds = recipe.lines.map((line) => line.inputZohoItemId);
  const substituteRows = await tx.materialConsumption.findMany({
    where: { productionOrderId: order.id, kind: 'substitution', stockMovementId: { not: null } },
    select: { inputZohoItemId: true },
  });
  const substituteIds = substituteRows.map((row) => row.inputZohoItemId);

  let zohoItemId: string;
  let warehouseId: string;
  let variantKey: string | undefined;
  let qualityCheckId: string | null = null;
  if (finished) {
    zohoItemId = input.zohoItemId ?? order.outputZohoItemId;
    if (zohoItemId !== order.outputZohoItemId) {
      throw new OperationsError(
        'invalid_payload',
        'El producto terminado debe ser el producto de la orden'
      );
    }
    warehouseId = order.outputWarehouseId;
    const demand = order.demandId
      ? await tx.caseDemand.findUnique({
          where: { id: order.demandId },
          select: { variantKey: true },
        })
      : null;
    variantKey = demand?.variantKey ?? '';
    const check = await tx.qualityCheck.findFirst({
      where: {
        productionOrderId: order.id,
        operationId: null,
        result: { in: ['pass', 'conditional'] },
      },
      orderBy: [{ inspectedAt: 'desc' }],
      select: { id: true },
    });
    qualityCheckId = check?.id ?? null;
  } else {
    const fallback = inputIds.length === 1 ? inputIds[0] : null;
    const chosen = input.zohoItemId ?? fallback;
    if (!chosen)
      throw new OperationsError('invalid_payload', 'Indica el material del sobrante o la merma');
    zohoItemId = chosen;
    const allowed = new Set([
      ...inputIds,
      ...substituteIds,
      ...(input.kind === 'scrap' ? [order.outputZohoItemId] : []),
    ]);
    if (!allowed.has(zohoItemId)) {
      throw new OperationsError(
        'invalid_payload',
        input.kind === 'leftover'
          ? 'El sobrante debe ser de un material que consumió la orden'
          : 'La merma debe ser de un material de la orden o de su producto'
      );
    }
    const center = order.workCenterId ? await loadWorkCenter(tx, order.workCenterId) : null;
    warehouseId = center?.warehouseId ?? order.outputWarehouseId;
  }

  const item = await units(zohoItemId);
  const quantity = convertToBase(input.qty, input.unit, item);
  const movement = await recordInventoryMovement(
    tx,
    {
      kind: 'produce',
      zohoItemId,
      warehouseId,
      locationId: finished && !input.locationCode ? order.outputLocationId : null,
      locationCode: input.kind === 'scrap' ? SCRAP_LOCATION_CODE : (input.locationCode ?? null),
      ...(variantKey !== undefined ? { variantKey } : {}),
      quantity,
      unit: item.baseUnit,
      referenceType: 'production_order',
      referenceId: order.id,
      originProductionOrderId: order.id,
      dimensions: input.kind === 'leftover' ? (input.dimensions ?? null) : null,
      note: input.reason ?? null,
      caseId: order.caseId,
    },
    ctx
  );
  const output = await tx.productionOutput.create({
    data: {
      productionOrderId: order.id,
      kind: input.kind,
      zohoItemId,
      qty: quantity,
      unit: item.baseUnit,
      ...(input.kind === 'leftover' && input.dimensions
        ? { dimensions: toOperationalJson(input.dimensions) }
        : {}),
      stockMovementId: movement.movement.id,
      stockItemId: movement.stockItem.id,
      locationId: movement.stockItem.locationId,
      qualityCheckId,
      recordedByUserId: ctx.actor.id,
    },
  });
  const data: Prisma.ProductionOrderUpdateInput = {};
  if (finished) {
    const outputUnits = await units(order.outputZohoItemId);
    data.producedQty = {
      increment: quantity.dividedBy(unitFactor(order.plannedUnit, outputUnits)).toDecimalPlaces(4),
    };
  } else if (input.kind === 'scrap') data.scrapQty = { increment: quantity };
  else data.leftoverQty = { increment: quantity };
  const updated = await tx.productionOrder.update({ where: { id: order.id }, data });
  ctx.emit(
    MANUFACTURING_EVENTS.outputRecorded,
    {
      productionOrderId: order.id,
      number: order.number,
      outputId: output.id,
      kind: input.kind,
      zohoItemId,
      quantity: qtyText(quantity),
      unit: item.baseUnit,
      movementId: movement.movement.id,
      stockItemId: movement.stockItem.id,
      containerKey: movement.createdContainerKey || movement.stockItem.containerKey,
      dimensions: input.dimensions ?? null,
      qualityCheckId,
      reason: input.reason ?? null,
    },
    orderEventOptions(order)
  );

  let scrap: OutputResult['scrap'] = null;
  if (input.kind === 'scrap') {
    const facts = await loadProductionFacts(tx, updated, units);
    let approvalRequestId: string | null = facts.scrapApprovals.at(-1)?.id ?? null;
    let approvalStatus: string | null = facts.scrapApprovals.at(-1)?.status ?? null;
    if (
      facts.scrap.exceeded &&
      (facts.scrapApproval === 'none' || facts.scrapApproval === 'stale')
    ) {
      const outcome = await requestScrapApprovalInTx(tx, ctx, updated, facts, input.reason ?? null);
      approvalRequestId = outcome.approvalRequestId;
      approvalStatus = outcome.status;
    }
    scrap = {
      exceeded: facts.scrap.exceeded,
      pending: facts.scrap.pending,
      maxPct: facts.scrap.maxPct,
      approvalRequestId: facts.scrap.exceeded ? approvalRequestId : null,
      approvalStatus: facts.scrap.exceeded ? approvalStatus : null,
    };
  }
  publishOrderChange(ctx, updated, { outputKind: input.kind });
  return {
    productionOrderId: order.id,
    outputId: output.id,
    kind: input.kind,
    zohoItemId,
    quantity: qtyText(quantity),
    unit: item.baseUnit,
    movementId: movement.movement.id,
    stockItemId: movement.stockItem.id,
    containerKey: movement.createdContainerKey || movement.stockItem.containerKey,
    producedQty: qtyText(updated.producedQty),
    scrapQty: qtyText(updated.scrapQty),
    leftoverQty: qtyText(updated.leftoverQty),
    scrap,
  };
}

export async function requestScrapReviewInTx(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  input: z.output<typeof scrapReviewSchema>
): Promise<ScrapReviewOutcome> {
  const error = orderActionError('request_scrap_review', order.status);
  if (error) throw new OperationsError('invalid_state', error);
  const facts = await loadProductionFacts(tx, order, unitsResolver(tx, 'write'));
  if (!facts.scrap.exceeded) {
    throw new OperationsError('invalid_state', 'La merma de la orden está dentro de la tolerancia');
  }
  if (facts.scrapApproval === 'pending') {
    throw manufacturingError('approval_pending', 'La merma ya tiene una aprobación pendiente');
  }
  if (facts.scrapApproval === 'approved') {
    throw new OperationsError('approval_closed', 'La merma ya fue aprobada');
  }
  const outcome = await requestScrapApprovalInTx(tx, ctx, order, facts, input.reason);
  if (outcome.status === 'no_approvers') {
    throw new OperationsError(
      'no_approvers',
      'No hay quién pueda aprobar incidencias de producción'
    );
  }
  publishOrderChange(ctx, order, { scrapApprovalRequestId: outcome.approvalRequestId });
  return outcome;
}

export { num };
