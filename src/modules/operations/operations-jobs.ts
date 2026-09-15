import { z } from 'zod';
import {
  enqueueJob,
  JOB_PRIORITY,
  registerJobHandler,
  type JobContext,
} from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { AREA_REQUEST_AUTO_ACK_JOB, runAreaRequestAutoAckJob } from './area-requests-service';
import { listRelationSources, rebuildObjectRelations } from './relations-rebuild';
import { OPS_SUPERVISOR_JOB, runSupervisorTick } from './supervisor';
import { SUPERVISOR_EVERY_MS } from './supervisor-rules';
// Case engine jobs (ops.case.start, ops.case.replan, ops.case.reconcile_orders).
import './case-jobs';

/**
 * Background jobs of the operations core, registered on import from
 * `src/modules/jobs/register-handlers.ts`.
 *
 * - `ops.supervisor`: recurring every 4 minutes with a single attempt (a
 *   failed tick is simply replaced by the next one; every finding is an
 *   idempotent command, so nothing is lost).
 * - `ops.request.auto_ack`: enqueued in the transaction that creates an area
 *   request; acknowledges it as the system (`request-ack:{id}`).
 * - `ops.relations_rebuild`: on demand (`enqueueRelationsRebuild`), rebuilds
 *   the `ObjectRelation` projection from the source tables. Operational events
 *   are never pruned: they are the audit trail of every case.
 */

export const OPS_RELATIONS_REBUILD_JOB = 'ops.relations_rebuild';

/** Below the queue's abort: the tick stops between commands when the signal fires. */
const SUPERVISOR_TIMEOUT_MS = Math.floor(SUPERVISOR_EVERY_MS * 0.875);
const RELATIONS_REBUILD_TIMEOUT_MS = 30 * 60_000;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-jobs', event, ...extra }));

export async function runSupervisorJob(job: JobContext<unknown>) {
  const summary = await runSupervisorTick({ signal: job.signal });
  return {
    skipped: summary.skipped,
    aborted: summary.aborted,
    durationMs: summary.durationMs,
    totals: summary.totals,
    tickEventId: summary.tickEventId,
  };
}

const rebuildPayloadSchema = z.object({
  sources: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
});

export type RelationsRebuildPayload = z.infer<typeof rebuildPayloadSchema>;

export async function runRelationsRebuildJob(job: JobContext<unknown>) {
  const parsed = rebuildPayloadSchema.safeParse(job.payload ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid ${OPS_RELATIONS_REBUILD_JOB} payload: ${parsed.error.message}`);
  }
  return rebuildObjectRelations({
    sources: parsed.data.sources,
    signal: job.signal,
    onProgress: (done, total) => job.setProgress(total > 0 ? (done / total) * 100 : 100),
  });
}

/**
 * Enqueues a rebuild of the relation projection (one at a time: a pending or
 * running rebuild is returned instead of a duplicate). Callers check
 * `operations.admin` before offering it.
 */
export async function enqueueRelationsRebuild(
  input: { requestedByUserId?: string | null; sources?: string[] } = {}
) {
  const known = new Set(listRelationSources().map((s) => s.key));
  const sources = input.sources?.filter((key) => known.has(key));
  const job = await enqueueJob({
    type: OPS_RELATIONS_REBUILD_JOB,
    payload: sources && sources.length > 0 ? { sources } : {},
    priority: JOB_PRIORITY.maintenance,
    maxAttempts: 2,
    dedupeKey: OPS_RELATIONS_REBUILD_JOB,
    createdBy: input.requestedByUserId ?? undefined,
  });
  log('relations_rebuild_enqueued', {
    jobId: job.id,
    deduplicated: job.deduplicated,
    sources: sources ?? 'all',
    requestedByUserId: input.requestedByUserId ?? null,
  });
  return job;
}

type GlobalWithOperationsJobs = typeof globalThis & { __unikOperationsJobsRegistered?: boolean };

export function registerOperationsJobs(): void {
  const scope = globalThis as GlobalWithOperationsJobs;
  if (scope.__unikOperationsJobsRegistered) return;
  scope.__unikOperationsJobsRegistered = true;
  registerJobHandler(OPS_SUPERVISOR_JOB, runSupervisorJob, { timeoutMs: SUPERVISOR_TIMEOUT_MS });
  registerRecurringJob({
    type: OPS_SUPERVISOR_JOB,
    everyMs: SUPERVISOR_EVERY_MS,
    priority: JOB_PRIORITY.maintenance,
  });
  registerJobHandler(OPS_RELATIONS_REBUILD_JOB, runRelationsRebuildJob, {
    timeoutMs: RELATIONS_REBUILD_TIMEOUT_MS,
  });
  registerJobHandler(AREA_REQUEST_AUTO_ACK_JOB, runAreaRequestAutoAckJob, { timeoutMs: 60_000 });
}

registerOperationsJobs();
