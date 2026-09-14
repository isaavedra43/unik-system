import { registerJobHandler, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { refreshAllDigests } from './ai-digest-service';
import { backfillEmbeddings } from './embeddings-service';

/**
 * AI background jobs.
 * - ai.daily_digest: per-user work digests (today + yesterday), every 6 hours.
 * - ai.embeddings_backfill: semantic vectors for knowledge chunks that still
 *   lack one (new sources, key configured later, transient failures), every 30 min.
 */
export const AI_DIGEST_JOB = 'ai.daily_digest';
export const AI_EMBEDDINGS_BACKFILL_JOB = 'ai.embeddings_backfill';

registerJobHandler(AI_DIGEST_JOB, async () => refreshAllDigests(), { timeoutMs: 20 * 60 * 1000 });
registerJobHandler(AI_EMBEDDINGS_BACKFILL_JOB, async () => backfillEmbeddings(600), { timeoutMs: 10 * 60 * 1000 });

registerRecurringJob({
  type: AI_DIGEST_JOB,
  everyMs: 6 * 60 * 60 * 1000,
  priority: JOB_PRIORITY.maintenance,
});

registerRecurringJob({
  type: AI_EMBEDDINGS_BACKFILL_JOB,
  everyMs: 30 * 60 * 1000,
  priority: JOB_PRIORITY.maintenance,
});
