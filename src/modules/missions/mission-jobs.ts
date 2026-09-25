import { registerJobHandler } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { tickMissions } from './mission-service';

/**
 * mission.tick — advances due missions one step each. Recurring every minute
 * via the durable BackgroundJob clock (dedupe by type, multi-instance safe).
 */
registerJobHandler('mission.tick', async () => {
  const { ran } = await tickMissions();
  return { ran };
});

registerRecurringJob({
  type: 'mission.tick',
  everyMs: 60 * 1000,
});
