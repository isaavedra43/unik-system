import { randomUUID } from 'crypto';
import {
  Prisma,
  type CaseDemand,
  type DemandAllocation,
  type OperationalCase,
  type SalesOrder,
} from '@prisma/client';
import { z } from 'zod';
import type { CurrentUser } from '@/modules/auth/authorization';
import { lockStockItems } from '@/modules/inventory/inventory-locks';
import { releaseReservation } from '@/modules/inventory/inventory-service';
import { dec, normalizeUnit, roundQty, type DecimalLike } from '@/modules/inventory/stock-math';
import { cancelDeliveryOrder } from '@/modules/logistics/delivery-service';
import { bumpDeliveryOrder } from '@/modules/logistics/logistics-helpers';
import { expireAreaRequestsForCase, transitionAreaRequestInTx } from './area-requests-service';
import {
  advanceCase,
  cancelOpenStepsForCase,
  caseAggregate,
  CASE_AGGREGATE_TYPE,
  CASE_COMMANDS,
  CASE_STEP_OBJECT_TYPE,
  createCaseDemand,
  loadFulfillableLines,
  reopenStep,
  resolveDemandQuantity,
  type AdvanceCaseResult,
  type DemandQuantity,
} from './case-service';
import {
  executeCommand,
  OperationsError,
  registerCommand,
  requireCommandContext,
  type CommandContext,
  type CommandResult,
} from './commands';
import { toOperationalJson } from './events-service';
import { openOrReopenIncident } from './incidents-service';
import { SALES_STEP } from './process-blueprints/sales-fulfillment';
import { isCancelledOrderStatus } from './start-policy';
import {
  AREA_REQUEST_OPEN_STATUSES,
  OPS_EVENTS,
  WORK_ITEM_OPEN_STATUSES,
  type AreaKey,
  type IncidentSeverity,
} from './types';
import { cancelWorkItemInTx } from './work-items-service';

/**
 * Replanning and cancellation of sales fulfillment cases (plan section 2.5).
 *
 * Pure part:
 * - `diffOrderForCase` compares the demands of a case with the current lines
 *   of its Zoho sales order (matching by `zohoLineItemId`, falling back to
 *   `zohoItemId` + variant) plus the recorded field changes (address, delivery
 *   method, status).
 * - `assessImpact` turns the diff and the state of the allocations into an
 *   ordered list of actions: less quantity reduces or releases what is not
 *   committed yet (and asks Compras/Manufactura to cancel what was already
 *   requested), committed material opens `order_change_conflict`; more
 *   quantity or new lines reopen planning; removed lines cancel with
 *   compensation; address or method changes patch a delivery not assigned yet
 *   or open an incident with a work item for Logística.
 *
 * Commands:
 * - `case.replan` (job `ops.case.replan`, or a manager) applies those actions,
 *   re-syncs the steps and advances the case. An order voided or cancelled in
 *   Zoho cancels the case.
 * - `case.cancel` releases reservations, cancels deliveries (queuing the Zoho
 *   shipment cancellation), expires requests, cancels steps and work items,
 *   and compensates every allocation in flight with a `cancel` request and a
 *   `cancellation_compensation` incident. History is never deleted.
 */

type Db = Prisma.TransactionClient;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-replan', event, ...extra }));

const MANAGE_PERMISSION = 'operations.manage';
export const REPLAN_QTY_EPSILON = 1e-6;

// ---------------------------------------------------------------------------
// Pure: diff
// ---------------------------------------------------------------------------

export const ADDRESS_FIELDS = [
  'shippingAddressLine1',
  'shippingCity',
  'shippingState',
  'shippingPostalCode',
] as const;

export interface DiffDemand {
  id: string;
  lineRef: string;
  zohoItemId: string | null;
  variantKey: string;
  quantity: DecimalLike;
  unit: string;
  status: string;
}

export interface DiffOrderLine {
  zohoLineItemId: string | null;
  zohoItemId: string | null;
  sku: string | null;
  name: string;
  quantity: DecimalLike;
  unit: string | null;
  locationId: string | null;
  sortOrder: number;
}

export type FieldChanges = Record<string, { before: unknown; after: unknown }>;

export interface OrderDiffInput {
  demands: DiffDemand[];
  lines: DiffOrderLine[];
  orderStatus?: string | null;
  /** `EntityChangeEvent.changes.fields` of the change being replanned. */
  fieldChanges?: FieldChanges | null;
}

export interface QuantityChange {
  demandId: string;
  lineRef: string;
  before: { quantity: string; unit: string };
  after: { quantity: string; unit: string };
  line: DiffOrderLine;
}

export interface OrderDiff {
  cancelled: boolean;
  matched: Array<{ demandId: string; line: DiffOrderLine }>;
  quantityChanges: QuantityChange[];
  added: Array<{ lineRef: string; line: DiffOrderLine }>;
  removed: Array<{ demandId: string; lineRef: string }>;
  addressChanged: boolean;
  addressFields: string[];
  deliveryMethod: { before: string | null; after: string | null } | null;
  hasChanges: boolean;
}

const asText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

export function diffOrderForCase(input: OrderDiffInput): OrderDiff {
  const cancelled = isCancelledOrderStatus(input.orderStatus);
  const active = input.demands.filter((demand) => demand.status !== 'cancelled');
  const takenRefs = new Set(input.demands.map((demand) => demand.lineRef));
  const used = new Set<string>();
  const matched: OrderDiff['matched'] = [];
  const quantityChanges: QuantityChange[] = [];
  const added: OrderDiff['added'] = [];

  input.lines.forEach((line, index) => {
    const quantity = roundQty(dec(line.quantity));
    if (quantity.lte(0)) return;
    const lineId = line.zohoLineItemId?.trim() || null;
    const positionalRef = `idx:${line.sortOrder || index + 1}`;
    const free = (demand: DiffDemand) => !used.has(demand.id);
    let demand = lineId ? active.find((d) => free(d) && d.lineRef === lineId) : undefined;
    if (!demand && !lineId) {
      demand = active.find(
        (d) =>
          free(d) &&
          d.lineRef === positionalRef &&
          (!d.zohoItemId || d.zohoItemId === line.zohoItemId)
      );
    }
    if (!demand && line.zohoItemId) {
      demand = active.find(
        (d) =>
          free(d) &&
          d.zohoItemId === line.zohoItemId &&
          d.variantKey === '' &&
          !d.lineRef.startsWith('idx:') === Boolean(lineId)
      );
      demand ??= active.find(
        (d) => free(d) && d.zohoItemId === line.zohoItemId && d.variantKey === ''
      );
    }
    if (demand) {
      used.add(demand.id);
      matched.push({ demandId: demand.id, line });
      const beforeQuantity = roundQty(dec(demand.quantity));
      const beforeUnit = normalizeUnit(demand.unit);
      const afterUnit = normalizeUnit(line.unit) || beforeUnit;
      if (!beforeQuantity.equals(quantity) || beforeUnit !== afterUnit) {
        quantityChanges.push({
          demandId: demand.id,
          lineRef: demand.lineRef,
          before: { quantity: beforeQuantity.toString(), unit: beforeUnit },
          after: { quantity: quantity.toString(), unit: afterUnit },
          line,
        });
      }
      return;
    }
    const base = lineId || positionalRef;
    let ref = base;
    let n = 2;
    while (takenRefs.has(ref)) ref = `${base}~${n++}`;
    takenRefs.add(ref);
    added.push({ lineRef: ref, line });
  });

  const removed = active
    .filter((demand) => !used.has(demand.id))
    .map((demand) => ({ demandId: demand.id, lineRef: demand.lineRef }));
  const fields = input.fieldChanges ?? {};
  const addressFields = ADDRESS_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(fields, field)
  );
  const deliveryMethod = Object.prototype.hasOwnProperty.call(fields, 'deliveryMethod')
    ? { before: asText(fields.deliveryMethod.before), after: asText(fields.deliveryMethod.after) }
    : null;
  const addressChanged = addressFields.length > 0;
  return {
    cancelled,
    matched,
    quantityChanges,
    added,
    removed,
    addressChanged,
    addressFields,
    deliveryMethod,
    hasChanges:
      cancelled ||
      quantityChanges.length > 0 ||
      added.length > 0 ||
      removed.length > 0 ||
      addressChanged ||
      deliveryMethod !== null,
  };
}

// ---------------------------------------------------------------------------
// Pure: impact
// ---------------------------------------------------------------------------

export interface ImpactAllocation {
  id: string;
  demandId: string;
  source: string;
  status: string;
  quantity: number;
  deliveredQuantity: number;
  hasActiveReservation: boolean;
  /** Status of the linked area request (purchase, production, direct delivery). */
  requestStatus: string | null;
}

export interface ImpactDeliveryOrder {
  id: string;
  status: string;
  mode: string;
}

export interface ImpactInput {
  diff: OrderDiff;
  /** Base quantity before/after of every demand in `diff.quantityChanges`. */
  baseQuantities: Record<string, { before: number; after: number }>;
  allocations: ImpactAllocation[];
  deliveryOrders: ImpactDeliveryOrder[];
  /** Status of the case step `preparar_pedido` (null when not instantiated). */
  preparationStatus: string | null;
}

export type AllocationCompensation =
  'none' | 'release_reservation' | 'cancel_request' | 'request_cancel';

export type ConflictReason = 'committed' | 'already_delivered' | 'prepared' | 'request_answered';

export type ReplanAction =
  | { type: 'cancel_case' }
  | { type: 'cancel_demand'; demandId: string }
  | { type: 'update_demand'; demandId: string }
  | { type: 'create_demand'; lineRef: string; line: DiffOrderLine }
  | { type: 'reopen_plan'; demandId: string; extraBase: number }
  | {
      type: 'cancel_allocation';
      demandId: string;
      allocationId: string;
      quantity: number;
      compensation: AllocationCompensation;
    }
  | {
      type: 'reduce_allocation';
      demandId: string;
      allocationId: string;
      newQuantity: number;
      reducedBy: number;
      compensation: AllocationCompensation;
    }
  | {
      type: 'conflict_incident';
      demandId: string | null;
      allocationId: string | null;
      lineRef: string | null;
      reason: ConflictReason;
      quantity: number;
      severity: IncidentSeverity;
    }
  | { type: 'patch_delivery'; deliveryOrderId: string }
  | {
      type: 'delivery_change_incident';
      deliveryOrderId: string;
      reason: 'address' | 'delivery_method';
      severity: IncidentSeverity;
    };

export interface ReplanImpact {
  actions: ReplanAction[];
  summary: {
    quantityDown: number;
    quantityUp: number;
    added: number;
    removed: number;
    conflicts: number;
    deliveryPatches: number;
    deliveryIncidents: number;
  };
}

const COMMITMENT_RANK: Record<string, number> = {
  planned: 0,
  reopened: 1,
  reserved: 2,
  requested: 3,
  in_progress: 4,
  ready: 5,
  released: 6,
};

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const PATCHABLE_DELIVERY_STATUSES = ['pending', 'planned', 'failed'];
const ASSIGNED_DELIVERY_STATUSES = ['assigned', 'pending_external', 'conflict', 'dispatched'];
const REQUEST_NOT_ACCEPTED = ['sent', 'acknowledged'];

/** Actions that take `delta` base units away from a demand's allocations (least committed first). */
export function planAllocationReduction(
  demandId: string,
  allocations: readonly ImpactAllocation[],
  delta: number
): ReplanAction[] {
  const actions: ReplanAction[] = [];
  const candidates = allocations
    .map((allocation, index) => ({ allocation, index }))
    .filter(
      ({ allocation }) =>
        allocation.demandId === demandId &&
        allocation.status !== 'cancelled' &&
        allocation.status !== 'delivered'
    )
    .sort(
      (a, b) =>
        (COMMITMENT_RANK[a.allocation.status] ?? 9) - (COMMITMENT_RANK[b.allocation.status] ?? 9) ||
        b.index - a.index
    )
    .map(({ allocation }) => allocation);
  let remaining = delta;
  for (const allocation of candidates) {
    if (remaining <= REPLAN_QTY_EPSILON) break;
    const open = allocation.quantity - allocation.deliveredQuantity;
    if (open <= REPLAN_QTY_EPSILON) continue;
    const take = Math.min(open, remaining);
    const full = take >= open - REPLAN_QTY_EPSILON;
    const newQuantity = round4(allocation.quantity - take);
    remaining = round4(remaining - take);
    const change = (compensation: AllocationCompensation) =>
      full
        ? ({
            type: 'cancel_allocation',
            demandId,
            allocationId: allocation.id,
            quantity: round4(take),
            compensation,
          } as const)
        : ({
            type: 'reduce_allocation',
            demandId,
            allocationId: allocation.id,
            newQuantity,
            reducedBy: round4(take),
            compensation,
          } as const);
    switch (allocation.status) {
      case 'planned':
      case 'reopened':
        actions.push(change('none'));
        break;
      case 'reserved':
        actions.push(change(allocation.hasActiveReservation ? 'release_reservation' : 'none'));
        break;
      case 'requested': {
        const notAccepted =
          allocation.requestStatus === null ||
          REQUEST_NOT_ACCEPTED.includes(allocation.requestStatus);
        actions.push(change(notAccepted && full ? 'cancel_request' : 'request_cancel'));
        if (allocation.requestStatus === 'resolved') {
          actions.push({
            type: 'conflict_incident',
            demandId,
            allocationId: allocation.id,
            lineRef: null,
            reason: 'request_answered',
            quantity: round4(take),
            severity: 'medium',
          });
        }
        break;
      }
      default:
        actions.push({
          type: 'conflict_incident',
          demandId,
          allocationId: allocation.id,
          lineRef: null,
          reason: 'committed',
          quantity: round4(take),
          severity: allocation.status === 'in_progress' ? 'high' : 'medium',
        });
    }
  }
  if (remaining > REPLAN_QTY_EPSILON) {
    actions.push({
      type: 'conflict_incident',
      demandId,
      allocationId: null,
      lineRef: null,
      reason: 'already_delivered',
      quantity: round4(remaining),
      severity: 'high',
    });
  }
  return actions;
}

export function assessImpact(input: ImpactInput): ReplanImpact {
  const summary: ReplanImpact['summary'] = {
    quantityDown: 0,
    quantityUp: 0,
    added: 0,
    removed: 0,
    conflicts: 0,
    deliveryPatches: 0,
    deliveryIncidents: 0,
  };
  const { diff } = input;
  if (diff.cancelled) return { actions: [{ type: 'cancel_case' }], summary };
  const actions: ReplanAction[] = [];
  const prepared = input.preparationStatus === 'done' || input.preparationStatus === 'active';

  for (const removed of diff.removed) {
    summary.removed += 1;
    const mine = input.allocations.filter((a) => a.demandId === removed.demandId);
    const open = mine
      .filter((a) => a.status !== 'cancelled' && a.status !== 'delivered')
      .reduce((sum, a) => sum + Math.max(a.quantity - a.deliveredQuantity, 0), 0);
    if (open > REPLAN_QTY_EPSILON)
      actions.push(...planAllocationReduction(removed.demandId, input.allocations, open));
    const delivered = mine.reduce((sum, a) => sum + a.deliveredQuantity, 0);
    if (delivered > REPLAN_QTY_EPSILON) {
      actions.push({
        type: 'conflict_incident',
        demandId: removed.demandId,
        allocationId: null,
        lineRef: removed.lineRef,
        reason: 'already_delivered',
        quantity: round4(delivered),
        severity: 'high',
      });
    }
    actions.push({ type: 'cancel_demand', demandId: removed.demandId });
  }

  for (const change of diff.quantityChanges) {
    const base = input.baseQuantities[change.demandId];
    if (!base) continue;
    const delta = round4(base.after - base.before);
    actions.push({ type: 'update_demand', demandId: change.demandId });
    if (delta < -REPLAN_QTY_EPSILON) {
      summary.quantityDown += 1;
      const allocated = input.allocations
        .filter((a) => a.demandId === change.demandId && a.status !== 'cancelled')
        .reduce((sum, a) => sum + a.quantity, 0);
      // Only what is allocated beyond the new quantity has to be taken back.
      const excess = round4(allocated - base.after);
      if (excess > REPLAN_QTY_EPSILON) {
        actions.push(...planAllocationReduction(change.demandId, input.allocations, excess));
      }
    } else if (delta > REPLAN_QTY_EPSILON) {
      summary.quantityUp += 1;
      actions.push({ type: 'reopen_plan', demandId: change.demandId, extraBase: delta });
      if (prepared) {
        actions.push({
          type: 'conflict_incident',
          demandId: change.demandId,
          allocationId: null,
          lineRef: change.lineRef,
          reason: 'prepared',
          quantity: delta,
          severity: 'medium',
        });
      }
    }
  }

  for (const addition of diff.added) {
    summary.added += 1;
    actions.push({ type: 'create_demand', lineRef: addition.lineRef, line: addition.line });
    if (prepared) {
      actions.push({
        type: 'conflict_incident',
        demandId: null,
        allocationId: null,
        lineRef: addition.lineRef,
        reason: 'prepared',
        quantity: Number(dec(addition.line.quantity).toString()),
        severity: 'medium',
      });
    }
  }

  const liveOrders = input.deliveryOrders.filter(
    (order) => !['cancelled', 'delivered', 'partially_delivered'].includes(order.status)
  );
  if (diff.addressChanged) {
    for (const order of liveOrders) {
      if (order.mode === 'customer_pickup') continue;
      if (PATCHABLE_DELIVERY_STATUSES.includes(order.status)) {
        summary.deliveryPatches += 1;
        actions.push({ type: 'patch_delivery', deliveryOrderId: order.id });
      } else if (ASSIGNED_DELIVERY_STATUSES.includes(order.status)) {
        summary.deliveryIncidents += 1;
        actions.push({
          type: 'delivery_change_incident',
          deliveryOrderId: order.id,
          reason: 'address',
          severity: order.status === 'dispatched' ? 'high' : 'medium',
        });
      }
    }
  }
  if (diff.deliveryMethod) {
    for (const order of liveOrders) {
      summary.deliveryIncidents += 1;
      actions.push({
        type: 'delivery_change_incident',
        deliveryOrderId: order.id,
        reason: 'delivery_method',
        severity: order.status === 'dispatched' ? 'high' : 'medium',
      });
    }
  }
  summary.conflicts = actions.filter((action) => action.type === 'conflict_incident').length;
  return { actions, summary };
}

/** How a cancelled case compensates an allocation (pure). */
export function cancellationCompensation(
  allocation: Pick<ImpactAllocation, 'source' | 'status' | 'deliveredQuantity'>,
  requestStatus: string | null
): { sendCancelRequest: boolean; severity: IncidentSeverity | null; areaKey: AreaKey } {
  const areaKey = compensationArea(allocation.source);
  if (allocation.deliveredQuantity > REPLAN_QTY_EPSILON || allocation.status === 'delivered') {
    return { sendCancelRequest: false, severity: 'high', areaKey: 'ventas' };
  }
  switch (allocation.status) {
    case 'planned':
    case 'reopened':
    case 'reserved':
    case 'cancelled':
      return { sendCancelRequest: false, severity: null, areaKey };
    case 'requested': {
      if (requestStatus === 'resolved')
        return { sendCancelRequest: true, severity: 'high', areaKey };
      if (requestStatus === 'accepted' || requestStatus === 'blocked') {
        return { sendCancelRequest: true, severity: 'medium', areaKey };
      }
      return { sendCancelRequest: false, severity: 'low', areaKey };
    }
    case 'in_progress':
      return { sendCancelRequest: allocation.source !== 'stock', severity: 'high', areaKey };
    default:
      // ready / released: material already in the warehouse.
      return { sendCancelRequest: false, severity: 'medium', areaKey: 'inventario' };
  }
}

function compensationArea(source: string): AreaKey {
  if (source === 'manufacture') return 'manufactura';
  if (source === 'stock') return 'inventario';
  return 'compras';
}

// ---------------------------------------------------------------------------
// Helpers of the commands
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(typeof value === 'object' ? value.toString() : value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function qtyText(value: DecimalLike): string {
  return dec(value).toDecimalPlaces(4).toString();
}

function caseLabel(opCase: Pick<OperationalCase, 'caseNumber' | 'salesOrderNumber'>): string {
  return [opCase.caseNumber, opCase.salesOrderNumber].filter(Boolean).join(' · ');
}

async function loadImpactAllocations(
  tx: Db,
  caseId: string
): Promise<{
  rows: DemandAllocation[];
  impact: ImpactAllocation[];
}> {
  const rows = await tx.demandAllocation.findMany({
    where: { caseId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const requestIds = rows
    .filter((row) => row.linkedType === 'area_request' && row.linkedId)
    .map((row) => row.linkedId!);
  const requests = requestIds.length
    ? await tx.areaRequest.findMany({
        where: { id: { in: requestIds } },
        select: { id: true, status: true },
      })
    : [];
  const reservations = await tx.stockReservation.findMany({
    where: { caseId, status: 'active' },
    select: { allocationId: true },
  });
  const reserved = new Set(reservations.map((r) => r.allocationId).filter(Boolean));
  const requestStatus = new Map(requests.map((r) => [r.id, r.status]));
  return {
    rows,
    impact: rows.map((row) => ({
      id: row.id,
      demandId: row.demandId,
      source: row.source,
      status: row.status,
      quantity: num(row.quantity),
      deliveredQuantity: num(row.deliveredQuantity),
      hasActiveReservation: reserved.has(row.id),
      requestStatus: row.linkedId ? (requestStatus.get(row.linkedId) ?? null) : null,
    })),
  };
}

async function releaseAllocationReservations(
  tx: Db,
  ctx: CommandContext,
  allocationId: string,
  reason: string
): Promise<number> {
  const reservations = await tx.stockReservation.findMany({
    where: { allocationId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  // Rows are locked up front in id order (the order reservations use): no deadlock.
  await lockStockItems(
    tx,
    reservations.map((reservation) => reservation.stockItemId)
  );
  for (const reservation of reservations) {
    await releaseReservation(tx, { reservationId: reservation.id, reason }, ctx);
  }
  return reservations.length;
}

async function sendCancelRequest(
  ctx: CommandContext,
  opCase: OperationalCase,
  allocation: DemandAllocation,
  demand: CaseDemand | undefined,
  input: { reason: string; newQuantity?: number }
): Promise<string> {
  const unit = demand?.baseUnit ?? '';
  const name = demand?.name ?? 'material';
  const title =
    input.newQuantity !== undefined
      ? `Reducir ${name} a ${qtyText(input.newQuantity)} ${unit} (${caseLabel(opCase)})`
      : `Cancelar ${qtyText(allocation.quantity)} ${unit} de ${name} (${caseLabel(opCase)})`;
  const { request } = await ctx.createAreaRequest({
    caseId: opCase.id,
    fromAreaKey: 'ventas',
    toAreaKey: compensationArea(allocation.source),
    kind: 'cancel',
    objectType: 'demand_allocation',
    objectId: allocation.id,
    title,
    payload: { allocationId: allocation.id, reason: input.reason.slice(0, 500) },
  });
  return request.id;
}

async function cancelLinkedRequest(
  tx: Db,
  allocation: DemandAllocation,
  reason: string
): Promise<boolean> {
  if (allocation.linkedType !== 'area_request' || !allocation.linkedId) return false;
  const request = await tx.areaRequest.findUnique({ where: { id: allocation.linkedId } });
  if (!request || !(AREA_REQUEST_OPEN_STATUSES as readonly string[]).includes(request.status))
    return false;
  await transitionAreaRequestInTx(tx, request, 'cancel', { reason });
  return true;
}

function emitAllocationEvent(
  ctx: CommandContext,
  type: string,
  allocation: DemandAllocation,
  extra: Record<string, unknown>
): void {
  ctx.emit(
    type,
    {
      allocationId: allocation.id,
      demandId: allocation.demandId,
      source: allocation.source,
      status: allocation.status,
      quantity: qtyText(allocation.quantity),
      ...extra,
    },
    {
      caseId: allocation.caseId,
      areaKey: compensationArea(allocation.source),
      objectType: 'demand_allocation',
      objectId: allocation.id,
    }
  );
}

const CONFLICT_TITLES: Record<ConflictReason, string> = {
  committed: 'Bajó la cantidad de material ya comprometido',
  already_delivered: 'Cambió la orden de material ya entregado',
  prepared: 'Aumentó la orden de un pedido ya preparado',
  request_answered: 'Bajó la cantidad de una compra ya atendida',
};

// ---------------------------------------------------------------------------
// case.replan
// ---------------------------------------------------------------------------

export interface ReplanData {
  caseId: string;
  changed: boolean;
  cancelled: boolean;
  skipped: string | null;
  changeEventId: string | null;
  summary: ReplanImpact['summary'];
  actions: Record<string, number>;
  incidentIds: string[];
  requestIds: string[];
  advance: AdvanceCaseResult | null;
}

const replanSchema = z
  .object({
    changeEventId: z.string().trim().min(1).max(120).nullish(),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();

const EMPTY_SUMMARY: ReplanImpact['summary'] = {
  quantityDown: 0,
  quantityUp: 0,
  added: 0,
  removed: 0,
  conflicts: 0,
  deliveryPatches: 0,
  deliveryIncidents: 0,
};

async function applyReplanActions(
  tx: Db,
  ctx: CommandContext,
  input: {
    opCase: OperationalCase;
    order: SalesOrder;
    demands: CaseDemand[];
    allocations: DemandAllocation[];
    conversions: Map<string, DemandQuantity>;
    changeEventId: string | null;
    impact: ReplanImpact;
  }
): Promise<{ incidentIds: string[]; requestIds: string[] }> {
  const { opCase, order, changeEventId } = input;
  const incidentIds: string[] = [];
  const requestIds: string[] = [];
  const demands = new Map(input.demands.map((d) => [d.id, d]));
  const allocations = new Map(input.allocations.map((a) => [a.id, a]));
  const reason = changeEventId
    ? `Cambió la orden de venta ${order.salesOrderNumber ?? ''} en Zoho`.trim()
    : 'Replaneación del expediente';
  let nextSort = input.demands.reduce((max, d) => Math.max(max, d.sortOrder), -1) + 1;

  for (const action of input.impact.actions) {
    switch (action.type) {
      case 'update_demand': {
        const demand = demands.get(action.demandId);
        const quantity = input.conversions.get(action.demandId);
        if (!demand || !quantity) break;
        const updated = await tx.caseDemand.update({
          where: { id: demand.id },
          data: {
            quantity: quantity.quantity,
            unit: quantity.unit,
            baseQuantity: quantity.baseQuantity,
            baseUnit: quantity.baseUnit,
            version: { increment: 1 },
          },
        });
        demands.set(updated.id, updated);
        ctx.emit(
          OPS_EVENTS.demand.changed,
          {
            demandId: demand.id,
            lineRef: demand.lineRef,
            before: {
              quantity: qtyText(demand.quantity),
              unit: demand.unit,
              baseQuantity: qtyText(demand.baseQuantity),
            },
            after: {
              quantity: qtyText(updated.quantity),
              unit: updated.unit,
              baseQuantity: qtyText(updated.baseQuantity),
            },
            changeEventId,
            unitResolved: quantity.unitResolved,
          },
          { caseId: opCase.id, areaKey: 'ventas', objectType: 'case_demand', objectId: demand.id }
        );
        break;
      }
      case 'reduce_allocation':
      case 'cancel_allocation': {
        const allocation = allocations.get(action.allocationId);
        if (!allocation) break;
        const demand = demands.get(allocation.demandId);
        if (action.compensation === 'release_reservation') {
          await releaseAllocationReservations(tx, ctx, allocation.id, reason);
        } else if (action.compensation === 'cancel_request') {
          await cancelLinkedRequest(tx, allocation, reason);
        } else if (action.compensation === 'request_cancel') {
          requestIds.push(
            await sendCancelRequest(ctx, opCase, allocation, demand, {
              reason,
              newQuantity: action.type === 'reduce_allocation' ? action.newQuantity : undefined,
            })
          );
        }
        if (action.type === 'cancel_allocation') {
          const updated = await tx.demandAllocation.update({
            where: { id: allocation.id },
            data: { status: 'cancelled', stockReservationId: null, version: { increment: 1 } },
          });
          allocations.set(updated.id, updated);
          emitAllocationEvent(ctx, OPS_EVENTS.allocation.cancelled, updated, {
            reason,
            compensation: action.compensation,
            changeEventId,
          });
          break;
        }
        const released = action.compensation === 'release_reservation';
        const updated = await tx.demandAllocation.update({
          where: { id: allocation.id },
          data: {
            quantity: new Prisma.Decimal(action.newQuantity),
            ...(released ? { status: 'planned', stockReservationId: null } : {}),
            version: { increment: 1 },
          },
        });
        allocations.set(updated.id, updated);
        emitAllocationEvent(
          ctx,
          released ? OPS_EVENTS.allocation.reopened : 'allocation.reduced',
          updated,
          {
            before: qtyText(allocation.quantity),
            after: qtyText(updated.quantity),
            compensation: action.compensation,
            changeEventId,
          }
        );
        if (released) {
          const reserveStep = await tx.caseStep.findFirst({
            where: { caseId: opCase.id, stepKey: SALES_STEP.reserve, scopeKey: allocation.id },
          });
          if (
            reserveStep &&
            reserveStep.status !== 'pending' &&
            reserveStep.status !== 'cancelled'
          ) {
            await reopenStep(tx, reserveStep, 'Cambió la cantidad reservada');
          }
        }
        break;
      }
      case 'conflict_incident': {
        const allocation = action.allocationId ? allocations.get(action.allocationId) : undefined;
        const demand = action.demandId ? demands.get(action.demandId) : undefined;
        const subject = action.allocationId ?? action.demandId ?? action.lineRef ?? 'orden';
        const { incident } = await openOrReopenIncident(tx, {
          kind: 'order_change_conflict',
          areaKey: allocation ? compensationArea(allocation.source) : 'ventas',
          severity: action.severity,
          title: `${CONFLICT_TITLES[action.reason]} (${caseLabel(opCase)})`,
          dedupeKey: `order_change:${opCase.id}:${subject}:${action.reason}`,
          caseId: opCase.id,
          detail: {
            reason: action.reason,
            demandId: action.demandId,
            allocationId: action.allocationId,
            lineRef: action.lineRef,
            item: demand?.name ?? null,
            quantity: action.quantity,
            unit: demand?.baseUnit ?? null,
            changeEventId,
          },
        });
        incidentIds.push(incident.id);
        break;
      }
      case 'reopen_plan': {
        const planStep = await tx.caseStep.findFirst({
          where: { caseId: opCase.id, stepKey: SALES_STEP.plan, scopeKey: action.demandId },
        });
        if (planStep && planStep.status === 'done') {
          await reopenStep(tx, planStep, 'Aumentó la cantidad de la partida');
        }
        const demand = demands.get(action.demandId);
        if (demand && demand.status === 'allocated') {
          demands.set(
            demand.id,
            await tx.caseDemand.update({
              where: { id: demand.id },
              data: { status: 'planned', version: { increment: 1 } },
            })
          );
        }
        break;
      }
      case 'create_demand': {
        const demand = await createCaseDemand(
          tx,
          ctx,
          opCase,
          {
            zohoLineItemId: action.line.zohoLineItemId,
            zohoItemId: action.line.zohoItemId,
            sku: action.line.sku,
            name: action.line.name,
            quantity: dec(action.line.quantity),
            unit: action.line.unit,
            locationId: action.line.locationId,
            sortOrder: action.line.sortOrder,
          },
          { lineRef: action.lineRef, sortOrder: nextSort++, reason: 'replan' }
        );
        demands.set(demand.id, demand);
        break;
      }
      case 'cancel_demand': {
        const demand = demands.get(action.demandId);
        if (!demand || demand.status === 'cancelled') break;
        const updated = await tx.caseDemand.update({
          where: { id: demand.id },
          data: { status: 'cancelled', version: { increment: 1 } },
        });
        demands.set(updated.id, updated);
        ctx.emit(
          OPS_EVENTS.demand.cancelled,
          { demandId: demand.id, lineRef: demand.lineRef, reason, changeEventId },
          { caseId: opCase.id, areaKey: 'ventas', objectType: 'case_demand', objectId: demand.id }
        );
        break;
      }
      case 'patch_delivery': {
        const deliveryOrder = await tx.deliveryOrder.findUnique({
          where: { id: action.deliveryOrderId },
        });
        if (!deliveryOrder) break;
        const addressLine = [order.shippingAddressLine1, order.shippingAddressLine2]
          .filter(Boolean)
          .join(', ');
        await bumpDeliveryOrder(
          tx,
          deliveryOrder,
          {
            addressLine: addressLine ? addressLine.slice(0, 500) : null,
            city: order.shippingCity?.slice(0, 120) ?? null,
            state: order.shippingState?.slice(0, 120) ?? null,
            postalCode: order.shippingPostalCode?.slice(0, 20) ?? null,
          },
          { status: { in: ['pending', 'planned', 'failed'] } }
        );
        ctx.emit(
          'delivery.address_updated',
          {
            deliveryOrderId: deliveryOrder.id,
            changeEventId,
            previousAddress: deliveryOrder.addressLine,
          },
          {
            caseId: opCase.id,
            areaKey: 'logistica',
            objectType: 'delivery_order',
            objectId: deliveryOrder.id,
          }
        );
        break;
      }
      case 'delivery_change_incident': {
        const what = action.reason === 'address' ? 'la dirección' : 'el método';
        const { incident, created, reopened } = await openOrReopenIncident(tx, {
          kind: 'order_change_conflict',
          areaKey: 'logistica',
          severity: action.severity,
          title: `Cambió ${what} de entrega de ${caseLabel(opCase)} con transporte en curso`,
          dedupeKey: `order_change:${opCase.id}:delivery:${action.deliveryOrderId}:${action.reason}`,
          caseId: opCase.id,
          detail: {
            deliveryOrderId: action.deliveryOrderId,
            reason: action.reason,
            changeEventId,
            address: {
              line1: order.shippingAddressLine1,
              city: order.shippingCity,
              state: order.shippingState,
              postalCode: order.shippingPostalCode,
            },
            deliveryMethod: order.deliveryMethod,
          },
        });
        incidentIds.push(incident.id);
        if (created || reopened) {
          await ctx.createWorkItem({
            areaKey: 'logistica',
            kind: 'incident_followup',
            title: `Actualizar la entrega de ${caseLabel(opCase)}: cambió ${what} de entrega`,
            description: [
              `Orden de entrega ${action.deliveryOrderId}`,
              action.reason === 'address'
                ? `Nueva dirección: ${[
                    order.shippingAddressLine1,
                    order.shippingCity,
                    order.shippingState,
                    order.shippingPostalCode,
                  ]
                    .filter(Boolean)
                    .join(', ')}`
                : `Nuevo método de entrega: ${order.deliveryMethod ?? 'sin especificar'}`,
            ].join('\n'),
            caseId: opCase.id,
            objectType: 'incident',
            objectId: incident.id,
          });
        }
        break;
      }
      case 'cancel_case':
        break;
    }
  }
  return { incidentIds, requestIds };
}

/** Header fields of the case copied from the order (kept in step with Zoho). */
function headerChanges(
  opCase: OperationalCase,
  order: SalesOrder
): Prisma.OperationalCaseUpdateInput {
  const data: Prisma.OperationalCaseUpdateInput = {};
  if (order.salesOrderNumber !== opCase.salesOrderNumber)
    data.salesOrderNumber = order.salesOrderNumber;
  if (order.customerName !== opCase.customerName) data.customerName = order.customerName;
  if (order.zohoCustomerId !== opCase.zohoCustomerId) data.zohoCustomerId = order.zohoCustomerId;
  if (order.salespersonName !== opCase.salespersonName)
    data.salespersonName = order.salespersonName;
  if (order.deliveryMethod !== opCase.deliveryMethod) data.deliveryMethod = order.deliveryMethod;
  if (order.locationId !== opCase.locationId) data.locationId = order.locationId;
  if (order.locationName !== opCase.locationName) data.locationName = order.locationName;
  return data;
}

registerCommand<z.output<typeof replanSchema>, ReplanData>(CASE_COMMANDS.replan, {
  schema: replanSchema,
  permission: MANAGE_PERMISSION,
  aggregate: caseAggregate,
  actorTypes: ['user', 'system'],
  audit: 'user',
  async handler(tx, cmd, ctx) {
    const changeEventId = cmd.payload.changeEventId ?? null;
    const base: ReplanData = {
      caseId: cmd.aggregate.id,
      changed: false,
      cancelled: false,
      skipped: null,
      changeEventId,
      summary: EMPTY_SUMMARY,
      actions: {},
      incidentIds: [],
      requestIds: [],
      advance: null,
    };
    const opCase = await tx.operationalCase.findUnique({ where: { id: cmd.aggregate.id } });
    if (!opCase) throw new OperationsError('not_found', 'No se encontró el expediente');
    if (opCase.status === 'closed' || opCase.status === 'cancelled') {
      return { data: { ...base, skipped: opCase.status } };
    }
    if (!opCase.zohoSalesOrderId) {
      throw new OperationsError(
        'invalid_state',
        'El expediente no está ligado a una orden de venta'
      );
    }
    const order = await tx.salesOrder.findUnique({
      where: { zohoSalesOrderId: opCase.zohoSalesOrderId },
    });
    if (!order)
      throw new OperationsError('not_found', 'No se encontró la orden de venta del expediente');

    if (isCancelledOrderStatus(order.status)) {
      const outcome = await cancelCaseInTx(
        tx,
        opCase,
        {
          reason: `La orden ${order.salesOrderNumber ?? order.zohoSalesOrderId} se anuló en Zoho`,
          source: 'sales_order',
        },
        { aggregate: true }
      );
      return {
        data: {
          ...base,
          changed: !outcome.alreadyCancelled,
          cancelled: true,
          incidentIds: outcome.incidentIds,
          requestIds: outcome.cancelRequestIds,
        },
      };
    }

    const change = changeEventId
      ? await tx.entityChangeEvent.findUnique({
          where: { id: changeEventId },
          select: { changes: true },
        })
      : null;
    const fieldChanges = asRecord(asRecord(change?.changes).fields) as FieldChanges;
    const demands = await tx.caseDemand.findMany({
      where: { caseId: opCase.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const lines = await loadFulfillableLines(tx, order.id);
    const diff = diffOrderForCase({
      demands: demands.map((d) => ({
        id: d.id,
        lineRef: d.lineRef,
        zohoItemId: d.zohoItemId,
        variantKey: d.variantKey,
        quantity: d.quantity,
        unit: d.unit,
        status: d.status,
      })),
      lines,
      orderStatus: order.status,
      fieldChanges,
    });

    const conversions = new Map<string, DemandQuantity>();
    const baseQuantities: ImpactInput['baseQuantities'] = {};
    for (const quantityChange of diff.quantityChanges) {
      const demand = demands.find((d) => d.id === quantityChange.demandId);
      if (!demand) continue;
      const converted = await resolveDemandQuantity(
        tx,
        demand.zohoItemId,
        dec(quantityChange.line.quantity),
        quantityChange.line.unit
      );
      conversions.set(demand.id, converted);
      baseQuantities[demand.id] = {
        before: num(demand.baseQuantity),
        after: num(converted.baseQuantity),
      };
    }
    const allocations = await loadImpactAllocations(tx, opCase.id);
    const deliveryOrders = await tx.deliveryOrder.findMany({
      where: { caseId: opCase.id },
      select: { id: true, status: true, mode: true },
    });
    const preparation = await tx.caseStep.findFirst({
      where: { caseId: opCase.id, stepKey: SALES_STEP.prepare, scopeKey: '' },
      select: { status: true },
    });
    const impact = assessImpact({
      diff,
      baseQuantities,
      allocations: allocations.impact,
      deliveryOrders,
      preparationStatus: preparation?.status ?? null,
    });
    const applied = await applyReplanActions(tx, ctx, {
      opCase,
      order,
      demands,
      allocations: allocations.rows,
      conversions,
      changeEventId,
      impact,
    });
    const header = headerChanges(opCase, order);
    if (Object.keys(header).length > 0) {
      await tx.operationalCase.update({ where: { id: opCase.id }, data: header });
    }
    const changed = impact.actions.length > 0 || Object.keys(header).length > 0;
    const actions = impact.actions.reduce<Record<string, number>>((counts, action) => {
      counts[action.type] = (counts[action.type] ?? 0) + 1;
      return counts;
    }, {});
    if (changed) {
      ctx.emit(
        OPS_EVENTS.case.replanned,
        {
          changeEventId,
          summary: impact.summary,
          actions,
          headerFields: Object.keys(header),
          incidentIds: applied.incidentIds,
          reason: cmd.payload.reason ?? null,
        },
        {
          caseId: opCase.id,
          areaKey: 'ventas',
          objectType: CASE_AGGREGATE_TYPE,
          objectId: opCase.id,
        }
      );
    }
    const advance = await advanceCase(tx, opCase.id, ctx, { aggregate: true });
    log('case_replanned', {
      caseId: opCase.id,
      changeEventId,
      actions,
      incidents: applied.incidentIds.length,
      commandId: ctx.commandId,
    });
    return {
      data: {
        ...base,
        changed,
        summary: impact.summary,
        actions,
        incidentIds: applied.incidentIds,
        requestIds: applied.requestIds,
        advance,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// case.cancel
// ---------------------------------------------------------------------------

export interface CancelCaseInput {
  reason: string;
  source: 'manual' | 'sales_order';
}

export interface CancelCaseOutcome {
  caseId: string;
  alreadyCancelled: boolean;
  releasedReservations: number;
  cancelledDeliveryOrders: number;
  zohoCancellationsQueued: number;
  expiredRequests: number;
  cancelledWorkItems: number;
  cancelRequestIds: string[];
  incidentIds: string[];
}

/**
 * Cancels a case inside the running command with its compensations (see the
 * module comment). Idempotent: an already cancelled case returns
 * `alreadyCancelled`; a closed case cannot be cancelled.
 */
export async function cancelCaseInTx(
  tx: Db,
  caseOrId: OperationalCase | string,
  input: CancelCaseInput,
  options: { aggregate?: boolean } = {}
): Promise<CancelCaseOutcome> {
  const ctx = requireCommandContext(tx);
  const opCase =
    typeof caseOrId === 'string'
      ? await tx.operationalCase.findUnique({ where: { id: caseOrId } })
      : caseOrId;
  if (!opCase) throw new OperationsError('not_found', 'No se encontró el expediente');
  const outcome: CancelCaseOutcome = {
    caseId: opCase.id,
    alreadyCancelled: false,
    releasedReservations: 0,
    cancelledDeliveryOrders: 0,
    zohoCancellationsQueued: 0,
    expiredRequests: 0,
    cancelledWorkItems: 0,
    cancelRequestIds: [],
    incidentIds: [],
  };
  if (opCase.status === 'cancelled') return { ...outcome, alreadyCancelled: true };
  if (opCase.status === 'closed') {
    throw new OperationsError('invalid_state', 'Un expediente cerrado no se puede cancelar');
  }
  const reason = input.reason.trim().slice(0, 500) || 'Expediente cancelado';

  // Snapshot before closing anything: compensation depends on how far each allocation went.
  const { rows: allocations, impact } = await loadImpactAllocations(tx, opCase.id);
  const demands = await tx.caseDemand.findMany({ where: { caseId: opCase.id } });

  const reservations = await tx.stockReservation.findMany({
    where: { caseId: opCase.id, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  await lockStockItems(
    tx,
    reservations.map((reservation) => reservation.stockItemId)
  );
  for (const reservation of reservations) {
    await releaseReservation(tx, { reservationId: reservation.id, reason }, ctx);
    outcome.releasedReservations += 1;
  }

  const deliveryOrders = await tx.deliveryOrder.findMany({
    where: {
      caseId: opCase.id,
      status: { notIn: ['cancelled', 'delivered', 'partially_delivered'] },
    },
  });
  for (const deliveryOrder of deliveryOrders) {
    const result = await cancelDeliveryOrder(tx, { deliveryOrderId: deliveryOrder.id, reason });
    if (!result.alreadyCancelled) outcome.cancelledDeliveryOrders += 1;
    if (result.zohoCancelQueued) outcome.zohoCancellationsQueued += 1;
  }

  outcome.expiredRequests = (await expireAreaRequestsForCase(tx, opCase.id, reason)).length;
  await cancelOpenStepsForCase(tx, opCase.id, reason);
  const openItems = await tx.workItem.findMany({
    where: { caseId: opCase.id, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
  });
  for (const item of openItems) {
    await cancelWorkItemInTx(tx, item, { reason });
    outcome.cancelledWorkItems += 1;
  }

  for (const allocation of allocations) {
    if (allocation.status === 'cancelled') continue;
    const facts = impact.find((a) => a.id === allocation.id)!;
    const demand = demands.find((d) => d.id === allocation.demandId);
    const compensation = cancellationCompensation(facts, facts.requestStatus);
    if (compensation.sendCancelRequest) {
      outcome.cancelRequestIds.push(
        await sendCancelRequest(ctx, opCase, allocation, demand, { reason })
      );
    }
    if (compensation.severity) {
      const { incident } = await openOrReopenIncident(tx, {
        kind: 'cancellation_compensation',
        areaKey: compensation.areaKey,
        severity: compensation.severity,
        title: `Compensar ${demand?.name ?? 'material'} del expediente cancelado ${caseLabel(opCase)}`,
        dedupeKey: `cancel_compensation:${opCase.id}:${allocation.id}`,
        caseId: opCase.id,
        detail: {
          allocationId: allocation.id,
          demandId: allocation.demandId,
          source: allocation.source,
          allocationStatus: allocation.status,
          requestStatus: facts.requestStatus,
          quantity: qtyText(allocation.quantity),
          deliveredQuantity: qtyText(allocation.deliveredQuantity),
          unit: demand?.baseUnit ?? null,
          reason,
        },
      });
      outcome.incidentIds.push(incident.id);
    }
    const updated = await tx.demandAllocation.update({
      where: { id: allocation.id },
      data: { status: 'cancelled', stockReservationId: null, version: { increment: 1 } },
    });
    emitAllocationEvent(ctx, OPS_EVENTS.allocation.cancelled, updated, {
      reason,
      previousStatus: allocation.status,
      compensated: Boolean(compensation.severity || compensation.sendCancelRequest),
    });
  }

  for (const demand of demands) {
    if (demand.status === 'cancelled' || demand.status === 'fulfilled') continue;
    await tx.caseDemand.update({
      where: { id: demand.id },
      data: { status: 'cancelled', version: { increment: 1 } },
    });
    ctx.emit(
      OPS_EVENTS.demand.cancelled,
      { demandId: demand.id, lineRef: demand.lineRef, reason },
      { caseId: opCase.id, areaKey: 'ventas', objectType: 'case_demand', objectId: demand.id }
    );
  }

  await tx.operationalCase.update({
    where: { id: opCase.id },
    data: {
      status: 'cancelled',
      cancelledAt: ctx.now,
      closeReason: reason,
      lastActivityAt: ctx.now,
      ...(options.aggregate ? {} : { version: { increment: 1 } }),
    },
  });
  const eventOptions = {
    caseId: opCase.id,
    areaKey: 'ventas',
    objectType: CASE_AGGREGATE_TYPE,
    objectId: opCase.id,
  };
  ctx.emit(OPS_EVENTS.case.statusChanged, { from: opCase.status, to: 'cancelled' }, eventOptions);
  ctx.emit(
    OPS_EVENTS.case.cancelled,
    toOperationalJson({
      reason,
      source: input.source,
      previousStatus: opCase.status,
      releasedReservations: outcome.releasedReservations,
      cancelledDeliveryOrders: outcome.cancelledDeliveryOrders,
      zohoCancellationsQueued: outcome.zohoCancellationsQueued,
      expiredRequests: outcome.expiredRequests,
      cancelRequestIds: outcome.cancelRequestIds,
      incidentIds: outcome.incidentIds,
    }) as Record<string, unknown>,
    eventOptions
  );
  if (opCase.ownerUserId) {
    ctx.notify({
      userId: opCase.ownerUserId,
      category: 'ops_workitem',
      type: 'ops_case_cancelled',
      title: `Expediente cancelado: ${caseLabel(opCase)}`,
      body: reason,
      url: `/app/operations/cases/${opCase.id}`,
      entityType: CASE_AGGREGATE_TYPE,
      entityId: opCase.id,
    });
  }
  log('case_cancelled', {
    caseId: opCase.id,
    source: input.source,
    incidents: outcome.incidentIds.length,
    cancelRequests: outcome.cancelRequestIds.length,
    commandId: ctx.commandId,
  });
  return outcome;
}

const cancelSchema = z
  .object({ reason: z.string().trim().min(3, 'Indica el motivo de la cancelación').max(500) })
  .strict();

registerCommand<z.output<typeof cancelSchema>, CancelCaseOutcome>(CASE_COMMANDS.cancel, {
  schema: cancelSchema,
  permission: MANAGE_PERMISSION,
  aggregate: caseAggregate,
  actorTypes: ['user', 'system'],
  audit: 'always',
  async handler(tx, cmd, ctx) {
    const outcome = await cancelCaseInTx(
      tx,
      cmd.aggregate.id,
      { reason: cmd.payload.reason, source: ctx.actor.type === 'user' ? 'manual' : 'sales_order' },
      { aggregate: true }
    );
    return { data: outcome };
  },
});

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

export interface ReplanCommandOptions {
  commandId?: string;
  expectedVersion?: number;
  now?: Date;
  /** Person (`operations.manage`); without it the system replans. */
  actor?: CurrentUser | null;
  systemActorId?: string;
  changeEventId?: string | null;
  reason?: string;
}

export function replanCase(
  caseId: string,
  options: ReplanCommandOptions = {}
): Promise<CommandResult<ReplanData>> {
  return executeCommand<ReplanData>(
    {
      commandId: options.commandId ?? `case.replan:${randomUUID()}`,
      type: CASE_COMMANDS.replan,
      actor: options.actor
        ? { type: 'user', id: options.actor.id }
        : { type: 'system', id: options.systemActorId ?? 'operations.case_replan' },
      aggregate: { type: CASE_AGGREGATE_TYPE, id: caseId },
      expectedVersion: options.expectedVersion,
      payload: {
        ...(options.changeEventId ? { changeEventId: options.changeEventId } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
    },
    options.actor ?? null,
    { now: options.now }
  );
}

/** Manual cancellation (`operations.manage`). */
export function cancelCase(
  actor: CurrentUser,
  caseId: string,
  input: { reason: string },
  options: { commandId?: string; expectedVersion?: number; now?: Date } = {}
): Promise<CommandResult<CancelCaseOutcome>> {
  return executeCommand<CancelCaseOutcome>(
    {
      commandId: options.commandId ?? `case.cancel:${randomUUID()}`,
      type: CASE_COMMANDS.cancel,
      actor: { type: 'user', id: actor.id },
      aggregate: { type: CASE_AGGREGATE_TYPE, id: caseId },
      expectedVersion: options.expectedVersion,
      payload: { reason: input.reason },
    },
    actor,
    { now: options.now }
  );
}

export { CASE_STEP_OBJECT_TYPE };
