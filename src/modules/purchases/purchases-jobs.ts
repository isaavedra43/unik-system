import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { JOB_PRIORITY, registerJobHandler, type JobContext } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import type { CommandResult } from '@/modules/operations/commands';
import {
  runConsolidationSuggestion,
  runDirectDeliverySync,
  runOrderPaymentFollowup,
  runRfqExpiration,
  runRfqSendReconciliation,
  runShortfallSync,
} from './purchases-commands';
import './purchases-storage';
import { PURCHASES_JOB_TYPES } from './purchases-types';
import { directDeliveryPlanSchema } from './receipts-service';
import { STALE_INVITATION_MS, runRfqInterpretation } from './rfq-service';
import { cleanupSourcingThrottle } from './sourcing-providers';
import { runSourcingSearchJob } from './sourcing-service';

/**
 * Background jobs of Compras y Sourcing (plan 6.1).
 *
 * - purchases.sourcing_search    → runs a Sourcing Lab search (progress on `job:{id}`).
 * - purchases.rfq_interpret      → reads a supplier reply with the utility model.
 * - purchases.consolidate_suggest (24 h) → work item with the requests of the same item and week.
 * - purchases.rfq_expire (1 h)   → RFQs past their due date; old throttle slots.
 * - purchases.shortfall_sync     → shortfall area request → purchase request (planned in-transaction).
 * - purchases.order_followup     → payable/payment request of an approved order.
 * - purchases.direct_delivery_sync → direct supplier delivery recorded in logistics.
 *
 * Imported once by `jobs/register-handlers.ts`.
 */

const RETRYABLE_CODES = ['concurrency_conflict'];

/** A transient loss is retried by the queue; business rejections are final. */
function throwIfRetryable(type: string, result: CommandResult<unknown>): void {
  if (result.status === 'rejected' && RETRYABLE_CODES.includes(result.errorCode ?? '')) {
    throw new Error(`${type}: ${result.errorCode} (${result.message ?? 'sin detalle'})`);
  }
}

function summarize(result: CommandResult<unknown>): Record<string, unknown> {
  return {
    status: result.status,
    errorCode: result.errorCode ?? null,
    message: result.message ?? null,
    replayed: result.replayed ?? false,
    data: result.data ?? null,
  };
}

const areaRequestPayload = z.object({ areaRequestId: z.string().min(1).max(120) });
const invitationPayload = z.object({ invitationId: z.string().min(1).max(120), messageId: z.string().min(1).max(120).nullish() });
const followupPayload = z.object({ orderId: z.string().min(1).max(120), step: z.literal('payment') });

export async function runShortfallSyncJob(job: JobContext<unknown>): Promise<Record<string, unknown>> {
  const payload = areaRequestPayload.safeParse(job.payload);
  if (!payload.success) return { skipped: 'invalid_payload' };
  const result = await runShortfallSync(payload.data.areaRequestId, job.id, job.attempt);
  throwIfRetryable(PURCHASES_JOB_TYPES.shortfallSync, result);
  return summarize(result);
}

export async function runRfqInterpretJob(job: JobContext<unknown>): Promise<Record<string, unknown>> {
  const payload = invitationPayload.safeParse(job.payload);
  if (!payload.success) return { skipped: 'invalid_payload' };
  const result = await runRfqInterpretation(payload.data.invitationId, { messageId: payload.data.messageId ?? null });
  if ('reason' in result) return { skipped: result.reason };
  throwIfRetryable(PURCHASES_JOB_TYPES.rfqInterpret, result);
  return summarize(result);
}

export async function runConsolidateSuggestJob(): Promise<Record<string, unknown>> {
  return summarize(await runConsolidationSuggestion(new Date()));
}

export async function runRfqExpireJob(now: Date = new Date()): Promise<Record<string, unknown>> {
  const due = await prisma.rfq.findMany({
    where: { status: { in: ['sent', 'collecting'] }, dueAt: { lt: now } },
    orderBy: { dueAt: 'asc' },
    take: 200,
    select: { id: true },
  });
  const bucket = now.toISOString().slice(0, 13);
  let expired = 0;
  for (const rfq of due) {
    const result = await runRfqExpiration(rfq.id, bucket, now);
    if (result.status === 'completed' && result.data?.expired) expired += 1;
  }
  // Invitations claimed for sending whose result was never recorded (the process died mid-send).
  const staleBefore = new Date(now.getTime() - STALE_INVITATION_MS);
  const stale = await prisma.rfqInvitation.findMany({
    where: { status: 'pending', sentAt: { not: null, lt: staleBefore } },
    select: { rfqId: true },
    take: 500,
  });
  let reconciled = 0;
  for (const rfqId of [...new Set(stale.map((row) => row.rfqId))]) {
    const result = await runRfqSendReconciliation(rfqId, staleBefore, bucket, now);
    if (result.status === 'completed') reconciled += (result.data?.sent ?? 0) + (result.data?.failed ?? 0);
  }
  const cleaned = await cleanupSourcingThrottle(new Date(now.getTime() - 10 * 60_000));
  return { due: due.length, expired, reconciledInvitations: reconciled, throttleSlotsRemoved: cleaned };
}

export async function runOrderFollowupJob(job: JobContext<unknown>): Promise<Record<string, unknown>> {
  const payload = followupPayload.safeParse(job.payload);
  if (!payload.success) return { skipped: 'invalid_payload' };
  const { result, failure } = await runOrderPaymentFollowup(payload.data.orderId, job.id, job.attempt);
  throwIfRetryable(PURCHASES_JOB_TYPES.orderFollowup, result);
  return { ...summarize(result), failureRecorded: failure ? failure.status : null };
}

export async function runDirectDeliverySyncJob(job: JobContext<unknown>): Promise<Record<string, unknown>> {
  const payload = directDeliveryPlanSchema.safeParse(job.payload);
  if (!payload.success) return { skipped: 'invalid_payload' };
  const { result, failure } = await runDirectDeliverySync(payload.data, job.id, job.attempt);
  throwIfRetryable(PURCHASES_JOB_TYPES.directDeliverySync, result);
  return { ...summarize(result), failureRecorded: failure ? failure.status : null };
}

registerJobHandler(PURCHASES_JOB_TYPES.sourcingSearch, (job) => runSourcingSearchJob(job), { timeoutMs: 3 * 60_000 });
registerJobHandler(PURCHASES_JOB_TYPES.rfqInterpret, runRfqInterpretJob, { timeoutMs: 2 * 60_000 });
registerJobHandler(PURCHASES_JOB_TYPES.consolidateSuggest, () => runConsolidateSuggestJob(), { timeoutMs: 2 * 60_000 });
registerJobHandler(PURCHASES_JOB_TYPES.rfqExpire, () => runRfqExpireJob(), { timeoutMs: 5 * 60_000 });
registerJobHandler(PURCHASES_JOB_TYPES.shortfallSync, runShortfallSyncJob, { timeoutMs: 60_000 });
registerJobHandler(PURCHASES_JOB_TYPES.orderFollowup, runOrderFollowupJob, { timeoutMs: 60_000 });
registerJobHandler(PURCHASES_JOB_TYPES.directDeliverySync, runDirectDeliverySyncJob, { timeoutMs: 60_000 });

registerRecurringJob({ type: PURCHASES_JOB_TYPES.consolidateSuggest, everyMs: 24 * 60 * 60_000, priority: JOB_PRIORITY.maintenance });
registerRecurringJob({ type: PURCHASES_JOB_TYPES.rfqExpire, everyMs: 60 * 60_000, priority: JOB_PRIORITY.maintenance });
