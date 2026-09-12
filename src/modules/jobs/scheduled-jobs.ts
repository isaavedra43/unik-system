import { prisma } from '@/lib/prisma';
import { enqueueJob, JOB_PRIORITY } from './job-queue';

/**
 * Recurring maintenance jobs. Instead of a cron service, each instance
 * checks every few minutes whether a recurring job is due (using the last
 * completed run in the BackgroundJob table as the durable clock) and
 * enqueues it with a dedupe key so several instances never double-run it.
 */

export interface RecurringJobDefinition {
  type: string;
  everyMs: number;
  payload?: Record<string, unknown>;
  priority?: number;
}

const recurring: RecurringJobDefinition[] = [];

export function registerRecurringJob(def: RecurringJobDefinition): void {
  if (recurring.some((r) => r.type === def.type)) return;
  recurring.push(def);
}

export function listRecurringJobs(): RecurringJobDefinition[] {
  return [...recurring];
}

async function isDue(def: RecurringJobDefinition, now: Date): Promise<boolean> {
  const last = await prisma.backgroundJob.findFirst({
    where: { type: def.type, status: { in: ['completed', 'failed'] } },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true },
  });
  if (!last?.completedAt) return true;
  return now.getTime() - last.completedAt.getTime() >= def.everyMs;
}

export async function scheduleDueRecurringJobs(now: Date = new Date()): Promise<string[]> {
  const enqueued: string[] = [];
  for (const def of recurring) {
    try {
      if (await isDue(def, now)) {
        const res = await enqueueJob({
          type: def.type,
          payload: def.payload ?? {},
          priority: def.priority ?? JOB_PRIORITY.maintenance,
          dedupeKey: `recurring:${def.type}`,
          maxAttempts: 1,
        });
        if (!res.deduplicated) enqueued.push(def.type);
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          component: 'jobs',
          event: 'recurring_schedule_error',
          type: def.type,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }
  return enqueued;
}

type GlobalWithScheduler = typeof globalThis & { __unikRecurringScheduler?: { started: boolean } };

export function startRecurringScheduler(intervalMs = 5 * 60 * 1000): void {
  const scope = globalThis as GlobalWithScheduler;
  scope.__unikRecurringScheduler ??= { started: false };
  if (scope.__unikRecurringScheduler.started) return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.UNIK_JOB_WORKER_ENABLED === 'false') return;
  scope.__unikRecurringScheduler.started = true;
  const tick = () => {
    void scheduleDueRecurringJobs().catch(() => undefined);
  };
  setTimeout(tick, 30_000);
  setInterval(tick, intervalMs);
}
