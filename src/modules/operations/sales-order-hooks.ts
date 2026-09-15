import type { Prisma } from '@prisma/client';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { getOperationsConfig } from './operations-config';
import { evaluateStartPolicy } from './start-policy';

/**
 * Hooks of the Zoho sales order normalizer into the operations core (plan
 * section 2.4). They run inside the normalizer transaction and only enqueue
 * durable jobs (`enqueueJob({tx})`, `INSERT … ON CONFLICT`): the case itself
 * is built later by `ops.case.start` / `ops.case.replan` (case-jobs.ts), so
 * normalization never depends on the case engine.
 *
 * Contract: the hooks never throw and never break the normalizer transaction.
 * They run inside a SAVEPOINT: in PostgreSQL a failed statement aborts the
 * whole transaction (every later statement fails with 25P02), so catching the
 * JavaScript error is not enough — the savepoint is rolled back and the
 * normalization goes on. Any failure is logged and reported as
 * `{action: 'failed'}`; the normalizer additionally wraps the call.
 *
 * This module is deliberately light (config, policy and the job queue only) so
 * the normalizer does not load inventory, logistics or the case engine.
 */

type Db = Prisma.TransactionClient;

export const CASE_KIND = 'sales_fulfillment';
export const CASE_SOURCE_TYPE = 'sales_order';

export const CASE_JOB_TYPES = {
  start: 'ops.case.start',
  replan: 'ops.case.replan',
  advance: 'ops.case.advance',
  reconcileOrders: 'ops.case.reconcile_orders',
} as const;

export const caseStartDedupeKey = (zohoSalesOrderId: string) => `case:so:${zohoSalesOrderId}`;
export const caseReplanDedupeKey = (zohoSalesOrderId: string, changeEventId: string) =>
  `replan:so:${zohoSalesOrderId}:${changeEventId}`;
/**
 * One advance per case per triggering command: a job already running for the
 * case may have read the state before the new facts committed, so bursts are
 * only collapsed within the same command (`token` = commandId or event id).
 */
export const caseAdvanceDedupeKey = (caseId: string, token: string) =>
  `case:advance:${caseId}:${token}`;

export interface SalesOrderHookInput {
  /** SalesOrder.id */
  salesOrderId: string;
  zohoSalesOrderId: string;
}

export interface SalesOrderChangedHookInput extends SalesOrderHookInput {
  /** EntityChangeEvent.id recorded for this change. */
  changeEventId: string;
}

export interface SalesOrderHookOutcome {
  action: 'start_enqueued' | 'replan_enqueued' | 'none' | 'failed';
  reason?: string;
  jobId?: string;
  deduplicated?: boolean;
}

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-sales-order-hooks', event, ...extra }));

function failed(hook: string, input: SalesOrderHookInput, err: unknown): SalesOrderHookOutcome {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    JSON.stringify({
      component: 'operations-sales-order-hooks',
      event: 'hook_failed',
      hook,
      salesOrderId: input.salesOrderId,
      zohoSalesOrderId: input.zohoSalesOrderId,
      message,
    })
  );
  return { action: 'failed', reason: message };
}

const SAVEPOINT = 'ops_sales_order_hook';

/** Runs a hook body inside a savepoint so a SQL error never aborts the caller's transaction. */
async function inSavepoint(
  tx: Db,
  hook: string,
  input: SalesOrderHookInput,
  body: () => Promise<SalesOrderHookOutcome>
): Promise<SalesOrderHookOutcome> {
  try {
    await tx.$executeRawUnsafe(`SAVEPOINT ${SAVEPOINT}`);
  } catch (err) {
    return failed(hook, input, err);
  }
  try {
    const outcome = await body();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return outcome;
  } catch (err) {
    try {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    } catch (rollbackError) {
      log('savepoint_rollback_failed', {
        hook,
        zohoSalesOrderId: input.zohoSalesOrderId,
        message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
    return failed(hook, input, err);
  }
}

async function enqueueStartIfEligible(
  tx: Db,
  input: SalesOrderHookInput,
  source: 'imported' | 'changed'
): Promise<SalesOrderHookOutcome> {
  const order = await tx.salesOrder.findUnique({
    where: { id: input.salesOrderId },
    select: {
      status: true,
      shippedStatus: true,
      createdTime: true,
      orderDate: true,
      locationId: true,
    },
  });
  if (!order) return { action: 'none', reason: 'order_missing' };
  const config = await getOperationsConfig();
  const decision = evaluateStartPolicy(order, config);
  if (!decision.eligible) return { action: 'none', reason: decision.reason };
  const job = await enqueueJob({
    type: CASE_JOB_TYPES.start,
    payload: { zohoSalesOrderId: input.zohoSalesOrderId },
    dedupeKey: caseStartDedupeKey(input.zohoSalesOrderId),
    priority: JOB_PRIORITY.interactive,
    maxAttempts: 3,
    createdBy: 'sales-orders-normalizer',
    tx,
  });
  log('case_start_enqueued', {
    zohoSalesOrderId: input.zohoSalesOrderId,
    jobId: job.id,
    deduplicated: job.deduplicated,
    source,
    basis: decision.basis,
  });
  return { action: 'start_enqueued', jobId: job.id, deduplicated: job.deduplicated };
}

/** First import of a sales order: enqueue `ops.case.start` when the start policy allows it. */
export async function onSalesOrderImported(
  tx: Db,
  input: SalesOrderHookInput
): Promise<SalesOrderHookOutcome> {
  return inSavepoint(tx, 'imported', input, () => enqueueStartIfEligible(tx, input, 'imported'));
}

/**
 * A recorded change of an existing sales order: enqueue `ops.case.replan` when
 * the order has a live case, or `ops.case.start` when it has none and just
 * became eligible (e.g. draft → confirmed).
 */
export async function onSalesOrderChanged(
  tx: Db,
  input: SalesOrderChangedHookInput
): Promise<SalesOrderHookOutcome> {
  return inSavepoint(tx, 'changed', input, async () => {
    const existing = await tx.operationalCase.findFirst({
      where: { kind: CASE_KIND, sourceType: CASE_SOURCE_TYPE, sourceId: input.zohoSalesOrderId },
      select: { id: true, status: true },
    });
    if (!existing) return await enqueueStartIfEligible(tx, input, 'changed');
    if (existing.status === 'closed' || existing.status === 'cancelled') {
      return { action: 'none', reason: 'case_closed' };
    }
    const config = await getOperationsConfig();
    if (!config.isEnabled) return { action: 'none', reason: 'core_disabled' };
    const job = await enqueueJob({
      type: CASE_JOB_TYPES.replan,
      payload: {
        caseId: existing.id,
        zohoSalesOrderId: input.zohoSalesOrderId,
        changeEventId: input.changeEventId,
      },
      dedupeKey: caseReplanDedupeKey(input.zohoSalesOrderId, input.changeEventId),
      groupKey: `case:${existing.id}`,
      priority: JOB_PRIORITY.interactive,
      maxAttempts: 3,
      createdBy: 'sales-orders-normalizer',
      tx,
    });
    log('case_replan_enqueued', {
      caseId: existing.id,
      zohoSalesOrderId: input.zohoSalesOrderId,
      changeEventId: input.changeEventId,
      jobId: job.id,
      deduplicated: job.deduplicated,
    });
    return { action: 'replan_enqueued', jobId: job.id, deduplicated: job.deduplicated };
  });
}
