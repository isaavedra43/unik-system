import { z } from 'zod';
import {
  JOB_PRIORITY,
  enqueueJob,
  registerJobHandler,
  type JobContext,
} from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import {
  DASHBOARD_SCOPE_CONTROL_TOWER,
  registerDashboardSnapshotProvider,
} from '@/modules/areas/dashboard-service';
import { CONTROL_TOWER_SCOPE_KEY, computeControlTowerOverview } from './control-tower-service';
import {
  PROJECTION_KEYS,
  refreshProjections,
  type ProjectionKey,
  type RefreshProjectionsResult,
} from './projections-service';

/**
 * Trabajos de fondo de la Torre de Control (plan 7.9).
 *
 * `ct.projections_refresh` recalcula las cuatro proyecciones de inteligencia de
 * procesos cada 15 minutos (timeout 10 min, por debajo de la siguiente
 * cadencia, así que dos corridas nunca se enciman). Es idempotente: si se
 * repite, vuelve a escribir los mismos días con los mismos números.
 *
 * El resumen de la Torre viaja además como un scope más del refresco de
 * tableros (`DashboardSnapshot('control_tower','')`): se registra aquí como
 * proveedor, de modo que el job de áreas lo recalcula junto con los seis
 * paneles y nadie paga el cálculo completo al abrir la pantalla.
 */

export const CT_PROJECTIONS_REFRESH_JOB = 'ct.projections_refresh';

/** Plan 7.9: cada 15 minutos. */
export const CT_PROJECTIONS_REFRESH_EVERY_MS = 15 * 60_000;

/** Plan 7.9: timeout de 10 minutos (por debajo del siguiente tic). */
const PROJECTIONS_TIMEOUT_MS = 10 * 60_000;

const payloadSchema = z
  .object({
    /** Reconstrucción completa desde la administración. */
    full: z.boolean().optional(),
    /** Sólo estas proyecciones (por omisión, las cuatro). */
    keys: z.array(z.enum(PROJECTION_KEYS)).max(PROJECTION_KEYS.length).optional(),
  })
  .partial();

export type ProjectionsRefreshPayload = z.infer<typeof payloadSchema>;

/**
 * Una corrida pendiente por modo: diez personas pidiendo "Reconstruir" son UNA
 * reconstrucción, y la reconstrucción completa no se traga el tic incremental.
 */
export function projectionsDedupeKey(full: boolean): string {
  return `${CT_PROJECTIONS_REFRESH_JOB}:${full ? 'full' : 'incremental'}`;
}

export interface ProjectionsRefreshDeps {
  refresh: typeof refreshProjections;
}

export const defaultProjectionsRefreshDeps: ProjectionsRefreshDeps = {
  refresh: refreshProjections,
};

/**
 * Handler de `ct.projections_refresh`. Una proyección que falle no tumba al
 * job: `refreshProjections` las reporta por separado y su marca de agua no
 * avanza, así que el siguiente tic la reintenta desde donde se quedó.
 */
export async function runProjectionsRefreshJob(
  job: JobContext<unknown>,
  deps: ProjectionsRefreshDeps = defaultProjectionsRefreshDeps
): Promise<RefreshProjectionsResult> {
  const parsed = payloadSchema.safeParse(job.payload ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid ${CT_PROJECTIONS_REFRESH_JOB} payload: ${parsed.error.message}`);
  }
  const keys = (parsed.data.keys ?? []) as ProjectionKey[];
  const result = await deps.refresh({
    full: parsed.data.full === true,
    ...(keys.length > 0 ? { keys } : {}),
    signal: job.signal,
  });
  job.log('projections_refreshed', {
    full: result.full,
    failed: result.failed,
    durationMs: result.durationMs,
    runs: result.runs.map((run) => `${run.key}:${run.ok ? run.written : 'error'}`).join(' '),
  });
  return result;
}

export interface EnqueueProjectionsRefreshInput {
  full?: boolean;
  keys?: readonly ProjectionKey[];
  /** Se puso en marcha por una persona: pasa delante del trabajo de mantenimiento. */
  requestedByUserId?: string | null;
}

/** Encola un recálculo de proyecciones (deduplicado por modo). */
export async function enqueueProjectionsRefresh(input: EnqueueProjectionsRefreshInput = {}) {
  const full = input.full === true;
  return enqueueJob({
    type: CT_PROJECTIONS_REFRESH_JOB,
    payload: {
      ...(full ? { full: true } : {}),
      ...(input.keys && input.keys.length > 0 ? { keys: [...input.keys] } : {}),
    },
    priority: input.requestedByUserId ? JOB_PRIORITY.interactive : JOB_PRIORITY.maintenance,
    maxAttempts: 1,
    dedupeKey: projectionsDedupeKey(full),
    ...(input.requestedByUserId ? { createdBy: input.requestedByUserId } : {}),
  });
}

type GlobalWithControlTowerJobs = typeof globalThis & {
  __unikControlTowerJobsRegistered?: boolean;
};

export function registerControlTowerJobs(): void {
  const scope = globalThis as GlobalWithControlTowerJobs;
  if (scope.__unikControlTowerJobsRegistered) return;
  scope.__unikControlTowerJobsRegistered = true;

  registerJobHandler(CT_PROJECTIONS_REFRESH_JOB, (job) => runProjectionsRefreshJob(job), {
    timeoutMs: PROJECTIONS_TIMEOUT_MS,
  });
  registerRecurringJob({
    type: CT_PROJECTIONS_REFRESH_JOB,
    everyMs: CT_PROJECTIONS_REFRESH_EVERY_MS,
    priority: JOB_PRIORITY.maintenance,
  });

  // El resumen de la Torre viaja con el refresco de tableros (scope propio).
  registerDashboardSnapshotProvider({
    scopeType: DASHBOARD_SCOPE_CONTROL_TOWER,
    scopeKey: CONTROL_TOWER_SCOPE_KEY,
    compute: ({ now }) => computeControlTowerOverview({ now }),
  });
}

registerControlTowerJobs();
