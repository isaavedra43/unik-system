import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { loadActiveCurrentUser } from '@/modules/auth/authorization';
import {
  enqueueJob,
  JOB_PRIORITY,
  registerJobHandler,
  type JobContext,
} from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import {
  advanceCaseCommand,
  CASE_AGGREGATE_TYPE,
  CASE_COMMANDS,
  startSalesFulfillment,
} from './case-service';
import type { CommandResult } from './commands';
import { getOperationsConfig } from './operations-config';
import { replanCase } from './replan';
import {
  CASE_JOB_TYPES,
  CASE_KIND,
  CASE_SOURCE_TYPE,
  caseStartDedupeKey,
} from './sales-order-hooks';
import {
  evaluateStartPolicy,
  START_EXCLUDED_ORDER_STATUSES,
  START_EXCLUDED_SHIPPED_STATUSES,
} from './start-policy';

/**
 * Background jobs of the case engine (plan sections 2.4 and 2.5):
 *
 * - `ops.case.start` `{zohoSalesOrderId}` → command `case.start` (system actor);
 *   `{zohoSalesOrderId, manual: true, requestedByUserId}` runs the manual start
 *   as that person (still active, with `operations.manage`).
 * - `ops.case.replan` `{caseId?, zohoSalesOrderId, changeEventId}` → `case.replan`.
 * - `ops.case.advance` `{caseId}` → `case.advance` (facts from other modules).
 * - Recurring `ops.case.reconcile_orders` every 5 minutes: eligible sales
 *   orders created since `cutoverDate` without a case (imported while the
 *   module was off, a lost job…) in batches of 200 → `ops.case.start`.
 *
 * Command ids include the job id and attempt: a re-delivered attempt replays
 * the stored result, while a retry after a concurrency rejection runs again.
 * Business rejections complete the job (they are results, not failures);
 * concurrency rejections and unexpected errors throw so the queue retries.
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-case-jobs', event, ...extra }));

export const CASE_RECONCILE_EVERY_MS = 5 * 60_000;
export const CASE_RECONCILE_BATCH = 200;

export const CASE_JOB_ACTORS = {
  start: 'job:ops.case.start',
  replan: 'job:ops.case.replan',
  advance: 'job:ops.case.advance',
} as const;

const RETRYABLE_CODES = ['concurrency_conflict', 'version_conflict'];

const idText = z.string().trim().min(1).max(120);
const startPayloadSchema = z.object({
  zohoSalesOrderId: idText,
  manual: z.boolean().optional(),
  requestedByUserId: idText.optional(),
});
const replanPayloadSchema = z.object({
  caseId: idText.optional(),
  zohoSalesOrderId: idText,
  changeEventId: idText,
});
const advancePayloadSchema = z.object({ caseId: idText });

/** Safe command id segment (Zoho and cuid ids already are). */
function segment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
}

function summarize(result: CommandResult<unknown>): Record<string, unknown> {
  return {
    commandId: result.commandId,
    status: result.status,
    errorCode: result.errorCode ?? null,
    message: result.message ?? null,
    replayed: result.replayed === true,
    createdWorkItems: result.createdWorkItemIds.length,
    data: result.data ?? null,
  };
}

function throwIfRetryable(type: string, result: CommandResult<unknown>): void {
  if (
    result.status === 'rejected' &&
    result.errorCode &&
    RETRYABLE_CODES.includes(result.errorCode)
  ) {
    throw new Error(`${type} rechazado por concurrencia (${result.errorCode}); se reintentará`);
  }
}

export async function runCaseStartJob(job: JobContext<unknown>): Promise<Record<string, unknown>> {
  const parsed = startPayloadSchema.safeParse(job.payload);
  if (!parsed.success) return { skipped: 'invalid_payload' };
  const { zohoSalesOrderId, manual, requestedByUserId } = parsed.data;
  const commandId = `ops:case.start:so:${segment(zohoSalesOrderId)}:${segment(job.id)}:${job.attempt}`;
  let result: CommandResult<unknown>;
  if (manual) {
    // The manual override (cutover and pilot skipped) belongs to the person who asked for it.
    const requester = requestedByUserId ? await loadActiveCurrentUser(requestedByUserId) : null;
    if (!requester) {
      log('case_start_job_requester_unavailable', {
        jobId: job.id,
        zohoSalesOrderId,
        requestedByUserId: requestedByUserId ?? null,
      });
      return { skipped: 'requester_unavailable', zohoSalesOrderId };
    }
    result = await startSalesFulfillment(zohoSalesOrderId, {
      commandId,
      actor: { type: 'user', id: requester.id },
      user: requester,
      manual: true,
    });
  } else {
    result = await startSalesFulfillment(zohoSalesOrderId, {
      commandId,
      actor: { type: 'system', id: CASE_JOB_ACTORS.start },
    });
  }
  log('case_start_job', {
    jobId: job.id,
    zohoSalesOrderId,
    status: result.status,
    errorCode: result.errorCode ?? null,
  });
  throwIfRetryable(CASE_COMMANDS.start, result);
  return summarize(result);
}

export async function runCaseReplanJob(job: JobContext<unknown>): Promise<Record<string, unknown>> {
  const parsed = replanPayloadSchema.safeParse(job.payload);
  if (!parsed.success) return { skipped: 'invalid_payload' };
  const { zohoSalesOrderId, changeEventId } = parsed.data;
  const caseId =
    parsed.data.caseId ??
    (
      await prisma.operationalCase.findFirst({
        where: { kind: CASE_KIND, sourceType: CASE_SOURCE_TYPE, sourceId: zohoSalesOrderId },
        select: { id: true },
      })
    )?.id;
  if (!caseId) return { skipped: 'case_missing', zohoSalesOrderId };
  const result = await replanCase(caseId, {
    commandId: `ops:case.replan:${segment(caseId)}:${segment(changeEventId)}:${job.attempt}`,
    systemActorId: CASE_JOB_ACTORS.replan,
    changeEventId,
  });
  log('case_replan_job', {
    jobId: job.id,
    caseId,
    changeEventId,
    status: result.status,
    errorCode: result.errorCode ?? null,
  });
  throwIfRetryable(CASE_COMMANDS.replan, result);
  return summarize(result);
}

export async function runCaseAdvanceJob(
  job: JobContext<unknown>
): Promise<Record<string, unknown>> {
  const parsed = advancePayloadSchema.safeParse(job.payload);
  if (!parsed.success) return { skipped: 'invalid_payload' };
  const { caseId } = parsed.data;
  const result = await advanceCaseCommand(caseId, {
    commandId: `ops:case.advance:${segment(caseId)}:${segment(job.id)}:${job.attempt}`,
    systemActorId: CASE_JOB_ACTORS.advance,
    reason: 'Hechos de otros módulos',
  });
  throwIfRetryable(CASE_COMMANDS.advance, result);
  return summarize(result);
}

export interface ReconcileCandidate {
  zohoSalesOrderId: string;
  status: string | null;
  shippedStatus: string | null;
  createdTime: Date | null;
  orderDate: Date | null;
  locationId: string | null;
}

/** Rejections that are a decision on the order under the current configuration. */
export const CASE_START_POLICY_REJECTIONS = ['case_not_eligible', 'invalid_state'] as const;
/** Any other rejection of `case.start` (no responsible, process version…) is retried after this. */
export const CASE_START_RETRY_AFTER_MS = 30 * 60_000;

/**
 * Eligible-looking sales orders without a case (parameterized SQL with
 * NOT EXISTS; the start policy is evaluated again on every row). A rejected
 * `case.start` holds an order back only while it still applies: a policy
 * rejection until the order or the operations configuration changes, any other
 * rejection (transient: no responsible, a process version mismatch after a
 * deploy…) for `CASE_START_RETRY_AFTER_MS`.
 */
export async function findOrdersWithoutCase(
  cutover: Date,
  pilotLocationIds: readonly string[],
  limit: number,
  options: { configUpdatedAt?: Date; now?: Date } = {}
): Promise<ReconcileCandidate[]> {
  // Prisma stores DateTime as UTC in `timestamp(3)`: compare with a UTC wall-clock literal.
  const utc = (date: Date) => date.toISOString().replace('Z', '');
  const cutoverUtc = utc(cutover);
  const now = options.now ?? new Date();
  const configChangedUtc = utc(options.configUpdatedAt ?? new Date(0));
  const retryAfterUtc = utc(new Date(now.getTime() - CASE_START_RETRY_AFTER_MS));
  const pilot =
    pilotLocationIds.length > 0
      ? Prisma.sql`AND so."locationId" IN (${Prisma.join([...pilotLocationIds])})`
      : Prisma.empty;
  return prisma.$queryRaw<ReconcileCandidate[]>`
    SELECT so."zohoSalesOrderId", so."status", so."shippedStatus", so."createdTime", so."orderDate", so."locationId"
    FROM "SalesOrder" so
    WHERE COALESCE(so."createdTime", so."orderDate"::timestamp) >= ${cutoverUtc}::timestamp
      AND (so."status" IS NULL OR lower(so."status") NOT IN (${Prisma.join([...START_EXCLUDED_ORDER_STATUSES])}))
      AND (so."shippedStatus" IS NULL OR lower(so."shippedStatus") NOT IN (${Prisma.join([...START_EXCLUDED_SHIPPED_STATUSES])}))
      ${pilot}
      AND NOT EXISTS (
        SELECT 1 FROM "OperationalCase" oc
        WHERE oc."kind" = ${CASE_KIND} AND oc."sourceType" = ${CASE_SOURCE_TYPE}
          AND oc."sourceId" = so."zohoSalesOrderId"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "OperationalCommand" c
        WHERE c."aggregateType" = ${CASE_AGGREGATE_TYPE}
          AND c."aggregateId" = ('so:' || so."zohoSalesOrderId")
          AND c."type" = ${CASE_COMMANDS.start}
          AND c."status" = 'rejected'
          AND c."receivedAt" >= so."updatedAt"
          AND (
            (c."errorCode" IN (${Prisma.join([...CASE_START_POLICY_REJECTIONS])})
              AND c."receivedAt" >= ${configChangedUtc}::timestamp)
            OR c."receivedAt" >= ${retryAfterUtc}::timestamp
          )
      )
    ORDER BY COALESCE(so."createdTime", so."orderDate"::timestamp) ASC, so."id" ASC
    LIMIT ${limit}`;
}

export interface ReconcileOrdersResult {
  skipped: string | null;
  candidates: number;
  enqueued: number;
  deduplicated: number;
  ineligible: number;
}

export async function reconcileOrdersWithoutCase(
  options: { limit?: number } = {}
): Promise<ReconcileOrdersResult> {
  const result: ReconcileOrdersResult = {
    skipped: null,
    candidates: 0,
    enqueued: 0,
    deduplicated: 0,
    ineligible: 0,
  };
  const config = await getOperationsConfig();
  if (!config.isEnabled || !config.flags.salesToCase) return { ...result, skipped: 'disabled' };
  const cutover = new Date(config.cutoverDate);
  if (Number.isNaN(cutover.getTime())) return { ...result, skipped: 'invalid_cutover' };
  const limit = Math.max(1, Math.min(options.limit ?? CASE_RECONCILE_BATCH, 500));
  const candidates = await findOrdersWithoutCase(cutover, config.pilotLocationIds, limit, {
    configUpdatedAt: new Date(config.updatedAt),
  });
  result.candidates = candidates.length;
  for (const candidate of candidates) {
    if (!evaluateStartPolicy(candidate, config).eligible) {
      result.ineligible += 1;
      continue;
    }
    const job = await enqueueJob({
      type: CASE_JOB_TYPES.start,
      payload: { zohoSalesOrderId: candidate.zohoSalesOrderId },
      dedupeKey: caseStartDedupeKey(candidate.zohoSalesOrderId),
      priority: JOB_PRIORITY.normal,
      maxAttempts: 3,
      createdBy: CASE_JOB_TYPES.reconcileOrders,
    });
    if (job.deduplicated) result.deduplicated += 1;
    else result.enqueued += 1;
  }
  if (result.candidates > 0) log('orders_reconciled', { ...result });
  return result;
}

let registered = false;

/** Registers the handlers and the recurring reconciler (idempotent). */
export function registerCaseJobs(): void {
  if (registered) return;
  registered = true;
  registerJobHandler(CASE_JOB_TYPES.start, runCaseStartJob, { timeoutMs: 2 * 60_000 });
  registerJobHandler(CASE_JOB_TYPES.replan, runCaseReplanJob, { timeoutMs: 2 * 60_000 });
  registerJobHandler(CASE_JOB_TYPES.advance, runCaseAdvanceJob, { timeoutMs: 2 * 60_000 });
  registerJobHandler(CASE_JOB_TYPES.reconcileOrders, () => reconcileOrdersWithoutCase(), {
    timeoutMs: 5 * 60_000,
  });
  registerRecurringJob({
    type: CASE_JOB_TYPES.reconcileOrders,
    everyMs: CASE_RECONCILE_EVERY_MS,
    priority: JOB_PRIORITY.maintenance,
  });
}

registerCaseJobs();
