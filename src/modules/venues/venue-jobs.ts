import { registerJobHandler } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { reapIdleVenues } from './venue-manager';

/**
 * venue.reaper — kills venue sessions that have been idle longer than
 * venueIdleTimeoutMinutes. Scheduled via the recurring-job table so every
 * instance cooperates (dedupe by job type).
 */
registerJobHandler('venue.reaper', async () => {
  const { reaped } = await reapIdleVenues();
  return { reaped };
});

registerRecurringJob({
  type: 'venue.reaper',
  everyMs: 5 * 60 * 1000,
});
