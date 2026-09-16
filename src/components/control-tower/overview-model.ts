import type {
  AreaLoadRow,
  ControlTowerOverview,
  ProjectionHealthRow,
  SyncHealthRow,
} from '@/modules/control-tower/control-tower-service';
import type { StatTone } from '@/components/patterns/dashboard/dashboard-utils';

/**
 * Pure rules of the Control Tower summary (plan 7.7 `resumen`): how healthy a
 * sync run, the job queue or a projection looks, how the area load table is
 * ordered and what the copilot gets as context.
 *
 * No React, no Prisma and no clock of its own: every function takes `now`, so
 * the server render and the hydrated page say exactly the same thing.
 */

export type HealthTone = StatTone;

export const SYNC_STATUS_LABELS: Record<string, string> = {
  COMPLETED: 'Completada',
  RUNNING: 'En curso',
  FAILED: 'Falló',
  PARTIAL: 'Parcial',
  CANCELLED: 'Cancelada',
  PENDING: 'Pendiente',
};

export function syncStatusLabel(status: string): string {
  return SYNC_STATUS_LABELS[status] ?? SYNC_STATUS_LABELS[status.toUpperCase()] ?? status;
}

/** A run that failed is danger; one that is simply old is a warning. */
export function syncTone(run: Pick<SyncHealthRow, 'status' | 'errorCode' | 'stale'>): HealthTone {
  if (run.status.toUpperCase() === 'FAILED' || run.errorCode) return 'danger';
  if (run.stale) return 'warning';
  return 'success';
}

/**
 * Caption of the sync card: says what the list is and, when something is wrong,
 * how much — so the state is readable without counting rows or reading colours.
 */
export function syncHealthCaption(sync: ControlTowerOverview['sync']): string {
  const problems: string[] = [];
  if (sync.failing > 0) problems.push(`${sync.failing} con error`);
  if (sync.stale > 0) {
    problems.push(`${sync.stale} sin correr hace más de ${sync.staleMinutes} min`);
  }
  if (problems.length === 0) return 'Última corrida por entidad.';
  return `Última corrida por entidad: ${problems.join(' y ')}.`;
}

/**
 * Sync rows in the order the panel shows them: what is wrong first (failed,
 * then stale), the rest alphabetically. The list is cut at 8 rows and there are
 * already ~11 entities, so without this an entity that stopped syncing could be
 * hidden behind healthy ones — exactly the thing the panel exists to show.
 * Pure and stable: the server render and the hydrated page agree.
 */
export function orderSyncRuns(runs: readonly SyncHealthRow[]): SyncHealthRow[] {
  const rank = (run: SyncHealthRow) => {
    const tone = syncTone(run);
    return tone === 'danger' ? 0 : tone === 'warning' ? 1 : 2;
  };
  return [...runs].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.source.localeCompare(b.source) ||
      a.entityType.localeCompare(b.entityType)
  );
}

export function projectionTone(row: Pick<ProjectionHealthRow, 'stale'>): HealthTone {
  return row.stale ? 'warning' : 'success';
}

export function jobsTone(jobs: ControlTowerOverview['jobs']): HealthTone {
  if (jobs.failed > 0) return 'danger';
  if (jobs.pending > 50) return 'warning';
  return 'success';
}

/** Minutes → "hace 4 min" / "hace 3 h" / "hace 2 d". Never negative. */
export function minutesAgoLabel(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return 'sin registro';
  const safe = Math.max(0, Math.floor(minutes));
  if (safe < 1) return 'hace un momento';
  if (safe < 60) return `hace ${safe} min`;
  const hours = Math.floor(safe / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

export const PROJECTION_LABELS: Record<string, string> = {
  variants: 'Variantes de proceso',
  step_metrics: 'Métricas por paso',
  handoffs: 'Traspasos entre áreas',
  block_causes: 'Causas de bloqueo',
};

export function projectionLabel(key: string): string {
  return PROJECTION_LABELS[key] ?? key;
}

/** Total load of an area: what decides the order of the table. */
export function areaPressure(area: AreaLoadRow): number {
  return (
    area.overdueWorkItems * 3 +
    area.overdueRequests * 3 +
    area.openIncidents * 2 +
    area.openWorkItems +
    area.openRequests
  );
}

/** Areas ordered by pressure; ties keep the canonical order of the core. */
export function sortedAreaLoad(areas: readonly AreaLoadRow[]): AreaLoadRow[] {
  return areas
    .map((area, index) => ({ area, index }))
    .sort((a, b) => areaPressure(b.area) - areaPressure(a.area) || a.index - b.index)
    .map((entry) => entry.area);
}

export function areaLoadTone(area: AreaLoadRow): HealthTone {
  if (area.overdueWorkItems > 0 || area.overdueRequests > 0) return 'danger';
  if (area.openIncidents > 0) return 'warning';
  return 'default';
}

/** Money of the AI meter; tokens on a flat plan are not money. */
export function formatUsd(value: number): string {
  return value.toLocaleString('es-MX', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

export function formatCount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('es-MX') : '0';
}

// ---------------------------------------------------------------------------
// Recálculo de las proyecciones (plan 7.9: «rebuild completo con {full:true}
// desde admin»). La ruta existía desde el principio y NADIE la llamaba: el
// resumen enseñaba que una proyección estaba atrasada y no había forma de
// reconstruirla sin entrar por HTTP a mano.
// ---------------------------------------------------------------------------

export const PROJECTIONS_REBUILD_ENDPOINT = '/app/admin/control-tower/api/projections/rebuild';

/** Respuesta de la ruta: `202 {mode:'queued'}` por omisión, `200 {mode:'inline'}` con `wait`. */
export interface ProjectionsRebuildResponse {
  mode?: string;
  job?: { id?: string; status?: string } | null;
  result?: {
    durationMs?: number;
    failed?: number;
    full?: boolean;
    runs?: Array<{ key: string; ok: boolean; written?: number; detail?: string; error?: string }>;
  } | null;
  error?: string;
}

export interface ProjectionsRebuildFeedback {
  tone: 'success' | 'error';
  message: string;
  /** Detalle por proyección cuando la reconstrucción corrió en línea. */
  detail: string | null;
}

/**
 * Qué decirle a la persona después de pedir el recálculo. Puro: la prueba lo
 * ejerce sin navegador y el panel sólo lo pinta.
 *
 * Encolar es el modo normal (el job está deduplicado: diez clics son una
 * corrida). El modo en línea devuelve el resultado por proyección, que es lo que
 * hace falta para ver QUÉ falló cuando algo no cuadra.
 */
export function projectionsRebuildFeedback(
  payload: ProjectionsRebuildResponse | null | undefined,
  options: { ok?: boolean } = {}
): ProjectionsRebuildFeedback {
  const ok = options.ok !== false;
  if (!ok || !payload) {
    return {
      tone: 'error',
      message: payload?.error || 'No pudimos pedir el recálculo de las proyecciones',
      detail: null,
    };
  }
  if (payload.error) return { tone: 'error', message: payload.error, detail: null };

  if (payload.mode === 'inline' && payload.result) {
    const runs = payload.result.runs ?? [];
    const failed = payload.result.failed ?? runs.filter((run) => !run.ok).length;
    const written = runs.reduce((total, run) => total + (run.written ?? 0), 0);
    const detail =
      runs
        .map(
          (run) =>
            `${projectionLabel(run.key)}: ${run.ok ? (run.detail ?? 'sin cambios') : (run.error ?? 'falló')}`
        )
        .join(' · ') || null;
    if (failed > 0) {
      return {
        tone: 'error',
        message:
          failed === 1
            ? 'Una proyección falló; las demás sí se reconstruyeron'
            : `${failed} proyecciones fallaron; las demás sí se reconstruyeron`,
        detail,
      };
    }
    return {
      tone: 'success',
      message: `Proyecciones reconstruidas (${formatCount(written)} fila(s))`,
      detail,
    };
  }

  return {
    tone: 'success',
    message: 'Recálculo encolado; las proyecciones se actualizan en unos minutos',
    detail: null,
  };
}

/**
 * Context sent to the Control Tower copilot on every turn (`context.page`):
 * the numbers already on screen, never personal data. Bounded on purpose — the
 * copilot reads its own data with its tools.
 */
export type ControlTowerCopilotContext = {
  surface: 'control_tower';
  view: string;
  computedAt: string;
  cases: ControlTowerOverview['cases'];
  work: ControlTowerOverview['work'];
  requests: ControlTowerOverview['requests'];
  incidents: { open: number; severe: number };
  deliveries: ControlTowerOverview['deliveries'];
  approvals: ControlTowerOverview['approvals'];
  areas: Array<{
    areaKey: string;
    label: string;
    openWorkItems: number;
    overdueWorkItems: number;
    openRequests: number;
    overdueRequests: number;
    openIncidents: number;
  }>;
  health: { syncFailing: number; jobsFailed: number; staleProjections: string[] };
  alerts: Array<{ title: string; severity: string }>;
};

const MAX_CONTEXT_ALERTS = 6;

export function buildControlTowerContext(
  overview: ControlTowerOverview,
  view: string
): ControlTowerCopilotContext {
  const severe = overview.incidents.bySeverity
    .filter((row) => row.severity === 'critical' || row.severity === 'high')
    .reduce((total, row) => total + row.count, 0);
  return {
    surface: 'control_tower',
    view,
    computedAt: overview.computedAt,
    cases: overview.cases,
    work: overview.work,
    requests: overview.requests,
    incidents: { open: overview.incidents.open, severe },
    deliveries: overview.deliveries,
    approvals: overview.approvals,
    areas: sortedAreaLoad(overview.areas).map((area) => ({
      areaKey: area.areaKey,
      label: area.label,
      openWorkItems: area.openWorkItems,
      overdueWorkItems: area.overdueWorkItems,
      openRequests: area.openRequests,
      overdueRequests: area.overdueRequests,
      openIncidents: area.openIncidents,
    })),
    health: {
      syncFailing: overview.sync.failing,
      jobsFailed: overview.jobs.failed,
      staleProjections: overview.projections.filter((row) => row.stale).map((row) => row.key),
    },
    alerts: overview.alerts
      .slice(0, MAX_CONTEXT_ALERTS)
      .map((alert) => ({ title: alert.title, severity: alert.severity })),
  };
}
