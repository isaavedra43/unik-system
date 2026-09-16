import {
  type GoodsReceipt,
  type GoodsReceiptLine,
  type ProcurementOrder,
  type ProcurementOrderLine,
} from '@prisma/client';
import { z } from 'zod';
import { procurementOrderLink } from '@/modules/areas/area-links';
import { recordInventoryMovement, reserveStock } from '@/modules/inventory/inventory-service';
import { getOrCreateProfile, toUnitProfile } from '@/modules/inventory/profiles-service';
import { createDeliveryOrder, recordDelivery } from '@/modules/logistics/delivery-service';
import { DELIVERY_ORDER_OPEN_STATUSES } from '@/modules/logistics/types';
import {
  isAreaRequestOpenStatus,
  transitionAreaRequestInTx,
} from '@/modules/operations/area-requests-service';
import type { CommandContext } from '@/modules/operations/commands';
import { OperationsError, isOperationsError } from '@/modules/operations/errors';
import { transitionIncidentInTx } from '@/modules/operations/incidents-service';
import {
  INCIDENT_OPEN_STATUSES,
  OPS_EVENTS,
  WORK_ITEM_OPEN_STATUSES,
} from '@/modules/operations/types';
import { completeWorkItemInTx } from '@/modules/operations/work-items-service';
import {
  QTY_EPS,
  checkReceiveOrder,
  classifyReceiptLine,
  computeOrderTotals,
  distributeFifo,
  lineStatusAfterReceipt,
  receiptReservationCap,
  statusAfterReceipt,
  type OrderStatus,
} from './orders-state';
import {
  loadOrder,
  loadOrderLines,
  orderCaseIds,
  releaseAllocationsExpectation,
} from './orders-service';
import {
  D,
  actorUserId,
  assertActorHasAny,
  assertFoundRow,
  emitPurchases,
  nextFolio,
  num,
  publishBoard,
  purchaseNotificationCategory,
  recordActorId,
  round4,
  throwCheck,
  truncate,
  type Db,
} from './purchases-helpers';
import {
  idText,
  isoDateText,
  nonNegativeQty,
  optionalText,
  positiveQty,
  toDate,
} from './purchases-schemas';
import {
  DIFFERENCE_KINDS,
  DIFFERENCE_KIND_LABELS,
  DIFFERENCE_RESOLUTIONS,
  DIFFERENCE_RESOLUTION_LABELS,
  PURCHASES_AREA_KEY,
  PURCHASES_EVENTS,
  PURCHASES_JOB_TYPES,
  PURCHASES_OBJECT_TYPES,
  labelOf,
  type DifferenceKind,
} from './purchases-types';
import {
  SHORTFALL_LINE_RELATION,
  addRequestLineReceived,
  adjustRequestLineOrdered,
  openShortfallRequests,
  recomputeRequestStatuses,
} from './requests-service';

import { resolveUnitFactor } from './unit-normalizer';

/**
 * Goods receipts and direct supplier deliveries (plan 6.1, `receipts-service`).
 *
 * Inviolable rule: expected material is never available. Only a posted
 * receipt moves the inventory (`recordInventoryMovement(receipt)` for the
 * accepted quantity) and only then the demand allocated to the order line is
 * reserved at once (`reserveStock` backed by that movement); an allocation is
 * `ready` when its reservations cover it, which lets the case close
 * `esperar_recepcion` and move on.
 *
 * Differences (short declared, damaged/rejected, over, wrong item) open a
 * `purchase_difference` incident plus a `resolve_difference` request to Compras
 * (a work item without case) and, when a sale is delayed, a `customer_notice`
 * to Ventas. `confirmDirectDelivery` records the supplier delivery without
 * stock movement and hands the delivery (evidence included) to logistics
 * through a durable system job that calls `recordDelivery`.
 */

const OBJ = PURCHASES_OBJECT_TYPES;
const EV = PURCHASES_EVENTS.receipt;
const RECEIPT_OBJECT_STATUSES_OK = ['ready', 'validating'];
const RESERVABLE_ALLOCATION_STATUSES = ['planned', 'requested', 'in_progress'];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const receiptLineInputSchema = z.object({
  orderLineId: idText,
  qtyReceived: nonNegativeQty,
  qtyRejected: nonNegativeQty.nullish(),
  qtyAccepted: nonNegativeQty.nullish(),
  differenceKind: z.enum(DIFFERENCE_KINDS).nullish(),
  lotCode: optionalText(80),
});

export const recordReceiptSchema = z.object({
  orderId: idText,
  warehouseId: idText.nullish(),
  locationId: idText.nullish(),
  receivedAt: isoDateText.nullish(),
  notes: optionalText(1000),
  evidenceObjectIds: z.array(idText).max(20).default([]),
  /** false keeps it as a draft (post later with `purchases.receipt.post`). */
  post: z.boolean().default(true),
  lines: z.array(receiptLineInputSchema).min(1, 'Registra al menos una partida').max(200),
});
export type RecordReceiptInput = z.output<typeof recordReceiptSchema>;

export const postReceiptSchema = z.object({ receiptId: idText });

export const resolveDifferenceSchema = z.object({
  receiptLineId: idText,
  resolution: z.enum(DIFFERENCE_RESOLUTIONS),
  note: z.string().trim().min(3, 'Describe cómo se resolvió').max(1000),
  /** For `credit`: quantity removed from the order (default: everything still pending). */
  creditQty: positiveQty.nullish(),
});

export const confirmDirectDeliverySchema = z.object({
  orderId: idText,
  lines: z
    .array(
      z.object({
        orderLineId: idText,
        qtyDelivered: nonNegativeQty,
        /** What went wrong on the site: the supplier will not bring the rest, it arrived damaged or it is another item. */
        difference: z.enum(['short', 'damaged', 'wrong_item']).nullish(),
      })
    )
    .min(1, 'Indica lo que entregó el proveedor')
    .max(200),
  receivedBy: z.string().trim().min(1, 'Indica quién recibió').max(200),
  evidenceObjectIds: z.array(idText).min(1, 'Sube la evidencia de entrega (foto o firma)').max(20),
  note: optionalText(1000),
  deliveredAt: isoDateText.nullish(),
});
export type ConfirmDirectDeliveryInput = z.output<typeof confirmDirectDeliverySchema>;

export const directDeliveryPlanSchema = z.object({
  receiptId: idText,
  receivedBy: z.string().trim().min(1).max(200),
  note: z.string().max(1000).nullish(),
  evidenceObjectIds: z.array(idText).max(20),
  deliveries: z
    .array(
      z.object({
        caseId: idText,
        allocationId: idText,
        deliveredQty: z.number().finite().positive(),
      })
    )
    .max(400),
});
export type DirectDeliveryPlan = z.output<typeof directDeliveryPlanSchema>;

export const directSyncFailedSchema = z.object({
  receiptId: idText,
  message: z.string().trim().min(1).max(1000),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Evidence of a receipt: uploaded to this order (EvidenceLink) or by the actor, bytes present. */
export async function assertReceiptEvidence(
  tx: Db,
  orderId: string,
  objectIds: readonly string[],
  ctx: Pick<CommandContext, 'actor'>
): Promise<void> {
  const ids = [...new Set(objectIds)];
  if (ids.length === 0) return;
  const objects = await tx.storageObject.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, createdBy: true },
  });
  const links = await tx.evidenceLink.findMany({
    where: { objectType: OBJ.order, objectId: orderId, storageObjectId: { in: ids } },
    select: { storageObjectId: true },
  });
  const linked = new Set(links.map((l) => l.storageObjectId));
  for (const id of ids) {
    const object = objects.find((o) => o.id === id);
    if (!object || !RECEIPT_OBJECT_STATUSES_OK.includes(object.status)) {
      throw new OperationsError(
        'evidence_invalid',
        'Alguna evidencia no está disponible; vuelve a subirla'
      );
    }
    if (!linked.has(id) && object.createdBy !== ctx.actor.id) {
      throw new OperationsError(
        'evidence_invalid',
        'Alguna evidencia no pertenece a esta orden de compra'
      );
    }
  }
}

interface LineAllocationContext {
  procurementAllocationId: string;
  procurementQty: number;
  /** Base units this order line already committed to this allocation in earlier direct deliveries. */
  directDeliveredQty: number;
  requestLineId: string | null;
  demand: {
    id: string;
    caseId: string;
    variantKey: string;
    baseUnit: string;
    name: string;
    zohoItemId: string | null;
  };
  allocation: {
    id: string;
    status: string;
    source: string;
    quantity: number;
    deliveredQuantity: number;
    stockReservationId: string | null;
    linkedId: string | null;
  } | null;
  promisedAt: Date | null;
}

async function lineAllocations(tx: Db, orderLineId: string): Promise<LineAllocationContext[]> {
  const rows = await tx.procurementAllocation.findMany({
    where: { orderLineId },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return [];
  const demands = await tx.caseDemand.findMany({
    where: { id: { in: rows.map((r) => r.demandId) } },
  });
  const allocationIds = rows
    .map((r) => r.demandAllocationId)
    .filter((id): id is string => Boolean(id));
  const allocations = allocationIds.length
    ? await tx.demandAllocation.findMany({ where: { id: { in: allocationIds } } })
    : [];
  const cases = await tx.operationalCase.findMany({
    where: { id: { in: [...new Set(demands.map((d) => d.caseId))] } },
    select: { id: true, promisedAt: true },
  });
  const out: LineAllocationContext[] = [];
  for (const row of rows) {
    const demand = demands.find((d) => d.id === row.demandId);
    if (!demand) continue;
    const allocation = allocations.find((a) => a.id === row.demandAllocationId) ?? null;
    out.push({
      procurementAllocationId: row.id,
      procurementQty: num(row.qty),
      directDeliveredQty: num(row.directDeliveredQty),
      requestLineId: row.requestLineId,
      demand: {
        id: demand.id,
        caseId: demand.caseId,
        variantKey: demand.variantKey,
        baseUnit: demand.baseUnit,
        name: demand.name,
        zohoItemId: demand.zohoItemId,
      },
      allocation: allocation
        ? {
            id: allocation.id,
            status: allocation.status,
            source: allocation.source,
            quantity: num(allocation.quantity),
            deliveredQuantity: num(allocation.deliveredQuantity),
            stockReservationId: allocation.stockReservationId,
            linkedId: allocation.linkedId,
          }
        : null,
      promisedAt: cases.find((c) => c.id === demand.caseId)?.promisedAt ?? null,
    });
  }
  // The sale promised first gets the material first.
  return out.sort(
    (a, b) =>
      (a.promisedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
      (b.promisedAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
  );
}

async function reservedForAllocation(tx: Db, allocationId: string): Promise<number> {
  const rows = await tx.stockReservation.findMany({
    where: { allocationId, status: { in: ['active', 'consumed'] } },
    select: { quantity: true },
  });
  return round4(rows.reduce((sum, row) => sum + num(row.quantity), 0));
}

async function openDifferenceCount(tx: Db, orderId: string): Promise<number> {
  const lines = await tx.goodsReceiptLine.findMany({
    where: { receipt: { orderId }, incidentId: { not: null } },
    select: { incidentId: true },
  });
  if (lines.length === 0) return 0;
  return tx.incident.count({
    where: {
      id: { in: lines.map((l) => l.incidentId!) },
      status: { in: [...INCIDENT_OPEN_STATUSES] },
    },
  });
}

async function refreshOrderStatus(tx: Db, order: ProcurementOrder): Promise<ProcurementOrder> {
  const lines = await loadOrderLines(tx, order.id);
  const status = statusAfterReceipt(
    order.status as OrderStatus,
    lines.map((l) => ({ qty: num(l.qty), qtyReceived: num(l.qtyAccepted), status: l.status })),
    await openDifferenceCount(tx, order.id)
  );
  if (status === order.status) return order;
  // Every caller runs in a command whose aggregate is the order (the engine bumps its version).
  return tx.procurementOrder.update({ where: { id: order.id }, data: { status } });
}

/** Relation receipt line → stock reservation it created (what each order line supplied to each allocation). */
const RECEIPT_RESERVATION_RELATION = 'reserved_for';

/** Base quantity reserved per allocation by earlier receipts of an order line (active or already consumed). */
async function suppliedByOrderLine(
  tx: Db,
  orderLineId: string,
  excludeReceiptLineId: string
): Promise<Map<string, number>> {
  const supplied = new Map<string, number>();
  const receiptLines = await tx.goodsReceiptLine.findMany({
    where: { orderLineId, id: { not: excludeReceiptLineId } },
    select: { id: true },
  });
  if (receiptLines.length === 0) return supplied;
  const relations = await tx.objectRelation.findMany({
    where: {
      fromType: OBJ.receiptLine,
      fromId: { in: receiptLines.map((line) => line.id) },
      toType: 'stock_reservation',
      relation: RECEIPT_RESERVATION_RELATION,
      validTo: null,
    },
    select: { toId: true },
  });
  if (relations.length === 0) return supplied;
  const reservations = await tx.stockReservation.findMany({
    where: {
      id: { in: relations.map((relation) => relation.toId) },
      status: { in: ['active', 'consumed'] },
    },
    select: { allocationId: true, quantity: true },
  });
  for (const reservation of reservations) {
    if (!reservation.allocationId) continue;
    supplied.set(
      reservation.allocationId,
      round4((supplied.get(reservation.allocationId) ?? 0) + num(reservation.quantity))
    );
  }
  return supplied;
}

/**
 * Resolves the shortfall requests that no demand allocation tracks (a
 * `material_shortfall` of Manufactura, a manual request) once every live
 * purchase request line created for them is fully received.
 */
async function resolveReceivedShortfalls(
  tx: Db,
  requestLineIds: readonly string[],
  answer: string,
  data: Record<string, unknown>
): Promise<string[]> {
  const resolved: string[] = [];
  for (const request of await openShortfallRequests(tx, { requestLineIds })) {
    const tracked = await tx.demandAllocation.count({
      where: { linkedType: 'area_request', linkedId: request.id },
    });
    if (tracked > 0) continue;
    const relations = await tx.objectRelation.findMany({
      where: {
        fromType: 'area_request',
        fromId: request.id,
        toType: OBJ.requestLine,
        relation: SHORTFALL_LINE_RELATION,
        validTo: null,
      },
      select: { toId: true },
    });
    const lines = relations.length
      ? await tx.purchaseRequestLine.findMany({
          where: { id: { in: relations.map((relation) => relation.toId) } },
        })
      : [];
    const live = lines.filter((line) => line.status !== 'cancelled');
    if (
      live.length === 0 ||
      !live.every((line) => num(line.qtyReceived) + QTY_EPS >= num(line.qty))
    )
      continue;
    await transitionAreaRequestInTx(tx, request, 'resolve', { answer, data });
    resolved.push(request.id);
  }
  return resolved;
}

interface DifferenceContext {
  receipt: GoodsReceipt;
  order: ProcurementOrder;
  orderLine: ProcurementOrderLine;
  receiptLine: GoodsReceiptLine;
  kind: DifferenceKind;
  caseId: string | null;
  /** Area that received the goods: the warehouse (inventario) or a direct delivery (logistica). */
  fromAreaKey: 'inventario' | 'logistica';
  hasAllocations: boolean;
  accepted: number;
  rejected: number;
  overQty: number;
}

/** Incident `purchase_difference` + `resolve_difference` to Compras (or a work item without a case). */
async function openReceiptDifferenceInTx(
  tx: Db,
  ctx: CommandContext,
  input: DifferenceContext
): Promise<{ incidentId: string; areaRequestId: string | null; workItemId: string | null }> {
  const { receipt, order, orderLine, receiptLine, kind, caseId } = input;
  const label = DIFFERENCE_KIND_LABELS[kind];
  const { incident } = await ctx.openIncident({
    kind: 'purchase_difference',
    areaKey: PURCHASES_AREA_KEY,
    severity: input.hasAllocations && kind !== 'over' ? 'high' : 'medium',
    title: truncate(`${label} en ${receipt.number}: ${orderLine.description}`, 200),
    dedupeKey: `purchases.difference:${receiptLine.id}`,
    caseId,
    detail: {
      receiptId: receipt.id,
      receiptLineId: receiptLine.id,
      orderId: order.id,
      orderLineId: orderLine.id,
      kind,
      mode: receipt.mode,
      ordered: orderLine.qty.toString(),
      received: receiptLine.qtyReceived.toString(),
      accepted: input.accepted,
      rejected: input.rejected,
      overQty: input.overQty,
    },
  });
  let areaRequestId: string | null = null;
  let workItemId: string | null = null;
  if (caseId) {
    const { request } = await ctx.createAreaRequest({
      caseId,
      fromAreaKey: input.fromAreaKey,
      toAreaKey: PURCHASES_AREA_KEY,
      kind: 'resolve_difference',
      objectType: OBJ.receiptLine,
      objectId: receiptLine.id,
      title: truncate(`${label} en la recepción ${receipt.number} (${order.number})`, 200),
      payload: {
        goodsReceiptId: receipt.id,
        lines: [
          {
            sku: (orderLine.zohoItemId ?? orderLine.description).slice(0, 120),
            ordered: num(orderLine.qty),
            received: num(receiptLine.qtyReceived),
            kind,
          },
        ],
      },
    });
    areaRequestId = request.id;
  } else {
    const item = await ctx.createWorkItem({
      areaKey: PURCHASES_AREA_KEY,
      kind: 'incident_followup',
      title: truncate(
        `Resolver ${label.toLowerCase()} de ${receipt.number} (${order.number})`,
        200
      ),
      description: `${orderLine.description}: pedido ${num(orderLine.qty)} ${orderLine.unit}, recibido ${num(receiptLine.qtyReceived)}, aceptado ${input.accepted}`,
      objectType: OBJ.receiptLine,
      objectId: receiptLine.id,
    });
    workItemId = item.id;
  }
  emitPurchases(
    ctx,
    EV.difference,
    {
      receiptId: receipt.id,
      receiptLineId: receiptLine.id,
      orderId: order.id,
      kind,
      incidentId: incident.id,
      areaRequestId,
    },
    { caseId, objectType: OBJ.receipt, objectId: receipt.id }
  );
  return { incidentId: incident.id, areaRequestId, workItemId };
}

/** Resolves the shortfall requests whose allocations are all ready or delivered. */
async function resolveCoveredShortfalls(
  tx: Db,
  allocationIds: readonly string[],
  answer: string,
  data: Record<string, unknown>
): Promise<string[]> {
  const resolved: string[] = [];
  for (const request of await openShortfallRequests(tx, { allocationIds })) {
    const linked = await tx.demandAllocation.findMany({
      where: { linkedType: 'area_request', linkedId: request.id },
    });
    const done =
      linked.length > 0 &&
      linked.every((a) => ['ready', 'released', 'delivered', 'cancelled'].includes(a.status));
    if (!done || !isAreaRequestOpenStatus(request.status)) continue;
    await transitionAreaRequestInTx(tx, request, 'resolve', { answer, data });
    resolved.push(request.id);
  }
  return resolved;
}

/** Received quantities of request lines, spread over the allocations that point to them. */
async function creditRequestLines(
  tx: Db,
  orderLine: ProcurementOrderLine,
  allocations: readonly LineAllocationContext[],
  accepted: number
): Promise<{ requestIds: Set<string>; requestLineIds: Set<string> }> {
  const requestIds = new Set<string>();
  const requestLineIds = new Set<string>();
  const caps = allocations
    .filter((a) => a.requestLineId)
    .map((a) => ({ id: a.requestLineId!, cap: a.procurementQty }));
  const { shares, rest } = distributeFifo(accepted, caps);
  const byLine = new Map<string, number>();
  for (const share of shares) byLine.set(share.id, (byLine.get(share.id) ?? 0) + share.qty);
  if (rest > QTY_EPS && orderLine.requestLineId) {
    byLine.set(orderLine.requestLineId, (byLine.get(orderLine.requestLineId) ?? 0) + rest);
  }
  for (const [requestLineId, qty] of byLine) {
    const updated = await addRequestLineReceived(tx, requestLineId, qty);
    if (updated) {
      requestIds.add(updated.requestId);
      requestLineIds.add(updated.id);
    }
  }
  return { requestIds, requestLineIds };
}

// ---------------------------------------------------------------------------
// Warehouse receipts
// ---------------------------------------------------------------------------

export interface PostReceiptResult {
  receiptId: string;
  number: string;
  status: string;
  orderId: string;
  orderStatus: string;
  movementIds: string[];
  reservations: Array<{ allocationId: string; reservationId: string; quantity: string }>;
  readyAllocationIds: string[];
  differences: Array<{
    receiptLineId: string;
    kind: string;
    incidentId: string;
    areaRequestId: string | null;
    workItemId: string | null;
  }>;
  customerNoticeRequestIds: string[];
  resolvedRequestIds: string[];
  conflicts: Array<{ allocationId: string; code: string; message: string }>;
}

export async function recordReceiptInTx(
  tx: Db,
  input: RecordReceiptInput,
  ctx: CommandContext
): Promise<{ receipt: GoodsReceipt; lines: GoodsReceiptLine[]; posted: PostReceiptResult | null }> {
  const order = await loadOrder(tx, input.orderId);
  throwCheck(
    checkReceiveOrder({ status: order.status, deliveryMode: order.deliveryMode, mode: 'warehouse' })
  );
  const orderLines = await loadOrderLines(tx, order.id);
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.orderLineId))
      throw new OperationsError('invalid_payload', 'Una partida aparece dos veces en la recepción');
    seen.add(line.orderLineId);
  }
  const classified = input.lines.map((line) => {
    const orderLine = orderLines.find((l) => l.id === line.orderLineId);
    if (!orderLine)
      throw new OperationsError('invalid_payload', 'Alguna partida no pertenece a la orden');
    if (orderLine.status === 'cancelled' || orderLine.status === 'closed') {
      throw new OperationsError(
        'invalid_state',
        `La partida "${truncate(orderLine.description, 60)}" ya está cerrada`
      );
    }
    const result = classifyReceiptLine({
      ordered: num(orderLine.qty),
      receivedBefore: num(orderLine.qtyAccepted),
      received: line.qtyReceived,
      accepted: line.qtyAccepted ?? null,
      rejected: line.qtyRejected ?? null,
      declared: line.differenceKind ?? null,
    });
    if (!result.ok)
      throw new OperationsError(
        result.code,
        `${truncate(orderLine.description, 60)}: ${result.message}`
      );
    return { input: line, orderLine, result };
  });
  const warehouseId = input.warehouseId ?? order.warehouseId;
  if (!warehouseId)
    throw new OperationsError('invalid_payload', 'Indica la bodega donde se recibe el material');
  const warehouse = await tx.warehouse.findUnique({
    where: { id: warehouseId },
    select: { id: true, active: true, name: true },
  });
  if (!warehouse) throw new OperationsError('not_found', 'No se encontró la bodega');
  if (!warehouse.active)
    throw new OperationsError('invalid_state', `La bodega ${warehouse.name} está desactivada`);
  if (input.locationId) {
    const location = await tx.storageLocation.findUnique({
      where: { id: input.locationId },
      select: { warehouseId: true },
    });
    if (!location || location.warehouseId !== warehouse.id) {
      throw new OperationsError('invalid_payload', 'La ubicación no pertenece a la bodega');
    }
  }
  await assertReceiptEvidence(tx, order.id, input.evidenceObjectIds, ctx);
  const number = await nextFolio(tx, 'receipt');
  const receivedAt = toDate(input.receivedAt ?? null) ?? ctx.now;
  const receipt = await tx.goodsReceipt.create({
    data: {
      number,
      orderId: order.id,
      receivedByUserId: recordActorId(ctx),
      receivedAt: receivedAt.getTime() > ctx.now.getTime() ? ctx.now : receivedAt,
      mode: 'warehouse',
      warehouseId: warehouse.id,
      locationId: input.locationId ?? null,
      evidenceObjectIds: [...new Set(input.evidenceObjectIds)],
      status: 'draft',
      notes: input.notes ?? null,
    },
  });
  const lines: GoodsReceiptLine[] = [];
  for (const entry of classified) {
    if (!entry.result.ok) continue;
    lines.push(
      await tx.goodsReceiptLine.create({
        data: {
          receiptId: receipt.id,
          orderLineId: entry.orderLine.id,
          qtyReceived: D(entry.input.qtyReceived),
          qtyAccepted: D(entry.result.accepted),
          qtyRejected: D(entry.result.rejected),
          unit: entry.orderLine.unit,
          lotCode: entry.input.lotCode ?? null,
          differenceKind: entry.result.differenceKind,
        },
      })
    );
  }
  const caseIds = await orderCaseIds(tx, order);
  emitPurchases(
    ctx,
    EV.created,
    {
      receiptId: receipt.id,
      number,
      orderId: order.id,
      orderNumber: order.number,
      lines: lines.length,
      draft: !input.post,
    },
    { caseId: caseIds[0] ?? null, objectType: OBJ.receipt, objectId: receipt.id }
  );
  const posted = input.post ? await postReceiptInTx(tx, receipt.id, ctx) : null;
  return {
    receipt: (await tx.goodsReceipt.findUnique({ where: { id: receipt.id } })) ?? receipt,
    lines,
    posted,
  };
}

export async function postReceiptInTx(
  tx: Db,
  receiptId: string,
  ctx: CommandContext
): Promise<PostReceiptResult> {
  const receipt = assertFoundRow(
    await tx.goodsReceipt.findUnique({ where: { id: receiptId } }),
    'No se encontró la recepción'
  );
  if (receipt.status !== 'draft')
    throw new OperationsError('invalid_state', 'La recepción ya fue registrada');
  if (receipt.mode !== 'warehouse' || !receipt.warehouseId) {
    throw new OperationsError('invalid_state', 'La recepción no es de bodega');
  }
  let order = await loadOrder(tx, receipt.orderId);
  throwCheck(
    checkReceiveOrder({ status: order.status, deliveryMode: order.deliveryMode, mode: 'warehouse' })
  );
  const receiptLines = await tx.goodsReceiptLine.findMany({
    where: { receiptId: receipt.id },
    orderBy: { createdAt: 'asc' },
  });
  const result: PostReceiptResult = {
    receiptId: receipt.id,
    number: receipt.number,
    status: 'posted',
    orderId: order.id,
    orderStatus: order.status,
    movementIds: [],
    reservations: [],
    readyAllocationIds: [],
    differences: [],
    customerNoticeRequestIds: [],
    resolvedRequestIds: [],
    conflicts: [],
  };
  const requestIds = new Set<string>();
  const creditedLineIds = new Set<string>();
  const delayedCases = new Map<string, string[]>();

  for (const receiptLine of receiptLines) {
    const orderLine = assertFoundRow(
      await tx.procurementOrderLine.findUnique({ where: { id: receiptLine.orderLineId } }),
      'No se encontró la partida de la orden'
    );
    const classification = classifyReceiptLine({
      ordered: num(orderLine.qty),
      receivedBefore: num(orderLine.qtyAccepted),
      received: num(receiptLine.qtyReceived),
      accepted: num(receiptLine.qtyAccepted),
      rejected: num(receiptLine.qtyRejected),
      declared: receiptLine.differenceKind as (typeof DIFFERENCE_KINDS)[number],
    });
    if (!classification.ok) throw new OperationsError(classification.code, classification.message);
    const accepted = classification.accepted;
    const allocations = await lineAllocations(tx, orderLine.id);
    const caseId = allocations[0]?.demand.caseId ?? order.directDeliveryCaseId ?? null;
    if (accepted > QTY_EPS && allocations.length > 0 && !orderLine.zohoItemId) {
      // Without a catalog item nothing enters stock nor is reserved: the sales it supplies would wait forever.
      throw new OperationsError(
        'invalid_payload',
        `La partida "${truncate(orderLine.description, 60)}" surte ventas y no tiene artículo del catálogo: asígnale el artículo antes de recibirla`
      );
    }

    let movementId: string | null = null;
    if (accepted > QTY_EPS && orderLine.zohoItemId) {
      const variants = [...new Set(allocations.map((a) => a.demand.variantKey))];
      const movement = await recordInventoryMovement(
        tx,
        {
          kind: 'receipt',
          zohoItemId: orderLine.zohoItemId,
          warehouseId: receipt.warehouseId,
          locationId: receipt.locationId,
          variantKey: variants.length === 1 ? variants[0] : '',
          quantity: accepted,
          unit: orderLine.unit,
          referenceType: OBJ.receiptLine,
          referenceId: receiptLine.id,
          note: `Recepción ${receipt.number} de la orden ${order.number}`,
          caseId,
        },
        ctx
      );
      movementId = movement.movement.id;
      result.movementIds.push(movementId);
      // Reserve at once for the sales the purchase was made for (first promised first).
      const factor = accepted > 0 ? Number(movement.quantityBase.toString()) / accepted : 1;
      const suppliedBefore = await suppliedByOrderLine(tx, orderLine.id, receiptLine.id);
      const caps = [];
      for (const entry of allocations) {
        if (!entry.allocation || entry.allocation.source !== 'purchase') continue;
        if (!RESERVABLE_ALLOCATION_STATUSES.includes(entry.allocation.status)) continue;
        const need = round4(
          entry.allocation.quantity - (await reservedForAllocation(tx, entry.allocation.id))
        );
        caps.push({
          id: entry.procurementAllocationId,
          cap: receiptReservationCap({
            need,
            promised: round4(entry.procurementQty * factor),
            suppliedByLine: suppliedBefore.get(entry.allocation.id) ?? 0,
          }),
        });
      }
      const { shares } = distributeFifo(Number(movement.quantityBase.toString()), caps);
      for (const share of shares) {
        const entry = allocations.find((a) => a.procurementAllocationId === share.id)!;
        const allocation = entry.allocation!;
        try {
          const reservation = await reserveStock(
            tx,
            {
              caseId: entry.demand.caseId,
              demandId: entry.demand.id,
              allocationId: allocation.id,
              zohoItemId: orderLine.zohoItemId,
              warehouseId: receipt.warehouseId,
              variantKey: entry.demand.variantKey,
              quantity: share.qty,
              unit: movement.baseUnit,
              receiptMovementIds: [movementId],
              note: `Material de la orden ${order.number} (${receipt.number})`,
            },
            ctx
          );
          result.reservations.push({
            allocationId: allocation.id,
            reservationId: reservation.primaryReservationId,
            quantity: reservation.quantityBase.toString(),
          });
          for (const row of reservation.reservations) {
            await ctx.relate(
              { type: OBJ.receiptLine, id: receiptLine.id },
              { type: 'stock_reservation', id: row.id },
              RECEIPT_RESERVATION_RELATION
            );
          }
          const reserved = await reservedForAllocation(tx, allocation.id);
          const current = await tx.demandAllocation.findUnique({ where: { id: allocation.id } });
          if (
            current &&
            reserved + QTY_EPS >= num(current.quantity) &&
            RESERVABLE_ALLOCATION_STATUSES.includes(current.status)
          ) {
            const ready = await tx.demandAllocation.update({
              where: { id: current.id },
              data: {
                status: 'ready',
                readyAt: current.readyAt ?? ctx.now,
                stockReservationId: current.stockReservationId ?? reservation.primaryReservationId,
                warehouseId: receipt.warehouseId,
                version: { increment: 1 },
              },
            });
            result.readyAllocationIds.push(ready.id);
            ctx.emit(
              OPS_EVENTS.allocation.ready,
              {
                allocationId: ready.id,
                demandId: ready.demandId,
                receiptId: receipt.id,
                procurementOrderId: order.id,
                movementIds: [movementId],
                quantity: ready.quantity.toString(),
              },
              {
                caseId: ready.caseId,
                areaKey: PURCHASES_AREA_KEY,
                objectType: 'demand_allocation',
                objectId: ready.id,
              }
            );
          }
        } catch (err) {
          if (!isOperationsError(err)) throw err;
          result.conflicts.push({
            allocationId: allocation.id,
            code: err.code,
            message: err.message,
          });
          await ctx.openIncident({
            kind: 'stock_conflict',
            areaKey: 'inventario',
            severity: 'medium',
            title: truncate(
              `No se pudo reservar lo recibido de ${order.number} para ${entry.demand.name}`,
              200
            ),
            dedupeKey: `purchases.receipt_reserve:${receiptLine.id}:${allocation.id}`,
            caseId: entry.demand.caseId,
            detail: { receiptId: receipt.id, movementId, code: err.code, message: err.message },
          });
        }
      }
    }

    const qtyAccepted = round4(num(orderLine.qtyAccepted) + accepted);
    await tx.procurementOrderLine.update({
      where: { id: orderLine.id },
      data: {
        qtyReceived: D(round4(num(orderLine.qtyReceived) + num(receiptLine.qtyReceived))),
        qtyAccepted: D(qtyAccepted),
        qtyRejected: D(round4(num(orderLine.qtyRejected) + classification.rejected)),
        status: lineStatusAfterReceipt(num(orderLine.qty), qtyAccepted, orderLine.status),
      },
    });
    const credited = await creditRequestLines(tx, orderLine, allocations, accepted);
    for (const id of credited.requestIds) requestIds.add(id);
    for (const id of credited.requestLineIds) creditedLineIds.add(id);

    let incidentId: string | null = null;
    if (classification.differenceKind !== 'none') {
      const opened = await openReceiptDifferenceInTx(tx, ctx, {
        receipt,
        order,
        orderLine,
        receiptLine,
        kind: classification.differenceKind,
        caseId,
        fromAreaKey: 'inventario',
        hasAllocations: allocations.length > 0,
        accepted,
        rejected: classification.rejected,
        overQty: classification.overQty,
      });
      incidentId = opened.incidentId;
      result.differences.push({
        receiptLineId: receiptLine.id,
        kind: classification.differenceKind,
        incidentId,
        areaRequestId: opened.areaRequestId,
        workItemId: opened.workItemId,
      });
      if (classification.differenceKind !== 'over') {
        for (const entry of allocations) {
          // Only the sales still waiting for this material are late: skip what is already ready or covered.
          const allocation = entry.allocation;
          if (allocation) {
            if (result.readyAllocationIds.includes(allocation.id)) continue;
            if (['ready', 'released', 'delivered', 'cancelled'].includes(allocation.status))
              continue;
            if ((await reservedForAllocation(tx, allocation.id)) + QTY_EPS >= allocation.quantity)
              continue;
          }
          const list = delayedCases.get(entry.demand.caseId) ?? [];
          list.push(entry.demand.name);
          delayedCases.set(entry.demand.caseId, list);
        }
      }
    }
    await tx.goodsReceiptLine.update({
      where: { id: receiptLine.id },
      data: {
        stockMovementId: movementId,
        incidentId,
        qtyAccepted: D(accepted),
        qtyRejected: D(classification.rejected),
        differenceKind: classification.differenceKind,
      },
    });
  }

  for (const [caseId, names] of delayedCases) {
    const existing = await tx.areaRequest.findFirst({
      where: {
        caseId,
        kind: 'customer_notice',
        objectType: OBJ.order,
        objectId: order.id,
        status: { in: ['sent', 'acknowledged', 'accepted', 'blocked'] },
      },
      select: { id: true },
    });
    if (existing) continue;
    const { request } = await ctx.createAreaRequest({
      caseId,
      fromAreaKey: PURCHASES_AREA_KEY,
      toAreaKey: 'ventas',
      kind: 'customer_notice',
      objectType: OBJ.order,
      objectId: order.id,
      title: truncate(
        `Avisar al cliente: llegó incompleta la compra de ${[...new Set(names)].join(', ')}`,
        200
      ),
      payload: {
        caseId,
        reason: truncate(
          `La recepción ${receipt.number} de la orden ${order.number} llegó con diferencias; Compras la está resolviendo con el proveedor`,
          500
        ),
      },
    });
    result.customerNoticeRequestIds.push(request.id);
  }

  await recomputeRequestStatuses(tx, requestIds, ctx);
  const receivedAnswer = `Material recibido en ${receipt.number} (orden ${order.number})`;
  const receivedData = { receiptId: receipt.id, movementIds: result.movementIds };
  result.resolvedRequestIds = await resolveCoveredShortfalls(
    tx,
    result.readyAllocationIds,
    receivedAnswer,
    receivedData
  );
  for (const id of await resolveReceivedShortfalls(
    tx,
    [...creditedLineIds],
    receivedAnswer,
    receivedData
  )) {
    if (!result.resolvedRequestIds.includes(id)) result.resolvedRequestIds.push(id);
  }
  order = await refreshOrderStatus(tx, order);
  const status = result.differences.length > 0 ? 'disputed' : 'posted';
  await tx.goodsReceipt.update({ where: { id: receipt.id }, data: { status } });
  result.status = status;
  result.orderStatus = order.status;
  const caseIds = await orderCaseIds(tx, order);
  emitPurchases(
    ctx,
    EV.posted,
    {
      receiptId: receipt.id,
      number: receipt.number,
      orderId: order.id,
      orderNumber: order.number,
      orderStatus: order.status,
      movementIds: result.movementIds,
      readyAllocationIds: result.readyAllocationIds,
      differences: result.differences.length,
    },
    { caseId: caseIds[0] ?? null, objectType: OBJ.receipt, objectId: receipt.id }
  );
  const creator = order.createdByUserId.includes(':') ? null : order.createdByUserId;
  if (creator && result.differences.length > 0) {
    ctx.notify({
      userId: creator,
      category: purchaseNotificationCategory(),
      type: 'purchase_receipt_difference',
      title: `Diferencias en ${receipt.number} (orden ${order.number})`,
      body: result.differences.map((d) => labelOf(DIFFERENCE_KIND_LABELS, d.kind)).join(', '),
      url: procurementOrderLink(order.id),
      entityType: OBJ.receipt,
      entityId: receipt.id,
    });
  }
  publishBoard(ctx, { orderId: order.id, receiptId: receipt.id });
  return result;
}

// ---------------------------------------------------------------------------
// Differences
// ---------------------------------------------------------------------------

export async function resolveReceiptDifferenceInTx(
  tx: Db,
  input: z.output<typeof resolveDifferenceSchema>,
  ctx: CommandContext
): Promise<{ orderId: string; orderStatus: string; creditedQty: number }> {
  const receiptLine = assertFoundRow(
    await tx.goodsReceiptLine.findUnique({ where: { id: input.receiptLineId } }),
    'No se encontró la partida de la recepción'
  );
  if (receiptLine.differenceKind === 'none' || !receiptLine.incidentId) {
    throw new OperationsError('invalid_state', 'La partida no tiene una diferencia abierta');
  }
  const incident = assertFoundRow(
    await tx.incident.findUnique({ where: { id: receiptLine.incidentId } }),
    'No se encontró la incidencia'
  );
  if (!(INCIDENT_OPEN_STATUSES as readonly string[]).includes(incident.status)) {
    throw new OperationsError('invalid_state', 'La diferencia ya está resuelta');
  }
  const receipt = assertFoundRow(
    await tx.goodsReceipt.findUnique({ where: { id: receiptLine.receiptId } }),
    'No se encontró la recepción'
  );
  let order = await loadOrder(tx, receipt.orderId);
  const orderLine = assertFoundRow(
    await tx.procurementOrderLine.findUnique({ where: { id: receiptLine.orderLineId } }),
    'No se encontró la partida de la orden'
  );
  const pending = Math.max(0, round4(num(orderLine.qty) - num(orderLine.qtyAccepted)));
  let creditedQty = 0;
  const credit =
    input.resolution === 'credit' || (input.resolution === 'accept' && pending > QTY_EPS);
  if (credit) {
    // Reducing what is bought and its total is a commercial decision, not a warehouse one.
    assertActorHasAny(
      ctx,
      ['purchases.manage_orders'],
      'Resolver con nota de crédito o aceptar el faltante reduce la orden: lo decide quien administra las órdenes de compra'
    );
    creditedQty = input.creditQty ?? pending;
    if (creditedQty > pending + QTY_EPS) {
      throw new OperationsError(
        'invalid_quantity',
        `Sólo quedan ${pending} ${orderLine.unit} pendientes en la partida`
      );
    }
    if (creditedQty > QTY_EPS) {
      const newQty = round4(num(orderLine.qty) - creditedQty);
      const lineTotal = D(newQty).times(orderLine.unitPrice).toDecimalPlaces(4);
      await tx.procurementOrderLine.update({
        where: { id: orderLine.id },
        data: {
          qty: D(newQty),
          lineTotal,
          status: lineStatusAfterReceipt(newQty, num(orderLine.qtyAccepted), orderLine.status),
        },
      });
      const lines = await loadOrderLines(tx, order.id);
      const totals = computeOrderTotals(
        lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, taxRate: l.taxRate })),
        order.freight
      );
      order = await tx.procurementOrder.update({
        where: { id: order.id },
        data: { subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total },
      });
      if (orderLine.requestLineId) {
        const updated = await adjustRequestLineOrdered(tx, orderLine.requestLineId, -creditedQty);
        if (updated) await recomputeRequestStatuses(tx, [updated.requestId], ctx);
      }
      const allocations = await lineAllocations(tx, orderLine.id);
      await releaseAllocationsExpectation(
        tx,
        allocations
          .filter((a) => a.allocation && a.allocation.status === 'in_progress')
          .map((a) => a.allocation!.id),
        ctx,
        `Nota de crédito en ${order.number}`,
        order.id
      );
      if (order.obligationId) {
        await ctx.createWorkItem({
          areaKey: 'contabilidad',
          kind: 'action',
          title: truncate(`Ajustar el pago de ${order.number} por nota de crédito`, 200),
          description: `Se quitaron ${creditedQty} ${orderLine.unit} de "${orderLine.description}". Nuevo total ${totals.total.toFixed(2)} ${order.currency}.`,
          objectType: 'obligation',
          objectId: order.obligationId,
        });
      }
    }
  }
  const resolution = `${DIFFERENCE_RESOLUTION_LABELS[input.resolution]}: ${input.note}`;
  await transitionIncidentInTx(tx, incident, 'resolve', { resolution });
  const requests = await tx.areaRequest.findMany({
    where: { kind: 'resolve_difference', objectType: OBJ.receiptLine, objectId: receiptLine.id },
  });
  for (const request of requests) {
    if (isAreaRequestOpenStatus(request.status)) {
      await transitionAreaRequestInTx(tx, request, 'resolve', {
        answer: resolution,
        data: { creditedQty },
      });
    }
  }
  const items = await tx.workItem.findMany({
    where: {
      objectType: OBJ.receiptLine,
      objectId: receiptLine.id,
      status: { in: [...WORK_ITEM_OPEN_STATUSES] },
    },
  });
  for (const item of items) {
    await completeWorkItemInTx(tx, item, {
      result: { resolution: input.resolution, creditedQty },
      skipEvidenceCheck: true,
    });
  }
  order = await refreshOrderStatus(tx, order);
  const stillOpen = await tx.goodsReceiptLine.findMany({
    where: { receiptId: receipt.id, incidentId: { not: null } },
    select: { incidentId: true },
  });
  const openCount = stillOpen.length
    ? await tx.incident.count({
        where: {
          id: { in: stillOpen.map((l) => l.incidentId!) },
          status: { in: [...INCIDENT_OPEN_STATUSES] },
        },
      })
    : 0;
  if (openCount === 0 && receipt.status === 'disputed') {
    await tx.goodsReceipt.update({
      where: { id: receipt.id },
      data: { status: 'posted', version: { increment: 1 } },
    });
  }
  emitPurchases(
    ctx,
    EV.differenceResolved,
    {
      receiptId: receipt.id,
      receiptLineId: receiptLine.id,
      orderId: order.id,
      resolution: input.resolution,
      creditedQty,
      orderStatus: order.status,
    },
    { caseId: incident.caseId, objectType: OBJ.receipt, objectId: receipt.id }
  );
  publishBoard(ctx, { orderId: order.id, receiptId: receipt.id });
  return { orderId: order.id, orderStatus: order.status, creditedQty };
}

// ---------------------------------------------------------------------------
// Direct supplier delivery
// ---------------------------------------------------------------------------

export interface ConfirmDirectDeliveryData {
  receiptId: string;
  number: string;
  orderId: string;
  orderStatus: string;
  plan: DirectDeliveryPlan;
  syncQueued: boolean;
}

export async function confirmDirectDeliveryInTx(
  tx: Db,
  input: ConfirmDirectDeliveryInput,
  ctx: CommandContext
): Promise<ConfirmDirectDeliveryData> {
  let order = await loadOrder(tx, input.orderId);
  throwCheck(
    checkReceiveOrder({
      status: order.status,
      deliveryMode: order.deliveryMode,
      mode: 'direct_delivery',
    })
  );
  await assertReceiptEvidence(tx, order.id, input.evidenceObjectIds, ctx);
  const orderLines = await loadOrderLines(tx, order.id);
  const number = await nextFolio(tx, 'receipt');
  const deliveredAt = toDate(input.deliveredAt ?? null) ?? ctx.now;
  const receipt = await tx.goodsReceipt.create({
    data: {
      number,
      orderId: order.id,
      receivedByUserId: recordActorId(ctx),
      receivedAt: deliveredAt.getTime() > ctx.now.getTime() ? ctx.now : deliveredAt,
      mode: 'direct_delivery',
      directConfirmedByUserId: actorUserId(ctx),
      evidenceObjectIds: [...new Set(input.evidenceObjectIds)],
      status: 'posted',
      notes: truncate(`Recibió: ${input.receivedBy}${input.note ? ` · ${input.note}` : ''}`, 1000),
    },
  });
  const plan: DirectDeliveryPlan = {
    receiptId: receipt.id,
    receivedBy: input.receivedBy,
    note: input.note ?? null,
    evidenceObjectIds: [...new Set(input.evidenceObjectIds)],
    deliveries: [],
  };
  const requestIds = new Set<string>();
  const seen = new Set<string>();
  let differences = 0;
  for (const entry of input.lines) {
    if (seen.has(entry.orderLineId))
      throw new OperationsError('invalid_payload', 'Una partida aparece dos veces');
    seen.add(entry.orderLineId);
    const orderLine = orderLines.find((l) => l.id === entry.orderLineId);
    if (!orderLine)
      throw new OperationsError('invalid_payload', 'Alguna partida no pertenece a la orden');
    if (orderLine.status === 'cancelled' || orderLine.status === 'closed') {
      throw new OperationsError(
        'invalid_state',
        `La partida "${truncate(orderLine.description, 60)}" ya está cerrada`
      );
    }
    const damaged = entry.difference === 'damaged';
    const classification = classifyReceiptLine({
      ordered: num(orderLine.qty),
      receivedBefore: num(orderLine.qtyAccepted),
      received: entry.qtyDelivered,
      // A damaged or wrong delivery is not accepted: nothing of it counts as delivered to the customer.
      accepted: damaged || entry.difference === 'wrong_item' ? 0 : entry.qtyDelivered,
      rejected: damaged || entry.difference === 'wrong_item' ? entry.qtyDelivered : 0,
      declared: entry.difference ?? null,
    });
    if (!classification.ok) throw new OperationsError(classification.code, classification.message);
    const receiptLine = await tx.goodsReceiptLine.create({
      data: {
        receiptId: receipt.id,
        orderLineId: orderLine.id,
        qtyReceived: D(entry.qtyDelivered),
        qtyAccepted: D(classification.accepted),
        qtyRejected: D(classification.rejected),
        unit: orderLine.unit,
        differenceKind: classification.differenceKind,
      },
    });
    const delivered = classification.accepted;
    const qtyAccepted = round4(num(orderLine.qtyAccepted) + delivered);
    await tx.procurementOrderLine.update({
      where: { id: orderLine.id },
      data: {
        qtyReceived: D(round4(num(orderLine.qtyReceived) + entry.qtyDelivered)),
        qtyAccepted: D(qtyAccepted),
        qtyRejected: D(round4(num(orderLine.qtyRejected) + classification.rejected)),
        status: lineStatusAfterReceipt(num(orderLine.qty), qtyAccepted, orderLine.status),
      },
    });
    const allocations = await lineAllocations(tx, orderLine.id);
    for (const id of (await creditRequestLines(tx, orderLine, allocations, delivered)).requestIds)
      requestIds.add(id);
    if (classification.differenceKind !== 'none') {
      // Differences of a direct delivery follow the same flow as the warehouse: incident + resolve_difference.
      const opened = await openReceiptDifferenceInTx(tx, ctx, {
        receipt,
        order,
        orderLine,
        receiptLine,
        kind: classification.differenceKind,
        caseId: allocations[0]?.demand.caseId ?? order.directDeliveryCaseId ?? null,
        fromAreaKey: 'logistica',
        hasAllocations: allocations.length > 0,
        accepted: classification.accepted,
        rejected: classification.rejected,
        overQty: classification.overQty,
      });
      await tx.goodsReceiptLine.update({
        where: { id: receiptLine.id },
        data: { incidentId: opened.incidentId },
      });
      differences += 1;
    }
    const caps: Array<{ id: string; cap: number }> = [];
    const factors = new Map<string, number>();
    for (const allocationEntry of allocations) {
      const allocation = allocationEntry.allocation;
      if (
        !allocation ||
        allocation.source !== 'direct_supplier' ||
        allocation.status === 'delivered' ||
        allocation.status === 'cancelled'
      )
        continue;
      const profile = allocationEntry.demand.zohoItemId
        ? toUnitProfile(await getOrCreateProfile(tx, allocationEntry.demand.zohoItemId))
        : null;
      const factor = resolveUnitFactor(orderLine.unit, allocationEntry.demand.baseUnit, profile);
      if (factor === null) {
        throw new OperationsError(
          'invalid_unit',
          `No se puede convertir ${orderLine.unit} a ${allocationEntry.demand.baseUnit} para "${truncate(allocationEntry.demand.name, 60)}"; registra la conversión del artículo`
        );
      }
      factors.set(allocationEntry.procurementAllocationId, factor);
      caps.push({
        id: allocationEntry.procurementAllocationId,
        // Same rule as the warehouse receipt: what this line still owes THIS sale,
        // never the share it already handed over to it in an earlier delivery.
        cap: receiptReservationCap({
          need: round4(allocation.quantity - allocation.deliveredQuantity),
          promised: round4(allocationEntry.procurementQty * factor),
          suppliedByLine: allocationEntry.directDeliveredQty,
        }),
      });
    }
    // Spread in base units: each allocation converts the delivered quantity with its own factor.
    let remainingLineQty = delivered;
    for (const cap of caps) {
      if (remainingLineQty <= QTY_EPS) break;
      const factor = factors.get(cap.id)!;
      const baseAvailable = round4(remainingLineQty * factor);
      const base = round4(Math.min(cap.cap, baseAvailable));
      if (base <= QTY_EPS) continue;
      const allocationEntry = allocations.find((a) => a.procurementAllocationId === cap.id)!;
      plan.deliveries.push({
        caseId: allocationEntry.demand.caseId,
        allocationId: allocationEntry.allocation!.id,
        deliveredQty: base,
      });
      // The delivery order is recorded by the sync job: the line notes here what it
      // already committed, so a later partial delivery cannot hand it over twice.
      await tx.procurementAllocation.update({
        where: { id: cap.id },
        data: { directDeliveredQty: D(round4(allocationEntry.directDeliveredQty + base)) },
      });
      remainingLineQty = round4(remainingLineQty - base / factor);
    }
  }
  await recomputeRequestStatuses(tx, requestIds, ctx);
  if (differences > 0)
    await tx.goodsReceipt.update({ where: { id: receipt.id }, data: { status: 'disputed' } });
  order = await refreshOrderStatus(tx, order);
  const syncQueued = plan.deliveries.length > 0;
  if (syncQueued) {
    ctx.outbox({
      type: PURCHASES_JOB_TYPES.directDeliverySync,
      payload: plan,
      dedupeKey: `${PURCHASES_JOB_TYPES.directDeliverySync}:${receipt.id}`,
      groupKey: `case:${plan.deliveries[0].caseId}`,
      maxAttempts: 3,
      createdBy: actorUserId(ctx) ?? 'purchases',
    });
  }
  await ctx.relate(
    { type: OBJ.receipt, id: receipt.id },
    { type: OBJ.order, id: order.id },
    'receipt_of'
  );
  emitPurchases(
    ctx,
    EV.directConfirmed,
    {
      receiptId: receipt.id,
      number,
      orderId: order.id,
      orderNumber: order.number,
      receivedBy: input.receivedBy,
      deliveries: plan.deliveries,
      evidenceObjectIds: plan.evidenceObjectIds,
    },
    { caseId: order.directDeliveryCaseId, objectType: OBJ.receipt, objectId: receipt.id }
  );
  publishBoard(ctx, { orderId: order.id, receiptId: receipt.id });
  return {
    receiptId: receipt.id,
    number,
    orderId: order.id,
    orderStatus: order.status,
    plan,
    syncQueued,
  };
}

function evidenceKindForMime(mime: string): 'photo' | 'signature' {
  return mime.trim().toLowerCase() === 'application/pdf' ? 'signature' : 'photo';
}

/**
 * System command of the `purchases.direct_delivery_sync` job: the delivery
 * order of each case (existing direct supplier order or a new one) is recorded
 * as delivered with the receipt evidence, through the logistics service.
 */
export async function syncDirectDeliveryInTx(
  tx: Db,
  plan: DirectDeliveryPlan,
  ctx: CommandContext
): Promise<{ deliveryOrderIds: string[]; resolvedRequestIds: string[] }> {
  const receipt = assertFoundRow(
    await tx.goodsReceipt.findUnique({ where: { id: plan.receiptId } }),
    'No se encontró la recepción'
  );
  const byCase = new Map<string, Array<{ allocationId: string; deliveredQty: number }>>();
  for (const delivery of plan.deliveries) {
    const list = byCase.get(delivery.caseId) ?? [];
    const current = list.find((l) => l.allocationId === delivery.allocationId);
    if (current) current.deliveredQty = round4(current.deliveredQty + delivery.deliveredQty);
    else list.push({ allocationId: delivery.allocationId, deliveredQty: delivery.deliveredQty });
    byCase.set(delivery.caseId, list);
  }
  const objects = plan.evidenceObjectIds.length
    ? await tx.storageObject.findMany({
        where: { id: { in: plan.evidenceObjectIds } },
        select: { id: true, declaredMimeType: true },
      })
    : [];
  const deliveryOrderIds: string[] = [];
  const allocationIds: string[] = [];
  for (const [caseId, lines] of byCase) {
    const ids = lines.map((l) => l.allocationId);
    const allocations = await tx.demandAllocation.findMany({ where: { id: { in: ids } } });
    const pendingLines = lines.filter((line) => {
      const allocation = allocations.find((a) => a.id === line.allocationId);
      return allocation && allocation.status !== 'delivered' && allocation.status !== 'cancelled';
    });
    if (pendingLines.length === 0) continue;
    const pendingIds = pendingLines.map((l) => l.allocationId);
    let deliveryOrder = await tx.deliveryOrder.findFirst({
      where: {
        caseId,
        mode: 'direct_supplier',
        status: { in: [...DELIVERY_ORDER_OPEN_STATUSES] },
        allocationIds: { hasSome: pendingIds },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!deliveryOrder) {
      deliveryOrder = (
        await createDeliveryOrder(tx, {
          caseId,
          allocationIds: pendingIds,
          mode: 'direct_supplier',
        })
      ).deliveryOrder;
    }
    const existingEvidence = await tx.deliveryEvidence.findMany({
      where: { deliveryOrderId: deliveryOrder.id, storageObjectId: { in: plan.evidenceObjectIds } },
      select: { storageObjectId: true },
    });
    for (const object of objects) {
      if (existingEvidence.some((e) => e.storageObjectId === object.id)) continue;
      await tx.deliveryEvidence.create({
        data: {
          deliveryOrderId: deliveryOrder.id,
          kind: evidenceKindForMime(object.declaredMimeType),
          storageObjectId: object.id,
          note: `Evidencia del proveedor (${receipt.number})`,
          commandId: ctx.commandId,
          createdBy: receipt.directConfirmedByUserId ?? receipt.receivedByUserId,
        },
      });
    }
    const coveredLines = pendingLines.filter((line) =>
      deliveryOrder!.allocationIds.includes(line.allocationId)
    );
    await recordDelivery(
      tx,
      {
        deliveryOrderId: deliveryOrder.id,
        lines: coveredLines.map((line) => ({
          allocationId: line.allocationId,
          deliveredQty: line.deliveredQty,
        })),
        receivedBy: plan.receivedBy,
        evidenceObjectIds: plan.evidenceObjectIds,
        note: plan.note ?? undefined,
      },
      { orderVersionGuard: true }
    );
    deliveryOrderIds.push(deliveryOrder.id);
    allocationIds.push(...coveredLines.map((l) => l.allocationId));
    await ctx.relate(
      { type: OBJ.receipt, id: receipt.id },
      { type: 'delivery_order', id: deliveryOrder.id },
      'confirmed_delivery'
    );
  }
  const resolvedRequestIds = await resolveCoveredShortfalls(
    tx,
    allocationIds,
    `El proveedor entregó directo al cliente (${receipt.number})`,
    { receiptId: receipt.id, deliveryOrderIds }
  );
  return { deliveryOrderIds, resolvedRequestIds };
}

export async function recordDirectSyncFailureInTx(
  tx: Db,
  input: z.output<typeof directSyncFailedSchema>,
  ctx: CommandContext
): Promise<{ incidentId: string; workItemId: string | null }> {
  const receipt = assertFoundRow(
    await tx.goodsReceipt.findUnique({ where: { id: input.receiptId } }),
    'No se encontró la recepción'
  );
  const order = await loadOrder(tx, receipt.orderId);
  const { incident, created } = await ctx.openIncident({
    kind: 'purchase_difference',
    areaKey: 'logistica',
    severity: 'medium',
    title: truncate(
      `No se pudo registrar la entrega directa de ${receipt.number} (${order.number})`,
      200
    ),
    dedupeKey: `purchases.direct_sync:${receipt.id}`,
    caseId: order.directDeliveryCaseId,
    detail: { receiptId: receipt.id, orderId: order.id, message: input.message },
  });
  let workItemId: string | null = null;
  if (created) {
    const item = await ctx.createWorkItem({
      areaKey: 'logistica',
      kind: 'action',
      title: truncate(`Registrar la entrega directa de ${order.number}`, 200),
      description: truncate(
        `Compras confirmó la entrega (${receipt.number}) pero no se pudo registrar en logística: ${input.message}`,
        1000
      ),
      caseId: order.directDeliveryCaseId,
      objectType: OBJ.receipt,
      objectId: receipt.id,
    });
    workItemId = item.id;
  }
  emitPurchases(
    ctx,
    EV.directSyncFailed,
    { receiptId: receipt.id, orderId: order.id, message: input.message, incidentId: incident.id },
    { caseId: order.directDeliveryCaseId, objectType: OBJ.receipt, objectId: receipt.id }
  );
  return { incidentId: incident.id, workItemId };
}
