import { registerJobHandler, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { dispatchPendingNotifications, pruneNotifications } from './notification-service';

/**
 * Notification background work.
 * - notifications.dispatch_pending: safety net for rows created inside
 *   transactions (the service wakes an in-process dispatcher right away; this
 *   catches anything an instance restart left behind).
 * - notifications.prune: 90-day retention, daily.
 */
export const NOTIFICATIONS_DISPATCH_JOB = 'notifications.dispatch_pending';
export const NOTIFICATIONS_PRUNE_JOB = 'notifications.prune';

registerJobHandler(NOTIFICATIONS_DISPATCH_JOB, async () => dispatchPendingNotifications(500), {
  timeoutMs: 2 * 60 * 1000,
});
registerJobHandler(NOTIFICATIONS_PRUNE_JOB, async () => ({ deleted: await pruneNotifications(90) }), {
  timeoutMs: 5 * 60 * 1000,
});

registerRecurringJob({
  type: NOTIFICATIONS_DISPATCH_JOB,
  everyMs: 5 * 60 * 1000,
  priority: JOB_PRIORITY.interactive,
});
registerRecurringJob({
  type: NOTIFICATIONS_PRUNE_JOB,
  everyMs: 24 * 60 * 60 * 1000,
  priority: JOB_PRIORITY.maintenance,
});

let dispatcherStarted = false;

/**
 * In-process dispatcher (every 20s). Cheap (one indexed query) and it is what
 * makes a "seguimiento" notification created by the Zoho sync reach the phone
 * within seconds instead of waiting for the recurring job.
 */
export function startNotificationDispatcher(intervalMs = 20_000): void {
  if (dispatcherStarted) return;
  dispatcherStarted = true;
  const timer = setInterval(() => {
    void dispatchPendingNotifications().catch(() => undefined);
  }, intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
}
