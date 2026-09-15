import { Prisma, type ProcurementOrder, type ProcurementOrderLine, type Supplier } from '@prisma/client';
import { z } from 'zod';
import { requestApproval, type ApprovalDecidedEvent } from '@/modules/operations/approvals-service';
import { isAreaRequestOpenStatus, transitionAreaRequestInTx } from '@/modules/operations/area-requests-service';
import type { CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { OPS_EVENTS, WORK_ITEM_OPEN_STATUSES } from '@/modules/operations/types';
import { cancelWorkItemInTx, completeWorkItemInTx } from '@/modules/operations/work-items-service';
import {
  cancelProcurementPayable,
  createProcurementPayable,
  requestProcurementPaymentAuthorization,
} from './finance-bridge';
import {
  ORDER_COMMITTED_STATUSES,
  QTY_EPS,
  checkCancelOrder,
  checkCloseOrder,
  checkEditOrder,
  checkRequestPayment,
  checkSendOrder,
  checkSubmitOrder,
  computeOrderTotals,
  paymentStatusFor,
  pendingQuantity,
  statusAfterApprovalDecision,
  statusAfterPaid,
  statusAfterPaymentRequest,
  statusAfterPaymentReversed,
  statusAfterSend,
  type OrderStatus,
} from './orders-state';
import {
  D,
  actorUserId,
  addDays,
  assertFoundRow,
  round4,
  emitPurchases,
  isoDay,
  nextFolio,
  num,
  publishBoard,
  purchaseNotificationCategory,
  recordActorId,
  throwCheck,
  truncate,
  type Db,
} from './purchases-helpers';
import {
  currencyCode,
  idText,
  isoDateText,
  moneyAmount,
  optionalText,
  positiveQty,
  rateFraction,
  toDate,
} from './purchases-schemas';
import {
  ORDER_DELIVERY_MODES,
  ORDER_SEND_CHANNELS,
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  PURCHASES_AREA_KEY,
  PURCHASES_COMMANDS,
  PURCHASES_EVENTS,
  PURCHASES_JOB_TYPES,
  PURCHASES_OBJECT_TYPES,
  labelOf,
} from './purchases-types';
import { remainingToOrder } from './request-rules';
import { adjustRequestLineOrdered, openShortfallRequests, recomputeRequestStatuses } from './requests-service';
import { touchSupplierProductPrice } from './suppliers-service';

/**
 * Procurement orders (plan 6.1, `orders-service`).
 *
 * createOrder (draft, request lines ordered, allocations to demands) →
 * submitOrder (`requestApproval` scope procurement: one signature, two distinct
 * from the double-approval threshold) → approval reaction (approved: the
 * allocations show the expected date — never available stock —, the shortfall
 * requests are accepted and the payment follow-up is queued; rejected: back to
 * draft) → requestPayment (payable `Obligation` + `payment_authorization` to
 * Contabilidad) → markOrderPaid (finance settlement) → sendOrderToSupplier →
 * receipts (receipts-service) → closeOrder. cancelOrder compensates every step
 * already taken (approval, payable, requests, allocations, supplier notice).
 *
 * Every function runs inside a purchases command.
 */

const OBJ = PURCHASES_OBJECT_TYPES;
const EV = PURCHASES_EVENTS.order;
const OBLIGATION_OBJECT_TYPE = 'obligation';
const ALLOCATION_COMMITTABLE = ['planned', 'requested'];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const lineAllocationInputSchema = z.object({
  demandId: idText,
  qty: positiveQty,
  /** DemandAllocation (source purchase / direct_supplier) of the demand; resolved when omitted. */
  allocationId: idText.nullish(),
});

export const orderLineInputSchema = z.object({
  requestLineId: idText.nullish(),
  zohoItemId: idText.nullish(),
  supplierProductId: idText.nullish(),
  description: optionalText(300),
  qty: positiveQty,
  unit: optionalText(40),
  unitPrice: moneyAmount,
  taxRate: rateFraction.nullish(),
  allocations: z.array(lineAllocationInputSchema).max(50).optional(),
  /** Several request lines consolidated in one order line (each keeps its demand). */
  sources: z.array(z.object({ requestLineId: idText, qty: positiveQty })).max(100).optional(),
});
export type OrderLineInput = z.output<typeof orderLineInputSchema>;

const orderHeaderFields = {
  currency: currencyCode.optional(),
  paymentMode: z.enum(PAYMENT_MODES).optional(),
  /** Omitted: direct to the customer when the lines supply direct-supplier allocations of one case, else warehouse. */
  deliveryMode: z.enum(ORDER_DELIVERY_MODES).optional(),
  warehouseId: idText.nullish(),
  directDeliveryCaseId: idText.nullish(),
  expectedAt: isoDateText.nullish(),
  freight: moneyAmount.default(0),
  notes: optionalText(2000),
};

export const createOrderSchema = z.object({
  supplierId: idText,
  ...orderHeaderFields,
  rfqResponseId: idText.nullish(),
  lines: z.array(orderLineInputSchema).min(1, 'Agrega al menos una partida').max(200),
});
export type CreateOrderInput = z.output<typeof createOrderSchema>;

export const updateOrderSchema = z.object({
  orderId: idText,
  currency: orderHeaderFields.currency,
  paymentMode: orderHeaderFields.paymentMode,
  deliveryMode: z.enum(ORDER_DELIVERY_MODES).optional(),
  warehouseId: orderHeaderFields.warehouseId,
  directDeliveryCaseId: orderHeaderFields.directDeliveryCaseId,
  expectedAt: orderHeaderFields.expectedAt,
  freight: moneyAmount.optional(),
  notes: orderHeaderFields.notes,
  lines: z.array(orderLineInputSchema).min(1).max(200).optional(),
});
export type UpdateOrderInput = z.output<typeof updateOrderSchema>;

export const orderIdSchema = z.object({ orderId: idText });
export const submitOrderSchema = z.object({
  orderId: idText,
  note: optionalText(1000),
  /** AI identities only: the human who caused the turn (excluded from signing, like the requester). */
  causedByUserId: idText.nullish(),
});
export const requestPaymentSchema = z.object({ orderId: idText, dueAt: isoDateText.nullish() });
export const markSentSchema = z.object({
  orderId: idText,
  via: z.enum(ORDER_SEND_CHANNELS),
  conversationId: idText.nullish(),
  messageId: idText.nullish(),
  pdfObjectId: idText.nullish(),
});
export const allocateLineSchema = z.object({
  orderLineId: idText,
  allocations: z.array(lineAllocationInputSchema).max(50),
});
export const cancelOrderSchema = z.object({
  orderId: idText,
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
});
export const closeOrderSchema = z.object({
  orderId: idText,
  reason: optionalText(500),
  acceptShortages: z.boolean().default(false),
});
export const followupFailedSchema = z.object({
  orderId: idText,
  step: z.enum(['payment']),
  message: z.string().trim().min(1).max(1000),
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadOrder(tx: Db, orderId: string): Promise<ProcurementOrder> {
  return assertFoundRow(await tx.procurementOrder.findUnique({ where: { id: orderId } }), 'No se encontró la orden de compra');
}

export async function loadOrderLines(tx: Db, orderId: string): Promise<ProcurementOrderLine[]> {
  return tx.procurementOrderLine.findMany({ where: { orderId }, orderBy: { sortOrder: 'asc' } });
}

export async function loadSupplier(tx: Db, supplierId: string): Promise<Supplier> {
  return assertFoundRow(await tx.supplier.findUnique({ where: { id: supplierId } }), 'No se encontró el proveedor');
}

/** Cases supplied by the order (direct delivery case first, then the allocated demands). */
export async function orderCaseIds(tx: Db, order: Pick<ProcurementOrder, 'id' | 'directDeliveryCaseId'>): Promise<string[]> {
  const lines = await tx.procurementOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } });
  const allocations = lines.length
    ? await tx.procurementAllocation.findMany({ where: { orderLineId: { in: lines.map((l) => l.id) } }, select: { demandId: true } })
    : [];
  const demands = allocations.length
    ? await tx.caseDemand.findMany({
        where: { id: { in: [...new Set(allocations.map((a) => a.demandId))] } },
        select: { caseId: true },
      })
    : [];
  return [...new Set([order.directDeliveryCaseId, ...demands.map((d) => d.caseId)].filter((id): id is string => Boolean(id)))];
}

function isCommitted(status: string): boolean {
  return (ORDER_COMMITTED_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Allocation expectations (never stock)
// ---------------------------------------------------------------------------

async function orderDemandAllocationIds(tx: Db, orderId: string): Promise<string[]> {
  const lines = await tx.procurementOrderLine.findMany({ where: { orderId }, select: { id: true } });
  if (lines.length === 0) return [];
  const rows = await tx.procurementAllocation.findMany({
    where: { orderLineId: { in: lines.map((l) => l.id) }, demandAllocationId: { not: null } },
    select: { demandAllocationId: true },
  });
  return [...new Set(rows.map((r) => r.demandAllocationId!))];
}

/**
 * The supplier committed: allocations still planned/requested become
 * `in_progress` with the expected date. The material is still only expected.
 */
export async function commitAllocationsExpectation(
  tx: Db,
  order: ProcurementOrder,
  ctx: CommandContext,
  demandAllocationIds?: readonly string[]
): Promise<string[]> {
  const ids = demandAllocationIds ? [...new Set(demandAllocationIds)] : await orderDemandAllocationIds(tx, order.id);
  if (ids.length === 0) return [];
  const allocations = await tx.demandAllocation.findMany({ where: { id: { in: ids } } });
  const changed: string[] = [];
  for (const allocation of allocations) {
    const fromPlan = ALLOCATION_COMMITTABLE.includes(allocation.status);
    const newDate =
      allocation.status === 'in_progress' &&
      (order.expectedAt?.getTime() ?? null) !== (allocation.expectedAt?.getTime() ?? null);
    if (!fromPlan && !newDate) continue;
    await tx.demandAllocation.update({
      where: { id: allocation.id },
      data: {
        ...(fromPlan ? { status: 'in_progress' } : {}),
        expectedAt: order.expectedAt ?? allocation.expectedAt,
        version: { increment: 1 },
      },
    });
    changed.push(allocation.id);
    ctx.emit(
      OPS_EVENTS.allocation.inProgress,
      {
        allocationId: allocation.id,
        demandId: allocation.demandId,
        procurementOrderId: order.id,
        orderNumber: order.number,
        expectedAt: order.expectedAt?.toISOString() ?? null,
        previousStatus: allocation.status,
      },
      { caseId: allocation.caseId, areaKey: PURCHASES_AREA_KEY, objectType: 'demand_allocation', objectId: allocation.id }
    );
  }
  return changed;
}

/**
 * An order stopped covering these allocations: when no other committed order
 * covers them they go back to `requested` (or `planned`) without expected date.
 */
export async function releaseAllocationsExpectation(
  tx: Db,
  demandAllocationIds: readonly string[],
  ctx: CommandContext,
  reason: string,
  excludeOrderId: string
): Promise<string[]> {
  const released: string[] = [];
  for (const allocationId of new Set(demandAllocationIds)) {
    const allocation = await tx.demandAllocation.findUnique({ where: { id: allocationId } });
    if (!allocation || allocation.status !== 'in_progress') continue;
    const others = await tx.procurementAllocation.findMany({ where: { demandAllocationId: allocation.id }, select: { orderLineId: true } });
    const otherLines = others.length
      ? await tx.procurementOrderLine.findMany({ where: { id: { in: others.map((o) => o.orderLineId) } }, select: { orderId: true } })
      : [];
    const otherOrders = otherLines.length
      ? await tx.procurementOrder.findMany({
          where: { id: { in: [...new Set(otherLines.map((l) => l.orderId))], not: excludeOrderId } },
          select: { id: true, status: true },
        })
      : [];
    if (otherOrders.some((o) => isCommitted(o.status))) continue;
    const status = allocation.linkedId ? 'requested' : 'planned';
    await tx.demandAllocation.update({
      where: { id: allocation.id },
      data: { status, expectedAt: null, version: { increment: 1 } },
    });
    released.push(allocation.id);
    ctx.emit(
      OPS_EVENTS.allocation.requested,
      { allocationId: allocation.id, demandId: allocation.demandId, previousStatus: 'in_progress', reason, procurementOrderId: excludeOrderId },
      { caseId: allocation.caseId, areaKey: PURCHASES_AREA_KEY, objectType: 'demand_allocation', objectId: allocation.id }
    );
  }
  return released;
}

// ---------------------------------------------------------------------------
// Lines and allocations
// ---------------------------------------------------------------------------

interface DesiredAllocation {
  demandId: string;
  qty: number;
  allocationId?: string | null;
  requestLineId?: string | null;
}

/** Replaces the demands a line supplies (exact split of one purchase among several sales). */
export async function applyLineAllocationsInTx(
  tx: Db,
  order: ProcurementOrder,
  line: ProcurementOrderLine,
  desired: readonly DesiredAllocation[],
  ctx: CommandContext,
  options: { silent?: boolean } = {}
): Promise<{ allocationIds: string[]; released: string[]; committed: string[] }> {
  if (order.status === 'cancelled' || order.status === 'closed') {
    throw new OperationsError('invalid_state', 'La orden está cerrada o cancelada');
  }
  if (num(line.qtyAccepted) > QTY_EPS || num(line.qtyReceived) > QTY_EPS) {
    throw new OperationsError('invalid_state', 'La partida ya tiene material recibido: su reparto no se cambia');
  }
  const byDemand = new Map<string, DesiredAllocation>();
  for (const entry of desired) {
    const current = byDemand.get(entry.demandId);
    byDemand.set(entry.demandId, current ? { ...current, qty: current.qty + entry.qty } : { ...entry });
  }
  const total = [...byDemand.values()].reduce((sum, entry) => sum + entry.qty, 0);
  if (total > num(line.qty) + QTY_EPS) {
    throw new OperationsError('invalid_quantity', `El reparto (${total}) supera la cantidad de la partida (${num(line.qty)})`);
  }
  const demandIds = [...byDemand.keys()];
  const demands = demandIds.length ? await tx.caseDemand.findMany({ where: { id: { in: demandIds } } }) : [];
  const direct = order.deliveryMode === 'direct_to_customer';
  const resolved: Array<DesiredAllocation & { demandAllocationId: string | null; caseId: string }> = [];
  for (const entry of byDemand.values()) {
    const demand = demands.find((d) => d.id === entry.demandId);
    if (!demand) throw new OperationsError('not_found', 'Alguna partida de venta del reparto no existe');
    if (demand.status === 'fulfilled' || demand.status === 'cancelled') {
      throw new OperationsError('invalid_state', `La partida "${truncate(demand.name, 60)}" ya está surtida o cancelada`);
    }
    if (direct && demand.caseId !== order.directDeliveryCaseId) {
      throw new OperationsError('invalid_payload', 'Una entrega directa sólo surte partidas de su expediente');
    }
    if (line.zohoItemId && demand.zohoItemId && line.zohoItemId !== demand.zohoItemId) {
      throw new OperationsError('invalid_payload', `La partida "${truncate(demand.name, 60)}" es de otro artículo`);
    }
    let demandAllocationId: string | null = null;
    const sources = direct ? ['direct_supplier'] : ['purchase'];
    if (entry.allocationId) {
      const allocation = await tx.demandAllocation.findUnique({ where: { id: entry.allocationId } });
      if (!allocation || allocation.demandId !== demand.id || !sources.includes(allocation.source)) {
        throw new OperationsError('invalid_payload', 'La asignación no corresponde a la partida o a este tipo de compra');
      }
      demandAllocationId = allocation.id;
    } else {
      const allocation = await tx.demandAllocation.findFirst({
        where: { demandId: demand.id, source: { in: sources }, status: { in: ['planned', 'requested', 'in_progress'] } },
        orderBy: { createdAt: 'asc' },
      });
      demandAllocationId = allocation?.id ?? null;
    }
    resolved.push({ ...entry, demandAllocationId, caseId: demand.caseId });
  }

  if (!line.zohoItemId && resolved.length > 0) {
    // A line that supplies sales must be a catalog item, or its receipt could not enter stock nor reserve.
    const items = [...new Set(demands.filter((d) => byDemand.has(d.id)).map((d) => d.zohoItemId))];
    if (items.length !== 1 || !items[0]) {
      throw new OperationsError(
        'invalid_payload',
        `La partida "${truncate(line.description, 60)}" no tiene artículo del catálogo y las ventas que surte no comparten uno: indica el artículo de la partida`
      );
    }
    await tx.procurementOrderLine.update({ where: { id: line.id }, data: { zohoItemId: items[0] } });
  }
  const existing = await tx.procurementAllocation.findMany({ where: { orderLineId: line.id } });
  const removed = existing.filter((row) => !byDemand.has(row.demandId));
  for (const row of removed) await tx.procurementAllocation.delete({ where: { id: row.id } });
  const allocationIds: string[] = [];
  for (const entry of resolved) {
    const current = existing.find((row) => row.demandId === entry.demandId);
    const data = {
      qty: D(entry.qty),
      demandAllocationId: entry.demandAllocationId,
      requestLineId: entry.requestLineId ?? current?.requestLineId ?? null,
    };
    const row = current
      ? await tx.procurementAllocation.update({ where: { id: current.id }, data })
      : await tx.procurementAllocation.create({ data: { orderLineId: line.id, demandId: entry.demandId, ...data } });
    allocationIds.push(row.id);
    await ctx.relate({ type: 'operational_case', id: entry.caseId }, { type: OBJ.order, id: order.id }, 'supplied_by');
  }

  let released: string[] = [];
  let committed: string[] = [];
  if (isCommitted(order.status)) {
    const keep = new Set(resolved.map((r) => r.demandAllocationId).filter(Boolean));
    released = await releaseAllocationsExpectation(
      tx,
      removed.map((r) => r.demandAllocationId).filter((id): id is string => Boolean(id) && !keep.has(id)),
      ctx,
      `Se quitó del reparto de ${order.number}`,
      order.id
    );
    committed = await commitAllocationsExpectation(
      tx,
      order,
      ctx,
      resolved.map((r) => r.demandAllocationId).filter((id): id is string => Boolean(id))
    );
  }
  if (!options.silent) {
    emitPurchases(
      ctx,
      EV.allocated,
      {
        orderId: order.id,
        orderLineId: line.id,
        allocations: resolved.map((r) => ({ demandId: r.demandId, qty: r.qty, demandAllocationId: r.demandAllocationId })),
        removed: removed.map((r) => r.demandId),
      },
      { caseId: resolved[0]?.caseId ?? null, objectType: OBJ.order, objectId: order.id }
    );
    publishBoard(ctx, { orderId: order.id });
  }
  return { allocationIds, released, committed };
}

interface PreparedLine {
  requestLineId: string | null;
  zohoItemId: string | null;
  supplierProductId: string | null;
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  taxRate: number | null;
  allocations: DesiredAllocation[];
  sources: Array<{ requestLineId: string; qty: number }>;
}

async function assertRequestOpen(tx: Db, requestId: string): Promise<void> {
  const request = await tx.purchaseRequest.findUnique({ where: { id: requestId }, select: { status: true, number: true } });
  if (!request || ['draft', 'cancelled', 'closed'].includes(request.status)) {
    throw new OperationsError('invalid_state', `La solicitud ${request?.number ?? ''} no está abierta`.trim());
  }
}

async function prepareLines(tx: Db, supplier: Supplier, inputs: readonly OrderLineInput[]): Promise<PreparedLine[]> {
  const prepared: PreparedLine[] = [];
  for (const input of inputs) {
    if (input.requestLineId && input.sources && input.sources.length > 0) {
      throw new OperationsError('invalid_payload', 'Una partida viene de una solicitud o de varias consolidadas, no de ambas');
    }
    const requestLine = input.requestLineId
      ? await tx.purchaseRequestLine.findUnique({ where: { id: input.requestLineId } })
      : null;
    if (input.requestLineId) {
      if (!requestLine || requestLine.status === 'cancelled') {
        throw new OperationsError('not_found', 'La partida de la solicitud de compra no existe o fue cancelada');
      }
      await assertRequestOpen(tx, requestLine.requestId);
    }
    const sourceLines: Array<{ line: NonNullable<typeof requestLine>; qty: number }> = [];
    for (const source of input.sources ?? []) {
      const line = await tx.purchaseRequestLine.findUnique({ where: { id: source.requestLineId } });
      if (!line || line.status === 'cancelled') {
        throw new OperationsError('not_found', 'Alguna partida consolidada no existe o fue cancelada');
      }
      if (!line.demandId) {
        throw new OperationsError('invalid_payload', 'Sólo se consolidan en una partida las solicitudes ligadas a una venta');
      }
      await assertRequestOpen(tx, line.requestId);
      sourceLines.push({ line, qty: source.qty });
    }
    const product = input.supplierProductId
      ? await tx.supplierProduct.findUnique({ where: { id: input.supplierProductId } })
      : null;
    if (input.supplierProductId && (!product || product.supplierId !== supplier.id)) {
      throw new OperationsError('invalid_payload', 'El producto no es de este proveedor');
    }
    const firstSource = sourceLines[0]?.line ?? null;
    const zohoItemId = input.zohoItemId ?? requestLine?.zohoItemId ?? firstSource?.zohoItemId ?? (product?.zohoItemId || null);
    const description = input.description ?? requestLine?.description ?? firstSource?.description ?? product?.description ?? null;
    const unit = input.unit ?? requestLine?.unit ?? firstSource?.unit ?? product?.unit ?? null;
    if (!description) throw new OperationsError('invalid_payload', 'Describe cada partida de la orden');
    if (!unit) throw new OperationsError('invalid_payload', `Indica la unidad de "${truncate(description, 60)}"`);
    let allocations: DesiredAllocation[] = (input.allocations ?? []).map((a) => ({
      demandId: a.demandId,
      qty: a.qty,
      allocationId: a.allocationId ?? null,
      requestLineId: requestLine?.id ?? null,
    }));
    if (!input.allocations && requestLine?.demandId) {
      const remaining = remainingToOrder({ qty: num(requestLine.qty), qtyOrdered: num(requestLine.qtyOrdered), status: requestLine.status });
      const qty = Math.min(input.qty, remaining > QTY_EPS ? remaining : input.qty);
      allocations = [{ demandId: requestLine.demandId, qty, allocationId: requestLine.allocationId, requestLineId: requestLine.id }];
    }
    if (!input.allocations && sourceLines.length > 0) {
      const total = sourceLines.reduce((sum, source) => sum + source.qty, 0);
      if (total > input.qty + QTY_EPS) {
        throw new OperationsError('invalid_quantity', `Las solicitudes consolidadas (${round4(total)}) superan la cantidad de la partida (${input.qty})`);
      }
      allocations = sourceLines.map(({ line, qty }) => ({
        demandId: line.demandId!,
        qty,
        allocationId: line.allocationId,
        requestLineId: line.id,
      }));
    }
    prepared.push({
      requestLineId: requestLine?.id ?? null,
      zohoItemId,
      supplierProductId: product?.id ?? null,
      description,
      qty: input.qty,
      unit,
      unitPrice: input.unitPrice,
      taxRate: input.taxRate ?? null,
      allocations,
      sources: sourceLines.map(({ line, qty }) => ({ requestLineId: line.id, qty })),
    });
  }
  return prepared;
}

async function insertLines(
  tx: Db,
  order: ProcurementOrder,
  prepared: readonly PreparedLine[],
  lineTotals: readonly Prisma.Decimal[],
  ctx: CommandContext
): Promise<ProcurementOrderLine[]> {
  const lines: ProcurementOrderLine[] = [];
  const requestIds = new Set<string>();
  for (const [index, entry] of prepared.entries()) {
    const line = await tx.procurementOrderLine.create({
      data: {
        orderId: order.id,
        requestLineId: entry.requestLineId,
        zohoItemId: entry.zohoItemId,
        supplierProductId: entry.supplierProductId,
        description: entry.description,
        qty: D(entry.qty),
        unit: entry.unit,
        unitPrice: D(entry.unitPrice),
        taxRate: entry.taxRate === null ? null : D(entry.taxRate),
        lineTotal: lineTotals[index],
        status: 'open',
        sortOrder: index,
      },
    });
    lines.push(line);
    const takes = entry.requestLineId ? [{ requestLineId: entry.requestLineId, qty: entry.qty }] : entry.sources;
    for (const take of takes) {
      const updated = await adjustRequestLineOrdered(tx, take.requestLineId, take.qty);
      if (updated) {
        requestIds.add(updated.requestId);
        await ctx.relate({ type: OBJ.request, id: updated.requestId }, { type: OBJ.order, id: order.id }, 'ordered_in');
      }
    }
    if (entry.allocations.length > 0) {
      await applyLineAllocationsInTx(tx, order, line, entry.allocations, ctx, { silent: true });
    }
  }
  await recomputeRequestStatuses(tx, requestIds, ctx);
  return lines;
}

/** Request lines an order line took quantity from (its own or the consolidated ones through the allocations). */
async function requestLineShares(tx: Db, line: ProcurementOrderLine): Promise<Array<{ requestLineId: string; qty: number }>> {
  if (line.requestLineId) return [{ requestLineId: line.requestLineId, qty: num(line.qty) }];
  const rows = await tx.procurementAllocation.findMany({
    where: { orderLineId: line.id, requestLineId: { not: null } },
    select: { requestLineId: true, qty: true },
  });
  const byLine = new Map<string, number>();
  for (const row of rows) byLine.set(row.requestLineId!, round4((byLine.get(row.requestLineId!) ?? 0) + num(row.qty)));
  return [...byLine].map(([requestLineId, qty]) => ({ requestLineId, qty }));
}

/** Gives `qty` of an order line back to its request lines, proportionally to what each one gave. */
async function giveBackToRequests(tx: Db, line: ProcurementOrderLine, qty: number, requestIds: Set<string>): Promise<void> {
  const shares = await requestLineShares(tx, line);
  const total = shares.reduce((sum, share) => sum + share.qty, 0);
  if (!(total > 0) || !(qty > 0)) return;
  for (const share of shares) {
    const portion = round4((Math.min(qty, total) * share.qty) / total);
    if (portion <= 0) continue;
    const updated = await adjustRequestLineOrdered(tx, share.requestLineId, -portion);
    if (updated) requestIds.add(updated.requestId);
  }
}

/** Gives back what the lines took from the requests and removes them (draft edition). */
async function detachDraftLines(tx: Db, order: ProcurementOrder, ctx: CommandContext): Promise<void> {
  const lines = await loadOrderLines(tx, order.id);
  const requestIds = new Set<string>();
  for (const line of lines) {
    await giveBackToRequests(tx, line, num(line.qty), requestIds);
    await tx.procurementAllocation.deleteMany({ where: { orderLineId: line.id } });
    await tx.procurementOrderLine.delete({ where: { id: line.id } });
  }
  await recomputeRequestStatuses(tx, requestIds, ctx);
}

// ---------------------------------------------------------------------------
// Create / update draft
// ---------------------------------------------------------------------------

/**
 * Destination implied by the demand allocations the lines supply (explicit
 * allocations, request lines and consolidated sources): the case of
 * direct-supplier allocations, or the warehouse.
 */
async function inferDestination(
  tx: Db,
  lines: readonly OrderLineInput[]
): Promise<{ deliveryMode: 'warehouse' | 'direct_to_customer'; directDeliveryCaseId: string | null }> {
  const requestLineIds = [
    ...new Set(lines.flatMap((line) => [line.requestLineId, ...(line.sources ?? []).map((s) => s.requestLineId)]).filter((id): id is string => Boolean(id))),
  ];
  const requestLines = requestLineIds.length
    ? await tx.purchaseRequestLine.findMany({ where: { id: { in: requestLineIds } }, select: { allocationId: true } })
    : [];
  const allocationIds = [
    ...new Set(
      [...lines.flatMap((line) => (line.allocations ?? []).map((a) => a.allocationId)), ...requestLines.map((r) => r.allocationId)].filter(
        (id): id is string => Boolean(id)
      )
    ),
  ];
  const warehouse = { deliveryMode: 'warehouse' as const, directDeliveryCaseId: null };
  if (allocationIds.length === 0) return warehouse;
  const allocations = await tx.demandAllocation.findMany({ where: { id: { in: allocationIds } }, select: { source: true, caseId: true } });
  const direct = allocations.filter((a) => a.source === 'direct_supplier');
  if (direct.length === 0) return warehouse;
  if (direct.length !== allocations.length || new Set(direct.map((a) => a.caseId)).size !== 1) {
    throw new OperationsError(
      'invalid_payload',
      'La orden mezcla entregas directas al cliente de distintos expedientes o con compras a bodega: haz una orden por entrega directa'
    );
  }
  return { deliveryMode: 'direct_to_customer', directDeliveryCaseId: direct[0].caseId };
}

async function resolveDestination(
  tx: Db,
  input: { deliveryMode: string; warehouseId?: string | null; directDeliveryCaseId?: string | null }
): Promise<{ warehouseId: string | null; directDeliveryCaseId: string | null }> {
  if (input.deliveryMode === 'direct_to_customer') {
    if (!input.directDeliveryCaseId) {
      throw new OperationsError('invalid_payload', 'Indica el expediente del cliente que recibe la entrega directa');
    }
    const opCase = assertFoundRow(
      await tx.operationalCase.findUnique({ where: { id: input.directDeliveryCaseId }, select: { id: true, status: true, caseNumber: true } }),
      'No se encontró el expediente'
    );
    if (opCase.status === 'closed' || opCase.status === 'cancelled') {
      throw new OperationsError('invalid_state', `El expediente ${opCase.caseNumber} ya está cerrado o cancelado`);
    }
    return { warehouseId: null, directDeliveryCaseId: opCase.id };
  }
  if (input.directDeliveryCaseId) {
    throw new OperationsError('invalid_payload', 'Una compra a bodega no lleva expediente de entrega directa');
  }
  if (input.warehouseId) {
    const warehouse = await tx.warehouse.findUnique({ where: { id: input.warehouseId }, select: { id: true, active: true, name: true } });
    if (!warehouse) throw new OperationsError('not_found', 'No se encontró la bodega');
    if (!warehouse.active) throw new OperationsError('invalid_state', `La bodega ${warehouse.name} está desactivada`);
    return { warehouseId: warehouse.id, directDeliveryCaseId: null };
  }
  const first = await tx.warehouse.findFirst({ where: { active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  return { warehouseId: first?.id ?? null, directDeliveryCaseId: null };
}

export async function createOrderInTx(
  tx: Db,
  input: CreateOrderInput,
  ctx: CommandContext
): Promise<{ order: ProcurementOrder; lines: ProcurementOrderLine[] }> {
  const supplier = await loadSupplier(tx, input.supplierId);
  if (supplier.status !== 'active') {
    throw new OperationsError('invalid_state', `El proveedor ${supplier.name} está bloqueado o archivado`);
  }
  const inferred = input.deliveryMode ? null : await inferDestination(tx, input.lines);
  const deliveryMode = input.deliveryMode ?? inferred!.deliveryMode;
  const destination = await resolveDestination(tx, {
    deliveryMode,
    warehouseId: input.warehouseId,
    directDeliveryCaseId: input.directDeliveryCaseId ?? inferred?.directDeliveryCaseId ?? null,
  });
  const expectedAt =
    toDate(input.expectedAt ?? null) ??
    (supplier.leadTimeDaysDefault !== null ? addDays(ctx.now, supplier.leadTimeDaysDefault) : null);
  const prepared = await prepareLines(tx, supplier, input.lines);
  const totals = computeOrderTotals(prepared, input.freight);
  const number = await nextFolio(tx, 'order');
  const order = await tx.procurementOrder.create({
    data: {
      number,
      supplierId: supplier.id,
      rfqResponseId: input.rfqResponseId ?? null,
      status: 'draft',
      currency: input.currency ?? supplier.currency,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      freight: totals.freight,
      total: totals.total,
      paymentMode: input.paymentMode ?? supplier.paymentMode,
      paymentStatus: 'unpaid',
      expectedAt,
      deliveryMode,
      warehouseId: destination.warehouseId,
      directDeliveryCaseId: destination.directDeliveryCaseId,
      notes: input.notes ?? null,
      createdByUserId: recordActorId(ctx),
    },
  });
  const lines = await insertLines(tx, order, prepared, totals.lineTotals, ctx);
  await ctx.relate({ type: OBJ.order, id: order.id }, { type: OBJ.supplier, id: supplier.id }, 'ordered_from');
  const caseIds = await orderCaseIds(tx, order);
  emitPurchases(
    ctx,
    EV.created,
    {
      orderId: order.id,
      number,
      supplierId: supplier.id,
      supplierName: supplier.name,
      total: order.total.toString(),
      currency: order.currency,
      lines: lines.length,
      deliveryMode: order.deliveryMode,
      caseIds,
      rfqResponseId: order.rfqResponseId,
    },
    { caseId: caseIds[0] ?? null, objectType: OBJ.order, objectId: order.id }
  );
  publishBoard(ctx, { orderId: order.id });
  return { order, lines };
}

export async function updateOrderDraftInTx(
  tx: Db,
  input: UpdateOrderInput,
  ctx: CommandContext
): Promise<{ order: ProcurementOrder; lines: ProcurementOrderLine[] }> {
  const order = await loadOrder(tx, input.orderId);
  throwCheck(checkEditOrder(order.status));
  const supplier = await loadSupplier(tx, order.supplierId);
  const deliveryMode = input.deliveryMode ?? order.deliveryMode;
  const destination = await resolveDestination(tx, {
    deliveryMode,
    warehouseId: input.warehouseId === undefined ? order.warehouseId : input.warehouseId,
    directDeliveryCaseId:
      input.directDeliveryCaseId === undefined
        ? deliveryMode === 'direct_to_customer'
          ? order.directDeliveryCaseId
          : null
        : input.directDeliveryCaseId,
  });
  const header = {
    currency: input.currency ?? order.currency,
    paymentMode: input.paymentMode ?? order.paymentMode,
    deliveryMode,
    warehouseId: destination.warehouseId,
    directDeliveryCaseId: destination.directDeliveryCaseId,
    expectedAt: input.expectedAt === undefined ? order.expectedAt : toDate(input.expectedAt),
    notes: input.notes === undefined ? order.notes : input.notes,
  };
  let lines: ProcurementOrderLine[];
  const freight = input.freight ?? num(order.freight);
  let updated = await tx.procurementOrder.update({ where: { id: order.id }, data: header });
  if (input.lines) {
    await detachDraftLines(tx, updated, ctx);
    const prepared = await prepareLines(tx, supplier, input.lines);
    const totals = computeOrderTotals(prepared, freight);
    updated = await tx.procurementOrder.update({
      where: { id: order.id },
      data: { subtotal: totals.subtotal, taxTotal: totals.taxTotal, freight: totals.freight, total: totals.total },
    });
    lines = await insertLines(tx, updated, prepared, totals.lineTotals, ctx);
  } else {
    lines = await loadOrderLines(tx, order.id);
    const totals = computeOrderTotals(
      lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, taxRate: l.taxRate })),
      freight
    );
    updated = await tx.procurementOrder.update({
      where: { id: order.id },
      data: { subtotal: totals.subtotal, taxTotal: totals.taxTotal, freight: totals.freight, total: totals.total },
    });
  }
  emitPurchases(
    ctx,
    EV.updated,
    { orderId: order.id, number: order.number, total: updated.total.toString(), linesReplaced: Boolean(input.lines) },
    { objectType: OBJ.order, objectId: order.id }
  );
  publishBoard(ctx, { orderId: order.id });
  return { order: updated, lines };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export interface SubmitOrderData {
  orderId: string;
  status: string;
  approvalRequestId: string;
  approvalStatus: string;
  requiredApprovals: number;
  autoApproved: boolean;
  approverCount: number;
}

export async function submitOrderInTx(
  tx: Db,
  input: z.output<typeof submitOrderSchema>,
  ctx: CommandContext
): Promise<SubmitOrderData> {
  const order = await loadOrder(tx, input.orderId);
  const lines = await loadOrderLines(tx, order.id);
  throwCheck(
    checkSubmitOrder({ status: order.status, lineCount: lines.filter((l) => l.status !== 'cancelled').length, total: order.total })
  );
  const supplier = await loadSupplier(tx, order.supplierId);
  if (supplier.status !== 'active') {
    throw new OperationsError('invalid_state', `El proveedor ${supplier.name} está bloqueado o archivado`);
  }
  await tx.procurementOrder.update({ where: { id: order.id }, data: { status: 'pending_approval' } });
  const caseIds = await orderCaseIds(tx, order);
  // A person is the requester. An AI identity keeps two distinct signatures and, when a human caused
  // the turn, that human is the requester so they cannot be one of the signatures.
  let causer: string | null = null;
  if (ctx.actor.type === 'ai' && input.causedByUserId) {
    const user = await tx.user.findUnique({ where: { id: input.causedByUserId }, select: { isActive: true, isBot: true } });
    if (user?.isActive && !user.isBot) {
      causer = input.causedByUserId;
      await ctx.relate({ type: OBJ.order, id: order.id }, { type: 'user', id: causer }, 'caused_by');
    }
  }
  const requester =
    ctx.actor.type === 'user'
      ? { requestedByUserId: ctx.actor.id }
      : { requestedByUserId: causer ?? `${ctx.actor.type}:${ctx.actor.id}`.slice(0, 120), minApprovals: 2 };
  const outcome = await requestApproval(tx, {
    scope: 'procurement',
    targetType: OBJ.order,
    targetId: order.id,
    amount: order.total,
    currency: order.currency,
    caseId: caseIds[0] ?? null,
    areaKey: PURCHASES_AREA_KEY,
    ...requester,
    title: truncate(`Orden ${order.number} a ${supplier.name}`, 200),
    description: truncate(
      [
        lines.map((l) => `${num(l.qty)} ${l.unit} ${l.description}`).join('; '),
        input.note ? `Nota: ${input.note}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      1000
    ),
  });
  const updated = await tx.procurementOrder.update({
    where: { id: order.id },
    data: { approvalRequestId: outcome.approvalRequest.id },
  });
  emitPurchases(
    ctx,
    EV.submitted,
    {
      orderId: order.id,
      number: order.number,
      approvalRequestId: outcome.approvalRequest.id,
      requiredApprovals: outcome.approvalRequest.requiredApprovals,
      autoApproved: outcome.autoApproved,
      total: order.total.toString(),
      currency: order.currency,
    },
    { caseId: caseIds[0] ?? null, objectType: OBJ.order, objectId: order.id }
  );
  publishBoard(ctx, { orderId: order.id });
  return {
    orderId: order.id,
    status: updated.status,
    approvalRequestId: outcome.approvalRequest.id,
    approvalStatus: outcome.status,
    requiredApprovals: outcome.approvalRequest.requiredApprovals,
    autoApproved: outcome.autoApproved,
    approverCount: outcome.approverUserIds.length,
  };
}

function lastDecisionNote(decisions: Prisma.JsonValue): string | null {
  if (!Array.isArray(decisions)) return null;
  for (let i = decisions.length - 1; i >= 0; i--) {
    const entry = decisions[i] as Record<string, unknown> | null;
    if (entry && typeof entry.note === 'string' && entry.note.trim()) return entry.note.trim();
  }
  return null;
}

/** Reaction registered with `onApprovalDecided('procurement_order')`; runs in the deciding transaction. */
export async function applyOrderApprovalDecision(tx: Db, event: ApprovalDecidedEvent): Promise<void> {
  const { ctx } = event;
  const order = await tx.procurementOrder.findUnique({ where: { id: event.approvalRequest.targetId } });
  if (!order) return;
  if (order.approvalRequestId && order.approvalRequestId !== event.approvalRequest.id) return;
  const next = statusAfterApprovalDecision(order.status, event.status);
  if (!next) return;
  // Auto-approval inside `purchases.order.submit`: the order is that command's aggregate (engine bumps it).
  const bump = !(event.auto && ctx.commandType === PURCHASES_COMMANDS.orderSubmit);
  const caseIds = await orderCaseIds(tx, order);
  const creator = order.createdByUserId.includes(':') ? null : order.createdByUserId;
  if (next === 'approved') {
    const updated = await tx.procurementOrder.update({
      where: { id: order.id },
      data: { status: 'approved', ...(bump ? { version: { increment: 1 } } : {}) },
    });
    await commitAllocationsExpectation(tx, updated, ctx);
    const lines = await loadOrderLines(tx, order.id);
    const note = `Orden ${order.number} aprobada${order.expectedAt ? `; llegada estimada ${isoDay(order.expectedAt)}` : ''}`;
    for (const request of await openShortfallRequests(tx, {
      requestLineIds: lines.map((l) => l.requestLineId).filter((id): id is string => Boolean(id)),
      allocationIds: await orderDemandAllocationIds(tx, order.id),
    })) {
      if (['sent', 'acknowledged', 'blocked'].includes(request.status)) {
        await transitionAreaRequestInTx(tx, request, 'accept', { note });
      }
    }
    for (const line of lines) {
      await touchSupplierProductPrice(tx, {
        supplierId: order.supplierId,
        zohoItemId: line.zohoItemId,
        description: line.description,
        unit: line.unit,
        price: line.unitPrice,
        currency: order.currency,
        source: order.rfqResponseId ? 'rfq' : 'manual',
        at: ctx.now,
      });
    }
    ctx.outbox({
      type: PURCHASES_JOB_TYPES.orderFollowup,
      payload: { orderId: order.id, step: 'payment', approvalRequestId: event.approvalRequest.id },
      dedupeKey: `${PURCHASES_JOB_TYPES.orderFollowup}:${order.id}:payment:${event.approvalRequest.id}`,
      groupKey: `purchases:order:${order.id}`,
      maxAttempts: 3,
      createdBy: 'purchases',
    });
    emitPurchases(
      ctx,
      EV.approved,
      { orderId: order.id, number: order.number, approvalRequestId: event.approvalRequest.id, auto: event.auto, decidedByUserId: event.decidedByUserId },
      { caseId: caseIds[0] ?? null, objectType: OBJ.order, objectId: order.id }
    );
    if (creator && creator !== event.decidedByUserId) {
      ctx.notify({
        userId: creator,
        category: purchaseNotificationCategory(),
        type: 'purchase_order_approved',
        title: `Aprobada: orden ${order.number}`,
        body: 'Envíala al proveedor; el pago se solicita en automático cuando aplica',
        url: `/app/purchases/orders/${order.id}`,
        entityType: OBJ.order,
        entityId: order.id,
      });
    }
  } else {
    await tx.procurementOrder.update({
      where: { id: order.id },
      data: { status: 'draft', approvalRequestId: null, ...(bump ? { version: { increment: 1 } } : {}) },
    });
    const note = lastDecisionNote(event.approvalRequest.decisions);
    emitPurchases(
      ctx,
      EV.rejected,
      { orderId: order.id, number: order.number, approvalRequestId: event.approvalRequest.id, note },
      { caseId: caseIds[0] ?? null, objectType: OBJ.order, objectId: order.id }
    );
    if (creator && creator !== event.decidedByUserId) {
      ctx.notify({
        userId: creator,
        category: purchaseNotificationCategory(),
        type: 'purchase_order_rejected',
        title: `Rechazada: orden ${order.number}`,
        body: note ?? 'Revisa la orden y vuelve a enviarla a aprobación',
        url: `/app/purchases/orders/${order.id}`,
        entityType: OBJ.order,
        entityId: order.id,
      });
    }
  }
  publishBoard(ctx, { orderId: order.id });
}

/** `payment_authorization` requests of an order: about its payable (current) or about the order itself. */
async function paymentAuthorizationRequestsOf(tx: Db, order: Pick<ProcurementOrder, 'id' | 'obligationId'>) {
  return tx.areaRequest.findMany({
    where: {
      kind: 'payment_authorization',
      OR: [
        ...(order.obligationId ? [{ objectType: OBLIGATION_OBJECT_TYPE, objectId: order.obligationId }] : []),
        { objectType: OBJ.order, objectId: order.id },
      ],
    },
  });
}

async function cancelPendingApproval(tx: Db, approvalRequestId: string, reason: string, ctx: CommandContext): Promise<void> {
  const approval = await tx.approvalRequest.findUnique({ where: { id: approvalRequestId } });
  if (!approval || approval.status !== 'pending') return;
  await tx.approvalRequest.update({
    where: { id: approval.id },
    data: { status: 'cancelled', decidedAt: ctx.now, version: { increment: 1 } },
  });
  const items = await tx.workItem.findMany({
    where: { objectType: 'approval_request', objectId: approval.id, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
  });
  for (const item of items) await cancelWorkItemInTx(tx, item, { reason });
  ctx.emit(
    OPS_EVENTS.approval.cancelled,
    {
      approvalRequestId: approval.id,
      scope: approval.scope,
      targetType: approval.targetType,
      targetId: approval.targetId,
      reason,
    },
    { caseId: approval.caseId, areaKey: approval.areaKey, objectType: 'approval_request', objectId: approval.id }
  );
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

export interface RequestPaymentData {
  orderId: string;
  status: string;
  obligationId: string;
  areaRequestId: string | null;
  workItemId: string | null;
  /** `payment` approval of the payable (finance settles it only once approved). */
  approvalRequestId: string | null;
  /** pending | approved | no_approvers */
  authorizationStatus: string;
  dueAt: string;
}

export async function requestPaymentInTx(
  tx: Db,
  input: z.output<typeof requestPaymentSchema>,
  ctx: CommandContext
): Promise<RequestPaymentData> {
  const order = await loadOrder(tx, input.orderId);
  throwCheck(checkRequestPayment({ status: order.status, paymentStatus: order.paymentStatus, obligationId: order.obligationId }));
  const supplier = await loadSupplier(tx, order.supplierId);
  const caseIds = await orderCaseIds(tx, order);
  const caseId = caseIds[0] ?? null;
  const explicit = toDate(input.dueAt ?? null);
  const dueAt =
    explicit ??
    (order.paymentMode === 'prepaid'
      ? addDays(ctx.now, 1)
      : order.paymentMode === 'credit'
        ? addDays(order.expectedAt ?? ctx.now, supplier.paymentTermsDays ?? 30)
        : (order.expectedAt ?? addDays(ctx.now, 3)));
  const obligation = await createProcurementPayable(
    tx,
    {
      orderId: order.id,
      orderNumber: order.number,
      supplierId: supplier.id,
      supplierName: supplier.name,
      zohoContactId: supplier.zohoContactId,
      caseId,
      currency: order.currency,
      amount: D(order.total).toFixed(2),
      dueAt,
    },
    ctx
  );
  const status = statusAfterPaymentRequest(order.status as OrderStatus, order.paymentMode);
  await tx.procurementOrder.update({ where: { id: order.id }, data: { obligationId: obligation.id, status } });
  await ctx.relate({ type: OBJ.order, id: order.id }, { type: OBLIGATION_OBJECT_TYPE, id: obligation.id }, 'payable');

  let areaRequestId: string | null = null;
  let workItemId: string | null = null;
  const paymentReason = truncate(`Orden de compra ${order.number} (${labelOf(PAYMENT_MODE_LABELS, order.paymentMode)})`, 500);
  // With a case, a prepaid / cash-on-delivery payment is a request between areas that blocks the case.
  // It points at the payable (objectType `obligation`), which is what Contabilidad authorizes and pays.
  if (order.paymentMode !== 'credit' && caseId) {
    const { request, workItem } = await ctx.createAreaRequest({
      caseId,
      fromAreaKey: PURCHASES_AREA_KEY,
      toAreaKey: 'contabilidad',
      kind: 'payment_authorization',
      objectType: OBLIGATION_OBJECT_TYPE,
      objectId: obligation.id,
      title: truncate(`Pagar ${order.number} a ${supplier.name}`, 200),
      payload: {
        procurementOrderId: order.id,
        vendorId: supplier.id,
        vendorName: supplier.name.slice(0, 200),
        amount: Number(D(order.total).toFixed(2)),
        currency: order.currency,
        dueDate: isoDay(dueAt),
        reason: paymentReason,
      },
    });
    areaRequestId = request.id;
    workItemId = workItem.id;
    await ctx.relate({ type: 'area_request', id: request.id }, { type: OBJ.order, id: order.id }, 'payment_for_order');
  }
  // Every payable of a purchase needs its `payment` approval before finance settles it, in every
  // payment mode (a credit order asks for it now, so it is signed long before the due date).
  const humanRequester = ctx.actor.type === 'user' ? null : order.createdByUserId.includes(':') ? null : order.createdByUserId;
  let approvalRequestId: string | null = null;
  let authorizationStatus = 'pending';
  try {
    const authorization = await requestProcurementPaymentAuthorization(
      tx,
      { obligationId: obligation.id, areaRequestId, requestedByUserId: humanRequester, note: paymentReason },
      ctx
    );
    approvalRequestId = authorization.approvalRequestId;
    authorizationStatus = authorization.status;
  } catch (err) {
    if (!(err instanceof OperationsError) || err.code !== 'no_approvers') throw err;
    // Nothing was written by the approval; the payable stays and Contabilidad is told why it cannot be authorized.
    authorizationStatus = 'no_approvers';
    const item = await ctx.createWorkItem({
      areaKey: 'contabilidad',
      kind: 'action',
      title: truncate(`Autorizar y pagar ${order.number} a ${supplier.name}`, 200),
      description: truncate(
        `${D(order.total).toFixed(2)} ${order.currency} · vence ${isoDay(dueAt)}. No se pudo pedir la autorización del pago: ${err.message}. Asigna aprobadores de pagos y solicita la autorización.`,
        1000
      ),
      objectType: OBLIGATION_OBJECT_TYPE,
      objectId: obligation.id,
      caseId,
    });
    workItemId = workItemId ?? item.id;
  }
  emitPurchases(
    ctx,
    EV.paymentRequested,
    {
      orderId: order.id,
      number: order.number,
      obligationId: obligation.id,
      paymentMode: order.paymentMode,
      dueAt: dueAt.toISOString(),
      areaRequestId,
      workItemId,
      approvalRequestId,
      authorizationStatus,
      amount: order.total.toString(),
      currency: order.currency,
    },
    { caseId, objectType: OBJ.order, objectId: order.id }
  );
  publishBoard(ctx, { orderId: order.id });
  return {
    orderId: order.id,
    status,
    obligationId: obligation.id,
    areaRequestId,
    workItemId,
    approvalRequestId,
    authorizationStatus,
    dueAt: dueAt.toISOString(),
  };
}

/**
 * Contract with finance (`onObligationSettled('procurement_order')`): the
 * payable of the order received money. Paid when the obligation is settled,
 * partial otherwise. A prepaid order waiting for the payment moves on.
 */
export async function markOrderPaid(tx: Db, orderId: string, ctx: CommandContext): Promise<ProcurementOrder | null> {
  const order = await tx.procurementOrder.findUnique({ where: { id: orderId } });
  if (!order) return null;
  let paymentStatus: 'unpaid' | 'partial' | 'paid' = 'paid';
  if (order.obligationId) {
    const obligation = await tx.obligation.findUnique({ where: { id: order.obligationId } });
    if (obligation) {
      paymentStatus = obligation.status === 'settled' ? 'paid' : paymentStatusFor(obligation.expectedAmount, obligation.settledAmount);
    }
  }
  if (paymentStatus === order.paymentStatus) return order;
  const wasPaid = order.paymentStatus === 'paid';
  const sent = Boolean(order.sentToSupplierAt);
  const status =
    paymentStatus === 'paid'
      ? statusAfterPaid(order.status as OrderStatus, sent)
      : wasPaid
        ? statusAfterPaymentReversed(order.status as OrderStatus, order.paymentMode, sent)
        : order.status;
  const updated = await tx.procurementOrder.update({
    where: { id: order.id },
    data: { paymentStatus, status, version: { increment: 1 } },
  });
  if (paymentStatus === 'paid') {
    const requests = await paymentAuthorizationRequestsOf(tx, order);
    for (const request of requests) {
      if (isAreaRequestOpenStatus(request.status)) {
        await transitionAreaRequestInTx(tx, request, 'resolve', { answer: `Pago aplicado a la orden ${order.number}` });
      }
    }
    if (order.obligationId) {
      const items = await tx.workItem.findMany({
        where: {
          areaKey: 'contabilidad',
          objectType: OBLIGATION_OBJECT_TYPE,
          objectId: order.obligationId,
          status: { in: [...WORK_ITEM_OPEN_STATUSES] },
        },
      });
      for (const item of items) {
        await completeWorkItemInTx(tx, item, { result: { paid: true, orderId: order.id }, skipEvidenceCheck: true });
      }
    }
  } else if (wasPaid && order.obligationId) {
    // A payment of the order was reversed in finance: Contabilidad pays it again.
    const open = await tx.workItem.findFirst({
      where: {
        areaKey: 'contabilidad',
        objectType: OBLIGATION_OBJECT_TYPE,
        objectId: order.obligationId,
        status: { in: [...WORK_ITEM_OPEN_STATUSES] },
      },
      select: { id: true },
    });
    if (!open) {
      const supplier = await tx.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } });
      await ctx.createWorkItem({
        areaKey: 'contabilidad',
        kind: 'action',
        title: truncate(`Volver a pagar ${order.number}${supplier ? ` a ${supplier.name}` : ''}`, 200),
        description: `Se revirtió el pago de la orden: vuelve a registrarlo (${paymentStatus === 'partial' ? 'queda un saldo parcial' : 'sin pagos aplicados'}).`,
        objectType: OBLIGATION_OBJECT_TYPE,
        objectId: order.obligationId,
      });
    }
  }
  const caseIds = await orderCaseIds(tx, order);
  emitPurchases(
    ctx,
    EV.paid,
    { orderId: order.id, number: order.number, paymentStatus, previousPaymentStatus: order.paymentStatus, status },
    { caseId: caseIds[0] ?? null, objectType: OBJ.order, objectId: order.id }
  );
  const creator = order.createdByUserId.includes(':') ? null : order.createdByUserId;
  if (creator && paymentStatus === 'paid') {
    ctx.notify({
      userId: creator,
      category: purchaseNotificationCategory(),
      type: 'purchase_order_paid',
      title: `Pagada: orden ${order.number}`,
      body: order.sentToSupplierAt ? 'El proveedor ya tiene la orden; espera el material' : 'Ya puedes enviarla al proveedor',
      url: `/app/purchases/orders/${order.id}`,
      entityType: OBJ.order,
      entityId: order.id,
    });
  }
  publishBoard(ctx, { orderId: order.id });
  return updated;
}

export async function recordFollowupFailureInTx(
  tx: Db,
  input: z.output<typeof followupFailedSchema>,
  ctx: CommandContext
): Promise<{ workItemId: string | null }> {
  const order = await loadOrder(tx, input.orderId);
  if (order.obligationId || order.status === 'cancelled') return { workItemId: null };
  const existing = await tx.workItem.findFirst({
    where: { objectType: OBJ.order, objectId: order.id, areaKey: PURCHASES_AREA_KEY, status: { in: [...WORK_ITEM_OPEN_STATUSES] }, title: { startsWith: 'Solicitar el pago' } },
    select: { id: true },
  });
  if (existing) return { workItemId: existing.id };
  const item = await ctx.createWorkItem({
    areaKey: PURCHASES_AREA_KEY,
    kind: 'action',
    title: truncate(`Solicitar el pago de ${order.number}`, 200),
    description: truncate(`No se pudo solicitar en automático: ${input.message}`, 1000),
    objectType: OBJ.order,
    objectId: order.id,
    ownerUserId: order.createdByUserId.includes(':') ? undefined : order.createdByUserId,
  });
  emitPurchases(ctx, EV.followupFailed, { orderId: order.id, step: input.step, message: input.message, workItemId: item.id }, { objectType: OBJ.order, objectId: order.id });
  return { workItemId: item.id };
}

// ---------------------------------------------------------------------------
// Send / allocate / cancel / close
// ---------------------------------------------------------------------------

export async function markOrderSentInTx(
  tx: Db,
  input: z.output<typeof markSentSchema>,
  ctx: CommandContext
): Promise<ProcurementOrder> {
  const order = await loadOrder(tx, input.orderId);
  throwCheck(checkSendOrder(order.status));
  const status = statusAfterSend(order.status as OrderStatus, order.paymentMode, order.paymentStatus);
  const evidenceObjectIds = input.pdfObjectId
    ? [...new Set([...order.evidenceObjectIds, input.pdfObjectId])]
    : order.evidenceObjectIds;
  const updated = await tx.procurementOrder.update({
    where: { id: order.id },
    data: {
      status,
      sentToSupplierAt: ctx.now,
      sentVia: input.via,
      conversationId: input.conversationId ?? order.conversationId,
      evidenceObjectIds,
    },
  });
  const caseIds = await orderCaseIds(tx, order);
  emitPurchases(
    ctx,
    EV.sent,
    {
      orderId: order.id,
      number: order.number,
      via: input.via,
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      pdfObjectId: input.pdfObjectId ?? null,
      status,
      resent: Boolean(order.sentToSupplierAt),
    },
    { caseId: caseIds[0] ?? null, objectType: OBJ.order, objectId: order.id }
  );
  publishBoard(ctx, { orderId: order.id });
  return updated;
}

export async function allocateLineInTx(
  tx: Db,
  input: z.output<typeof allocateLineSchema>,
  ctx: CommandContext
): Promise<{ orderId: string; allocationIds: string[] }> {
  const line = assertFoundRow(await tx.procurementOrderLine.findUnique({ where: { id: input.orderLineId } }), 'No se encontró la partida de la orden');
  const order = await loadOrder(tx, line.orderId);
  const result = await applyLineAllocationsInTx(
    tx,
    order,
    line,
    input.allocations.map((a) => ({ demandId: a.demandId, qty: a.qty, allocationId: a.allocationId ?? null, requestLineId: line.requestLineId })),
    ctx
  );
  return { orderId: order.id, allocationIds: result.allocationIds };
}

export async function cancelOrderInTx(
  tx: Db,
  input: z.output<typeof cancelOrderSchema>,
  ctx: CommandContext
): Promise<{ order: ProcurementOrder; compensations: string[] }> {
  const order = await loadOrder(tx, input.orderId);
  const postedReceipts = await tx.goodsReceipt.count({ where: { orderId: order.id, status: { in: ['posted', 'disputed'] } } });
  throwCheck(checkCancelOrder({ status: order.status, postedReceipts }));
  const compensations: string[] = [];
  const reason = input.reason;
  const caseIds = await orderCaseIds(tx, order);

  if (order.approvalRequestId && order.status === 'pending_approval') {
    await cancelPendingApproval(tx, order.approvalRequestId, `Orden ${order.number} cancelada: ${reason}`, ctx);
    compensations.push('approval_cancelled');
  }
  if (order.obligationId) {
    const obligation = await tx.obligation.findUnique({ where: { id: order.obligationId } });
    if (obligation && num(obligation.settledAmount) > 0.004) {
      await ctx.openIncident({
        kind: 'cancellation_compensation',
        areaKey: 'contabilidad',
        severity: 'high',
        title: truncate(`Recuperar el pago de la orden cancelada ${order.number}`, 200),
        dedupeKey: `purchases.order_refund:${order.id}`,
        caseId: caseIds[0] ?? null,
        detail: { orderId: order.id, obligationId: obligation.id, settledAmount: obligation.settledAmount.toString(), reason },
      });
      await ctx.createWorkItem({
        areaKey: 'contabilidad',
        kind: 'action',
        title: truncate(`Gestionar reembolso o nota de crédito de ${order.number}`, 200),
        description: `Se pagaron ${obligation.settledAmount.toString()} ${obligation.currency} y la orden se canceló: ${reason}`.slice(0, 1000),
        objectType: OBLIGATION_OBJECT_TYPE,
        objectId: obligation.id,
        caseId: caseIds[0] ?? null,
      });
      compensations.push('refund_requested');
    } else if (obligation && obligation.status !== 'cancelled') {
      await cancelProcurementPayable(tx, obligation.id, `Orden ${order.number} cancelada: ${reason}`, ctx);
      compensations.push('payable_cancelled');
    }
  }
  if (order.obligationId) {
    const pendingPaymentApprovals = await tx.approvalRequest.findMany({
      where: { scope: 'payment', targetType: OBLIGATION_OBJECT_TYPE, targetId: order.obligationId, status: 'pending' },
      select: { id: true },
    });
    for (const approval of pendingPaymentApprovals) {
      await cancelPendingApproval(tx, approval.id, `Orden ${order.number} cancelada: ${reason}`, ctx);
      compensations.push('payment_approval_cancelled');
    }
  }
  const paymentRequests = await paymentAuthorizationRequestsOf(tx, order);
  for (const request of paymentRequests) {
    if (isAreaRequestOpenStatus(request.status)) {
      await transitionAreaRequestInTx(tx, request, 'cancel', { reason: `Orden ${order.number} cancelada: ${reason}` });
      compensations.push('payment_request_cancelled');
    }
  }
  const openPaymentItems = order.obligationId
    ? await tx.workItem.findMany({
        where: { objectType: OBLIGATION_OBJECT_TYPE, objectId: order.obligationId, status: { in: [...WORK_ITEM_OPEN_STATUSES] }, title: { startsWith: 'Autorizar y pagar' } },
      })
    : [];
  for (const item of openPaymentItems) await cancelWorkItemInTx(tx, item, { reason: `Orden ${order.number} cancelada` });

  const lines = await loadOrderLines(tx, order.id);
  const requestIds = new Set<string>();
  for (const line of lines) {
    if (line.status !== 'cancelled') await giveBackToRequests(tx, line, num(line.qty), requestIds);
    if (line.status !== 'cancelled') {
      await tx.procurementOrderLine.update({ where: { id: line.id }, data: { status: 'cancelled' } });
    }
  }
  await recomputeRequestStatuses(tx, requestIds, ctx);
  const released = await releaseAllocationsExpectation(
    tx,
    await orderDemandAllocationIds(tx, order.id),
    ctx,
    `Orden ${order.number} cancelada`,
    order.id
  );
  if (released.length > 0) compensations.push('allocations_released');
  if (order.sentToSupplierAt) {
    await ctx.createWorkItem({
      areaKey: PURCHASES_AREA_KEY,
      kind: 'action',
      title: truncate(`Avisar al proveedor la cancelación de ${order.number}`, 200),
      description: `La orden ya se había enviado (${order.sentVia ?? 'sin canal'}). Motivo: ${reason}`.slice(0, 1000),
      objectType: OBJ.order,
      objectId: order.id,
      caseId: caseIds[0] ?? null,
      ownerUserId: actorUserId(ctx) ?? undefined,
    });
    compensations.push('supplier_notice');
  }
  const updated = await tx.procurementOrder.update({ where: { id: order.id }, data: { status: 'cancelled' } });
  emitPurchases(
    ctx,
    EV.cancelled,
    { orderId: order.id, number: order.number, reason, previousStatus: order.status, compensations, releasedAllocationIds: released },
    { caseId: caseIds[0] ?? null, objectType: OBJ.order, objectId: order.id }
  );
  publishBoard(ctx, { orderId: order.id });
  return { order: updated, compensations };
}

export async function closeOrderInTx(
  tx: Db,
  input: z.output<typeof closeOrderSchema>,
  ctx: CommandContext
): Promise<ProcurementOrder> {
  const order = await loadOrder(tx, input.orderId);
  const lines = await loadOrderLines(tx, order.id);
  const openDifferences = await tx.goodsReceiptLine.count({
    where: {
      receipt: { orderId: order.id },
      differenceKind: { not: 'none' },
      incidentId: { not: null },
    },
  });
  const openDifferenceIncidents = openDifferences
    ? await tx.incident.count({
        where: {
          id: {
            in: (
              await tx.goodsReceiptLine.findMany({
                where: { receipt: { orderId: order.id }, incidentId: { not: null } },
                select: { incidentId: true },
              })
            ).map((l) => l.incidentId!),
          },
          status: { in: ['open', 'acknowledged'] },
        },
      })
    : 0;
  const quantities = lines.map((l) => ({ qty: num(l.qty), qtyReceived: num(l.qtyAccepted), status: l.status }));
  throwCheck(
    checkCloseOrder({
      status: order.status,
      openDifferences: openDifferenceIncidents,
      pendingQty: pendingQuantity(quantities),
      acceptShortages: input.acceptShortages,
      paymentStatus: order.paymentStatus,
      obligationId: order.obligationId,
    })
  );
  const requestIds = new Set<string>();
  const shortDemandAllocationIds: string[] = [];
  for (const line of lines) {
    if (line.status === 'cancelled' || line.status === 'closed') continue;
    const pending = Math.max(0, num(line.qty) - num(line.qtyAccepted));
    if (pending > QTY_EPS) await giveBackToRequests(tx, line, pending, requestIds);
    if (pending > QTY_EPS) {
      const allocations = await tx.procurementAllocation.findMany({
        where: { orderLineId: line.id, demandAllocationId: { not: null } },
        select: { demandAllocationId: true },
      });
      shortDemandAllocationIds.push(...allocations.map((a) => a.demandAllocationId!));
    }
    await tx.procurementOrderLine.update({ where: { id: line.id }, data: { status: 'closed' } });
  }
  await recomputeRequestStatuses(tx, requestIds, ctx);
  const released = await releaseAllocationsExpectation(
    tx,
    shortDemandAllocationIds,
    ctx,
    `Orden ${order.number} cerrada con faltante`,
    order.id
  );
  const updated = await tx.procurementOrder.update({ where: { id: order.id }, data: { status: 'closed' } });
  const caseIds = await orderCaseIds(tx, order);
  emitPurchases(
    ctx,
    EV.closed,
    {
      orderId: order.id,
      number: order.number,
      reason: input.reason ?? null,
      acceptedShortages: input.acceptShortages,
      pendingQty: pendingQuantity(quantities),
      releasedAllocationIds: released,
    },
    { caseId: caseIds[0] ?? null, objectType: OBJ.order, objectId: order.id }
  );
  publishBoard(ctx, { orderId: order.id });
  return updated;
}
