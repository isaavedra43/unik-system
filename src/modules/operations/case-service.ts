import { randomUUID } from 'crypto';
import {
  Prisma,
  type AreaRequest,
  type CaseDemand,
  type CaseStep,
  type DeliveryOrder,
  type DemandAllocation,
  type OperationalCase,
  type SalesOrder,
  type Warehouse,
  type WorkItem,
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { areaSlug, resolveResponsible } from '@/modules/comms/responsibles-service';
import {
  assertReceiptMovements,
  reserveStock,
  verifyAvailability,
} from '@/modules/inventory/inventory-service';
import type { MovementKind } from '@/modules/inventory/inventory-types';
import {
  DEFAULT_BASE_UNIT,
  getOrCreateProfile,
  toUnitProfile,
} from '@/modules/inventory/profiles-service';
import {
  StockMathError,
  dec,
  normalizeUnit,
  roundQty,
  toBase,
} from '@/modules/inventory/stock-math';
import { resolveWarehouseForZohoLocation } from '@/modules/inventory/warehouses-service';
import { JOB_PRIORITY } from '@/modules/jobs/job-queue';
import {
  createDeliveryOrder,
  type CreateDeliveryOrderInput,
} from '@/modules/logistics/delivery-service';
import {
  allocationDecisionSchema,
  describePlanLines,
  planAllocations,
  type AllocationDecision,
  type AllocationPlanResult,
} from './allocation-planner';
import { expireAreaRequestsForCase } from './area-requests-service';
import {
  ConcurrencyConflict,
  executeCommand,
  isOperationsError,
  OperationsError,
  registerCommand,
  requireCommandContext,
  resolveAreaAssignee,
  versionedAggregate,
  type CommandContext,
  type CommandResult,
} from './commands';
import {
  authorizeOperationsChannel,
  listCaseEvents,
  onOperationalEvents,
  onOperationalEventsInTransaction,
  type OperationalOutboxJob,
  toOperationalJson,
  type OperationalEventRecord,
} from './events-service';
import { getOperationsConfig, isOpsFlagEnabled } from './operations-config';
import {
  CONDITION_LABELS,
  QTY_EPSILON,
  evaluateCondition,
  isCarrierDelivery,
  isConditionKey,
  isCustomerPickup,
  uncoveredQuantity,
  type AvailabilityFacts,
  type CaseFacts,
  type ConditionScope,
} from './process-blueprints/conditions';
import {
  dependenciesSatisfied,
  instantiateSteps,
  sameDependencies,
  stepRef,
} from './process-blueprints/instantiate';
import {
  ensureProcessVersion,
  findStepDef,
  loadProcessBlueprint,
} from './process-blueprints/registry';
import { SALES_FULFILLMENT_BLUEPRINT, SALES_STEP } from './process-blueprints/sales-fulfillment';
import type { ProcessBlueprint, StepDef } from './process-blueprints/types';
import {
  CASE_JOB_TYPES,
  CASE_KIND,
  CASE_SOURCE_TYPE,
  caseAdvanceDedupeKey,
} from './sales-order-hooks';
import { nextSequence } from './sequence-service';
import { evaluateStartPolicy } from './start-policy';
import { registerSupervisorCaseAdvancer } from './supervisor';
import {
  AI_TURN_EVENT_TYPES,
  AREA_REQUEST_OPEN_STATUSES,
  CASE_OPEN_STATUSES,
  CASE_PHASES,
  CASE_PHASE_LABELS,
  CASE_STATUSES,
  CASE_STATUS_LABELS,
  INCIDENT_OPEN_STATUSES,
  OPS_EVENTS,
  WORK_ITEM_OPEN_STATUSES,
  type AreaKey,
  type CasePhase,
  type CaseStatus,
  type OperationsActor,
} from './types';
import {
  completeWorkItemInTx,
  cancelWorkItemInTx,
  decodeListCursor,
  encodeListCursor,
  isActiveHumanUser,
  keysetCondition,
  registerWorkItemHooks,
} from './work-items-service';

/**
 * Sales fulfillment cases (plan sections 2.3 and 2.4).
 *
 * - `case.start` (`startSalesFulfillment`, `startCaseManually`): creates the
 *   `OperationalCase` of a Zoho sales order (idempotent by kind + source), one
 *   `CaseDemand` per fulfillable line with its base quantity, instantiates the
 *   blueprint and advances it.
 * - `advanceCase(tx, caseId, ctx)`: deterministic engine. It keeps the steps
 *   in line with demands and allocations, marks ready the steps whose
 *   dependencies are satisfied (or skips them when their entry condition is
 *   false), closes steps whose `autoComplete` condition holds, executes the
 *   engine steps (`reservar_stock` → `reserveStock`, `solicitar_compra` /
 *   `ordenar_produccion` / `coordinar_entrega_directa` → `AreaRequest`,
 *   `planear_entrega` → `createDeliveryOrder`) and opens one `WorkItem` per
 *   ready step that needs a person. Finally it recomputes phase and status.
 * - `completeStep(tx, stepId, …)`: closes a step from evidence or an event.
 *   Completing a step's work item (`workitem.complete`) does the same through
 *   the work item hooks registered here, in the same transaction.
 * - `case.advance`: the same engine as a command (jobs, supervisor, "Reintentar").
 * - Reads: `getCaseSnapshot(caseId)` (compact JSON for prompts and UI) and
 *   `listCases(actor, filters)`.
 * - `onCaseStarted(listener)`: extension point after the commit (the agents
 *   layer creates the case room). With no listeners nothing happens.
 *
 * Facts emitted by other modules (a confirmed shipment, a delivery, a stock
 * count) enqueue `ops.case.advance` through an `onOperationalEvents` listener.
 */

type Db = Prisma.TransactionClient;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-cases', event, ...extra }));

export const CASE_AGGREGATE_TYPE = 'operational_case';
export const CASE_STEP_OBJECT_TYPE = 'case_step';

export const CASE_COMMANDS = {
  start: 'case.start',
  advance: 'case.advance',
  replan: 'case.replan',
  cancel: 'case.cancel',
} as const;

/** Command ids generated by the case wrappers and jobs (their events never re-trigger an advance). */
export const CASE_COMMAND_ID_PREFIXES = ['case.', 'ops:case.'] as const;

const MANAGE_PERMISSION = 'operations.manage';
const VIEW_PERMISSION = 'operations.view';
const MAX_ADVANCE_PASSES = 40;
const DAY_MS = 24 * 60 * 60_000;

export const OPEN_STEP_STATUSES = ['ready', 'active', 'waiting'] as const;
const TERMINAL_STEP_STATUSES = ['done', 'skipped', 'cancelled', 'failed'];
const ACTIVE_ALLOCATION_EXCLUDED = ['cancelled'];

/** `reservar_stock` failures that retrying cannot fix: the allocation goes back to the plan. */
const REPLANNABLE_RESERVE_FAILURES = [
  'insufficient_stock',
  'stock_not_promisable',
  'stock_uncounted',
  'stock_disputed',
  'provisional_not_allowed',
  'provisional_verification_stale',
  'provisional_requires_human',
  'invalid_unit',
  'demand_over_reserved',
];
/** Requests whose area will never deliver what the allocation asked for. */
const DEAD_REQUEST_STATUSES = ['rejected', 'cancelled', 'expired'];
/** Allocations nothing was committed for yet (no stock reserved, nothing received). */
const REPLANNABLE_ALLOCATION_STATUSES = ['planned', 'requested', 'in_progress'];
const TRANSPORT_WAIT_REASON = 'Esperando que Zoho confirme el embarque';
/** Awaited receipts: the evidence must be the inventory movement that brought the material in. */
const RECEIPT_EVIDENCE: Record<string, { key: string; kinds: readonly MovementKind[] }> = {
  [SALES_STEP.awaitReceipt]: { key: 'receipt_movement', kinds: ['receipt'] },
  [SALES_STEP.awaitProduction]: { key: 'produce_movement', kinds: ['produce'] },
};

export const caseAggregate = versionedAggregate(CASE_AGGREGATE_TYPE, 'operationalCase');

export const caseSourceAggregateId = (zohoSalesOrderId: string) => `so:${zohoSalesOrderId}`;

// ---------------------------------------------------------------------------
// Small helpers
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

function qtyText(value: Prisma.Decimal | number | string): string {
  return dec(value).toDecimalPlaces(4).toString();
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function truncate(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const clean = text.trim();
  if (!clean) return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

function isOpenStep(status: string): boolean {
  return (OPEN_STEP_STATUSES as readonly string[]).includes(status);
}

function upsertById<T extends { id: string }>(list: T[], row: T): void {
  const index = list.findIndex((item) => item.id === row.id);
  if (index >= 0) list[index] = row;
  else list.push(row);
}

function scopeOf(step: Pick<CaseStep, 'scope' | 'demandId' | 'allocationId'>): ConditionScope {
  return {
    scope: step.scope as ConditionScope['scope'],
    demandId: step.demandId,
    allocationId: step.allocationId,
  };
}

export function caseUrl(caseId: string): string {
  return `/app/operations/cases/${caseId}`;
}

// ---------------------------------------------------------------------------
// Pure rules: SLA, phase and status
// ---------------------------------------------------------------------------

/** Due date of a step: `anchor + slaMinutes`, or `now + (fallback ?? slaMinutes)` without anchor. */
export function computeStepDueAt(
  def: Pick<StepDef, 'slaMinutes' | 'slaAnchor' | 'slaFallbackMinutes'>,
  anchor: Date | null,
  now: Date
): Date {
  if (def.slaAnchor && anchor && !Number.isNaN(anchor.getTime())) {
    return new Date(anchor.getTime() + def.slaMinutes * 60_000);
  }
  const minutes = def.slaAnchor ? (def.slaFallbackMinutes ?? def.slaMinutes) : def.slaMinutes;
  return new Date(now.getTime() + Math.max(0, minutes) * 60_000);
}

const PHASE_RANK: Record<CasePhase, number> = {
  planning: 0,
  sourcing: 1,
  preparing: 2,
  delivering: 3,
  closing: 4,
};

/**
 * Where the case is: the least advanced phase among its open steps (ready,
 * active or waiting), so a direct supplier delivery being confirmed never shows
 * the case as "delivering" while another line is still being sourced. Without
 * open steps, the furthest phase already done.
 */
export function deriveCasePhase(
  steps: ReadonlyArray<Pick<CaseStep, 'stepKey' | 'status'>>,
  blueprint: ProcessBlueprint
): CasePhase {
  let openRank: number | null = null;
  let doneRank = 0;
  for (const step of steps) {
    const def = findStepDef(blueprint, step.stepKey);
    if (!def) continue;
    const rank = PHASE_RANK[def.phase];
    if ((OPEN_STEP_STATUSES as readonly string[]).includes(step.status)) {
      openRank = openRank === null ? rank : Math.min(openRank, rank);
    } else if (step.status === 'done') {
      doneRank = Math.max(doneRank, rank);
    }
  }
  return CASE_PHASES[openRank ?? doneRank];
}

export interface CaseStatusInput {
  current: string;
  steps: ReadonlyArray<Pick<CaseStep, 'stepKey' | 'status'>>;
  openWorkItemStatuses: readonly string[];
  openRequestStatuses: readonly string[];
}

/**
 * Status of a live case: closed once the financial close is done,
 * ready_to_close after the operational close, blocked with a blocked request
 * or a failed step, waiting when every open work item waits (or only waiting
 * steps remain), open otherwise. Closed and cancelled cases never change here.
 */
export function deriveCaseStatus(input: CaseStatusInput): CaseStatus {
  if (input.current === 'closed' || input.current === 'cancelled') return input.current;
  const status = (key: string) => input.steps.find((step) => step.stepKey === key)?.status;
  if (status(SALES_STEP.financialClose) === 'done') return 'closed';
  if (
    input.openRequestStatuses.includes('blocked') ||
    input.steps.some((step) => step.status === 'failed')
  ) {
    return 'blocked';
  }
  if (status(SALES_STEP.operationalClose) === 'done') return 'ready_to_close';
  const open = input.openWorkItemStatuses;
  if (open.length > 0 && open.every((value) => value === 'waiting')) return 'waiting';
  if (open.length === 0 && input.steps.some((step) => step.status === 'waiting')) return 'waiting';
  return 'open';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type CaseSalesOrder = Pick<
  SalesOrder,
  | 'id'
  | 'zohoSalesOrderId'
  | 'salesOrderNumber'
  | 'status'
  | 'invoicedStatus'
  | 'paidStatus'
  | 'shippedStatus'
  | 'customerName'
  | 'customerPhone'
  | 'shippingAttention'
  | 'shippingAddressLine1'
  | 'shippingAddressLine2'
  | 'shippingCity'
  | 'shippingState'
  | 'shippingPostalCode'
  | 'shippingPhone'
>;

interface CaseState {
  opCase: OperationalCase;
  steps: CaseStep[];
  demands: CaseDemand[];
  allocations: DemandAllocation[];
  deliveryOrders: DeliveryOrder[];
  salesOrder: CaseSalesOrder | null;
  openWorkItems: WorkItem[];
  openRequests: Pick<AreaRequest, 'id' | 'status' | 'kind' | 'objectType' | 'objectId'>[];
  activeReservationAllocationIds: Set<string>;
}

async function loadCaseState(tx: Db, caseId: string): Promise<CaseState | null> {
  const opCase = await tx.operationalCase.findUnique({ where: { id: caseId } });
  if (!opCase) return null;
  const steps = await tx.caseStep.findMany({ where: { caseId } });
  const demands = await tx.caseDemand.findMany({
    where: { caseId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  const allocations = await tx.demandAllocation.findMany({
    where: { caseId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const deliveryOrders = await tx.deliveryOrder.findMany({
    where: { caseId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const salesOrder = opCase.zohoSalesOrderId
    ? await tx.salesOrder.findUnique({
        where: { zohoSalesOrderId: opCase.zohoSalesOrderId },
        select: {
          id: true,
          zohoSalesOrderId: true,
          salesOrderNumber: true,
          status: true,
          invoicedStatus: true,
          paidStatus: true,
          shippedStatus: true,
          customerName: true,
          customerPhone: true,
          shippingAttention: true,
          shippingAddressLine1: true,
          shippingAddressLine2: true,
          shippingCity: true,
          shippingState: true,
          shippingPostalCode: true,
          shippingPhone: true,
        },
      })
    : null;
  const openWorkItems = await tx.workItem.findMany({
    where: { caseId, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
  });
  const openRequests = await tx.areaRequest.findMany({
    where: { caseId, status: { in: [...AREA_REQUEST_OPEN_STATUSES] } },
    select: { id: true, status: true, kind: true, objectType: true, objectId: true },
  });
  const reservations = await tx.stockReservation.findMany({
    where: { caseId, status: 'active' },
    select: { allocationId: true },
  });
  return {
    opCase,
    steps,
    demands,
    allocations,
    deliveryOrders,
    salesOrder,
    openWorkItems,
    openRequests,
    activeReservationAllocationIds: new Set(
      reservations.map((r) => r.allocationId).filter((id): id is string => Boolean(id))
    ),
  };
}

function activeAllocationsOf(state: CaseState, demandId?: string): DemandAllocation[] {
  return state.allocations.filter(
    (a) =>
      !ACTIVE_ALLOCATION_EXCLUDED.includes(a.status) &&
      (demandId === undefined || a.demandId === demandId)
  );
}

function buildFacts(
  state: CaseState,
  availability: ReadonlyMap<string, AvailabilityFacts | null>
): CaseFacts {
  return {
    case: {
      id: state.opCase.id,
      status: state.opCase.status,
      deliveryMethod: state.opCase.deliveryMethod,
    },
    salesOrder: state.salesOrder
      ? {
          status: state.salesOrder.status,
          invoicedStatus: state.salesOrder.invoicedStatus,
          paidStatus: state.salesOrder.paidStatus,
          shippedStatus: state.salesOrder.shippedStatus,
        }
      : null,
    demands: state.demands.map((demand) => ({
      id: demand.id,
      status: demand.status,
      zohoItemId: demand.zohoItemId,
      quantity: num(demand.baseQuantity),
      fulfilledQuantity: num(demand.fulfilledQuantity),
      allocatedQuantity: activeAllocationsOf(state, demand.id).reduce(
        (sum, a) => sum + num(a.quantity),
        0
      ),
      availability: availability.get(demand.id) ?? null,
    })),
    allocations: state.allocations.map((allocation) => ({
      id: allocation.id,
      demandId: allocation.demandId,
      source: allocation.source,
      status: allocation.status,
      quantity: num(allocation.quantity),
      deliveredQuantity: num(allocation.deliveredQuantity),
      stockReservationId: allocation.stockReservationId,
      hasActiveReservation: state.activeReservationAllocationIds.has(allocation.id),
      linkedId: allocation.linkedId,
      readyAt: allocation.readyAt?.toISOString() ?? null,
      expectedAt: allocation.expectedAt?.toISOString() ?? null,
    })),
    deliveryOrders: state.deliveryOrders.map((order) => ({
      id: order.id,
      status: order.status,
      mode: order.mode,
      zohoSyncState: order.zohoSyncState,
      allocationIds: order.allocationIds,
      plannedDate: order.plannedDate?.toISOString() ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Warehouses, availability and owners
// ---------------------------------------------------------------------------

interface AdvanceCaches {
  warehouses: Map<string, Warehouse>;
  owners: Map<string, { ownerUserId: string; backupUserId: string | null }>;
  /** Demands whose plan was reopened in this run: never auto-planned again in the same run. */
  replannedDemands: Set<string>;
  /** Demand id → base unit of its item, when the demand unit does not convert to it. */
  unitMismatch: Map<string, string>;
  /** zohoItemId → base unit of its profile (null without profile). */
  profileUnits: Map<string, string | null>;
}

function newCaches(): AdvanceCaches {
  return {
    warehouses: new Map(),
    owners: new Map(),
    replannedDemands: new Set(),
    unitMismatch: new Map(),
    profileUnits: new Map(),
  };
}

async function warehouseFor(
  tx: Db,
  locationId: string | null | undefined,
  caches: AdvanceCaches
): Promise<Warehouse> {
  const key = locationId?.trim() ?? '';
  const cached = caches.warehouses.get(key);
  if (cached) return cached;
  const warehouse = await resolveWarehouseForZohoLocation(tx, key || null);
  caches.warehouses.set(key, warehouse);
  return warehouse;
}

const AVAILABILITY_CONDITIONS = ['controlledStockSufficient', 'planCoveredByControlledStock'];

function needsAvailability(def: StepDef | null): boolean {
  if (!def) return false;
  return (
    def.uiAction === 'plan_allocations' ||
    Boolean(def.autoComplete && AVAILABILITY_CONDITIONS.includes(def.autoComplete))
  );
}

async function demandAvailability(
  tx: Db,
  state: CaseState,
  demand: CaseDemand,
  caches: AdvanceCaches
): Promise<AvailabilityFacts | null> {
  if (!demand.zohoItemId) return null;
  const warehouse = await warehouseFor(tx, demand.locationId, caches);
  const result = await verifyAvailability(tx, {
    zohoItemId: demand.zohoItemId,
    warehouseId: warehouse.id,
    variantKey: demand.variantKey,
  });
  if ((normalizeUnit(demand.baseUnit) || result.baseUnit) !== result.baseUnit) {
    // A quantity in another unit cannot be compared with the stock: availability is
    // unknown, so neither the verification nor the plan completes on their own.
    caches.unitMismatch.set(demand.id, result.baseUnit);
    return null;
  }
  caches.unitMismatch.delete(demand.id);
  // Stock planned for other demands of this case but not reserved yet is already promised.
  const claimed = state.allocations
    .filter((allocation) => {
      if (allocation.source !== 'stock' || allocation.status !== 'planned') return false;
      if (allocation.demandId === demand.id) return false;
      if (allocation.warehouseId && allocation.warehouseId !== warehouse.id) return false;
      const other = state.demands.find((d) => d.id === allocation.demandId);
      return other?.zohoItemId === demand.zohoItemId && other.variantKey === demand.variantKey;
    })
    .reduce((sum, allocation) => sum + num(allocation.quantity), 0);
  return {
    confidence: result.confidence,
    available: num(result.available) - claimed,
    lastVerifiedAt: result.lastVerifiedAt?.toISOString() ?? null,
  };
}

async function loadAvailability(
  tx: Db,
  state: CaseState,
  blueprint: ProcessBlueprint,
  caches: AdvanceCaches
): Promise<Map<string, AvailabilityFacts | null>> {
  const map = new Map<string, AvailabilityFacts | null>();
  for (const step of state.steps) {
    if (!step.demandId || TERMINAL_STEP_STATUSES.includes(step.status)) continue;
    if (!needsAvailability(findStepDef(blueprint, step.stepKey)) || map.has(step.demandId))
      continue;
    const demand = state.demands.find((d) => d.id === step.demandId);
    map.set(step.demandId, demand ? await demandAvailability(tx, state, demand, caches) : null);
  }
  return map;
}

async function areaAssignee(
  tx: Db,
  areaKey: AreaKey
): Promise<{ ownerUserId: string; backupUserId: string | null }> {
  const assignee = await resolveAreaAssignee(tx, areaKey);
  return { ownerUserId: assignee.ownerUserId, backupUserId: assignee.backupUserId };
}

async function resolveStepOwner(
  tx: Db,
  state: CaseState,
  def: StepDef,
  step: CaseStep,
  caches: AdvanceCaches
): Promise<{ ownerUserId: string; backupUserId: string | null }> {
  const resolution = def.ownerResolution;
  if ('role' in resolution) {
    const key = `case_owner:${state.opCase.ownerUserId}`;
    const cached = caches.owners.get(key);
    if (cached) return cached;
    let owner: { ownerUserId: string; backupUserId: string | null };
    if (await isActiveHumanUser(tx, state.opCase.ownerUserId)) {
      let backup: string | null = null;
      try {
        const sales = await areaAssignee(tx, 'ventas');
        backup =
          sales.ownerUserId !== state.opCase.ownerUserId ? sales.ownerUserId : sales.backupUserId;
      } catch (err) {
        if (!isOperationsError(err) || err.code !== 'no_responsible') throw err;
      }
      owner = { ownerUserId: state.opCase.ownerUserId, backupUserId: backup };
    } else {
      owner = await areaAssignee(tx, 'ventas');
    }
    caches.owners.set(key, owner);
    return owner;
  }
  if (resolution.byLocation) {
    const demand = step.demandId ? state.demands.find((d) => d.id === step.demandId) : null;
    const warehouse = await warehouseFor(tx, demand?.locationId ?? state.opCase.locationId, caches);
    const slug = areaSlug(`${resolution.area} ${warehouse.key}`);
    const key = `location:${slug}`;
    const cached = caches.owners.get(key);
    if (cached) return cached;
    const local = await resolveResponsible(slug, tx);
    const owner =
      local && local.area === slug
        ? {
            ownerUserId: local.userId,
            backupUserId:
              !local.isBackup && local.backupUserId && local.backupUserId !== local.userId
                ? local.backupUserId
                : null,
          }
        : await areaAssignee(tx, resolution.area);
    caches.owners.set(key, owner);
    return owner;
  }
  const key = `area:${resolution.area}`;
  const cached = caches.owners.get(key);
  if (cached) return cached;
  const owner = await areaAssignee(tx, resolution.area);
  caches.owners.set(key, owner);
  return owner;
}

/**
 * Owner of a new case: the active user whose name is exactly the Zoho
 * salesperson (only when a single user matches), otherwise the responsible of
 * Ventas.
 */
async function resolveCaseOwner(tx: Db, salespersonName: string | null): Promise<string> {
  const name = salespersonName?.trim();
  if (name) {
    const users = await tx.user.findMany({
      where: { isActive: true, isBot: false, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
      take: 2,
    });
    if (users.length === 1) return users[0].id;
  }
  return (await resolveAreaAssignee(tx, 'ventas')).ownerUserId;
}

// ---------------------------------------------------------------------------
// Demand quantities
// ---------------------------------------------------------------------------

export interface DemandQuantity {
  quantity: Prisma.Decimal;
  unit: string;
  baseQuantity: Prisma.Decimal;
  baseUnit: string;
  /** False when the unit had no conversion to the profile's base unit (quantity kept as is). */
  unitResolved: boolean;
}

/**
 * Base quantity of an order line: conversions of the item's inventory profile
 * (created UNCOUNTED with factor 1 when missing). Without an item, or when the
 * unit has no conversion, the quantity is kept in the line unit.
 */
export async function resolveDemandQuantity(
  tx: Db,
  zohoItemId: string | null,
  quantity: Prisma.Decimal.Value,
  unit: string | null
): Promise<DemandQuantity> {
  const amount = roundQty(dec(quantity));
  const lineUnit = normalizeUnit(unit);
  if (!zohoItemId) {
    const fallback = lineUnit || DEFAULT_BASE_UNIT;
    return {
      quantity: amount,
      unit: fallback,
      baseQuantity: amount,
      baseUnit: fallback,
      unitResolved: true,
    };
  }
  const profile = await getOrCreateProfile(tx, zohoItemId);
  const units = toUnitProfile(profile);
  try {
    const baseQuantity = toBase(amount, lineUnit || units.baseUnit, units);
    return {
      quantity: amount,
      unit: lineUnit || units.baseUnit,
      baseQuantity,
      baseUnit: units.baseUnit,
      unitResolved: true,
    };
  } catch (err) {
    if (!(err instanceof StockMathError)) throw err;
    return {
      quantity: amount,
      unit: lineUnit || units.baseUnit,
      baseQuantity: amount,
      baseUnit: lineUnit || units.baseUnit,
      unitResolved: false,
    };
  }
}

export interface FulfillableLine {
  zohoLineItemId: string | null;
  zohoItemId: string | null;
  sku: string | null;
  name: string;
  quantity: Prisma.Decimal;
  unit: string | null;
  locationId: string | null;
  sortOrder: number;
}

/** Order lines that need physical fulfillment: positive quantity and not a service item. */
export async function loadFulfillableLines(
  tx: Db,
  salesOrderId: string
): Promise<FulfillableLine[]> {
  const items = await tx.salesOrderItem.findMany({
    where: { salesOrderId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  const itemIds = [
    ...new Set(items.map((i) => i.zohoItemId).filter((id): id is string => Boolean(id))),
  ];
  const products = itemIds.length
    ? await tx.product.findMany({
        where: { zohoItemId: { in: itemIds } },
        select: { zohoItemId: true, productType: true, itemType: true },
      })
    : [];
  const services = new Set(
    products
      .filter((p) =>
        [p.productType, p.itemType].some((t) => (t ?? '').trim().toLowerCase() === 'service')
      )
      .map((p) => p.zohoItemId)
  );
  return items
    .filter((item) => item.quantity && dec(item.quantity).gt(0))
    .filter((item) => !(item.zohoItemId && services.has(item.zohoItemId)))
    .map((item) => ({
      zohoLineItemId: item.zohoLineItemId,
      zohoItemId: item.zohoItemId,
      sku: item.sku,
      name: item.name?.trim() || item.sku?.trim() || 'Artículo sin nombre',
      quantity: dec(item.quantity!),
      unit: item.unit,
      locationId: item.locationId,
      sortOrder: item.sortOrder,
    }));
}

/** `zohoLineItemId`, or `idx:{sortOrder}`; never repeats one of `taken`. */
export function uniqueLineRef(
  line: Pick<FulfillableLine, 'zohoLineItemId' | 'sortOrder'>,
  index: number,
  taken: Set<string>
): string {
  const base = line.zohoLineItemId?.trim() || `idx:${line.sortOrder || index + 1}`;
  let ref = base;
  let n = 2;
  while (taken.has(ref)) ref = `${base}~${n++}`;
  taken.add(ref);
  return ref;
}

/** Creates a demand in the running command and emits `demand.created`. */
export async function createCaseDemand(
  tx: Db,
  ctx: CommandContext,
  opCase: Pick<OperationalCase, 'id' | 'locationId'>,
  line: FulfillableLine,
  input: { lineRef: string; sortOrder: number; reason?: string }
): Promise<CaseDemand> {
  const quantity = await resolveDemandQuantity(tx, line.zohoItemId, line.quantity, line.unit);
  const demand = await tx.caseDemand.create({
    data: {
      caseId: opCase.id,
      lineRef: input.lineRef,
      zohoItemId: line.zohoItemId,
      sku: line.sku,
      name: line.name.slice(0, 300),
      quantity: quantity.quantity,
      unit: quantity.unit,
      baseQuantity: quantity.baseQuantity,
      baseUnit: quantity.baseUnit,
      variantKey: '',
      locationId: line.locationId ?? opCase.locationId,
      status: 'pending',
      sortOrder: input.sortOrder,
    },
  });
  ctx.emit(
    OPS_EVENTS.demand.created,
    {
      demandId: demand.id,
      lineRef: demand.lineRef,
      zohoItemId: demand.zohoItemId,
      sku: demand.sku,
      name: demand.name,
      quantity: qtyText(demand.quantity),
      unit: demand.unit,
      baseQuantity: qtyText(demand.baseQuantity),
      baseUnit: demand.baseUnit,
      unitResolved: quantity.unitResolved,
      reason: input.reason ?? 'case_start',
    },
    { caseId: opCase.id, areaKey: 'ventas', objectType: 'case_demand', objectId: demand.id }
  );
  return demand;
}

// ---------------------------------------------------------------------------
// Advance run
// ---------------------------------------------------------------------------

interface AdvanceRun {
  tx: Db;
  ctx: CommandContext;
  blueprint: ProcessBlueprint;
  state: CaseState;
  availability: Map<string, AvailabilityFacts | null>;
  statusByRef: Map<string, string>;
  caches: AdvanceCaches;
  result: AdvanceCaseResult;
}

export interface AdvanceCaseOptions {
  /** True when the case is the aggregate of the running command (its version was bumped). */
  aggregate?: boolean;
}

export interface AdvanceCaseResult {
  caseId: string;
  changed: boolean;
  status: string;
  phase: string;
  readySteps: string[];
  completedSteps: string[];
  skippedSteps: string[];
  workItemIds: string[];
  engineFailures: Array<{ step: string; code: string; message: string }>;
  reentrant?: boolean;
}

const advancing = new WeakMap<object, Set<string>>();

function isAdvancing(tx: Db, caseId: string): boolean {
  return advancing.get(tx as object)?.has(caseId) ?? false;
}

async function lockCaseRow(tx: Db, caseId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "OperationalCase" WHERE "id" = ${caseId} FOR UPDATE`;
}

async function withAdvancing<T>(tx: Db, caseId: string, fn: () => Promise<T>): Promise<T> {
  const set = advancing.get(tx as object) ?? new Set<string>();
  advancing.set(tx as object, set);
  if (set.has(caseId)) return fn();
  set.add(caseId);
  try {
    // Every engine run of a case (advance, step completion) is serialized behind
    // its row lock, whatever the aggregate of the command; state is read after it.
    await lockCaseRow(tx, caseId);
    return await fn();
  } finally {
    set.delete(caseId);
  }
}

/** Case ids already advanced inside a command transaction (their trigger events need no extra advance). */
const advancedInTransaction = new WeakMap<object, Set<string>>();
function rememberAdvanced(tx: Db, caseId: string): void {
  const set = advancedInTransaction.get(tx as object) ?? new Set<string>();
  set.add(caseId);
  advancedInTransaction.set(tx as object, set);
}

function facts(run: AdvanceRun): CaseFacts {
  return buildFacts(run.state, run.availability);
}

function orderSteps(state: CaseState, blueprint: ProcessBlueprint): CaseStep[] {
  const stepIndex = new Map(blueprint.steps.map((step, index) => [step.key, index]));
  const demandIndex = new Map(state.demands.map((demand, index) => [demand.id, index]));
  const allocationIndex = new Map(
    state.allocations.map((allocation, index) => [allocation.id, index])
  );
  return [...state.steps].sort((a, b) => {
    const byStep = (stepIndex.get(a.stepKey) ?? 999) - (stepIndex.get(b.stepKey) ?? 999);
    if (byStep !== 0) return byStep;
    const byDemand =
      (demandIndex.get(a.demandId ?? '') ?? -1) - (demandIndex.get(b.demandId ?? '') ?? -1);
    if (byDemand !== 0) return byDemand;
    const byAllocation =
      (allocationIndex.get(a.allocationId ?? '') ?? -1) -
      (allocationIndex.get(b.allocationId ?? '') ?? -1);
    if (byAllocation !== 0) return byAllocation;
    return a.id.localeCompare(b.id);
  });
}

function replaceStep(run: AdvanceRun, step: CaseStep): void {
  upsertById(run.state.steps, step);
  run.statusByRef.set(stepRef(step.stepKey, step.scopeKey), step.status);
}

function stepSubject(state: CaseState, step: Pick<CaseStep, 'demandId' | 'allocationId'>): string {
  const allocation = step.allocationId
    ? state.allocations.find((a) => a.id === step.allocationId)
    : null;
  const demand = step.demandId ? state.demands.find((d) => d.id === step.demandId) : null;
  if (allocation && demand)
    return `${qtyText(allocation.quantity)} ${demand.baseUnit} de ${demand.name}`;
  if (demand) return `${qtyText(demand.quantity)} ${demand.unit} de ${demand.name}`;
  const parts = [state.opCase.caseNumber, state.opCase.salesOrderNumber, state.opCase.customerName];
  return parts.filter(Boolean).join(' · ');
}

function caseContextLines(state: CaseState): string[] {
  return [
    `Expediente ${state.opCase.caseNumber}`,
    state.opCase.salesOrderNumber ? `Orden de venta ${state.opCase.salesOrderNumber}` : null,
    state.opCase.customerName ? `Cliente: ${state.opCase.customerName}` : null,
  ].filter((line): line is string => Boolean(line));
}

// ---------------------------------------------------------------------------
// Step transitions
// ---------------------------------------------------------------------------

function anchorFor(run: AdvanceRun, def: StepDef, step: CaseStep): Date | null {
  if (def.slaAnchor === 'expectedAt') {
    return run.state.allocations.find((a) => a.id === step.allocationId)?.expectedAt ?? null;
  }
  if (def.slaAnchor === 'plannedDate') {
    const dates = run.state.deliveryOrders
      .filter((order) => order.status !== 'cancelled' && order.plannedDate)
      .map((order) => order.plannedDate!.getTime());
    return dates.length ? new Date(Math.min(...dates)) : null;
  }
  return null;
}

async function markStepReady(run: AdvanceRun, step: CaseStep, def: StepDef): Promise<CaseStep> {
  const { tx, ctx } = run;
  const dueAt = computeStepDueAt(def, anchorFor(run, def, step), ctx.now);
  const updated = await tx.caseStep.update({
    where: { id: step.id },
    data: { status: 'ready', dueAt, version: { increment: 1 } },
  });
  replaceStep(run, updated);
  run.result.readySteps.push(stepRef(step.stepKey, step.scopeKey));
  ctx.emit(
    OPS_EVENTS.step.ready,
    {
      stepId: step.id,
      stepKey: step.stepKey,
      scopeKey: step.scopeKey,
      areaKey: def.areaKey,
      kind: def.kind,
      dueAt: dueAt.toISOString(),
      engine: def.engine ?? null,
    },
    {
      caseId: step.caseId,
      areaKey: def.areaKey,
      objectType: CASE_STEP_OBJECT_TYPE,
      objectId: step.id,
    }
  );
  if (def.key === SALES_STEP.verify && step.demandId) {
    const demand = run.state.demands.find((d) => d.id === step.demandId);
    if (demand && demand.status === 'pending') {
      upsertById(
        run.state.demands,
        await tx.caseDemand.update({
          where: { id: demand.id },
          data: { status: 'verifying', version: { increment: 1 } },
        })
      );
    }
  }
  return updated;
}

async function skipStep(run: AdvanceRun, step: CaseStep, def: StepDef): Promise<void> {
  const { tx, ctx } = run;
  const updated = await tx.caseStep.update({
    where: { id: step.id },
    data: { status: 'skipped', completedAt: ctx.now, version: { increment: 1 } },
  });
  replaceStep(run, updated);
  run.result.skippedSteps.push(stepRef(step.stepKey, step.scopeKey));
  ctx.emit(
    OPS_EVENTS.step.skipped,
    {
      stepId: step.id,
      stepKey: step.stepKey,
      scopeKey: step.scopeKey,
      condition: def.entryCondition ?? null,
      reason:
        def.entryCondition && isConditionKey(def.entryCondition)
          ? `No se cumple: ${CONDITION_LABELS[def.entryCondition]}`
          : null,
    },
    {
      caseId: step.caseId,
      areaKey: def.areaKey,
      objectType: CASE_STEP_OBJECT_TYPE,
      objectId: step.id,
    }
  );
}

async function cancelStepInTx(
  tx: Db,
  ctx: CommandContext,
  step: CaseStep,
  reason: string
): Promise<CaseStep> {
  const updated = await tx.caseStep.update({
    where: { id: step.id },
    data: { status: 'cancelled', completedAt: ctx.now, version: { increment: 1 } },
  });
  const items = await tx.workItem.findMany({
    where: { stepId: step.id, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
  });
  for (const item of items) await cancelWorkItemInTx(tx, item, { reason });
  ctx.emit(
    OPS_EVENTS.step.cancelled,
    { stepId: step.id, stepKey: step.stepKey, scopeKey: step.scopeKey, reason },
    {
      caseId: step.caseId,
      areaKey: step.areaKey,
      objectType: CASE_STEP_OBJECT_TYPE,
      objectId: step.id,
    }
  );
  return updated;
}

/** Cancels every open step of a case (cancellation) and their work items. */
export async function cancelOpenStepsForCase(
  tx: Db,
  caseId: string,
  reason: string
): Promise<number> {
  const ctx = requireCommandContext(tx);
  const steps = await tx.caseStep.findMany({
    where: { caseId, status: { in: ['pending', ...OPEN_STEP_STATUSES] } },
  });
  for (const step of steps) await cancelStepInTx(tx, ctx, step, reason);
  return steps.length;
}

function workItemDescription(
  run: AdvanceRun,
  step: CaseStep,
  def: StepDef,
  extra: string[]
): string {
  const lines = [...caseContextLines(run.state)];
  const demand = step.demandId ? run.state.demands.find((d) => d.id === step.demandId) : null;
  if (demand) {
    lines.push(
      `Partida: ${demand.name}${demand.sku ? ` (${demand.sku})` : ''} · ${qtyText(demand.quantity)} ${demand.unit}`
    );
  }
  const availability = step.demandId ? run.availability.get(step.demandId) : undefined;
  if (availability) {
    lines.push(
      `Existencia en sistema: ${qtyText(Math.max(availability.available, 0))} ${demand?.baseUnit ?? ''} (${availability.confidence})`.trim()
    );
  }
  const mismatch = step.demandId ? run.caches.unitMismatch.get(step.demandId) : undefined;
  if (demand && mismatch) {
    lines.push(
      `La unidad de la partida (${demand.baseUnit}) no se convierte a la unidad base del artículo (${mismatch}): registra la conversión en su perfil de inventario y vuelve a avanzar el expediente.`
    );
  }
  lines.push(...extra);
  if (def.exit.evidence.length > 0 && def.completion === 'manual') {
    lines.push(`Para terminar: ${def.exit.evidence.join(', ')}`);
  }
  return lines.join('\n').slice(0, 4000);
}

async function planProposalText(run: AdvanceRun, step: CaseStep): Promise<string | null> {
  const demand = step.demandId ? run.state.demands.find((d) => d.id === step.demandId) : null;
  if (!demand) return null;
  const plan = await computePlan(
    run.tx,
    run.ctx,
    run.state,
    demand,
    undefined,
    run.availability.get(demand.id) ?? null,
    false
  );
  if (!plan.ok) return null;
  return `Propuesta: ${describePlanLines(plan.lines, demand.baseUnit)}`;
}

async function ensureStepWorkItem(
  run: AdvanceRun,
  step: CaseStep,
  def: StepDef,
  options: { failure?: EngineFailure } = {}
): Promise<boolean> {
  if (run.state.openWorkItems.some((item) => item.stepId === step.id)) return false;
  const { tx, ctx } = run;
  const owner = await resolveStepOwner(tx, run.state, def, step, run.caches);
  const waiting = def.kind === 'wait';
  const extra: string[] = [];
  if (options.failure) {
    extra.push(`El motor no pudo hacerlo automáticamente: ${options.failure.message}`);
  }
  if (def.key === SALES_STEP.plan) {
    const proposal = await planProposalText(run, step);
    if (proposal) extra.push(proposal);
  }
  if (def.uiAction === 'assign_transport' || def.uiAction === 'record_delivery') {
    const orders = run.state.deliveryOrders.filter((o) => o.status !== 'cancelled');
    if (orders.length > 0) extra.push(`Órdenes de entrega: ${orders.map((o) => o.id).join(', ')}`);
  }
  const dueAt = step.dueAt ?? computeStepDueAt(def, anchorFor(run, def, step), ctx.now);
  const item = await ctx.createWorkItem({
    areaKey: def.areaKey,
    kind: def.kind,
    title: `${def.label}: ${stepSubject(run.state, step)}`,
    description: workItemDescription(run, step, def, extra),
    caseId: step.caseId,
    stepId: step.id,
    objectType: CASE_STEP_OBJECT_TYPE,
    objectId: step.id,
    ownerUserId: owner.ownerUserId,
    backupUserId: owner.backupUserId,
    dueAt,
    status: waiting ? 'waiting' : 'open',
    waitReason: waiting ? def.label : null,
    waitUntil: waiting ? dueAt : null,
    requiredEvidence: def.completion === 'manual' ? def.exit.evidence : [],
    notify: !waiting,
  });
  run.state.openWorkItems.push(item);
  run.result.workItemIds.push(item.id);
  if (waiting && step.status !== 'waiting') {
    const updated = await tx.caseStep.update({
      where: { id: step.id },
      data: { status: 'waiting', version: { increment: 1 } },
    });
    replaceStep(run, updated);
    ctx.emit(
      OPS_EVENTS.step.waiting,
      {
        stepId: step.id,
        stepKey: step.stepKey,
        scopeKey: step.scopeKey,
        workItemId: item.id,
        dueAt: dueAt.toISOString(),
      },
      {
        caseId: step.caseId,
        areaKey: def.areaKey,
        objectType: CASE_STEP_OBJECT_TYPE,
        objectId: step.id,
      }
    );
  }
  return true;
}

/** Reopens a finished step (replan): pending again, previous exit evidence kept under `previous`. */
export async function reopenStep(tx: Db, step: CaseStep, reason: string): Promise<CaseStep> {
  const ctx = requireCommandContext(tx);
  const updated = await tx.caseStep.update({
    where: { id: step.id },
    data: {
      status: 'pending',
      dueAt: null,
      startedAt: null,
      completedAt: null,
      exitEvidence: toOperationalJson({
        previous: asRecord(step.exitEvidence),
        reopenedAt: ctx.now.toISOString(),
        reopenReason: reason,
      }),
      version: { increment: 1 },
    },
  });
  const items = await tx.workItem.findMany({
    where: { stepId: step.id, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
  });
  for (const item of items) await cancelWorkItemInTx(tx, item, { reason });
  ctx.emit(
    'step.reopened',
    {
      stepId: step.id,
      stepKey: step.stepKey,
      scopeKey: step.scopeKey,
      previousStatus: step.status,
      reason,
    },
    {
      caseId: step.caseId,
      areaKey: step.areaKey,
      objectType: CASE_STEP_OBJECT_TYPE,
      objectId: step.id,
    }
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Engine steps
// ---------------------------------------------------------------------------

interface EngineFailure {
  ok: false;
  code: string;
  message: string;
}

type EngineOutcome = { ok: true; evidence: Record<string, unknown> } | EngineFailure;

const engineFailure = (code: string, message: string): EngineFailure => ({
  ok: false,
  code,
  message,
});

const DELIVERABLE_ALLOCATION_STATUSES = ['ready', 'released', 'reopened'];

function neededByDay(run: AdvanceRun, allocation: DemandAllocation): string {
  const date =
    allocation.expectedAt ??
    run.state.opCase.promisedAt ??
    new Date(run.ctx.now.getTime() + 3 * DAY_MS);
  return isoDay(date);
}

function planEvidenceOf(state: CaseState, demandId: string): Record<string, unknown> {
  const step = state.steps.find((s) => s.stepKey === SALES_STEP.plan && s.demandId === demandId);
  return asRecord(asRecord(step?.exitEvidence).allocation_plan);
}

function allocationAndDemand(
  state: CaseState,
  step: CaseStep
): { allocation: DemandAllocation; demand: CaseDemand } | null {
  const allocation = state.allocations.find((a) => a.id === step.allocationId);
  const demand = allocation ? state.demands.find((d) => d.id === allocation.demandId) : undefined;
  return allocation && demand ? { allocation, demand } : null;
}

async function engineReserveStock(run: AdvanceRun, step: CaseStep): Promise<EngineOutcome> {
  const { tx, ctx, state } = run;
  const found = allocationAndDemand(state, step);
  if (!found) return engineFailure('not_found', 'La asignación ya no existe');
  const { allocation, demand } = found;
  if (!(await isOpsFlagEnabled('inventory'))) {
    return engineFailure('module_disabled', 'El inventario progresivo está desactivado');
  }
  if (!demand.zohoItemId) {
    return engineFailure(
      'no_item',
      'La partida no tiene artículo de Zoho; reserva la existencia manualmente'
    );
  }
  const warehouseId =
    allocation.warehouseId ?? (await warehouseFor(tx, demand.locationId, run.caches)).id;
  const allowProvisional =
    planEvidenceOf(state, demand.id).allowProvisional === true && ctx.actor.type === 'user';
  try {
    const reservation = await reserveStock(
      tx,
      {
        caseId: state.opCase.id,
        demandId: demand.id,
        allocationId: allocation.id,
        zohoItemId: demand.zohoItemId,
        warehouseId,
        variantKey: demand.variantKey,
        quantity: allocation.quantity,
        unit: demand.baseUnit,
        allowProvisional,
        note: `Reserva automática del ${state.opCase.caseNumber}`,
      },
      ctx
    );
    const claimed = await tx.demandAllocation.updateMany({
      where: { id: allocation.id, status: 'planned' },
      data: {
        status: 'reserved',
        stockReservationId: reservation.primaryReservationId,
        warehouseId,
        version: { increment: 1 },
      },
    });
    // Another run moved the allocation meanwhile: roll everything back and run again.
    if (claimed.count !== 1) throw new ConcurrencyConflict();
    const updated = await tx.demandAllocation.findUniqueOrThrow({ where: { id: allocation.id } });
    upsertById(state.allocations, updated);
    state.activeReservationAllocationIds.add(updated.id);
    const reservationIds = reservation.reservations.map((r) => r.id);
    ctx.emit(
      OPS_EVENTS.allocation.reserved,
      {
        allocationId: updated.id,
        demandId: demand.id,
        reservationIds,
        quantity: qtyText(reservation.quantityBase),
        unit: reservation.baseUnit,
        provisional: reservation.provisional,
        confidence: reservation.confidence,
      },
      {
        caseId: state.opCase.id,
        areaKey: 'inventario',
        objectType: 'demand_allocation',
        objectId: updated.id,
      }
    );
    return {
      ok: true,
      evidence: {
        stock_reservation: reservation.primaryReservationId,
        reservationIds,
        provisional: reservation.provisional,
        confidence: reservation.confidence,
      },
    };
  } catch (err) {
    if (isOperationsError(err)) return engineFailure(err.code, err.message);
    throw err;
  }
}

async function engineRequest(
  run: AdvanceRun,
  step: CaseStep,
  def: StepDef
): Promise<EngineOutcome> {
  const { ctx, state, tx } = run;
  const found = allocationAndDemand(state, step);
  if (!found) return engineFailure('not_found', 'La asignación ya no existe');
  const { allocation, demand } = found;
  const evidenceKey = def.exit.evidence[0] ?? 'request_ref';
  if (allocation.linkedType === 'area_request' && allocation.linkedId) {
    return { ok: true, evidence: { [evidenceKey]: allocation.linkedId } };
  }
  const quantity = num(allocation.quantity);
  const sku = (demand.sku || demand.zohoItemId || demand.lineRef).slice(0, 120);
  const caseLabel = [state.opCase.caseNumber, state.opCase.salesOrderNumber]
    .filter(Boolean)
    .join(' · ');
  const amount = `${qtyText(allocation.quantity)} ${demand.baseUnit} de ${demand.name}`;
  const neededBy = neededByDay(run, allocation);
  const shortfallPayload = {
    demandId: demand.id,
    allocationId: allocation.id,
    sku,
    productName: demand.name.slice(0, 300),
    missingQty: quantity,
    unit: demand.baseUnit,
    neededBy,
  };
  let spec: {
    kind: string;
    fromAreaKey: AreaKey;
    toAreaKey: AreaKey;
    title: string;
    payload: Record<string, unknown>;
    freeText?: string;
  };
  switch (def.engine) {
    case 'request_production':
      spec = {
        kind: 'transformation',
        fromAreaKey: 'inventario',
        toAreaKey: 'manufactura',
        title: `Producir ${amount} (${caseLabel})`,
        payload: {
          sourceSku: sku,
          targetSku: sku,
          qty: quantity,
          unit: demand.baseUnit,
          dueAt: neededBy,
          spec: `Surtir ${caseLabel}: ${demand.name}`.slice(0, 1000),
        },
      };
      break;
    case 'request_direct_delivery':
      spec = {
        kind: 'direct_delivery',
        fromAreaKey: 'inventario',
        toAreaKey: 'compras',
        title: `Entrega directa del proveedor: ${amount} (${caseLabel})`,
        payload: shortfallPayload,
        freeText:
          'El proveedor entrega directamente al cliente: confirma con él la fecha y los datos de entrega.',
      };
      break;
    default:
      spec = {
        kind: 'purchase_shortfall',
        fromAreaKey: 'inventario',
        toAreaKey: 'compras',
        title: `Comprar ${amount} (${caseLabel})`,
        payload: shortfallPayload,
      };
  }
  try {
    const { request, workItem } = await ctx.createAreaRequest({
      caseId: state.opCase.id,
      fromAreaKey: spec.fromAreaKey,
      toAreaKey: spec.toAreaKey,
      kind: spec.kind,
      objectType: 'demand_allocation',
      objectId: allocation.id,
      title: spec.title,
      payload: spec.payload,
      freeText: spec.freeText ?? null,
      slaMinutes: def.slaMinutes,
    });
    const updated = await tx.demandAllocation.update({
      where: { id: allocation.id },
      data: {
        status: 'requested',
        linkedType: 'area_request',
        linkedId: request.id,
        version: { increment: 1 },
      },
    });
    upsertById(state.allocations, updated);
    state.openRequests.push({
      id: request.id,
      status: request.status,
      kind: request.kind,
      objectType: request.objectType,
      objectId: request.objectId,
    });
    state.openWorkItems.push(workItem);
    ctx.emit(
      OPS_EVENTS.allocation.requested,
      {
        allocationId: updated.id,
        demandId: demand.id,
        source: updated.source,
        requestId: request.id,
        requestKind: request.kind,
        toAreaKey: request.toAreaKey,
        quantity: qtyText(updated.quantity),
        unit: demand.baseUnit,
      },
      {
        caseId: state.opCase.id,
        areaKey: request.toAreaKey,
        objectType: 'demand_allocation',
        objectId: updated.id,
      }
    );
    await ctx.relate(
      { type: 'demand_allocation', id: updated.id },
      { type: 'area_request', id: request.id },
      'requested_via'
    );
    return { ok: true, evidence: { [evidenceKey]: request.id, workItemId: workItem.id } };
  } catch (err) {
    if (isOperationsError(err)) return engineFailure(err.code, err.message);
    throw err;
  }
}

async function enginePlanDelivery(run: AdvanceRun): Promise<EngineOutcome> {
  const { tx, state } = run;
  if (!(await isOpsFlagEnabled('logistics'))) {
    return engineFailure('module_disabled', 'La logística está desactivada');
  }
  const busy = new Set(
    state.deliveryOrders
      .filter((order) => !['cancelled', 'delivered', 'partially_delivered'].includes(order.status))
      .flatMap((order) => order.allocationIds)
  );
  const eligible = state.allocations.filter(
    (allocation) =>
      allocation.source !== 'direct_supplier' &&
      DELIVERABLE_ALLOCATION_STATUSES.includes(allocation.status) &&
      !busy.has(allocation.id)
  );
  if (eligible.length === 0) {
    return engineFailure('nothing_ready', 'No hay material listo sin orden de entrega');
  }
  const so = state.salesOrder;
  const pickup = isCustomerPickup(state.opCase.deliveryMethod);
  // Plan §4: el método de entrega de Zoho decide cómo nace la entrega. Cuando
  // dice paquetería o transportista nace `carrier` (sin unidad ni chofer
  // nuestros); Logística puede cambiarlo al asignar transporte.
  const carrier = !pickup && isCarrierDelivery(state.opCase.deliveryMethod);
  const address = [so?.shippingAddressLine1, so?.shippingAddressLine2].filter(Boolean).join(', ');
  const input: CreateDeliveryOrderInput = {
    caseId: state.opCase.id,
    allocationIds: eligible.map((allocation) => allocation.id),
    mode: pickup ? 'customer_pickup' : carrier ? 'carrier' : 'own_fleet',
    addressLine: pickup ? null : truncate(address, 500),
    city: pickup ? null : truncate(so?.shippingCity, 120),
    state: pickup ? null : truncate(so?.shippingState, 120),
    postalCode: pickup ? null : truncate(so?.shippingPostalCode, 20),
    contactName: truncate(
      so?.shippingAttention ?? so?.customerName ?? state.opCase.customerName,
      200
    ),
    contactPhone: truncate(so?.shippingPhone ?? so?.customerPhone, 40),
  };
  try {
    const result = await createDeliveryOrder(tx, input);
    upsertById(state.deliveryOrders, result.deliveryOrder);
    if (result.workItemId) {
      const item = await tx.workItem.findUnique({ where: { id: result.workItemId } });
      if (item) state.openWorkItems.push(item);
    }
    return {
      ok: true,
      evidence: {
        delivery_order: result.deliveryOrder.id,
        packageLinked: result.packageLinked,
        packageRequestId: result.areaRequestId,
      },
    };
  } catch (err) {
    if (isOperationsError(err)) return engineFailure(err.code, err.message);
    throw err;
  }
}

async function runEngine(run: AdvanceRun, step: CaseStep, def: StepDef): Promise<EngineOutcome> {
  switch (def.engine) {
    case 'reserve_stock':
      return engineReserveStock(run, step);
    case 'request_purchase':
    case 'request_production':
    case 'request_direct_delivery':
      return engineRequest(run, step, def);
    case 'plan_delivery':
      return enginePlanDelivery(run);
    default:
      return engineFailure('unknown_engine', 'Paso automático desconocido');
  }
}

async function recordEngineFailure(
  run: AdvanceRun,
  step: CaseStep,
  failure: EngineFailure
): Promise<boolean> {
  const { tx, ctx } = run;
  run.result.engineFailures.push({
    step: stepRef(step.stepKey, step.scopeKey),
    code: failure.code,
    message: failure.message,
  });
  const evidence = asRecord(step.exitEvidence);
  const previous = asRecord(evidence.engine);
  if (previous.code === failure.code && previous.message === failure.message) return false;
  const updated = await tx.caseStep.update({
    where: { id: step.id },
    data: {
      exitEvidence: toOperationalJson({
        ...evidence,
        engine: { code: failure.code, message: failure.message, at: ctx.now.toISOString() },
      }),
      version: { increment: 1 },
    },
  });
  replaceStep(run, updated);
  ctx.emit(
    'step.engine_failed',
    {
      stepId: step.id,
      stepKey: step.stepKey,
      scopeKey: step.scopeKey,
      code: failure.code,
      message: failure.message,
    },
    {
      caseId: step.caseId,
      areaKey: step.areaKey,
      objectType: CASE_STEP_OBJECT_TYPE,
      objectId: step.id,
    }
  );
  log('engine_step_failed', {
    caseId: step.caseId,
    stepKey: step.stepKey,
    scopeKey: step.scopeKey,
    code: failure.code,
    commandId: ctx.commandId,
  });
  return true;
}

/**
 * Takes an allocation nothing was committed for back to the plan of its demand:
 * the allocation is cancelled (its steps and work items follow) and
 * `plan_abastecimiento` reopens, so Ventas decides another source instead of
 * leaving the case stuck on something that cannot happen (stock taken by
 * another order, a unit without conversion, a request the area rejected).
 */
async function replanAllocation(
  run: AdvanceRun,
  allocationId: string,
  reason: string
): Promise<boolean> {
  const { tx, ctx, state } = run;
  const allocation = state.allocations.find((a) => a.id === allocationId);
  if (!allocation || !REPLANNABLE_ALLOCATION_STATUSES.includes(allocation.status)) return false;
  if (state.activeReservationAllocationIds.has(allocation.id)) return false;
  const demand = state.demands.find((d) => d.id === allocation.demandId);
  if (!demand || demand.status === 'cancelled' || demand.status === 'fulfilled') return false;
  const cancelled = await updateAllocation(run, allocation, { status: 'cancelled' });
  emitAllocation(run, OPS_EVENTS.allocation.cancelled, cancelled, { reason, replan: true });
  const planStep = state.steps.find(
    (s) => s.stepKey === SALES_STEP.plan && s.demandId === demand.id
  );
  if (planStep && planStep.status === 'done') {
    replaceStep(run, await reopenStep(tx, planStep, reason));
  }
  if (demand.status === 'allocated') {
    upsertById(
      state.demands,
      await tx.caseDemand.update({
        where: { id: demand.id },
        data: { status: 'planned', version: { increment: 1 } },
      })
    );
  }
  run.caches.replannedDemands.add(demand.id);
  log('allocation_replanned', {
    caseId: state.opCase.id,
    allocationId: allocation.id,
    demandId: demand.id,
    reason,
    commandId: ctx.commandId,
  });
  return true;
}

/** Allocations whose purchase/production/direct request was rejected, cancelled or expired. */
async function replanDeadRequests(run: AdvanceRun): Promise<boolean> {
  const { tx, state } = run;
  const openIds = new Set(state.openRequests.map((request) => request.id));
  const candidates = state.allocations.filter(
    (a) =>
      a.linkedType === 'area_request' &&
      a.linkedId &&
      !openIds.has(a.linkedId) &&
      REPLANNABLE_ALLOCATION_STATUSES.includes(a.status)
  );
  if (candidates.length === 0) return false;
  const requests = await tx.areaRequest.findMany({
    where: { id: { in: candidates.map((a) => a.linkedId!) } },
    select: { id: true, status: true },
  });
  const dead = new Map(
    requests
      .filter((request) => DEAD_REQUEST_STATUSES.includes(request.status))
      .map((request) => [request.id, request.status])
  );
  let changed = false;
  for (const allocation of candidates) {
    const status = dead.get(allocation.linkedId!);
    if (!status) continue;
    const reason =
      status === 'rejected'
        ? 'El área rechazó la solicitud: hay que elegir otra fuente'
        : 'La solicitud se canceló o venció: hay que elegir otra fuente';
    changed = (await replanAllocation(run, allocation.id, reason)) || changed;
  }
  return changed;
}

/**
 * Demands created while their unit had no conversion keep the line unit. Once
 * the item's profile converts it, and nothing was allocated in the old unit,
 * the base quantity is recomputed so plans and reservations use the base unit.
 */
async function refreshDemandUnits(run: AdvanceRun): Promise<boolean> {
  const { tx, ctx, state } = run;
  let changed = false;
  for (const demand of [...state.demands]) {
    if (!demand.zohoItemId || !['pending', 'verifying', 'planned'].includes(demand.status))
      continue;
    if (activeAllocationsOf(state, demand.id).length > 0) continue;
    let profileUnit = run.caches.profileUnits.get(demand.zohoItemId);
    if (profileUnit === undefined) {
      const profile = await tx.productInventoryProfile.findUnique({
        where: { zohoItemId: demand.zohoItemId },
        select: { baseUnit: true },
      });
      profileUnit = profile ? normalizeUnit(profile.baseUnit) || DEFAULT_BASE_UNIT : null;
      run.caches.profileUnits.set(demand.zohoItemId, profileUnit);
    }
    if (!profileUnit || profileUnit === normalizeUnit(demand.baseUnit)) continue;
    const resolved = await resolveDemandQuantity(
      tx,
      demand.zohoItemId,
      demand.quantity,
      demand.unit
    );
    if (!resolved.unitResolved || resolved.baseUnit === demand.baseUnit) continue;
    const updated = await tx.caseDemand.update({
      where: { id: demand.id },
      data: {
        baseQuantity: resolved.baseQuantity,
        baseUnit: resolved.baseUnit,
        version: { increment: 1 },
      },
    });
    upsertById(state.demands, updated);
    run.caches.unitMismatch.delete(demand.id);
    ctx.emit(
      OPS_EVENTS.demand.changed,
      {
        demandId: demand.id,
        reason: 'unit_resolved',
        previousBaseQuantity: qtyText(demand.baseQuantity),
        previousBaseUnit: demand.baseUnit,
        baseQuantity: qtyText(updated.baseQuantity),
        baseUnit: updated.baseUnit,
      },
      {
        caseId: demand.caseId,
        areaKey: 'inventario',
        objectType: 'case_demand',
        objectId: demand.id,
      }
    );
    changed = true;
  }
  return changed;
}

/** After a replan in this run, the plan of that demand waits for a person instead of repeating what failed. */
function autoCompleteHeld(run: AdvanceRun, step: CaseStep, def: StepDef): boolean {
  if (def.key !== SALES_STEP.plan || !step.demandId) return false;
  if (!run.caches.replannedDemands.has(step.demandId)) return false;
  const demand = facts(run).demands.find((d) => d.id === step.demandId);
  return Boolean(demand && uncoveredQuantity(demand) > QTY_EPSILON);
}

/**
 * Warehouse allocations that cannot be prepared yet: stock without an active
 * reservation, purchases or productions not received. Planned, requested and
 * in-progress material never counts as ready.
 */
export function preparationBlockers(
  allocations: ReadonlyArray<Pick<DemandAllocation, 'id' | 'source' | 'status'>>,
  reservedAllocationIds: ReadonlySet<string>
): string[] {
  return allocations
    .filter((allocation) => {
      if (allocation.source === 'direct_supplier') return false;
      if (['ready', 'released', 'delivered', 'cancelled'].includes(allocation.status)) return false;
      if (!reservedAllocationIds.has(allocation.id)) return true;
      return !(allocation.source === 'stock' || allocation.status === 'reopened');
    })
    .map((allocation) => allocation.id);
}

function preparationPendingError(state: CaseState, blockers: string[]): OperationsError {
  const labels = blockers.map((id) => {
    const allocation = state.allocations.find((a) => a.id === id);
    const demand = allocation ? state.demands.find((d) => d.id === allocation.demandId) : null;
    if (!allocation || !demand) return id;
    const what = allocation.source === 'stock' ? 'sin reservar' : 'sin recibir';
    return `${qtyText(allocation.quantity)} ${demand.baseUnit} de ${demand.name} (${what})`;
  });
  return new OperationsError(
    'step_condition_pending',
    `Todavía no se puede preparar el pedido: ${labels.slice(0, 3).join('; ')}${labels.length > 3 ? '…' : ''}`,
    { httpStatus: 409, details: { stepKey: SALES_STEP.prepare, allocationIds: blockers } }
  );
}

function evidenceMovementIds(value: unknown): string[] {
  const one = (entry: unknown): string[] => {
    if (typeof entry === 'string') return entry.split(/[\s,]+/);
    const record = asRecord(entry);
    if (typeof record.movementId === 'string') return [record.movementId];
    if (Array.isArray(record.movementIds)) return record.movementIds.flatMap(one);
    return [];
  };
  const list = Array.isArray(value) ? value.flatMap(one) : one(value);
  return [...new Set(list.map((id) => id.trim()).filter(Boolean))];
}

/**
 * Validates the evidence of an awaited receipt/production (the movements that
 * brought the material in, of the item, warehouse and quantity of the
 * allocation). Null when the step needs no movement (not a receipt step, a
 * direct supplier allocation, or material already reserved).
 */
async function receiptEvidence(
  tx: Db,
  state: CaseState,
  step: CaseStep,
  def: StepDef,
  evidence: Record<string, unknown>
): Promise<{ demand: CaseDemand; movementIds: string[]; warehouseId: string } | null> {
  const receipt = RECEIPT_EVIDENCE[def.key];
  if (!receipt) return null;
  const allocation = state.allocations.find((a) => a.id === step.allocationId);
  const demand = allocation ? state.demands.find((d) => d.id === allocation.demandId) : undefined;
  if (!allocation || !demand?.zohoItemId || allocation.source === 'direct_supplier') return null;
  if (state.activeReservationAllocationIds.has(allocation.id)) return null;
  const units = toUnitProfile(await getOrCreateProfile(tx, demand.zohoItemId));
  let needed: Prisma.Decimal;
  try {
    needed = toBase(allocation.quantity, demand.baseUnit || units.baseUnit, units);
  } catch (err) {
    if (!(err instanceof StockMathError)) throw err;
    throw new OperationsError(
      'invalid_unit',
      `La partida está en ${demand.baseUnit} y el artículo se controla en ${units.baseUnit}; registra la conversión`
    );
  }
  const checked = await assertReceiptMovements(tx, {
    movementIds: evidenceMovementIds(evidence[receipt.key]),
    kinds: receipt.kinds,
    zohoItemId: demand.zohoItemId,
    warehouseId: allocation.warehouseId,
    minQuantity: needed,
  });
  return { demand, movementIds: checked.movementIds, warehouseId: checked.warehouseId };
}

/**
 * While Zoho has not confirmed the shipment the work item of `asignar_transporte`
 * waits too (until `externalSyncStaleMinutes`, when the stale-sync rule of the
 * supervisor takes over), so the escalation ladder does not pile up critical
 * incidents for every case while Zoho is down. When the wait ends it is open
 * again with a fresh due date.
 */
async function syncTransportWorkItems(
  run: AdvanceRun,
  step: CaseStep,
  def: StepDef
): Promise<boolean> {
  const { tx, ctx } = run;
  const items = run.state.openWorkItems.filter((item) => item.stepId === step.id);
  if (items.length === 0) return false;
  let changed = false;
  if (step.status === 'waiting') {
    const minutes = (await getOperationsConfig()).externalSyncStaleMinutes;
    const until = new Date(ctx.now.getTime() + minutes * 60_000);
    for (const item of items) {
      if (!['open', 'in_progress', 'escalated'].includes(item.status)) continue;
      const held = await tx.workItem.update({
        where: { id: item.id },
        data: {
          status: 'waiting',
          waitReason: TRANSPORT_WAIT_REASON,
          waitUntil: until,
          dueAt: new Date(until.getTime() + def.slaMinutes * 60_000),
          version: { increment: 1 },
        },
      });
      upsertById(run.state.openWorkItems, held);
      ctx.emit(
        OPS_EVENTS.workitem.waiting,
        {
          workItemId: held.id,
          previousStatus: item.status,
          reason: TRANSPORT_WAIT_REASON,
          waitUntil: until.toISOString(),
        },
        { caseId: held.caseId, areaKey: held.areaKey, objectType: 'work_item', objectId: held.id }
      );
      changed = true;
    }
    return changed;
  }
  for (const item of items) {
    if (item.status !== 'waiting' || item.waitReason !== TRANSPORT_WAIT_REASON) continue;
    const resumed = await tx.workItem.update({
      where: { id: item.id },
      data: {
        status: 'open',
        waitReason: null,
        waitUntil: null,
        dueAt: new Date(ctx.now.getTime() + def.slaMinutes * 60_000),
        version: { increment: 1 },
      },
    });
    upsertById(run.state.openWorkItems, resumed);
    ctx.emit(
      'workitem.resumed',
      { workItemId: resumed.id, reason: 'zoho_wait_over', dueAt: resumed.dueAt.toISOString() },
      {
        caseId: resumed.caseId,
        areaKey: resumed.areaKey,
        objectType: 'work_item',
        objectId: resumed.id,
      }
    );
    changed = true;
  }
  return changed;
}

/** Transport waits while Zoho has not confirmed the shipment write. */
async function syncTransportWaiting(
  run: AdvanceRun,
  step: CaseStep,
  def: StepDef
): Promise<boolean> {
  const { tx, ctx } = run;
  const pending = run.state.deliveryOrders.some(
    (order) =>
      order.status !== 'cancelled' &&
      (order.status === 'pending_external' ||
        ['pending_write', 'written'].includes(order.zohoSyncState))
  );
  if (pending && step.status !== 'waiting') {
    const updated = await tx.caseStep.update({
      where: { id: step.id },
      data: { status: 'waiting', version: { increment: 1 } },
    });
    replaceStep(run, updated);
    ctx.emit(
      OPS_EVENTS.step.waiting,
      { stepId: step.id, stepKey: step.stepKey, scopeKey: step.scopeKey, reason: 'zoho_pending' },
      {
        caseId: step.caseId,
        areaKey: def.areaKey,
        objectType: CASE_STEP_OBJECT_TYPE,
        objectId: step.id,
      }
    );
    return true;
  }
  if (!pending && step.status === 'waiting') {
    const started = run.state.openWorkItems.some(
      (item) => item.stepId === step.id && item.status === 'in_progress'
    );
    const updated = await tx.caseStep.update({
      where: { id: step.id },
      data: { status: started ? 'active' : 'ready', version: { increment: 1 } },
    });
    replaceStep(run, updated);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export type StepCompletionSource = 'auto' | 'engine' | 'work_item' | 'manual';

interface CompletionInput {
  evidence: Record<string, unknown>;
  source: StepCompletionSource;
  workItemId?: string | null;
}

/** `allocation_plan` result → decision (`true`/`"aceptar"` accept the proposal). */
export function parseAllocationDecision(
  value: unknown
): { ok: true; decision: AllocationDecision | undefined } | { ok: false; message: string } {
  if (value === true || value === 'accept' || value === 'aceptar') {
    return { ok: true, decision: { acceptProposal: true } };
  }
  const record = asRecord(value);
  if (record.auto === true) return { ok: true, decision: undefined };
  const parsed = allocationDecisionSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) =>
        issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
      )
      .join('; ');
    return { ok: false, message: `El plan de abastecimiento es inválido: ${detail}` };
  }
  return { ok: true, decision: parsed.data };
}

async function computePlan(
  tx: Db,
  ctx: CommandContext,
  state: CaseState,
  demand: CaseDemand,
  decision: AllocationDecision | undefined,
  availability: AvailabilityFacts | null,
  humanDecision: boolean
): Promise<AllocationPlanResult> {
  const profile = demand.zohoItemId
    ? await tx.productInventoryProfile.findUnique({
        where: { zohoItemId: demand.zohoItemId },
        select: { defaultSource: true },
      })
    : null;
  const config = await getOperationsConfig();
  const allocated = activeAllocationsOf(state, demand.id).reduce(
    (sum, allocation) => sum.plus(allocation.quantity),
    new Prisma.Decimal(0)
  );
  return planAllocations(
    { baseQuantity: demand.baseQuantity, allocatedQuantity: allocated },
    availability
      ? {
          confidence: availability.confidence,
          available: availability.available,
          lastVerifiedAt: availability.lastVerifiedAt
            ? new Date(availability.lastVerifiedAt)
            : null,
        }
      : null,
    profile,
    decision,
    { now: ctx.now, provisionalMaxHours: config.provisionalVerificationMaxHours, humanDecision }
  );
}

type EffectResult = { structural: boolean; evidence: Record<string, unknown> };
const NO_EFFECT: EffectResult = { structural: false, evidence: {} };

async function updateAllocation(
  run: AdvanceRun,
  allocation: DemandAllocation,
  data: Prisma.DemandAllocationUpdateInput
): Promise<DemandAllocation> {
  const updated = await run.tx.demandAllocation.update({
    where: { id: allocation.id },
    data: { ...data, version: { increment: 1 } },
  });
  upsertById(run.state.allocations, updated);
  return updated;
}

function emitAllocation(
  run: AdvanceRun,
  type: string,
  allocation: DemandAllocation,
  extra: Record<string, unknown> = {}
): void {
  run.ctx.emit(
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
      areaKey:
        allocation.source === 'manufacture'
          ? 'manufactura'
          : allocation.source === 'stock'
            ? 'inventario'
            : 'compras',
      objectType: 'demand_allocation',
      objectId: allocation.id,
    }
  );
}

async function effectVerified(
  run: AdvanceRun,
  step: CaseStep,
  input: CompletionInput
): Promise<EffectResult> {
  const demand = run.state.demands.find((d) => d.id === step.demandId);
  if (!demand) return NO_EFFECT;
  if (demand.status === 'pending' || demand.status === 'verifying') {
    upsertById(
      run.state.demands,
      await run.tx.caseDemand.update({
        where: { id: demand.id },
        data: { status: 'planned', version: { increment: 1 } },
      })
    );
  }
  const availability = run.availability.get(demand.id) ?? null;
  const evidence =
    input.source === 'auto'
      ? {
          availability_result: {
            auto: true,
            confidence: availability?.confidence ?? null,
            available: availability?.available ?? null,
            quantity: num(demand.baseQuantity),
            unit: demand.baseUnit,
          },
        }
      : {};
  run.ctx.emit(
    OPS_EVENTS.demand.verified,
    {
      demandId: demand.id,
      source: input.source,
      confidence: availability?.confidence ?? null,
      available: availability?.available ?? null,
      quantity: qtyText(demand.baseQuantity),
      unit: demand.baseUnit,
    },
    { caseId: demand.caseId, areaKey: 'inventario', objectType: 'case_demand', objectId: demand.id }
  );
  return { structural: false, evidence };
}

async function effectPlanned(
  run: AdvanceRun,
  step: CaseStep,
  input: CompletionInput
): Promise<EffectResult> {
  const { tx, ctx, state } = run;
  const demand = state.demands.find((d) => d.id === step.demandId);
  if (!demand) return NO_EFFECT;
  const parsed =
    input.source === 'auto'
      ? { ok: true as const, decision: undefined }
      : parseAllocationDecision(input.evidence.allocation_plan);
  if (!parsed.ok) throw new OperationsError('invalid_payload', parsed.message);
  const availability = run.availability.has(demand.id)
    ? (run.availability.get(demand.id) ?? null)
    : await demandAvailability(tx, state, demand, run.caches);
  const humanDecision = input.source === 'work_item' && ctx.actor.type === 'user';
  const plan = await computePlan(
    tx,
    ctx,
    state,
    demand,
    parsed.decision,
    availability,
    humanDecision
  );
  if (!plan.ok) throw new OperationsError(plan.code, plan.message, { httpStatus: 409 });

  const needsWarehouse = plan.lines.some((line) => line.source !== 'direct_supplier');
  const warehouse = needsWarehouse ? await warehouseFor(tx, demand.locationId, run.caches) : null;
  const created: DemandAllocation[] = [];
  for (const line of plan.lines) {
    const allocation = await tx.demandAllocation.create({
      data: {
        demandId: demand.id,
        caseId: demand.caseId,
        source: line.source,
        quantity: line.quantity,
        status: 'planned',
        warehouseId: line.source === 'direct_supplier' ? null : (warehouse?.id ?? null),
        expectedAt: line.expectedAt,
      },
    });
    upsertById(state.allocations, allocation);
    created.push(allocation);
    emitAllocation(run, OPS_EVENTS.allocation.planned, allocation, {
      unit: demand.baseUnit,
      provisional: line.source === 'stock' && plan.provisional,
      expectedAt: allocation.expectedAt?.toISOString() ?? null,
    });
    await ctx.relate(
      { type: 'demand_allocation', id: allocation.id },
      { type: 'case_demand', id: demand.id },
      'allocates'
    );
  }
  upsertById(
    state.demands,
    await tx.caseDemand.update({
      where: { id: demand.id },
      data: { status: 'allocated', version: { increment: 1 } },
    })
  );
  const lines = plan.lines.map((line) => ({
    source: line.source,
    quantity: qtyText(line.quantity),
    expectedAt: line.expectedAt?.toISOString() ?? null,
  }));
  ctx.emit(
    OPS_EVENTS.demand.allocated,
    {
      demandId: demand.id,
      lines,
      unit: demand.baseUnit,
      auto: input.source === 'auto',
      provisional: plan.provisional,
      coveredByControlledStock: plan.coveredByControlledStock,
    },
    { caseId: demand.caseId, areaKey: 'ventas', objectType: 'case_demand', objectId: demand.id }
  );
  if (plan.shortfall.gt(0)) {
    ctx.emit(
      OPS_EVENTS.demand.shortfallConfirmed,
      {
        demandId: demand.id,
        shortfall: qtyText(plan.shortfall),
        unit: demand.baseUnit,
        source: plan.lines.find((line) => line.source !== 'stock')?.source ?? plan.remainderSource,
      },
      { caseId: demand.caseId, areaKey: 'ventas', objectType: 'case_demand', objectId: demand.id }
    );
  }
  return {
    structural: created.length > 0,
    evidence: {
      allocation_plan: {
        lines,
        auto: input.source === 'auto',
        allowProvisional: parsed.decision?.allowProvisional === true,
        note: parsed.decision?.note ?? null,
      },
    },
  };
}

async function effectReserved(run: AdvanceRun, step: CaseStep): Promise<EffectResult> {
  const allocation = run.state.allocations.find((a) => a.id === step.allocationId);
  if (!allocation || allocation.status !== 'planned') return NO_EFFECT;
  const reservation = await run.tx.stockReservation.findFirst({
    where: { allocationId: allocation.id, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  if (!reservation) return NO_EFFECT;
  const updated = await updateAllocation(run, allocation, {
    status: 'reserved',
    stockReservationId: reservation.id,
    warehouseId: allocation.warehouseId ?? reservation.warehouseId,
  });
  emitAllocation(run, OPS_EVENTS.allocation.reserved, updated, {
    reservationIds: [reservation.id],
  });
  return { structural: false, evidence: { stock_reservation: reservation.id } };
}

async function effectRequested(run: AdvanceRun, step: CaseStep): Promise<EffectResult> {
  const allocation = run.state.allocations.find((a) => a.id === step.allocationId);
  if (!allocation || allocation.status !== 'planned' || !allocation.linkedId) return NO_EFFECT;
  const updated = await updateAllocation(run, allocation, { status: 'requested' });
  emitAllocation(run, OPS_EVENTS.allocation.requested, updated, { requestId: allocation.linkedId });
  return NO_EFFECT;
}

async function effectMaterialReady(
  run: AdvanceRun,
  step: CaseStep,
  def: StepDef,
  input: CompletionInput
): Promise<EffectResult> {
  const allocation = run.state.allocations.find((a) => a.id === step.allocationId);
  if (!allocation) return NO_EFFECT;
  let backing: { stockReservationId: string; warehouseId: string } | null = null;
  if (input.source !== 'auto') {
    // Completed by a person: the material must be in, and it is reserved for this
    // allocation right away (never "ready" on a promise, always consumed at delivery).
    const receipt = await receiptEvidence(run.tx, run.state, step, def, input.evidence);
    if (receipt) {
      const reservation = await reserveStock(
        run.tx,
        {
          caseId: receipt.demand.caseId,
          demandId: receipt.demand.id,
          allocationId: allocation.id,
          zohoItemId: receipt.demand.zohoItemId!,
          warehouseId: receipt.warehouseId,
          variantKey: receipt.demand.variantKey,
          quantity: allocation.quantity,
          unit: receipt.demand.baseUnit,
          receiptMovementIds: receipt.movementIds,
          note: `Material recibido para ${run.state.opCase.caseNumber}`,
        },
        run.ctx
      );
      backing = {
        stockReservationId: reservation.primaryReservationId,
        warehouseId: receipt.warehouseId,
      };
      run.state.activeReservationAllocationIds.add(allocation.id);
    }
  }
  if (['planned', 'requested', 'in_progress', 'reserved'].includes(allocation.status)) {
    const updated = await updateAllocation(run, allocation, {
      status: 'ready',
      readyAt: allocation.readyAt ?? run.ctx.now,
      ...(backing ?? {}),
    });
    emitAllocation(run, OPS_EVENTS.allocation.ready, updated);
  } else if (!allocation.readyAt || backing) {
    await updateAllocation(run, allocation, {
      readyAt: allocation.readyAt ?? run.ctx.now,
      ...(backing ?? {}),
    });
  }
  return backing
    ? { structural: false, evidence: { stock_reservation: backing.stockReservationId } }
    : NO_EFFECT;
}

async function effectDirectDelivered(
  run: AdvanceRun,
  step: CaseStep,
  input: CompletionInput
): Promise<EffectResult> {
  const { tx, ctx, state } = run;
  const allocation = state.allocations.find((a) => a.id === step.allocationId);
  if (!allocation) return NO_EFFECT;
  const demand = state.demands.find((d) => d.id === allocation.demandId);
  if (allocation.status !== 'delivered') {
    const delta = Prisma.Decimal.max(
      dec(allocation.quantity).minus(allocation.deliveredQuantity),
      0
    );
    const updated = await updateAllocation(run, allocation, {
      status: 'delivered',
      deliveredQuantity: allocation.quantity,
      readyAt: allocation.readyAt ?? ctx.now,
    });
    emitAllocation(run, OPS_EVENTS.allocation.delivered, updated, { direct: true });
    if (demand && demand.status !== 'fulfilled' && demand.status !== 'cancelled') {
      const fulfilled = Prisma.Decimal.min(
        dec(demand.fulfilledQuantity).plus(delta),
        demand.baseQuantity
      );
      const complete = fulfilled.plus(QTY_EPSILON).gte(demand.baseQuantity);
      upsertById(
        state.demands,
        await tx.caseDemand.update({
          where: { id: demand.id },
          data: {
            fulfilledQuantity: fulfilled,
            ...(complete ? { status: 'fulfilled' } : {}),
            version: { increment: 1 },
          },
        })
      );
      if (complete) {
        ctx.emit(
          OPS_EVENTS.demand.fulfilled,
          { demandId: demand.id, fulfilledQuantity: qtyText(fulfilled), direct: true },
          {
            caseId: demand.caseId,
            areaKey: 'logistica',
            objectType: 'case_demand',
            objectId: demand.id,
          }
        );
      }
    }
  }
  if (input.source !== 'auto') {
    ctx.emit(
      OPS_EVENTS.delivery.confirmed,
      {
        allocationId: allocation.id,
        demandId: allocation.demandId,
        direct: true,
        source: input.source,
      },
      {
        caseId: allocation.caseId,
        areaKey: 'logistica',
        objectType: 'demand_allocation',
        objectId: allocation.id,
      }
    );
  }
  return NO_EFFECT;
}

async function effectPrepared(run: AdvanceRun): Promise<EffectResult> {
  const blockers = preparationBlockers(
    run.state.allocations,
    run.state.activeReservationAllocationIds
  );
  if (blockers.length > 0) throw preparationPendingError(run.state, blockers);
  const prepared: string[] = [];
  for (const allocation of [...run.state.allocations]) {
    if (allocation.source === 'direct_supplier' || allocation.status === 'cancelled') continue;
    if (allocation.status === 'reserved') {
      const updated = await updateAllocation(run, allocation, {
        status: 'ready',
        readyAt: allocation.readyAt ?? run.ctx.now,
      });
      emitAllocation(run, OPS_EVENTS.allocation.ready, updated, { prepared: true });
    }
    if (allocation.status !== 'delivered') prepared.push(allocation.id);
  }
  run.ctx.emit(
    OPS_EVENTS.order.prepared,
    { allocationIds: prepared },
    {
      caseId: run.state.opCase.id,
      areaKey: 'inventario',
      objectType: CASE_AGGREGATE_TYPE,
      objectId: run.state.opCase.id,
    }
  );
  return NO_EFFECT;
}

function emitCaseFact(run: AdvanceRun, type: string, areaKey: AreaKey): void {
  run.ctx.emit(
    type,
    { caseId: run.state.opCase.id, caseNumber: run.state.opCase.caseNumber },
    {
      caseId: run.state.opCase.id,
      areaKey,
      objectType: CASE_AGGREGATE_TYPE,
      objectId: run.state.opCase.id,
    }
  );
}

async function applyCompletionEffects(
  run: AdvanceRun,
  step: CaseStep,
  def: StepDef,
  input: CompletionInput
): Promise<EffectResult> {
  switch (def.key) {
    case SALES_STEP.verify:
      return effectVerified(run, step, input);
    case SALES_STEP.plan:
      return effectPlanned(run, step, input);
    case SALES_STEP.reserve:
      return effectReserved(run, step);
    case SALES_STEP.requestPurchase:
    case SALES_STEP.orderProduction:
    case SALES_STEP.coordinateDirect:
      return effectRequested(run, step);
    case SALES_STEP.awaitReceipt:
    case SALES_STEP.awaitProduction:
      return effectMaterialReady(run, step, def, input);
    case SALES_STEP.confirmDirect:
      return effectDirectDelivered(run, step, input);
    case SALES_STEP.prepare:
      return effectPrepared(run);
    case SALES_STEP.deliver:
      emitCaseFact(run, OPS_EVENTS.case.delivered, 'logistica');
      return NO_EFFECT;
    case SALES_STEP.operationalClose:
      emitCaseFact(run, OPS_EVENTS.case.operationalClosed, 'ventas');
      return NO_EFFECT;
    case SALES_STEP.financialClose:
      emitCaseFact(run, OPS_EVENTS.case.financialClosed, 'contabilidad');
      return NO_EFFECT;
    default:
      return NO_EFFECT;
  }
}

async function completeStepInRun(
  run: AdvanceRun,
  step: CaseStep,
  def: StepDef,
  input: CompletionInput
): Promise<{ completed: boolean; structural: boolean }> {
  const { tx, ctx } = run;
  const fresh = await tx.caseStep.findUnique({ where: { id: step.id } });
  if (!fresh || !isOpenStep(fresh.status)) return { completed: false, structural: false };
  const effect = await applyCompletionEffects(run, fresh, def, input);
  const evidence = {
    ...asRecord(fresh.exitEvidence),
    ...input.evidence,
    ...effect.evidence,
  };
  const updated = await tx.caseStep.update({
    where: { id: fresh.id },
    data: {
      status: 'done',
      startedAt: fresh.startedAt ?? ctx.now,
      completedAt: ctx.now,
      exitEvidence: toOperationalJson(evidence),
      version: { increment: 1 },
    },
  });
  replaceStep(run, updated);
  run.result.completedSteps.push(stepRef(fresh.stepKey, fresh.scopeKey));
  ctx.emit(
    OPS_EVENTS.step.completed,
    {
      stepId: fresh.id,
      stepKey: fresh.stepKey,
      scopeKey: fresh.scopeKey,
      exitEventType: def.exit.eventType,
      source: input.source,
      workItemId: input.workItemId ?? null,
      evidenceKeys: Object.keys(input.evidence),
    },
    {
      caseId: fresh.caseId,
      areaKey: def.areaKey,
      objectType: CASE_STEP_OBJECT_TYPE,
      objectId: fresh.id,
    }
  );
  for (const item of run.state.openWorkItems.filter((w) => w.stepId === fresh.id)) {
    if (item.id === input.workItemId) continue;
    const current = await tx.workItem.findUnique({ where: { id: item.id } });
    if (current && (WORK_ITEM_OPEN_STATUSES as readonly string[]).includes(current.status)) {
      await completeWorkItemInTx(tx, current, {
        result: { stepCompleted: true, completionSource: input.source },
        skipEvidenceCheck: true,
      });
    }
  }
  run.state.openWorkItems = run.state.openWorkItems.filter((w) => w.stepId !== fresh.id);
  return { completed: true, structural: effect.structural };
}

// ---------------------------------------------------------------------------
// Step synchronization
// ---------------------------------------------------------------------------

function rebuildStatusByRef(run: AdvanceRun): void {
  run.statusByRef = new Map(run.state.steps.map((s) => [stepRef(s.stepKey, s.scopeKey), s.status]));
}

async function syncCaseSteps(run: AdvanceRun): Promise<boolean> {
  const { tx, ctx, state, blueprint } = run;
  const instances = instantiateSteps(blueprint, {
    demands: state.demands.map((d) => ({ id: d.id, status: d.status })),
    allocations: state.allocations.map((a) => ({
      id: a.id,
      demandId: a.demandId,
      source: a.source,
      status: a.status,
    })),
  });
  const byRef = new Map(
    instances.map((instance) => [stepRef(instance.stepKey, instance.scopeKey), instance])
  );
  const existing = new Set(state.steps.map((s) => stepRef(s.stepKey, s.scopeKey)));
  let changed = false;

  const missing = instances.filter(
    (instance) => !existing.has(stepRef(instance.stepKey, instance.scopeKey))
  );
  if (missing.length > 0) {
    await tx.caseStep.createMany({
      data: missing.map((instance) => ({
        caseId: state.opCase.id,
        processVersionId: state.opCase.processVersionId,
        stepKey: instance.stepKey,
        scope: instance.scope,
        scopeKey: instance.scopeKey,
        demandId: instance.demandId,
        allocationId: instance.allocationId,
        areaKey: instance.areaKey,
        kind: instance.kind,
        status: 'pending',
        dependsOn: instance.dependsOn,
        slaMinutes: instance.slaMinutes,
      })),
      skipDuplicates: true,
    });
    state.steps = await tx.caseStep.findMany({ where: { caseId: state.opCase.id } });
    rebuildStatusByRef(run);
    changed = true;
  }

  for (const step of [...state.steps]) {
    const ref = stepRef(step.stepKey, step.scopeKey);
    const instance = byRef.get(ref);
    if (!instance) {
      if (step.status === 'pending' || isOpenStep(step.status)) {
        replaceStep(
          run,
          await cancelStepInTx(tx, ctx, step, 'La partida o la asignación ya no aplica')
        );
        state.openWorkItems = state.openWorkItems.filter((w) => w.stepId !== step.id);
        changed = true;
      }
      continue;
    }
    // Steps not finished take the new dependencies; an open step whose new
    // dependencies are not satisfied is reverted by `progressStep`, in
    // dependency order, so it is not churned when they complete in the same pass.
    if (
      (step.status === 'pending' || isOpenStep(step.status)) &&
      !sameDependencies(step.dependsOn, instance.dependsOn)
    ) {
      const updated = await tx.caseStep.update({
        where: { id: step.id },
        data: { dependsOn: instance.dependsOn, version: { increment: 1 } },
      });
      replaceStep(run, updated);
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// advanceCase
// ---------------------------------------------------------------------------

function autoEvidence(def: StepDef): Record<string, unknown> {
  return { autoCompleted: def.autoComplete ?? true };
}

async function progressOpenStep(
  run: AdvanceRun,
  step: CaseStep,
  def: StepDef,
  justReady: boolean
): Promise<{ changed: boolean; structural: boolean }> {
  if (
    def.autoComplete &&
    !autoCompleteHeld(run, step, def) &&
    evaluateCondition(def.autoComplete, facts(run), scopeOf(step))
  ) {
    const outcome = await completeStepInRun(run, step, def, {
      evidence: autoEvidence(def),
      source: 'auto',
    });
    return { changed: justReady || outcome.completed, structural: outcome.structural };
  }
  if (def.engine) {
    const outcome = await runEngine(run, step, def);
    const current = run.state.steps.find((s) => s.id === step.id) ?? step;
    if (outcome.ok) {
      const completion = await completeStepInRun(run, current, def, {
        evidence: outcome.evidence,
        source: 'engine',
      });
      return { changed: true, structural: completion.structural };
    }
    const recorded = await recordEngineFailure(run, current, outcome);
    if (
      def.engine === 'reserve_stock' &&
      current.allocationId &&
      REPLANNABLE_RESERVE_FAILURES.includes(outcome.code) &&
      (await replanAllocation(
        run,
        current.allocationId,
        `No se pudo reservar la existencia: ${outcome.message}`
      ))
    ) {
      return { changed: true, structural: true };
    }
    const latest = run.state.steps.find((s) => s.id === step.id) ?? current;
    const opened = await ensureStepWorkItem(run, latest, def, { failure: outcome });
    return { changed: justReady || recorded || opened, structural: false };
  }
  let changed = justReady;
  if (def.key === SALES_STEP.assignTransport) {
    changed = (await syncTransportWaiting(run, step, def)) || changed;
  }
  const latest = run.state.steps.find((s) => s.id === step.id) ?? step;
  const opened = await ensureStepWorkItem(run, latest, def);
  const held =
    def.key === SALES_STEP.assignTransport ? await syncTransportWorkItems(run, latest, def) : false;
  return { changed: changed || opened || held, structural: false };
}

async function progressStep(
  run: AdvanceRun,
  step: CaseStep,
  def: StepDef
): Promise<{ changed: boolean; structural: boolean }> {
  if (step.status === 'pending') {
    if (!dependenciesSatisfied(step.dependsOn, run.statusByRef))
      return { changed: false, structural: false };
    if (def.entryCondition && !evaluateCondition(def.entryCondition, facts(run), scopeOf(step))) {
      await skipStep(run, step, def);
      return { changed: true, structural: false };
    }
    const ready = await markStepReady(run, step, def);
    return progressOpenStep(run, ready, def, true);
  }
  // An open step whose dependencies were reopened (a reservation reduced by a
  // replan, a new line while the order is being prepared) goes back to pending
  // and its work item is cancelled: it waits for them again.
  if (isOpenStep(step.status) && !dependenciesSatisfied(step.dependsOn, run.statusByRef)) {
    await revertStep(run, step, 'Cambió el expediente: el paso espera a otros pasos');
    return { changed: true, structural: false };
  }
  if (isOpenStep(step.status)) return progressOpenStep(run, step, def, false);
  return { changed: false, structural: false };
}

async function revertStep(run: AdvanceRun, step: CaseStep, reason: string): Promise<void> {
  const { tx, ctx } = run;
  const updated = await tx.caseStep.update({
    where: { id: step.id },
    data: { status: 'pending', dueAt: null, version: { increment: 1 } },
  });
  replaceStep(run, updated);
  for (const item of run.state.openWorkItems.filter((w) => w.stepId === step.id)) {
    const current = await tx.workItem.findUnique({ where: { id: item.id } });
    if (current && (WORK_ITEM_OPEN_STATUSES as readonly string[]).includes(current.status)) {
      await cancelWorkItemInTx(tx, current, { reason });
    }
  }
  run.state.openWorkItems = run.state.openWorkItems.filter((w) => w.stepId !== step.id);
  ctx.emit(
    'step.reverted',
    { stepId: step.id, stepKey: step.stepKey, scopeKey: step.scopeKey, reason },
    {
      caseId: step.caseId,
      areaKey: step.areaKey,
      objectType: CASE_STEP_OBJECT_TYPE,
      objectId: step.id,
    }
  );
}

async function recomputeCase(
  tx: Db,
  ctx: CommandContext,
  caseId: string,
  blueprint: ProcessBlueprint,
  options: { aggregate: boolean; touched: boolean }
): Promise<{ status: string; phase: string; version: number }> {
  const opCase = await tx.operationalCase.findUnique({ where: { id: caseId } });
  if (!opCase) throw new OperationsError('not_found', 'No se encontró el expediente');
  if (opCase.status === 'closed' || opCase.status === 'cancelled') {
    return { status: opCase.status, phase: opCase.phase, version: opCase.version };
  }
  const steps = await tx.caseStep.findMany({
    where: { caseId },
    select: { stepKey: true, status: true },
  });
  const items = await tx.workItem.findMany({
    where: { caseId, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
    select: { status: true },
  });
  const requests = await tx.areaRequest.findMany({
    where: { caseId, status: { in: [...AREA_REQUEST_OPEN_STATUSES] } },
    select: { status: true },
  });
  const phase = deriveCasePhase(steps, blueprint);
  const status = deriveCaseStatus({
    current: opCase.status,
    steps,
    openWorkItemStatuses: items.map((item) => item.status),
    openRequestStatuses: requests.map((request) => request.status),
  });
  const data: Prisma.OperationalCaseUpdateInput = {};
  const eventOptions = {
    caseId,
    areaKey: 'administracion',
    objectType: CASE_AGGREGATE_TYPE,
    objectId: caseId,
  };
  if (phase !== opCase.phase) {
    data.phase = phase;
    ctx.emit(OPS_EVENTS.case.phaseChanged, { from: opCase.phase, to: phase }, eventOptions);
  }
  if (status !== opCase.status) {
    data.status = status;
    if (status === 'closed') {
      data.closedAt = ctx.now;
      data.closeReason = 'Proceso completado';
      // Nothing keeps hanging from a closed case (plan 2.5: requests expire, never deleted).
      const reason = 'El expediente se cerró';
      await expireAreaRequestsForCase(tx, caseId, reason);
      const leftovers = await tx.workItem.findMany({
        where: { caseId, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
      });
      for (const item of leftovers) await cancelWorkItemInTx(tx, item, { reason });
    }
    ctx.emit(OPS_EVENTS.case.statusChanged, { from: opCase.status, to: status }, eventOptions);
  }
  if (Object.keys(data).length === 0 && !options.touched) {
    return { status, phase, version: opCase.version };
  }
  data.lastActivityAt = ctx.now;
  if (!options.aggregate) data.version = { increment: 1 };
  const updated = await tx.operationalCase.update({ where: { id: caseId }, data });
  return { status: updated.status, phase: updated.phase, version: updated.version };
}

/**
 * Advances a case inside the running command until nothing else can move (see
 * the module comment). Re-entrant calls for the same case in the same
 * transaction return immediately.
 */
export async function advanceCase(
  tx: Db,
  caseId: string,
  ctx: CommandContext = requireCommandContext(tx),
  options: AdvanceCaseOptions = {}
): Promise<AdvanceCaseResult> {
  const result: AdvanceCaseResult = {
    caseId,
    changed: false,
    status: '',
    phase: '',
    readySteps: [],
    completedSteps: [],
    skippedSteps: [],
    workItemIds: [],
    engineFailures: [],
  };
  if (isAdvancing(tx, caseId)) return { ...result, reentrant: true };
  return withAdvancing(tx, caseId, async () => {
    const caches = newCaches();
    let blueprint: ProcessBlueprint | null = null;
    for (let pass = 0; pass < MAX_ADVANCE_PASSES; pass++) {
      const state = await loadCaseState(tx, caseId);
      if (!state) throw new OperationsError('not_found', 'No se encontró el expediente');
      if (state.opCase.status === 'closed' || state.opCase.status === 'cancelled') {
        result.status = state.opCase.status;
        result.phase = state.opCase.phase;
        return result;
      }
      blueprint ??= (await loadProcessBlueprint(tx, state.opCase.processVersionId)).blueprint;
      const run: AdvanceRun = {
        tx,
        ctx,
        blueprint,
        state,
        availability: new Map(),
        statusByRef: new Map(),
        caches,
        result,
      };
      rebuildStatusByRef(run);
      let passChanged = await replanDeadRequests(run);
      passChanged = (await syncCaseSteps(run)) || passChanged;
      passChanged = (await refreshDemandUnits(run)) || passChanged;
      run.availability = await loadAvailability(tx, state, blueprint, caches);
      let structural = false;
      for (const ordered of orderSteps(state, blueprint)) {
        const step = state.steps.find((s) => s.id === ordered.id) ?? ordered;
        const def = findStepDef(blueprint, step.stepKey);
        if (!def) continue;
        const progress = await progressStep(run, step, def);
        if (progress.changed) passChanged = true;
        if (progress.structural) {
          structural = true;
          break;
        }
      }
      if (passChanged) result.changed = true;
      if (!passChanged && !structural) break;
      if (pass === MAX_ADVANCE_PASSES - 1) {
        log('advance_pass_limit', { caseId, commandId: ctx.commandId });
      }
    }
    if (!blueprint) return result;
    const recomputed = await recomputeCase(tx, ctx, caseId, blueprint, {
      aggregate: options.aggregate === true,
      touched: result.changed,
    });
    result.status = recomputed.status;
    result.phase = recomputed.phase;
    rememberAdvanced(ctx.tx, caseId);
    return result;
  });
}

export interface CompleteStepInput {
  evidence?: Record<string, unknown>;
  source?: StepCompletionSource;
  workItemId?: string | null;
  /** Default true: advance the case afterwards. */
  advance?: boolean;
}

/**
 * Closes an open step from evidence or an event (inside a command), applies
 * its effects (allocations of a plan, ready material, fulfilled demands…) and
 * advances the case.
 */
export async function completeStep(
  tx: Db,
  stepId: string,
  input: CompleteStepInput = {},
  ctx: CommandContext = requireCommandContext(tx)
): Promise<{ completed: boolean; advance: AdvanceCaseResult | null }> {
  const step = await tx.caseStep.findUnique({ where: { id: stepId } });
  if (!step) throw new OperationsError('not_found', 'No se encontró el paso del expediente');
  if (step.status === 'pending') {
    throw new OperationsError(
      'invalid_state',
      'El paso todavía espera a otros pasos del expediente'
    );
  }
  if (!isOpenStep(step.status)) return { completed: false, advance: null };
  let completed = false;
  const wasAdvancing = isAdvancing(tx, step.caseId);
  await withAdvancing(tx, step.caseId, async () => {
    const state = await loadCaseState(tx, step.caseId);
    if (!state) throw new OperationsError('not_found', 'No se encontró el expediente');
    const { blueprint } = await loadProcessBlueprint(tx, step.processVersionId);
    const def = findStepDef(blueprint, step.stepKey);
    if (!def)
      throw new OperationsError('invalid_state', 'El paso no existe en la versión del proceso');
    const caches = newCaches();
    const run: AdvanceRun = {
      tx,
      ctx,
      blueprint,
      state,
      availability: new Map(),
      statusByRef: new Map(),
      caches,
      result: {
        caseId: step.caseId,
        changed: false,
        status: state.opCase.status,
        phase: state.opCase.phase,
        readySteps: [],
        completedSteps: [],
        skippedSteps: [],
        workItemIds: [],
        engineFailures: [],
      },
    };
    rebuildStatusByRef(run);
    run.availability = await loadAvailability(tx, state, blueprint, caches);
    const current = state.steps.find((s) => s.id === step.id) ?? step;
    completed = (
      await completeStepInRun(run, current, def, {
        evidence: input.evidence ?? {},
        source: input.source ?? 'manual',
        workItemId: input.workItemId ?? null,
      })
    ).completed;
  });
  const advance =
    input.advance === false || wasAdvancing ? null : await advanceCase(tx, step.caseId, ctx);
  return { completed, advance };
}

// ---------------------------------------------------------------------------
// Work item hooks of case steps
// ---------------------------------------------------------------------------

const CONDITION_PENDING_MESSAGES: Record<string, string> = {
  [SALES_STEP.reserve]:
    'Este trabajo se cierra cuando la existencia queda reservada para la asignación (usa «Reservar existencia»)',
  [SALES_STEP.requestPurchase]:
    'Se cierra cuando se crea la solicitud a Compras; revisa los responsables y reintenta el avance del expediente',
  [SALES_STEP.orderProduction]:
    'Se cierra cuando se crea la solicitud a Manufactura; revisa los responsables y reintenta el avance del expediente',
  [SALES_STEP.coordinateDirect]:
    'Se cierra cuando se crea la solicitud a Compras; revisa los responsables y reintenta el avance del expediente',
  [SALES_STEP.planDelivery]: 'Se cierra al crear la orden de entrega del expediente en Logística',
  [SALES_STEP.assignTransport]:
    'Se cierra cuando Zoho confirma el embarque con el transporte asignado',
  [SALES_STEP.deliver]: 'Se cierra al registrar la entrega con su evidencia',
};

function conditionPendingMessage(def: StepDef): string {
  const fixed = CONDITION_PENDING_MESSAGES[def.key];
  if (fixed) return fixed;
  return def.autoComplete && isConditionKey(def.autoComplete)
    ? `Este trabajo se cierra solo cuando se cumple: ${CONDITION_LABELS[def.autoComplete].toLowerCase()}`
    : 'Este trabajo se cierra automáticamente';
}

async function assertStepCompletable(
  tx: Db,
  ctx: CommandContext,
  item: WorkItem,
  result: Record<string, unknown>
): Promise<void> {
  if (!item.stepId) return;
  const step = await tx.caseStep.findUnique({ where: { id: item.stepId } });
  if (!step || !isOpenStep(step.status)) return;
  const { blueprint } = await loadProcessBlueprint(tx, step.processVersionId);
  const def = findStepDef(blueprint, step.stepKey);
  if (!def) return;
  const state = await loadCaseState(tx, step.caseId);
  if (!state) return;
  if (def.completion === 'condition') {
    const satisfied = def.autoComplete
      ? evaluateCondition(def.autoComplete, buildFacts(state, new Map()), scopeOf(step))
      : false;
    if (!satisfied) {
      throw new OperationsError('step_condition_pending', conditionPendingMessage(def), {
        httpStatus: 409,
        details: { stepKey: step.stepKey, condition: def.autoComplete ?? null },
      });
    }
  }
  if (def.key === SALES_STEP.prepare) {
    const issueEvidence = asRecord(result.issue_movements);
    const movementIds = evidenceMovementIds(issueEvidence.movementIds);
    if (movementIds.length === 0) {
      throw new OperationsError(
        'invalid_payload',
        'El pedido sólo se prepara al surtirlo: usa «Surtir y preparar» para registrar las salidas de material'
      );
    }
    const blockers = preparationBlockers(state.allocations, state.activeReservationAllocationIds);
    if (blockers.length > 0) throw preparationPendingError(state, blockers);
  }
  if (RECEIPT_EVIDENCE[def.key]) await receiptEvidence(tx, state, step, def, result);
  if (def.key === SALES_STEP.plan) {
    const parsed = parseAllocationDecision(result.allocation_plan);
    if (!parsed.ok) throw new OperationsError('invalid_payload', parsed.message);
    const demand = state.demands.find((d) => d.id === step.demandId);
    if (!demand) return;
    const availability = await demandAvailability(tx, state, demand, newCaches());
    const plan = await computePlan(
      tx,
      ctx,
      state,
      demand,
      parsed.decision,
      availability,
      ctx.actor.type === 'user'
    );
    if (!plan.ok) throw new OperationsError(plan.code, plan.message, { httpStatus: 409 });
  }
}

registerWorkItemHooks(
  CASE_STEP_OBJECT_TYPE,
  {
    async beforeStart({ tx, ctx, item }) {
      if (!item.stepId) return;
      const step = await tx.caseStep.findUnique({ where: { id: item.stepId } });
      if (!step || (step.status !== 'ready' && step.status !== 'waiting')) return;
      await tx.caseStep.update({
        where: { id: step.id },
        data: { status: 'active', startedAt: step.startedAt ?? ctx.now, version: { increment: 1 } },
      });
      ctx.emit(
        OPS_EVENTS.step.started,
        { stepId: step.id, stepKey: step.stepKey, scopeKey: step.scopeKey, workItemId: item.id },
        {
          caseId: step.caseId,
          areaKey: step.areaKey,
          objectType: CASE_STEP_OBJECT_TYPE,
          objectId: step.id,
        }
      );
    },
    async beforeComplete({ tx, ctx, item }, { result }) {
      await assertStepCompletable(tx, ctx, item, result);
    },
    async afterComplete({ tx, ctx, item }) {
      if (!item.stepId) return;
      const step = await tx.caseStep.findUnique({ where: { id: item.stepId } });
      if (!step || !isOpenStep(step.status)) return;
      await completeStep(
        tx,
        step.id,
        { evidence: asRecord(item.result), source: 'work_item', workItemId: item.id },
        ctx
      );
    },
  },
  'case-service'
);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const startSchema = z
  .object({
    zohoSalesOrderId: z.string().trim().min(1).max(120),
    manual: z.boolean().default(false),
  })
  .strict();

export interface CaseStartData {
  caseId: string;
  caseNumber: string;
  created: boolean;
  status: string;
  phase: string;
  demandIds: string[];
  workItemIds: string[];
}

function startData(
  opCase: OperationalCase,
  created: boolean,
  extra: Partial<CaseStartData> = {}
): CaseStartData {
  return {
    caseId: opCase.id,
    caseNumber: opCase.caseNumber,
    created,
    status: opCase.status,
    phase: opCase.phase,
    demandIds: [],
    workItemIds: [],
    ...extra,
  };
}

registerCommand<z.output<typeof startSchema>, CaseStartData>(CASE_COMMANDS.start, {
  schema: startSchema,
  permission: MANAGE_PERMISSION,
  aggregate: 'none',
  actorTypes: ['user', 'system'],
  audit: 'user',
  async handler(tx, cmd, ctx) {
    const { zohoSalesOrderId, manual } = cmd.payload;
    if (
      cmd.aggregate.type !== CASE_AGGREGATE_TYPE ||
      cmd.aggregate.id !== caseSourceAggregateId(zohoSalesOrderId)
    ) {
      throw new OperationsError(
        'invalid_payload',
        'El registro del comando no corresponde a la orden de venta'
      );
    }
    if (manual && ctx.actor.type !== 'user') {
      throw new OperationsError(
        'forbidden',
        'Sólo una persona puede iniciar el seguimiento manual de una orden'
      );
    }
    const order = await tx.salesOrder.findUnique({ where: { zohoSalesOrderId } });
    if (!order) {
      throw new OperationsError(
        'not_found',
        'La orden de venta aún no está sincronizada desde Zoho'
      );
    }
    const existing = await tx.operationalCase.findFirst({
      where: { kind: CASE_KIND, sourceType: CASE_SOURCE_TYPE, sourceId: zohoSalesOrderId },
    });
    if (existing) return { aggregateVersion: existing.version, data: startData(existing, false) };

    const config = await getOperationsConfig();
    const decision = evaluateStartPolicy(order, config, { manual });
    if (!decision.eligible) {
      throw new OperationsError('case_not_eligible', decision.message, {
        httpStatus: 409,
        details: { reason: decision.reason },
      });
    }
    const lines = await loadFulfillableLines(tx, order.id);
    if (lines.length === 0) {
      throw new OperationsError('invalid_state', 'La orden no tiene partidas que surtir');
    }
    const processVersion = await ensureProcessVersion(tx, SALES_FULFILLMENT_BLUEPRINT);
    const ownerUserId = await resolveCaseOwner(tx, order.salespersonName);
    const sequence = await nextSequence(tx, 'case', 'EXP');
    const [created] = await tx.operationalCase.createManyAndReturn({
      data: [
        {
          caseSeq: sequence.value,
          caseNumber: sequence.number,
          kind: CASE_KIND,
          sourceType: CASE_SOURCE_TYPE,
          sourceId: zohoSalesOrderId,
          zohoSalesOrderId,
          salesOrderNumber: order.salesOrderNumber,
          customerName: order.customerName,
          zohoCustomerId: order.zohoCustomerId,
          salespersonName: order.salespersonName,
          locationId: order.locationId,
          locationName: order.locationName,
          deliveryMethod: order.deliveryMethod,
          orderDate: order.orderDate,
          processVersionId: processVersion.id,
          status: 'open',
          phase: 'planning',
          priority: 'normal',
          ownerUserId,
          openedAt: ctx.now,
          lastActivityAt: ctx.now,
        },
      ],
      skipDuplicates: true,
    });
    if (!created) {
      const winner = await tx.operationalCase.findFirst({
        where: { kind: CASE_KIND, sourceType: CASE_SOURCE_TYPE, sourceId: zohoSalesOrderId },
      });
      if (!winner) throw new Error(`Case of ${zohoSalesOrderId} conflicted but could not be read`);
      return { aggregateVersion: winner.version, data: startData(winner, false) };
    }

    ctx.emit(
      OPS_EVENTS.case.created,
      {
        caseId: created.id,
        caseNumber: created.caseNumber,
        zohoSalesOrderId,
        salesOrderNumber: created.salesOrderNumber,
        customerName: created.customerName,
        ownerUserId,
        manual,
        basis: decision.basis,
        processKey: SALES_FULFILLMENT_BLUEPRINT.processKey,
        processVersion: SALES_FULFILLMENT_BLUEPRINT.version,
        lines: lines.length,
      },
      {
        caseId: created.id,
        areaKey: 'ventas',
        objectType: CASE_AGGREGATE_TYPE,
        objectId: created.id,
      }
    );
    await ctx.relate(
      { type: CASE_AGGREGATE_TYPE, id: created.id },
      { type: 'sales_order', id: order.id },
      'fulfills'
    );
    const taken = new Set<string>();
    const demandIds: string[] = [];
    for (const [index, line] of lines.entries()) {
      const demand = await createCaseDemand(tx, ctx, created, line, {
        lineRef: uniqueLineRef(line, index, taken),
        sortOrder: index,
      });
      demandIds.push(demand.id);
    }
    const advance = await advanceCase(tx, created.id, ctx);
    const final = (await tx.operationalCase.findUnique({ where: { id: created.id } })) ?? created;
    log('case_started', {
      caseId: created.id,
      caseNumber: created.caseNumber,
      zohoSalesOrderId,
      manual,
      demands: demandIds.length,
      workItems: advance.workItemIds.length,
      commandId: ctx.commandId,
    });
    return {
      aggregateVersion: final.version,
      data: startData(final, true, { demandIds, workItemIds: advance.workItemIds }),
    };
  },
});

const advanceSchema = z.object({ reason: z.string().trim().max(200).optional() }).strict();

registerCommand<z.output<typeof advanceSchema>, AdvanceCaseResult>(CASE_COMMANDS.advance, {
  schema: advanceSchema,
  permission: MANAGE_PERMISSION,
  aggregate: caseAggregate,
  actorTypes: ['user', 'system'],
  audit: 'user',
  async handler(tx, cmd, ctx) {
    const outcome = await advanceCase(tx, cmd.aggregate.id, ctx, { aggregate: true });
    return { data: outcome };
  },
});

export interface CaseCommandOptions {
  commandId?: string;
  expectedVersion?: number;
  deviceId?: string;
  now?: Date;
}

/** `case.start` for a Zoho sales order (jobs pass a system actor; people use `startCaseManually`). */
export function startSalesFulfillment(
  zohoSalesOrderId: string,
  options: {
    commandId: string;
    actor: OperationsActor;
    user?: CurrentUser | null;
    manual?: boolean;
    deviceId?: string;
    now?: Date;
  }
): Promise<CommandResult<CaseStartData>> {
  return executeCommand<CaseStartData>(
    {
      commandId: options.commandId,
      type: CASE_COMMANDS.start,
      actor: options.actor,
      aggregate: { type: CASE_AGGREGATE_TYPE, id: caseSourceAggregateId(zohoSalesOrderId) },
      payload: { zohoSalesOrderId, manual: options.manual === true },
      deviceId: options.deviceId,
    },
    options.user ?? null,
    { now: options.now }
  );
}

/** "Iniciar seguimiento" (`operations.manage`): skips cutover and pilot, never the status filters. */
export function startCaseManually(
  actor: CurrentUser,
  zohoSalesOrderId: string,
  options: CaseCommandOptions = {}
): Promise<CommandResult<CaseStartData>> {
  return startSalesFulfillment(zohoSalesOrderId, {
    commandId: options.commandId ?? `case.start:${randomUUID()}`,
    actor: { type: 'user', id: actor.id },
    user: actor,
    manual: true,
    deviceId: options.deviceId,
    now: options.now,
  });
}

/** `case.advance` by a person (`operations.manage`) or, without actor, by the system. */
export function advanceCaseCommand(
  caseId: string,
  options: CaseCommandOptions & {
    actor?: CurrentUser | null;
    reason?: string;
    systemActorId?: string;
  } = {}
): Promise<CommandResult<AdvanceCaseResult>> {
  const actor: OperationsActor = options.actor
    ? { type: 'user', id: options.actor.id }
    : { type: 'system', id: options.systemActorId ?? 'operations.case_advance' };
  return executeCommand<AdvanceCaseResult>(
    {
      commandId: options.commandId ?? `case.advance:${randomUUID()}`,
      type: CASE_COMMANDS.advance,
      actor,
      aggregate: { type: CASE_AGGREGATE_TYPE, id: caseId },
      expectedVersion: options.expectedVersion,
      deviceId: options.deviceId,
      payload: options.reason ? { reason: options.reason } : {},
    },
    options.actor ?? null,
    { now: options.now }
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface CaseSnapshot {
  case: {
    id: string;
    caseNumber: string;
    status: string;
    statusLabel: string;
    phase: string;
    phaseLabel: string;
    priority: string;
    ownerUserId: string;
    ownerName: string | null;
    zohoSalesOrderId: string | null;
    salesOrderNumber: string | null;
    customerName: string | null;
    deliveryMethod: string | null;
    locationName: string | null;
    promisedAt: string | null;
    openedAt: string;
    lastActivityAt: string;
    closedAt: string | null;
    cancelledAt: string | null;
    closeReason: string | null;
    version: number;
    process: string;
  };
  demands: Array<{
    id: string;
    lineRef: string;
    sku: string | null;
    name: string;
    quantity: string;
    unit: string;
    baseQuantity: string;
    baseUnit: string;
    status: string;
    fulfilledQuantity: string;
  }>;
  allocations: Array<{
    id: string;
    demandId: string;
    source: string;
    quantity: string;
    status: string;
    warehouseId: string | null;
    stockReservationId: string | null;
    linkedType: string | null;
    linkedId: string | null;
    expectedAt: string | null;
    deliveredQuantity: string;
  }>;
  steps: Array<{
    id: string;
    stepKey: string;
    label: string;
    scopeKey: string;
    areaKey: string;
    kind: string;
    status: string;
    dueAt: string | null;
    completedAt: string | null;
    overdue: boolean;
    uiAction: string | null;
  }>;
  openWorkItems: Array<{
    id: string;
    title: string;
    areaKey: string;
    kind: string;
    status: string;
    ownerUserId: string;
    backupUserId: string | null;
    dueAt: string;
    overdue: boolean;
    stepId: string | null;
  }>;
  requests: Array<{
    id: string;
    kind: string;
    fromAreaKey: string;
    toAreaKey: string;
    status: string;
    title: string;
    dueAt: string;
    blocksDelivery: boolean;
  }>;
  incidents: Array<{
    id: string;
    kind: string;
    severity: string;
    status: string;
    title: string;
    openedAt: string;
  }>;
  delivery: {
    orders: Array<{
      id: string;
      status: string;
      mode: string;
      zohoSyncState: string;
      plannedDate: string | null;
      carrier: string | null;
      packageId: string | null;
      deliveredAt: string | null;
    }>;
  };
  timeline: Array<{
    id: string;
    type: string;
    occurredAt: string;
    actorType: string;
    actorId: string | null;
    areaKey: string | null;
    objectType: string | null;
    objectId: string | null;
    summary: Record<string, string | number | boolean | null>;
  }>;
}

function summarizePayload(
  payload: Record<string, unknown>
): Record<string, string | number | boolean | null> {
  const summary: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (Object.keys(summary).length >= 8) break;
    if (value === null || typeof value === 'number' || typeof value === 'boolean')
      summary[key] = value;
    else if (typeof value === 'string')
      summary[key] = value.length > 120 ? `${value.slice(0, 119)}…` : value;
  }
  return summary;
}

/**
 * Compact JSON of a case for prompts and UI: header, demands, allocations,
 * steps, open work items, requests, open incidents, deliveries and the last 10
 * timeline entries. With `actor` the case channel authorization is enforced
 * (`operations.view`, owner, work item participant or room member).
 */
export async function getCaseSnapshot(
  caseId: string,
  options: { actor?: CurrentUser | null; now?: Date } = {}
): Promise<CaseSnapshot | null> {
  if (options.actor && !(await authorizeOperationsChannel(options.actor, 'case', caseId))) {
    throw new OperationsError('forbidden', 'No tienes acceso a este expediente');
  }
  const opCase = await prisma.operationalCase.findUnique({ where: { id: caseId } });
  if (!opCase) return null;
  const now = options.now ?? new Date();
  const [demands, allocations, steps, workItems, requests, incidents, orders, owner, events] =
    await Promise.all([
      prisma.caseDemand.findMany({
        where: { caseId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.demandAllocation.findMany({
        where: { caseId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.caseStep.findMany({ where: { caseId } }),
      prisma.workItem.findMany({
        where: { caseId, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.areaRequest.findMany({
        where: { caseId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 30,
      }),
      prisma.incident.findMany({
        where: { caseId, status: { in: [...INCIDENT_OPEN_STATUSES] } },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
      prisma.deliveryOrder.findMany({
        where: { caseId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.user.findUnique({ where: { id: opCase.ownerUserId }, select: { name: true } }),
      // The business timeline: the audit events of the AI decisions never displace real facts.
      listCaseEvents(caseId, { limit: 10, excludeTypes: AI_TURN_EVENT_TYPES }),
    ]);
  let blueprint: ProcessBlueprint | null = null;
  let process = opCase.processVersionId;
  try {
    const loaded = await loadProcessBlueprint(prisma, opCase.processVersionId);
    blueprint = loaded.blueprint;
    process = `${loaded.version.processKey}@${loaded.version.version}`;
  } catch (err) {
    if (!isOperationsError(err)) throw err;
  }
  const stepOrder = new Map((blueprint?.steps ?? []).map((step, index) => [step.key, index]));
  const openRequests = requests.filter((r) =>
    (AREA_REQUEST_OPEN_STATUSES as readonly string[]).includes(r.status)
  );
  const closedRequests = requests.filter(
    (r) => !(AREA_REQUEST_OPEN_STATUSES as readonly string[]).includes(r.status)
  );
  return {
    case: {
      id: opCase.id,
      caseNumber: opCase.caseNumber,
      status: opCase.status,
      statusLabel: (CASE_STATUS_LABELS as Record<string, string>)[opCase.status] ?? opCase.status,
      phase: opCase.phase,
      phaseLabel: (CASE_PHASE_LABELS as Record<string, string>)[opCase.phase] ?? opCase.phase,
      priority: opCase.priority,
      ownerUserId: opCase.ownerUserId,
      ownerName: owner?.name ?? null,
      zohoSalesOrderId: opCase.zohoSalesOrderId,
      salesOrderNumber: opCase.salesOrderNumber,
      customerName: opCase.customerName,
      deliveryMethod: opCase.deliveryMethod,
      locationName: opCase.locationName,
      promisedAt: opCase.promisedAt?.toISOString() ?? null,
      openedAt: opCase.openedAt.toISOString(),
      lastActivityAt: opCase.lastActivityAt.toISOString(),
      closedAt: opCase.closedAt?.toISOString() ?? null,
      cancelledAt: opCase.cancelledAt?.toISOString() ?? null,
      closeReason: opCase.closeReason,
      version: opCase.version,
      process,
    },
    demands: demands.map((d) => ({
      id: d.id,
      lineRef: d.lineRef,
      sku: d.sku,
      name: d.name,
      quantity: qtyText(d.quantity),
      unit: d.unit,
      baseQuantity: qtyText(d.baseQuantity),
      baseUnit: d.baseUnit,
      status: d.status,
      fulfilledQuantity: qtyText(d.fulfilledQuantity),
    })),
    allocations: allocations.map((a) => ({
      id: a.id,
      demandId: a.demandId,
      source: a.source,
      quantity: qtyText(a.quantity),
      status: a.status,
      warehouseId: a.warehouseId,
      stockReservationId: a.stockReservationId,
      linkedType: a.linkedType,
      linkedId: a.linkedId,
      expectedAt: a.expectedAt?.toISOString() ?? null,
      deliveredQuantity: qtyText(a.deliveredQuantity),
    })),
    steps: [...steps]
      .sort(
        (a, b) =>
          (stepOrder.get(a.stepKey) ?? 999) - (stepOrder.get(b.stepKey) ?? 999) ||
          a.scopeKey.localeCompare(b.scopeKey)
      )
      .map((s) => {
        const def = blueprint ? findStepDef(blueprint, s.stepKey) : null;
        return {
          id: s.id,
          stepKey: s.stepKey,
          label: def?.label ?? s.stepKey,
          scopeKey: s.scopeKey,
          areaKey: s.areaKey,
          kind: s.kind,
          status: s.status,
          dueAt: s.dueAt?.toISOString() ?? null,
          completedAt: s.completedAt?.toISOString() ?? null,
          overdue: Boolean(s.dueAt && isOpenStep(s.status) && s.dueAt.getTime() < now.getTime()),
          uiAction: def?.uiAction ?? null,
        };
      }),
    openWorkItems: workItems.map((w) => ({
      id: w.id,
      title: w.title,
      areaKey: w.areaKey,
      kind: w.kind,
      status: w.status,
      ownerUserId: w.ownerUserId,
      backupUserId: w.backupUserId,
      dueAt: w.dueAt.toISOString(),
      overdue: w.dueAt.getTime() < now.getTime(),
      stepId: w.stepId,
    })),
    requests: [...openRequests, ...closedRequests.slice(0, 5)].map((r) => ({
      id: r.id,
      kind: r.kind,
      fromAreaKey: r.fromAreaKey,
      toAreaKey: r.toAreaKey,
      status: r.status,
      title: r.title,
      dueAt: r.dueAt.toISOString(),
      blocksDelivery: r.blocksDelivery,
    })),
    incidents: incidents.map((i) => ({
      id: i.id,
      kind: i.kind,
      severity: i.severity,
      status: i.status,
      title: i.title,
      openedAt: i.openedAt.toISOString(),
    })),
    delivery: {
      orders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        mode: o.mode,
        zohoSyncState: o.zohoSyncState,
        plannedDate: o.plannedDate?.toISOString() ?? null,
        carrier: o.carrier,
        packageId: o.packageId,
        deliveredAt: o.deliveredAt?.toISOString() ?? null,
      })),
    },
    timeline: events.events
      .slice(-10)
      .reverse()
      .map((event) => ({
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        actorType: event.actorType,
        actorId: event.actorId,
        areaKey: event.areaKey,
        objectType: event.objectType,
        objectId: event.objectId,
        summary: summarizePayload(event.payload),
      })),
  };
}

export const caseListFiltersSchema = z
  .object({
    scope: z.enum(['open', 'closed', 'all']).default('open'),
    status: z.array(z.enum(CASE_STATUSES)).max(6).optional(),
    phase: z.enum(CASE_PHASES).optional(),
    ownerUserId: z.string().trim().min(1).max(120).optional(),
    mine: z.boolean().optional(),
    q: z.string().trim().max(120).optional(),
    zohoSalesOrderId: z.string().trim().min(1).max(120).optional(),
    locationId: z.string().trim().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(500).optional(),
  })
  .strict();

export type CaseListFilters = z.input<typeof caseListFiltersSchema>;

export interface CaseListItem {
  id: string;
  caseNumber: string;
  status: string;
  statusLabel: string;
  phase: string;
  phaseLabel: string;
  priority: string;
  customerName: string | null;
  salesOrderNumber: string | null;
  zohoSalesOrderId: string | null;
  locationName: string | null;
  ownerUserId: string;
  ownerName: string | null;
  openedAt: string;
  lastActivityAt: string;
  promisedAt: string | null;
  openWorkItems: number;
  overdueWorkItems: number;
  openIncidents: number;
  version: number;
}

export interface CaseListPage {
  items: CaseListItem[];
  nextCursor: string | null;
}

/**
 * Cases ordered by last activity. `operations.view` sees every case; anybody
 * else only the cases they own.
 */
export async function listCases(
  actor: CurrentUser,
  filters: CaseListFilters = {},
  options: { now?: Date } = {}
): Promise<CaseListPage> {
  const parsed = caseListFiltersSchema.safeParse(filters);
  if (!parsed.success)
    throw new OperationsError('invalid_payload', 'Filtros de expedientes inválidos');
  const input = parsed.data;
  const now = options.now ?? new Date();
  const and: Prisma.OperationalCaseWhereInput[] = [];
  if (!hasPermission(actor, VIEW_PERMISSION)) and.push({ ownerUserId: actor.id });
  if (input.scope === 'open') and.push({ status: { in: [...CASE_OPEN_STATUSES] } });
  if (input.scope === 'closed') and.push({ status: { in: ['closed', 'cancelled'] } });
  if (input.status?.length) and.push({ status: { in: input.status } });
  if (input.phase) and.push({ phase: input.phase });
  if (input.mine) and.push({ ownerUserId: actor.id });
  else if (input.ownerUserId) and.push({ ownerUserId: input.ownerUserId });
  if (input.zohoSalesOrderId) and.push({ zohoSalesOrderId: input.zohoSalesOrderId });
  if (input.locationId) and.push({ locationId: input.locationId });
  if (input.q) {
    and.push({
      OR: [
        { caseNumber: { contains: input.q, mode: 'insensitive' } },
        { salesOrderNumber: { contains: input.q, mode: 'insensitive' } },
        { customerName: { contains: input.q, mode: 'insensitive' } },
      ],
    });
  }
  const keyset = keysetCondition('lastActivityAt', 'desc', decodeListCursor(input.cursor));
  if (keyset) and.push(keyset as Prisma.OperationalCaseWhereInput);
  const rows = await prisma.operationalCase.findMany({
    where: { AND: and },
    orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
  });
  const page = rows.slice(0, input.limit);
  const ids = page.map((row) => row.id);
  const [openItems, overdueItems, openIncidents, owners] = ids.length
    ? await Promise.all([
        prisma.workItem.groupBy({
          by: ['caseId'],
          where: { caseId: { in: ids }, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
          _count: { _all: true },
        }),
        prisma.workItem.groupBy({
          by: ['caseId'],
          where: {
            caseId: { in: ids },
            status: { in: [...WORK_ITEM_OPEN_STATUSES] },
            dueAt: { lt: now },
          },
          _count: { _all: true },
        }),
        prisma.incident.groupBy({
          by: ['caseId'],
          where: { caseId: { in: ids }, status: { in: [...INCIDENT_OPEN_STATUSES] } },
          _count: { _all: true },
        }),
        prisma.user.findMany({
          where: { id: { in: [...new Set(page.map((row) => row.ownerUserId))] } },
          select: { id: true, name: true },
        }),
      ])
    : [[], [], [], []];
  const countBy = (groups: Array<{ caseId: string | null; _count: { _all: number } }>) =>
    new Map(groups.map((group) => [group.caseId ?? '', group._count._all]));
  const openMap = countBy(openItems);
  const overdueMap = countBy(overdueItems);
  const incidentMap = countBy(openIncidents);
  const ownerNames = new Map(owners.map((user) => [user.id, user.name]));
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id,
      caseNumber: row.caseNumber,
      status: row.status,
      statusLabel: (CASE_STATUS_LABELS as Record<string, string>)[row.status] ?? row.status,
      phase: row.phase,
      phaseLabel: (CASE_PHASE_LABELS as Record<string, string>)[row.phase] ?? row.phase,
      priority: row.priority,
      customerName: row.customerName,
      salesOrderNumber: row.salesOrderNumber,
      zohoSalesOrderId: row.zohoSalesOrderId,
      locationName: row.locationName,
      ownerUserId: row.ownerUserId,
      ownerName: ownerNames.get(row.ownerUserId) ?? null,
      openedAt: row.openedAt.toISOString(),
      lastActivityAt: row.lastActivityAt.toISOString(),
      promisedAt: row.promisedAt?.toISOString() ?? null,
      openWorkItems: openMap.get(row.id) ?? 0,
      overdueWorkItems: overdueMap.get(row.id) ?? 0,
      openIncidents: incidentMap.get(row.id) ?? 0,
      version: row.version,
    })),
    nextCursor:
      rows.length > input.limit && last ? encodeListCursor(last.lastActivityAt, last.id) : null,
  };
}

// ---------------------------------------------------------------------------
// Extension point and event-driven advance
// ---------------------------------------------------------------------------

export interface CaseStartedEvent {
  caseId: string;
  caseNumber: string;
  zohoSalesOrderId: string | null;
  salesOrderNumber: string | null;
  customerName: string | null;
  ownerUserId: string | null;
  manual: boolean;
  commandId: string | null;
  eventId: string;
  occurredAt: string;
}

export type CaseStartedListener = (event: CaseStartedEvent) => void | Promise<void>;

type GlobalWithCaseListeners = typeof globalThis & {
  __unikCaseStartedListeners?: Set<CaseStartedListener>;
  __unikCaseEventsUnsubscribe?: () => void;
  __unikCaseAdvanceTxUnsubscribe?: () => void;
};

function caseStartedListeners(): Set<CaseStartedListener> {
  const scope = globalThis as GlobalWithCaseListeners;
  if (!scope.__unikCaseStartedListeners) scope.__unikCaseStartedListeners = new Set();
  return scope.__unikCaseStartedListeners;
}

/**
 * Runs `listener` after the commit of every new case (e.g. the agents layer
 * creates the case room). Failures are logged and never affect the case.
 */
export function onCaseStarted(listener: CaseStartedListener): () => void {
  caseStartedListeners().add(listener);
  return () => {
    caseStartedListeners().delete(listener);
  };
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export async function dispatchCaseStarted(events: OperationalEventRecord[]): Promise<void> {
  const listeners = [...caseStartedListeners()];
  if (listeners.length === 0) return;
  for (const event of events) {
    if (event.type !== OPS_EVENTS.case.created || !event.caseId) continue;
    const payload: CaseStartedEvent = {
      caseId: event.caseId,
      caseNumber: str(event.payload.caseNumber) ?? '',
      zohoSalesOrderId: str(event.payload.zohoSalesOrderId),
      salesOrderNumber: str(event.payload.salesOrderNumber),
      customerName: str(event.payload.customerName),
      ownerUserId: str(event.payload.ownerUserId),
      manual: event.payload.manual === true,
      commandId: event.commandId,
      eventId: event.id,
      occurredAt: event.occurredAt,
    };
    for (const listener of listeners) {
      try {
        await listener(payload);
      } catch (err) {
        log('case_started_listener_failed', {
          caseId: event.caseId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/** Facts of other modules that may let a case move. */
export const CASE_ADVANCE_TRIGGER_EVENTS: readonly string[] = [
  OPS_EVENTS.stock.reserved,
  OPS_EVENTS.stock.reservedProvisional,
  OPS_EVENTS.stock.released,
  OPS_EVENTS.stock.received,
  OPS_EVENTS.stock.issued,
  'stock.controlled',
  'stock.count_closed',
  OPS_EVENTS.production.finished,
  OPS_EVENTS.order.prepared,
  OPS_EVENTS.delivery.planned,
  OPS_EVENTS.delivery.dispatched,
  OPS_EVENTS.delivery.confirmed,
  OPS_EVENTS.delivery.partial,
  OPS_EVENTS.delivery.failed,
  'delivery.cancelled',
  OPS_EVENTS.zoho.shipmentConfirmed,
  OPS_EVENTS.zoho.shipmentConflict,
  OPS_EVENTS.zoho.shipmentFailed,
  OPS_EVENTS.zoho.deliveredMarked,
  OPS_EVENTS.allocation.ready,
  OPS_EVENTS.allocation.delivered,
  OPS_EVENTS.allocation.reopened,
  OPS_EVENTS.demand.fulfilled,
  OPS_EVENTS.request.resolved,
  OPS_EVENTS.request.rejected,
  OPS_EVENTS.request.cancelled,
  OPS_EVENTS.request.expired,
];

const TRIGGERS = new Set(CASE_ADVANCE_TRIGGER_EVENTS);
const ITEM_TRIGGERS = new Set(['stock.controlled', 'stock.count_closed']);

function isCaseCommandId(commandId: string | null): boolean {
  return Boolean(
    commandId && CASE_COMMAND_ID_PREFIXES.some((prefix) => commandId.startsWith(prefix))
  );
}

export interface CaseAdvanceJob {
  caseId: string;
  job: OperationalOutboxJob;
}

/**
 * `ops.case.advance` jobs for the cases touched by trigger events, planned
 * INSIDE the transaction that appends them (in-transaction reaction): the jobs
 * commit or roll back with the facts, so a restart right after the commit can
 * never leave a case waiting for an advance nobody enqueued. Case commands and
 * cases already advanced inside the same transaction are skipped. Count events
 * without a case wake the cases whose demands of that item still wait for
 * verification or planning.
 */
export async function planCaseAdvanceJobs(
  tx: Db,
  events: OperationalEventRecord[]
): Promise<CaseAdvanceJob[]> {
  const advanced = advancedInTransaction.get(tx as object);
  const caseIds = new Map<string, string>();
  const itemIds = new Map<string, string>();
  for (const event of events) {
    if (!TRIGGERS.has(event.type) || isCaseCommandId(event.commandId)) continue;
    const token = event.commandId ?? `event-${event.id}`;
    if (event.caseId) {
      if (advanced?.has(event.caseId)) continue;
      caseIds.set(event.caseId, token);
    } else if (ITEM_TRIGGERS.has(event.type) && typeof event.payload.zohoItemId === 'string') {
      itemIds.set(event.payload.zohoItemId, token);
    }
  }
  if (itemIds.size > 0) {
    const demands = await tx.caseDemand.findMany({
      where: {
        zohoItemId: { in: [...itemIds.keys()] },
        status: { in: ['pending', 'verifying', 'planned'] },
      },
      select: { caseId: true, zohoItemId: true },
      take: 100,
    });
    for (const demand of demands) {
      if (!caseIds.has(demand.caseId))
        caseIds.set(demand.caseId, itemIds.get(demand.zohoItemId ?? '') ?? 'count');
    }
  }
  return [...caseIds].map(([caseId, token]) => ({
    caseId,
    job: {
      type: CASE_JOB_TYPES.advance,
      payload: { caseId },
      dedupeKey: caseAdvanceDedupeKey(caseId, token),
      groupKey: `case:${caseId}`,
      priority: JOB_PRIORITY.normal,
      maxAttempts: 3,
      createdBy: 'operations.case_events',
    },
  }));
}

/** Subscribes once per module evaluation, replacing a previous subscription (hot reload, tests). */
function registerCaseEventListener(): void {
  const scope = globalThis as GlobalWithCaseListeners;
  scope.__unikCaseEventsUnsubscribe?.();
  scope.__unikCaseEventsUnsubscribe = onOperationalEvents(async (events) => {
    await dispatchCaseStarted(events);
  });
  scope.__unikCaseAdvanceTxUnsubscribe?.();
  scope.__unikCaseAdvanceTxUnsubscribe = onOperationalEventsInTransaction(
    async (tx, events, sink) => {
      for (const { job } of await planCaseAdvanceJobs(tx, events)) sink.outbox(job);
    }
  );
}

registerCaseEventListener();

// Orphan cases found by the supervisor are re-evaluated by this engine inside the
// supervisor's own command (its aggregate is not the case, so the case version is bumped here).
registerSupervisorCaseAdvancer((tx, caseId) => advanceCase(tx, caseId, requireCommandContext(tx)));

export { loadCaseState, buildFacts };
export type { CaseState };
