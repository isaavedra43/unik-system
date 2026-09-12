import { registerJobHandler, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { expireProposals } from './proposals-service';
import { purgeExpiredOAuthStates } from './oauth-service';

/** Hourly housekeeping: expired proposals and stale OAuth states. */
export const EXTENSIONS_MAINTENANCE_JOB = 'extensions.maintenance';

registerJobHandler(EXTENSIONS_MAINTENANCE_JOB, async (ctx) => {
  const proposals = await expireProposals();
  const oauth = await purgeExpiredOAuthStates();
  ctx.log('maintenance', { proposals, oauth });
  return { proposals, oauth };
});

registerRecurringJob({
  type: EXTENSIONS_MAINTENANCE_JOB,
  everyMs: 60 * 60 * 1000,
  priority: JOB_PRIORITY.maintenance,
});
