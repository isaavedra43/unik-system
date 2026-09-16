import { z } from 'zod';
import {
  JOB_PRIORITY,
  enqueueJob,
  registerJobHandler,
  type JobContext,
} from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { AREA_WORKSPACE_KEYS, isAreaWorkspaceKey } from './area-registry';
import { refreshDashboardSnapshots, type DashboardRefreshSummary } from './dashboard-service';

/**
 * Background jobs of the areas module, registered on import from
 * `src/modules/jobs/register-handlers.ts`.
 *
 * `areas.dashboard_refresh` recomputes the `DashboardSnapshot` rows of the six
 * areas (and of every scope registered on top, such as the Control Tower):
 * - every 5 minutes as a recurring job, so a panel is never more than one
 *   cadence old;
 * - on demand, deduplicated by scope, so ten people pressing "Actualizar" at
 *   the same time produce ONE recomputation.
 *
 * The job never fails because of one area: `refreshDashboardSnapshots` reports
 * each scope separately and the result says what did not refresh.
 */

export const AREAS_DASHBOARD_REFRESH_JOB = 'areas.dashboard_refresh';

/** Plan 7.3: every 5 minutes. */
export const AREAS_DASHBOARD_REFRESH_EVERY_MS = 5 * 60_000;

/** Below the next tick, so a stuck run never overlaps the following one. */
const REFRESH_TIMEOUT_MS = 4 * 60_000;

const payloadSchema = z
  .object({
    /** Areas to refresh; empty or absent = the six areas and the extra scopes. */
    areaKeys: z.array(z.string().trim().min(1).max(40)).max(AREA_WORKSPACE_KEYS.length).optional(),
  })
  .partial();

export type DashboardRefreshPayload = z.infer<typeof payloadSchema>;

/** One pending refresh per scope: ten "Actualizar" in a row are one job. */
export function areaDashboardDedupeKey(areaKey?: string | null): string {
  return `${AREAS_DASHBOARD_REFRESH_JOB}:${areaKey && isAreaWorkspaceKey(areaKey) ? areaKey : 'all'}`;
}

export interface DashboardRefreshDeps {
  refresh: typeof refreshDashboardSnapshots;
}

export const defaultDashboardRefreshDeps: DashboardRefreshDeps = {
  refresh: refreshDashboardSnapshots,
};

/**
 * Handler of `areas.dashboard_refresh`. An unknown area key in the payload is
 * ignored (a module could be uninstalled between the enqueue and the run); when
 * nothing valid is left it refreshes everything.
 */
export async function runDashboardRefreshJob(
  job: JobContext<unknown>,
  deps: DashboardRefreshDeps = defaultDashboardRefreshDeps
): Promise<DashboardRefreshSummary> {
  const parsed = payloadSchema.safeParse(job.payload ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid ${AREAS_DASHBOARD_REFRESH_JOB} payload: ${parsed.error.message}`);
  }
  const requested = (parsed.data.areaKeys ?? []).filter(isAreaWorkspaceKey);
  const summary = await deps.refresh({
    ...(requested.length > 0 ? { areaKeys: requested } : {}),
    signal: job.signal,
  });
  job.log('dashboards_refreshed', {
    refreshed: summary.refreshed.length,
    failed: summary.failed.length,
  });
  return summary;
}

export interface EnqueueDashboardRefreshInput {
  /** One area, or every scope when absent. */
  areaKey?: string | null;
  /** Set when a person asked for it: the job jumps ahead of maintenance work. */
  requestedByUserId?: string | null;
}

/** Queues a refresh (deduplicated by scope). Returns the job and whether it was deduplicated. */
export async function enqueueAreaDashboardRefresh(input: EnqueueDashboardRefreshInput = {}) {
  const areaKey = input.areaKey && isAreaWorkspaceKey(input.areaKey) ? input.areaKey : null;
  return enqueueJob({
    type: AREAS_DASHBOARD_REFRESH_JOB,
    payload: areaKey ? { areaKeys: [areaKey] } : {},
    priority: input.requestedByUserId ? JOB_PRIORITY.interactive : JOB_PRIORITY.maintenance,
    maxAttempts: 1,
    dedupeKey: areaDashboardDedupeKey(areaKey),
    ...(input.requestedByUserId ? { createdBy: input.requestedByUserId } : {}),
  });
}

type GlobalWithAreasJobs = typeof globalThis & { __unikAreasJobsRegistered?: boolean };

export function registerAreasJobs(): void {
  const scope = globalThis as GlobalWithAreasJobs;
  if (scope.__unikAreasJobsRegistered) return;
  scope.__unikAreasJobsRegistered = true;
  registerJobHandler(AREAS_DASHBOARD_REFRESH_JOB, (job) => runDashboardRefreshJob(job), {
    timeoutMs: REFRESH_TIMEOUT_MS,
  });
  registerRecurringJob({
    type: AREAS_DASHBOARD_REFRESH_JOB,
    everyMs: AREAS_DASHBOARD_REFRESH_EVERY_MS,
    priority: JOB_PRIORITY.maintenance,
  });
}

registerAreasJobs();
