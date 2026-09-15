import { randomUUID } from 'crypto';
import type { z } from 'zod';
import type { CurrentUser } from '@/modules/auth/authorization';
import { isKnownPermission } from '@/modules/auth/permissions';
import { JOB_PRIORITY } from '@/modules/jobs/job-queue';
import {
  onApprovalDecided,
  registerApprovalScopePermission,
} from '@/modules/operations/approvals-service';
import {
  executeCommand,
  registerCommand,
  versionedAggregate,
  type CommandResult,
  type DomainCommand,
} from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import {
  onOperationalEventsInTransaction,
  type OperationalEventRecord,
  type OperationalOutboxJob,
} from '@/modules/operations/events-service';
import { isOpsFlagEnabled } from '@/modules/operations/operations-config';
import { OPS_EVENTS, type OperationsActor } from '@/modules/operations/types';
import {
  activateBomInTx,
  activateBomSchema,
  createBomInTx,
  createBomSchema,
  retireBomInTx,
  retireBomSchema,
  updateBomDraftInTx,
  updateBomSchema,
  type CreateBomInput,
  type UpdateBomInput,
} from './bom-service';
import { capacityAlertInTx, capacityAlertSchema, type CapacityAlertResult } from './capacity-service';
import type { BomDTO, WorkCenterDTO } from './manufacturing-dto';
import { assertActorMayAny, assertAggregateMatches, loadOrder, type Db } from './manufacturing-helpers';
import {
  MANUFACTURING_AREA_KEY,
  MANUFACTURING_COMMANDS,
  MANUFACTURING_JOB_TYPES,
  MANUFACTURING_OBJECT_TYPES,
  MANUFACTURING_SYSTEM_ACTOR_ID,
  STOCK_ARRIVAL_EVENTS,
} from './manufacturing-types';
import { MANUFACTURING_APPROVER_PERMISSION } from './permissions';
import {
  finishOperationInTx,
  finishOperationSchema,
  handleScrapDecision,
  handleSubstitutionDecision,
  inspectInTx,
  inspectSchema,
  pauseOperationInTx,
  pauseOperationSchema,
  recordConsumptionInTx,
  recordConsumptionSchema,
  recordOutputInTx,
  recordOutputSchema,
  requestScrapReviewInTx,
  scrapReviewSchema,
  startOperationInTx,
  startOperationSchema,
  type ConsumptionResult,
  type FinishOperationInput,
  type InspectInput,
  type InspectionResult,
  type OperationResult,
  type OutputResult,
  type PauseOperationInput,
  type RecordConsumptionInput,
  type RecordOutputInput,
  type ScrapReviewInput,
  type ScrapReviewOutcome,
  type StartOperationInput,
} from './production-floor-service';
import {
  cancelInTx,
  cancelOrderSchema,
  createOrderFromBomSchema,
  createProductionOrderFromBomInTx,
  createTransformationOrderInTx,
  createTransformationOrderSchema,
  intakeRequestSchema,
  intakeTransformationRequestInTx,
  prepareInTx,
  prepareOrderSchema,
  releaseInTx,
  releaseOrderSchema,
  reserveMaterialsInTx,
  reserveMaterialsSchema,
  scheduleOrderInTx,
  scheduleOrderSchema,
  type CancelOrderInput,
  type CancelResult,
  type CreateOrderFromBomInput,
  type CreateOrderResult,
  type CreateTransformationOrderInput,
  type IntakeResult,
  type PrepareOrderInput,
  type PrepareResult,
  type ReleaseOrderInput,
  type ReleaseResult,
  type ReserveMaterialsInput,
  type ReserveMaterialsResult,
  type ScheduleOrderInput,
  type ScheduleResult,
} from './production-service';
import {
  createWorkCenterInTx,
  createWorkCenterSchema,
  normalizeWorkCenterKey,
  updateWorkCenterInTx,
  updateWorkCenterSchema,
  type CreateWorkCenterInput,
  type UpdateWorkCenterInput,
} from './work-centers-service';

/**
 * Registration of the manufacturing commands (plan 6.2) and the uniform service
 * signatures `fn(actor, input, {commandId})` used by routes, server actions, the
 * floor tablets (offline queue) and the AI tools.
 *
 * | command | aggregate | permission | actors |
 * |---|---|---|---|
 * | manufacturing.work_center.create / update | none | manufacturing.manage_boms | user |
 * | manufacturing.bom.create / update / activate / retire | none | manufacturing.manage_boms | user |
 * | manufacturing.order.create_transformation / create_from_bom | none | manufacturing.manage_orders | user, ai, system |
 * | manufacturing.order.intake_request | none | — | system |
 * | manufacturing.order.schedule | production_order | manufacturing.manage_orders | user, ai |
 * | manufacturing.order.reserve_materials | production_order | manufacturing.manage_orders | user, ai, system |
 * | manufacturing.order.prepare | production_order | manage_orders or inventory.manage | user, ai |
 * | manufacturing.operation.start / pause / finish | production_order | manufacturing.operate | user, ai |
 * | manufacturing.order.record_consumption / record_output | production_order | manufacturing.operate | user, ai |
 * | manufacturing.order.inspect | production_order | manufacturing.inspect | user |
 * | manufacturing.order.request_scrap_review | production_order | operate or manage_orders | user, ai |
 * | manufacturing.order.release / cancel | production_order | manufacturing.manage_orders | user, ai |
 * | manufacturing.capacity.alert | none | — | system |
 *
 * Also registers, once per process: the in-transaction reaction that turns a
 * `transformation` request into the intake job and wakes blocked orders when
 * stock arrives or a shortfall request is resolved, the approval reactions
 * (substitutions outside the BOM, excess scrap) and the approver permission of
 * the `production_incident` scope. Import this file from
 * `operations/register-commands.ts`.
 */

const ORDER = MANUFACTURING_OBJECT_TYPES.productionOrder;
const orderAggregate = versionedAggregate(ORDER, 'productionOrder');
const USERS = ['user'] as const;
const PEOPLE_AND_BOTS = ['user', 'ai'] as const;
const ANY_ACTOR = ['user', 'ai', 'system'] as const;
const SYSTEM_ONLY = ['system'] as const;

async function assertManufacturingEnabled(): Promise<void> {
  if (!(await isOpsFlagEnabled('manufacturing'))) {
    throw new OperationsError('module_disabled', 'El módulo de manufactura está desactivado');
  }
}

async function orderFor(tx: Db, cmd: Pick<DomainCommand, 'aggregate'>, productionOrderId: string) {
  assertAggregateMatches(cmd, productionOrderId);
  return loadOrder(tx, productionOrderId);
}

async function versionOf(tx: Db, productionOrderId: string): Promise<number | undefined> {
  const row = await tx.productionOrder.findUnique({ where: { id: productionOrderId }, select: { version: true } });
  return row?.version;
}

// ---------------------------------------------------------------------------
// Work centers and BOMs
// ---------------------------------------------------------------------------

registerCommand(MANUFACTURING_COMMANDS.workCenterCreate, {
  schema: createWorkCenterSchema,
  permission: 'manufacturing.manage_boms',
  aggregate: 'none',
  actorTypes: USERS,
  async handler(tx, cmd) {
    await assertManufacturingEnabled();
    return { data: await createWorkCenterInTx(tx, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.workCenterUpdate, {
  schema: updateWorkCenterSchema,
  permission: 'manufacturing.manage_boms',
  aggregate: 'none',
  actorTypes: USERS,
  async handler(tx, cmd) {
    await assertManufacturingEnabled();
    return { data: await updateWorkCenterInTx(tx, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.bomCreate, {
  schema: createBomSchema,
  permission: 'manufacturing.manage_boms',
  aggregate: 'none',
  actorTypes: USERS,
  async handler(tx, cmd) {
    await assertManufacturingEnabled();
    return { data: await createBomInTx(tx, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.bomUpdate, {
  schema: updateBomSchema,
  permission: 'manufacturing.manage_boms',
  aggregate: 'none',
  actorTypes: USERS,
  async handler(tx, cmd) {
    await assertManufacturingEnabled();
    return { data: await updateBomDraftInTx(tx, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.bomActivate, {
  schema: activateBomSchema,
  permission: 'manufacturing.manage_boms',
  aggregate: 'none',
  actorTypes: USERS,
  async handler(tx, cmd) {
    await assertManufacturingEnabled();
    return { data: await activateBomInTx(tx, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.bomRetire, {
  schema: retireBomSchema,
  permission: 'manufacturing.manage_boms',
  aggregate: 'none',
  actorTypes: USERS,
  async handler(tx, cmd) {
    await assertManufacturingEnabled();
    return { data: await retireBomInTx(tx, cmd.payload) };
  },
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

registerCommand(MANUFACTURING_COMMANDS.orderCreateTransformation, {
  schema: createTransformationOrderSchema,
  permission: 'manufacturing.manage_orders',
  aggregate: 'none',
  actorTypes: ANY_ACTOR,
  async handler(tx, cmd) {
    await assertManufacturingEnabled();
    const data = await createTransformationOrderInTx(tx, cmd.payload);
    return { data, aggregateVersion: await versionOf(tx, data.productionOrderId) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.orderCreateFromBom, {
  schema: createOrderFromBomSchema,
  permission: 'manufacturing.manage_orders',
  aggregate: 'none',
  actorTypes: ANY_ACTOR,
  async handler(tx, cmd) {
    await assertManufacturingEnabled();
    const data = await createProductionOrderFromBomInTx(tx, cmd.payload);
    return { data, aggregateVersion: await versionOf(tx, data.productionOrderId) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.orderIntakeRequest, {
  schema: intakeRequestSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd) {
    await assertManufacturingEnabled();
    return { data: await intakeTransformationRequestInTx(tx, cmd.payload.requestId) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.orderSchedule, {
  schema: scheduleOrderSchema,
  permission: 'manufacturing.manage_orders',
  aggregate: orderAggregate,
  actorTypes: PEOPLE_AND_BOTS,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    const { orderActionError } = await import('./production-state');
    const error = orderActionError('schedule', order.status);
    if (error) throw new OperationsError('invalid_state', error);
    return {
      data: await scheduleOrderInTx(tx, ctx, order, {
        workCenterId: cmd.payload.workCenterId ?? null,
        plannedStartAt: cmd.payload.plannedStartAt ? new Date(cmd.payload.plannedStartAt) : null,
      }),
    };
  },
});

registerCommand(MANUFACTURING_COMMANDS.orderReserveMaterials, {
  schema: reserveMaterialsSchema,
  permission: 'manufacturing.manage_orders',
  aggregate: orderAggregate,
  actorTypes: ANY_ACTOR,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    return { data: await reserveMaterialsInTx(tx, ctx, order, { allowProvisional: cmd.payload.allowProvisional === true }) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.orderPrepare, {
  schema: prepareOrderSchema,
  aggregate: orderAggregate,
  actorTypes: PEOPLE_AND_BOTS,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    assertActorMayAny(ctx, ['manufacturing.manage_orders', 'inventory.manage']);
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    return { data: await prepareInTx(tx, ctx, order) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.operationStart, {
  schema: startOperationSchema,
  permission: 'manufacturing.operate',
  aggregate: orderAggregate,
  actorTypes: PEOPLE_AND_BOTS,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    return { data: await startOperationInTx(tx, ctx, cmd, order, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.operationPause, {
  schema: pauseOperationSchema,
  permission: 'manufacturing.operate',
  aggregate: orderAggregate,
  actorTypes: PEOPLE_AND_BOTS,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    return { data: await pauseOperationInTx(tx, ctx, cmd, order, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.operationFinish, {
  schema: finishOperationSchema,
  permission: 'manufacturing.operate',
  aggregate: orderAggregate,
  actorTypes: PEOPLE_AND_BOTS,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    return { data: await finishOperationInTx(tx, ctx, cmd, order, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.consumptionRecord, {
  schema: recordConsumptionSchema,
  permission: 'manufacturing.operate',
  aggregate: orderAggregate,
  actorTypes: PEOPLE_AND_BOTS,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    return { data: await recordConsumptionInTx(tx, ctx, order, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.inspect, {
  schema: inspectSchema,
  permission: 'manufacturing.inspect',
  aggregate: orderAggregate,
  actorTypes: USERS,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    return { data: await inspectInTx(tx, ctx, order, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.outputRecord, {
  schema: recordOutputSchema,
  permission: 'manufacturing.operate',
  aggregate: orderAggregate,
  actorTypes: PEOPLE_AND_BOTS,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    return { data: await recordOutputInTx(tx, ctx, order, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.scrapReview, {
  schema: scrapReviewSchema,
  aggregate: orderAggregate,
  actorTypes: PEOPLE_AND_BOTS,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    assertActorMayAny(ctx, ['manufacturing.operate', 'manufacturing.manage_orders']);
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    return { data: await requestScrapReviewInTx(tx, ctx, order, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.release, {
  schema: releaseOrderSchema,
  permission: 'manufacturing.manage_orders',
  aggregate: orderAggregate,
  actorTypes: PEOPLE_AND_BOTS,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    return { data: await releaseInTx(tx, ctx, order, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.cancel, {
  schema: cancelOrderSchema,
  permission: 'manufacturing.manage_orders',
  aggregate: orderAggregate,
  actorTypes: PEOPLE_AND_BOTS,
  async handler(tx, cmd, ctx) {
    await assertManufacturingEnabled();
    const order = await orderFor(tx, cmd, cmd.payload.productionOrderId);
    return { data: await cancelInTx(tx, ctx, order, cmd.payload) };
  },
});

registerCommand(MANUFACTURING_COMMANDS.capacityAlert, {
  schema: capacityAlertSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd) {
    await assertManufacturingEnabled();
    return { data: await capacityAlertInTx(tx, cmd.payload) };
  },
});

// ---------------------------------------------------------------------------
// Uniform service signatures
// ---------------------------------------------------------------------------

export interface ManufacturingCommandOptions {
  /** Client-generated id (offline queue); a new UUID otherwise. */
  commandId?: string;
  expectedVersion?: number;
  deviceId?: string;
  /** Instant on the device (real minutes of operations recorded offline). */
  occurredAt?: string;
  /** Server clock of the execution (tests). */
  now?: Date;
}

/** `ai` for an AI identity (set only by `buildBotActor`), `user` for people. */
export function manufacturingActorOf(actor: CurrentUser): OperationsActor {
  return { type: actor.isBot === true ? 'ai' : 'user', id: actor.id };
}

function run<D>(
  actor: CurrentUser,
  type: string,
  aggregate: { type: string; id: string },
  payload: unknown,
  options: ManufacturingCommandOptions = {}
): Promise<CommandResult<D>> {
  return executeCommand<D>(
    {
      commandId: options.commandId ?? randomUUID(),
      type,
      actor: manufacturingActorOf(actor),
      aggregate,
      expectedVersion: options.expectedVersion,
      payload,
      deviceId: options.deviceId,
      occurredAt: options.occurredAt,
    },
    actor,
    { now: options.now }
  );
}

const orderTarget = (productionOrderId: unknown) => ({ type: ORDER, id: String(productionOrderId ?? '') });

function creationTarget(input: { demandAllocationId?: string | null }): { type: string; id: string } {
  return {
    type: ORDER,
    id: input.demandAllocationId ? `production_order:allocation:${input.demandAllocationId}` : 'production_order:new',
  };
}

export const createWorkCenter = (actor: CurrentUser, input: CreateWorkCenterInput, options?: ManufacturingCommandOptions) =>
  run<WorkCenterDTO>(
    actor,
    MANUFACTURING_COMMANDS.workCenterCreate,
    { type: MANUFACTURING_OBJECT_TYPES.workCenter, id: `work_center:${normalizeWorkCenterKey(String(input.key ?? '')) || 'new'}` },
    input,
    options
  );

export const updateWorkCenter = (actor: CurrentUser, input: UpdateWorkCenterInput, options?: ManufacturingCommandOptions) =>
  run<WorkCenterDTO>(
    actor,
    MANUFACTURING_COMMANDS.workCenterUpdate,
    { type: MANUFACTURING_OBJECT_TYPES.workCenter, id: String(input.workCenterId ?? '') },
    input,
    options
  );

export const createBom = (actor: CurrentUser, input: CreateBomInput, options?: ManufacturingCommandOptions) =>
  run<BomDTO>(
    actor,
    MANUFACTURING_COMMANDS.bomCreate,
    { type: MANUFACTURING_OBJECT_TYPES.bom, id: `bom:${String(input.outputZohoItemId ?? '').slice(0, 150)}` },
    input,
    options
  );

export const updateBomDraft = (actor: CurrentUser, input: UpdateBomInput, options?: ManufacturingCommandOptions) =>
  run<BomDTO>(actor, MANUFACTURING_COMMANDS.bomUpdate, { type: MANUFACTURING_OBJECT_TYPES.bom, id: String(input.bomId ?? '') }, input, options);

export const activateBom = (actor: CurrentUser, input: z.input<typeof activateBomSchema>, options?: ManufacturingCommandOptions) =>
  run<BomDTO>(actor, MANUFACTURING_COMMANDS.bomActivate, { type: MANUFACTURING_OBJECT_TYPES.bom, id: String(input.bomId ?? '') }, input, options);

export const retireBom = (actor: CurrentUser, input: z.input<typeof retireBomSchema>, options?: ManufacturingCommandOptions) =>
  run<BomDTO>(actor, MANUFACTURING_COMMANDS.bomRetire, { type: MANUFACTURING_OBJECT_TYPES.bom, id: String(input.bomId ?? '') }, input, options);

export const createTransformationOrder = (
  actor: CurrentUser,
  input: CreateTransformationOrderInput,
  options?: ManufacturingCommandOptions
) => run<CreateOrderResult>(actor, MANUFACTURING_COMMANDS.orderCreateTransformation, creationTarget(input), input, options);

export const createProductionOrderFromBom = (
  actor: CurrentUser,
  input: CreateOrderFromBomInput,
  options?: ManufacturingCommandOptions
) => run<CreateOrderResult>(actor, MANUFACTURING_COMMANDS.orderCreateFromBom, creationTarget(input), input, options);

export const scheduleProductionOrder = (actor: CurrentUser, input: ScheduleOrderInput, options?: ManufacturingCommandOptions) =>
  run<ScheduleResult>(actor, MANUFACTURING_COMMANDS.orderSchedule, orderTarget(input.productionOrderId), input, options);

export const reserveMaterials = (actor: CurrentUser, input: ReserveMaterialsInput, options?: ManufacturingCommandOptions) =>
  run<ReserveMaterialsResult>(actor, MANUFACTURING_COMMANDS.orderReserveMaterials, orderTarget(input.productionOrderId), input, options);

export const prepareProductionOrder = (actor: CurrentUser, input: PrepareOrderInput, options?: ManufacturingCommandOptions) =>
  run<PrepareResult>(actor, MANUFACTURING_COMMANDS.orderPrepare, orderTarget(input.productionOrderId), input, options);

export const startOperation = (actor: CurrentUser, input: StartOperationInput, options?: ManufacturingCommandOptions) =>
  run<OperationResult>(actor, MANUFACTURING_COMMANDS.operationStart, orderTarget(input.productionOrderId), input, options);

export const pauseOperation = (actor: CurrentUser, input: PauseOperationInput, options?: ManufacturingCommandOptions) =>
  run<OperationResult>(actor, MANUFACTURING_COMMANDS.operationPause, orderTarget(input.productionOrderId), input, options);

export const finishOperation = (actor: CurrentUser, input: FinishOperationInput, options?: ManufacturingCommandOptions) =>
  run<OperationResult>(actor, MANUFACTURING_COMMANDS.operationFinish, orderTarget(input.productionOrderId), input, options);

export const recordConsumption = (actor: CurrentUser, input: RecordConsumptionInput, options?: ManufacturingCommandOptions) =>
  run<ConsumptionResult>(actor, MANUFACTURING_COMMANDS.consumptionRecord, orderTarget(input.productionOrderId), input, options);

export const inspectProductionOrder = (actor: CurrentUser, input: InspectInput, options?: ManufacturingCommandOptions) =>
  run<InspectionResult>(actor, MANUFACTURING_COMMANDS.inspect, orderTarget(input.productionOrderId), input, options);

export const recordOutput = (actor: CurrentUser, input: RecordOutputInput, options?: ManufacturingCommandOptions) =>
  run<OutputResult>(actor, MANUFACTURING_COMMANDS.outputRecord, orderTarget(input.productionOrderId), input, options);

export const requestScrapReview = (actor: CurrentUser, input: ScrapReviewInput, options?: ManufacturingCommandOptions) =>
  run<ScrapReviewOutcome>(actor, MANUFACTURING_COMMANDS.scrapReview, orderTarget(input.productionOrderId), input, options);

export const releaseProductionOrder = (actor: CurrentUser, input: ReleaseOrderInput, options?: ManufacturingCommandOptions) =>
  run<ReleaseResult>(actor, MANUFACTURING_COMMANDS.release, orderTarget(input.productionOrderId), input, options);

export const cancelProductionOrder = (actor: CurrentUser, input: CancelOrderInput, options?: ManufacturingCommandOptions) =>
  run<CancelResult>(actor, MANUFACTURING_COMMANDS.cancel, orderTarget(input.productionOrderId), input, options);

/** Jobs and sweeps: a `system` command with a deterministic id. */
export function runManufacturingSystemCommand<D>(input: {
  type: string;
  commandId: string;
  aggregate: { type: string; id: string };
  payload: Record<string, unknown>;
  now?: Date;
}): Promise<CommandResult<D>> {
  return executeCommand<D>(
    {
      commandId: input.commandId,
      type: input.type,
      actor: { type: 'system', id: MANUFACTURING_SYSTEM_ACTOR_ID },
      aggregate: input.aggregate,
      payload: input.payload,
    },
    null,
    { now: input.now }
  );
}

export type { CapacityAlertResult, IntakeResult };

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Jobs planned INSIDE the transaction that appends the events (committed or
 * rolled back with them): intake of transformation requests for Manufactura,
 * and a retry of blocked orders when a shortfall request is resolved or stock of
 * an item arrives (only when some order is blocked).
 */
export async function planManufacturingJobs(
  tx: Db,
  events: readonly OperationalEventRecord[]
): Promise<OperationalOutboxJob[]> {
  const jobs: OperationalOutboxJob[] = [];
  const items = new Set<string>();
  for (const event of events) {
    const payload = event.payload ?? {};
    const requestId = text(payload.requestId);
    if (
      event.type === OPS_EVENTS.request.created &&
      payload.kind === 'transformation' &&
      payload.toAreaKey === MANUFACTURING_AREA_KEY &&
      requestId
    ) {
      jobs.push({
        type: MANUFACTURING_JOB_TYPES.intakeRequest,
        payload: { requestId },
        dedupeKey: `mfg-intake:${requestId}`,
        groupKey: event.caseId ? `case:${event.caseId}` : undefined,
        priority: JOB_PRIORITY.normal,
        maxAttempts: 5,
        createdBy: 'manufacturing.intake',
      });
    } else if (event.type === OPS_EVENTS.request.resolved && payload.kind === 'material_shortfall' && requestId) {
      jobs.push({
        type: MANUFACTURING_JOB_TYPES.retryBlocked,
        payload: { requestId },
        dedupeKey: `mfg-retry:request:${requestId}`,
        priority: JOB_PRIORITY.normal,
        maxAttempts: 3,
        createdBy: 'manufacturing.retry',
      });
    } else if (STOCK_ARRIVAL_EVENTS.includes(event.type)) {
      const zohoItemId = text(payload.zohoItemId);
      if (zohoItemId) items.add(zohoItemId);
    }
  }
  if (items.size > 0) {
    const blocked = await tx.productionOrder.findFirst({ where: { status: 'blocked' }, select: { id: true } });
    if (blocked) {
      for (const zohoItemId of items) {
        jobs.push({
          type: MANUFACTURING_JOB_TYPES.retryBlocked,
          payload: { zohoItemId },
          dedupeKey: `mfg-retry:item:${zohoItemId}`,
          priority: JOB_PRIORITY.normal,
          maxAttempts: 3,
          createdBy: 'manufacturing.retry',
        });
      }
    }
  }
  return jobs;
}

type GlobalWithManufacturing = typeof globalThis & {
  __unikManufacturingReactions?: Array<() => void>;
};

/** Subscribes once per module evaluation, replacing a previous subscription (hot reload, tests). */
function registerManufacturingReactions(): void {
  const scope = globalThis as GlobalWithManufacturing;
  for (const unsubscribe of scope.__unikManufacturingReactions ?? []) unsubscribe();
  scope.__unikManufacturingReactions = [
    onOperationalEventsInTransaction(async (tx, events, sink) => {
      for (const job of await planManufacturingJobs(tx, events)) sink.outbox(job);
    }),
    onApprovalDecided(MANUFACTURING_OBJECT_TYPES.materialConsumption, handleSubstitutionDecision),
    onApprovalDecided(MANUFACTURING_OBJECT_TYPES.scrapReview, handleScrapDecision),
  ];
  if (isKnownPermission(MANUFACTURING_APPROVER_PERMISSION)) {
    registerApprovalScopePermission('production_incident', MANUFACTURING_APPROVER_PERMISSION);
  }
}

registerManufacturingReactions();
