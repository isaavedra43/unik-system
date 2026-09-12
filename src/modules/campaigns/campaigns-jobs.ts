import { prisma } from '@/lib/prisma';
import { registerJobHandler, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import {
  CAMPAIGN_DISPATCH_JOB,
  CAMPAIGN_SCHEDULER_JOB,
  defaultDispatchDeps,
  dispatchBatch,
  enqueueBatch,
  isAccountBusy,
  type DispatchPayload,
} from './campaign-dispatcher';
import { tickScheduler } from './campaign-service';

/**
 * Campaign background jobs.
 *  - `campaigns.dispatch_batch` (bulk priority, groupKey campaign:<id>,
 *    dedupeKey per batch): sends one batch. Only ONE batch per sending
 *    account runs at a time — a second one defers itself 30 s so the inbox
 *    (interactive priority) and provider rate limits are never starved.
 *  - `campaigns.scheduler` (every 5 min): scheduled → running when due and
 *    re-enqueues batches for running campaigns that lost their job (crash
 *    recovery). Idempotent thanks to recipient statuses and dedupe keys.
 */

const DEFER_MS = 30_000;
const BATCH_TIMEOUT_MS = 60 * 60 * 1000;

registerJobHandler<DispatchPayload>(
  CAMPAIGN_DISPATCH_JOB,
  async (ctx) => {
    const payload = ctx.payload;
    if (await isAccountBusy(payload.accountId, ctx.id)) {
      // Release our dedupe key so the deferred copy can take it, then retry later.
      await prisma.backgroundJob.update({ where: { id: ctx.id }, data: { dedupeKey: null } });
      await enqueueBatch({ ...payload, createdBy: null, runAt: new Date(Date.now() + DEFER_MS) });
      ctx.log('deferred: account busy', { accountId: payload.accountId });
      return { deferred: true };
    }
    const result = await dispatchBatch(payload, { ...defaultDispatchDeps, signal: ctx.signal });
    ctx.log('batch finished', { ...result });
    if (result.outcome === 'interrupted' && !ctx.signal.aborted) {
      // Time budget exhausted: continue the same batch in a fresh job.
      await prisma.backgroundJob.update({ where: { id: ctx.id }, data: { dedupeKey: null } });
      await enqueueBatch({ ...payload, createdBy: null });
    }
    return result;
  },
  { timeoutMs: BATCH_TIMEOUT_MS }
);

registerJobHandler(CAMPAIGN_SCHEDULER_JOB, async (ctx) => {
  const result = await tickScheduler();
  if (result.started.length || result.recovered.length) ctx.log('scheduler tick', { ...result });
  return result;
});

registerRecurringJob({
  type: CAMPAIGN_SCHEDULER_JOB,
  everyMs: 5 * 60 * 1000,
  priority: JOB_PRIORITY.maintenance,
});
