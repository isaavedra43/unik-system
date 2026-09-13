import { registerJobHandler, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { refreshAllDigests } from './ai-digest-service';

/**
 * AI background jobs.
 * - ai.daily_digest: per-user work digests (today + yesterday), every 6 hours.
 */
export const AI_DIGEST_JOB = 'ai.daily_digest';

registerJobHandler(AI_DIGEST_JOB, async () => refreshAllDigests(), { timeoutMs: 20 * 60 * 1000 });

registerRecurringJob({
  type: AI_DIGEST_JOB,
  everyMs: 6 * 60 * 60 * 1000,
  priority: JOB_PRIORITY.maintenance,
});
