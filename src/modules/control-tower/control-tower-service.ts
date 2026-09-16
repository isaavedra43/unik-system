import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { hasPermission } from '@/modules/auth/authorization';
import {
  getAgentHealth,
  getAreaAiUsage,
  type AgentHealth,
  type AreaAiUsage,
} from '@/modules/agents/budget';
import type {
  AreaDashboardAlert,
  AreaDashboardChart,
  AreaDashboardTile,
} from '@/modules/areas/area-server-registry';
import { getJobStats } from '@/modules/jobs/job-queue';
import { OperationsError } from '@/modules/operations/errors';
import {
  AREA_KEYS,
  AREA_LABELS,
  AREA_REQUEST_OPEN_STATUSES,
  CASE_OPEN_STATUSES,
  CASE_PHASES,
  CASE_PHASE_LABELS,
  INCIDENT_OPEN_STATUSES,
  INCIDENT_SEVERITY_LABELS,
  WORK_ITEM_OPEN_STATUSES,
  type AreaKey,
} from '@/modules/operations/types';

/**
 * Resumen de la Torre de Control (plan 7.7 `resumen`). SÓLO SERVIDOR.
 *
 * Un solo lugar responde "cómo va la empresa ahora mismo": expedientes, trabajo
 * vencido por área y por persona, incidencias por severidad, solicitudes
 * esperando, entregas en conflicto, salud de la sincronización con Zoho, cola
 * de trabajos, consumo de IA por área y frescura de las proyecciones.
 *
 * Los números salen de `count`/`groupBy` indexados, así que el panel responde en
 * frío; el job de tableros guarda además una foto en `DashboardSnapshot`
 * (`control_tower`) para que la primera visita del día no pague el cálculo.
 *
 * Este archivo NO importa `projections-service` (leería en círculo): la frescura
 * de las proyecciones se lee directamente de `CtProjectionWatermark`.
 */

export const CONTROL_TOWER_PERMISSION = 'operations.admin';
export const CONTROL_TOWER_SCOPE_TYPE = 'control_tower';
export const CONTROL_TOWER_SCOPE_KEY = '';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Guarda única de todo el módulo: la Torre de Control es de `operations.admin`. */
export function assertControlTowerAccess(actor: CurrentUser): void {
  if (!hasPermission(actor, CONTROL_TOWER_PERMISSION)) {
    throw new OperationsError('forbidden', 'Necesitas permiso de administrar operaciones');
  }
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface AreaLoadRow {
  areaKey: AreaKey;
  label: string;
  openWorkItems: number;
  overdueWorkItems: number;
  openRequests: number;
  overdueRequests: number;
  openIncidents: number;
  aiTokens: number | null;
  aiUsd: number | null;
}

export interface SyncHealthRow {
  source: string;
  entityType: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  minutesAgo: number;
  errorCode: string | null;
  recordsSeen: number;
  stale: boolean;
}

/** Una corrida tal como sale de `IntegrationSyncRun` (fechas todavía como `Date`). */
export interface SyncRunRow {
  source: string;
  entityType: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  errorCode: string | null;
  recordsSeen: number;
}

/** Sin noticias de una entidad durante más de esto, la fila sale en ámbar. */
export const SYNC_STALE_MINUTES = 120;

/**
 * Tope de PARES (fuente, entidad), no de corridas: hoy hay ~11 entidades de Zoho
 * y el `DISTINCT ON` devuelve una fila por par, así que 200 deja sitio de sobra
 * para las integraciones que vengan sin que la pantalla pague una lista larga.
 */
export const SYNC_ENTITY_LIMIT = 200;

/**
 * LA ÚLTIMA corrida de CADA entidad, no «las últimas N corridas».
 *
 * POR QUÉ ASÍ. Antes se leían las 60 corridas más recientes y se deduplicaba
 * después. Con ~11 entidades sincronizando cada 30 minutos, 60 corridas son una
 * o dos horas de historia: la entidad que DEJA de sincronizar sale de la ventana
 * antes de cumplir los 120 minutos que la pintan en ámbar, así que su fila
 * DESAPARECÍA del panel —y de `failing`— justo cuando había que verla. Una
 * integración detenida se volvía invisible por estar detenida.
 *
 * `DISTINCT ON` recorre el índice `(source, entityType, startedAt)` y el `LIMIT`
 * cuenta pares ya deduplicados, de modo que la antigüedad de una corrida no
 * influye en si se ve.
 */
export function latestSyncRunsSql(limit: number = SYNC_ENTITY_LIMIT): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT ON (r."source", r."entityType")
      r."source", r."entityType", r."status", r."startedAt", r."completedAt",
      r."errorCode", r."recordsSeen"
    FROM "IntegrationSyncRun" r
    ORDER BY r."source", r."entityType", r."startedAt" DESC
    LIMIT ${limit}
  `;
}

/**
 * Filas de salud de sincronización, ordenadas por fuente y entidad. PURA: la
 * consulta ya devuelve una corrida por entidad, aquí sólo se calcula la
 * antigüedad contra el reloj que recibe el resumen.
 */
export function toSyncHealthRows(
  rows: readonly SyncRunRow[],
  now: Date,
  staleMinutes: number = SYNC_STALE_MINUTES
): SyncHealthRow[] {
  return rows
    .map((run) => {
      const reference = run.completedAt ?? run.startedAt;
      const minutesAgo = Math.max(0, Math.floor((now.getTime() - reference.getTime()) / 60_000));
      return {
        source: run.source,
        entityType: run.entityType,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        minutesAgo,
        errorCode: run.errorCode,
        recordsSeen: run.recordsSeen,
        stale: minutesAgo > staleMinutes,
      };
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.entityType.localeCompare(b.entityType));
}

/** `fuente/entidad` de las primeras filas, para el detalle de una alerta. */
export function syncRunLabels(rows: readonly SyncHealthRow[], max = 3): string[] {
  return rows.slice(0, max).map((run) => `${run.source}/${run.entityType}`);
}

/**
 * ¿La última corrida de esa entidad falló? El motor escribe el estado en
 * MAYÚSCULAS (`SYNC_STATUS.FAILED`), así que la comparación es insensible a la
 * caja: escrita como `'failed'` nunca coincidía y la alerta dependía por entero
 * de que la corrida además hubiera guardado un `errorCode`.
 */
export function isFailedSyncRun(run: Pick<SyncHealthRow, 'status' | 'errorCode'>): boolean {
  return run.status.toUpperCase() === 'FAILED' || run.errorCode !== null;
}

export interface ProjectionHealthRow {
  key: string;
  lastRunAt: string;
  minutesAgo: number;
  lastDurationMs: number | null;
  stale: boolean;
}

export interface ControlTowerOverview {
  computedAt: string;
  cases: {
    open: number;
    blocked: number;
    waiting: number;
    openedToday: number;
    deliveredToday: number;
    stuck24h: number;
    promiseAtRisk: number;
    promiseBreached: number;
    byPhase: Array<{ phase: string; label: string; count: number }>;
  };
  work: { open: number; overdue: number; escalated: number };
  requests: { open: number; overdue: number; blocking: number };
  incidents: {
    open: number;
    bySeverity: Array<{ severity: string; label: string; count: number }>;
  };
  deliveries: { conflict: number; pendingExternal: number; failed: number };
  approvals: { pending: number; proposals: number };
  areas: AreaLoadRow[];
  /** Personas con más trabajo vencido (id + conteo; el nombre lo pone `people-service`). */
  overdueByOwner: Array<{ userId: string; name: string | null; overdue: number }>;
  sync: { runs: SyncHealthRow[]; failing: number; stale: number; staleMinutes: number };
  jobs: { pending: number; running: number; failed: number; completed: number; cancelled: number };
  ai: {
    tokensToday: number;
    usdToday: number;
    byArea: Array<{ areaKey: string; tokens: number; usd: number }>;
  };
  projections: ProjectionHealthRow[];
  tiles: AreaDashboardTile[];
  charts: AreaDashboardChart[];
  alerts: AreaDashboardAlert[];
}

// ---------------------------------------------------------------------------
// Cálculo
// ---------------------------------------------------------------------------

const fmt = (value: number) => value.toLocaleString('es-MX');

const money = (value: number) =>
  value.toLocaleString('es-MX', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

function startOfDay(now: Date): Date {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day;
}

interface CountRow {
  key: string;
  count: number;
}

const toCounts = <K extends string>(
  rows: Array<Record<K, string> & { _count: { _all: number } }>,
  key: K
): CountRow[] => rows.map((row) => ({ key: row[key], count: row._count._all }));

const sumBy = (rows: CountRow[], key: string) =>
  rows.filter((row) => row.key === key).reduce((total, row) => total + row.count, 0);

interface EventsPerHourRow {
  hour: Date;
  total: number;
}

/**
 * Entrada de `buildControlTowerAlerts`: números ya calculados, nunca Prisma.
 */
export interface ControlTowerAlertInput {
  // Procesos
  severeIncidents: number;
  promiseBreached: number;
  // Integración
  conflictDeliveries: number;
  failedDeliveries: number;
  failingRuns: number;
  /** `fuente/entidad` de las tres primeras corridas con error. */
  failingRunLabels: string[];
  /** Entidades sin noticias hace más de `staleRunMinutes` y SIN error que lo explique. */
  staleRuns: number;
  staleRunLabels: string[];
  staleRunMinutes: number;
  // Infraestructura y frescura
  failedJobs: number;
  staleProjectionKeys: string[];
  // IA
  ai: AgentHealth | null;
  aiFailureIncidents: number;
  // Datos
  areasWithoutResponsible: string[];
  configIncidents: number;
  casesWithInactiveOwner: number;
}

/**
 * Las alertas del resumen, PURAS y en un solo lugar (plan sección 8 · E8:
 * «alertas de integración/procesos/IA/datos»). Orden estable: primero lo que
 * frena una entrega, luego integración, IA, datos e infraestructura.
 *
 * Familias:
 * - procesos: `incidents_severe`, `promise_breached`;
 * - integración: `deliveries_conflict`, `sync_failing`, `sync_stale`;
 * - IA: `ai_budget_exhausted`, `ai_agents_paused`, `ai_failures`,
 *   `ai_budget_degraded`, `ai_disabled`;
 * - datos: `data_responsible_missing`, `data_config_incidents`,
 *   `data_cases_inactive_owner`;
 * - infraestructura: `jobs_failed`, `projections_stale`.
 */
export function buildControlTowerAlerts(input: ControlTowerAlertInput): AreaDashboardAlert[] {
  const alerts: AreaDashboardAlert[] = [];
  const names = (rows: Array<{ label: string }>, max = 3) =>
    rows
      .slice(0, max)
      .map((row) => row.label)
      .join(', ') + (rows.length > max ? `, +${rows.length - max}` : '');

  // --- Procesos -------------------------------------------------------------
  if (input.severeIncidents > 0) {
    alerts.push({
      id: 'incidents_severe',
      severity: 'danger',
      title: `${fmt(input.severeIncidents)} incidencias altas o críticas abiertas`,
      detail: 'Revísalas en Excepciones antes de que bloqueen una entrega.',
      href: '/app/admin/control-tower/excepciones',
    });
  }
  // --- Integración ----------------------------------------------------------
  if (input.conflictDeliveries + input.failedDeliveries > 0) {
    alerts.push({
      id: 'deliveries_conflict',
      severity: 'danger',
      title: `${fmt(input.conflictDeliveries + input.failedDeliveries)} entregas en conflicto o fallidas`,
      detail: 'Zoho devolvió otro valor o la escritura falló; Logística decide si se reescribe.',
    });
  }
  if (input.failingRuns > 0) {
    alerts.push({
      id: 'sync_failing',
      severity: 'warning',
      title: `${fmt(input.failingRuns)} sincronizaciones con error`,
      detail: input.failingRunLabels.join(', '),
    });
  }
  if (input.staleRuns > 0) {
    // Una integración DETENIDA no falla: deja de correr, y sin esta alerta sólo
    // se notaba por el tono ámbar de una fila que casi nadie mira.
    alerts.push({
      id: 'sync_stale',
      severity: 'warning',
      title: `${fmt(input.staleRuns)} sincronizaciones sin correr hace más de ${fmt(input.staleRunMinutes)} min`,
      detail: `${input.staleRunLabels.join(', ')}. No fallaron: dejaron de correr; revisa el programador de la integración.`,
    });
  }
  // --- IA -------------------------------------------------------------------
  const ai = input.ai;
  if (ai && ai.exhausted.length > 0) {
    alerts.push({
      id: 'ai_budget_exhausted',
      severity: 'danger',
      title: `${fmt(ai.exhausted.length)} identidades de IA con el presupuesto agotado`,
      detail: `${names(ai.exhausted)}. Sólo responden cuando alguien las menciona; sube el presupuesto en Agentes o espera al día siguiente.`,
      href: '/app/admin/assistant',
    });
  }
  if (ai && ai.paused.length > 0) {
    alerts.push({
      id: 'ai_agents_paused',
      severity: 'warning',
      title: `${fmt(ai.paused.length)} identidades de IA en pausa`,
      detail: `${names(ai.paused)}. No toman turnos automáticos hasta que alguien las reactive.`,
      href: '/app/admin/assistant',
    });
  }
  if (input.aiFailureIncidents > 0) {
    alerts.push({
      id: 'ai_failures',
      severity: 'warning',
      title: `${fmt(input.aiFailureIncidents)} incidencias de la capa de IA abiertas`,
      detail:
        'Un turno automático falló y el motor siguió sin ella; revisa el proveedor y las llaves.',
      href: '/app/admin/control-tower/excepciones',
    });
  }
  if (ai && ai.exhausted.length === 0 && ai.degraded.length > 0) {
    alerts.push({
      id: 'ai_budget_degraded',
      severity: 'info',
      title: `${fmt(ai.degraded.length)} identidades de IA pasaron el ${ai.degradeAtPct} % de su presupuesto`,
      detail: `${names(ai.degraded)}. Desde aquí sólo actúan por mención.`,
    });
  }
  if (ai && !ai.enabled) {
    alerts.push({
      id: 'ai_disabled',
      severity: 'info',
      title: 'La capa de IA coordinada está apagada',
      detail:
        'Ninguna identidad toma turnos automáticos; el motor operativo sigue funcionando igual.',
      href: '/app/admin/assistant',
    });
  }
  // --- Datos ----------------------------------------------------------------
  if (input.areasWithoutResponsible.length > 0) {
    alerts.push({
      id: 'data_responsible_missing',
      severity: 'danger',
      title: `${fmt(input.areasWithoutResponsible.length)} áreas sin responsable activo`,
      detail: `${input.areasWithoutResponsible.join(', ')}. Su trabajo cae en Administración hasta que se configure.`,
      href: '/app/admin/access',
    });
  }
  if (input.configIncidents > 0) {
    alerts.push({
      id: 'data_config_incidents',
      severity: 'warning',
      title: `${fmt(input.configIncidents)} incidencias de configuración abiertas`,
      detail:
        'Falta un dato maestro (responsable, área o catálogo); se resuelven solas al corregirlo.',
      href: '/app/admin/control-tower/excepciones',
    });
  }
  if (input.casesWithInactiveOwner > 0) {
    alerts.push({
      id: 'data_cases_inactive_owner',
      severity: 'warning',
      title: `${fmt(input.casesWithInactiveOwner)} expedientes abiertos con un dueño dado de baja`,
      detail: 'Nadie responde por ellos: reasigna el expediente o reactiva a la persona.',
      href: '/app/operations',
    });
  }
  // --- Infraestructura ------------------------------------------------------
  if (input.failedJobs > 0) {
    alerts.push({
      id: 'jobs_failed',
      severity: 'warning',
      title: `${fmt(input.failedJobs)} trabajos de fondo fallidos`,
      detail: 'Revisa la cola: un trabajo fallido puede dejar un expediente esperando.',
    });
  }
  if (input.staleProjectionKeys.length > 0) {
    alerts.push({
      id: 'projections_stale',
      severity: 'info',
      title: 'Las proyecciones llevan más de una hora sin actualizarse',
      detail: input.staleProjectionKeys.join(', '),
    });
  }
  if (input.promiseBreached > 0) {
    alerts.push({
      id: 'promise_breached',
      severity: 'danger',
      title: `${fmt(input.promiseBreached)} expedientes pasaron su fecha prometida`,
      detail: 'Ventas debe avisar al cliente o replanear la entrega.',
    });
  }
  return alerts;
}

/**
 * Calcula el resumen. Sin actor: lo usan tanto la lectura autenticada como el
 * job del snapshot (que corre como sistema y nunca expone datos personales).
 */
export async function computeControlTowerOverview(
  options: { now?: Date } = {}
): Promise<ControlTowerOverview> {
  const now = options.now ?? new Date();
  const dayStart = startOfDay(now);
  const openCases = { status: { in: [...CASE_OPEN_STATUSES] } };
  const openWork = { status: { in: [...WORK_ITEM_OPEN_STATUSES] } };
  const openRequests = { status: { in: [...AREA_REQUEST_OPEN_STATUSES] } };
  const openIncidents = { status: { in: [...INCIDENT_OPEN_STATUSES] } };

  const [
    casesByStatus,
    casesByPhase,
    openedToday,
    deliveredToday,
    stuck24h,
    promiseAtRisk,
    promiseBreached,
    workOpenByArea,
    workOverdueByArea,
    workEscalated,
    requestsOpenByArea,
    requestsOverdueByArea,
    blockingRequests,
    incidentsBySeverity,
    incidentsByArea,
    deliveriesByStatus,
    pendingApprovals,
    pendingProposals,
    overdueOwners,
    syncRuns,
    jobStats,
    watermarks,
    eventsPerHour,
    aiFailureIncidents,
    configIncidents,
    caseOwners,
    areaRows,
    responsibleRows,
    agentHealth,
  ] = await Promise.all([
    prisma.operationalCase.groupBy({ by: ['status'], where: openCases, _count: { _all: true } }),
    prisma.operationalCase.groupBy({ by: ['phase'], where: openCases, _count: { _all: true } }),
    prisma.operationalCase.count({ where: { openedAt: { gte: dayStart } } }),
    prisma.operationalEvent.count({
      where: { type: 'case.delivered', occurredAt: { gte: dayStart } },
    }),
    prisma.operationalCase.count({
      where: { ...openCases, lastActivityAt: { lt: new Date(now.getTime() - DAY) } },
    }),
    prisma.operationalCase.count({
      where: { ...openCases, promisedAt: { gte: now, lt: new Date(now.getTime() + 2 * DAY) } },
    }),
    prisma.operationalCase.count({ where: { ...openCases, promisedAt: { lt: now } } }),
    prisma.workItem.groupBy({ by: ['areaKey'], where: openWork, _count: { _all: true } }),
    prisma.workItem.groupBy({
      by: ['areaKey'],
      where: { ...openWork, dueAt: { lt: now } },
      _count: { _all: true },
    }),
    prisma.workItem.count({ where: { status: 'escalated' } }),
    prisma.areaRequest.groupBy({ by: ['toAreaKey'], where: openRequests, _count: { _all: true } }),
    prisma.areaRequest.groupBy({
      by: ['toAreaKey'],
      where: { ...openRequests, dueAt: { lt: now } },
      _count: { _all: true },
    }),
    prisma.areaRequest.count({ where: { ...openRequests, blocksDelivery: true } }),
    prisma.incident.groupBy({ by: ['severity'], where: openIncidents, _count: { _all: true } }),
    prisma.incident.groupBy({ by: ['areaKey'], where: openIncidents, _count: { _all: true } }),
    prisma.deliveryOrder.groupBy({
      by: ['status'],
      where: { status: { in: ['conflict', 'pending_external', 'failed'] } },
      _count: { _all: true },
    }),
    prisma.approvalRequest.count({ where: { status: 'pending' } }),
    prisma.aiProposal.count({
      where: {
        status: { in: ['pending', 'awaiting_second_approval'] },
        expiresAt: { gt: now },
      },
    }),
    prisma.workItem.groupBy({
      by: ['ownerUserId'],
      where: { ...openWork, dueAt: { lt: now } },
      _count: { _all: true },
      orderBy: { _count: { ownerUserId: 'desc' } },
      take: 8,
    }),
    prisma.$queryRaw<SyncRunRow[]>(latestSyncRunsSql(SYNC_ENTITY_LIMIT)),
    getJobStats().catch(() => ({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    })),
    prisma.ctProjectionWatermark.findMany({
      select: { key: true, lastRunAt: true, lastDurationMs: true },
      orderBy: { key: 'asc' },
    }),
    prisma.$queryRaw<EventsPerHourRow[]>(Prisma.sql`
      SELECT date_trunc('hour', e."occurredAt") AS "hour", COUNT(*)::int AS "total"
      FROM "OperationalEvent" e
      WHERE e."occurredAt" >= ${new Date(now.getTime() - DAY)}
        AND e."type" NOT LIKE 'ai.%'
      GROUP BY 1
      ORDER BY 1 ASC
    `),
    prisma.incident.count({ where: { ...openIncidents, kind: 'ai_failure' } }),
    prisma.incident.count({ where: { ...openIncidents, dedupeKey: { startsWith: 'config:' } } }),
    prisma.operationalCase.groupBy({
      by: ['ownerUserId'],
      where: openCases,
      _count: { _all: true },
    }),
    prisma.area.findMany({
      where: { active: true },
      select: { key: true, label: true, responsibleArea: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.responsible.findMany({ select: { area: true, active: true, userId: true } }),
    // La capa de IA puede estar sin configurar: su salud nunca tumba el resumen.
    getAgentHealth({ now }).catch(() => null),
  ]);

  const statusCounts = toCounts(casesByStatus, 'status');
  const phaseCounts = toCounts(casesByPhase, 'phase');
  const workOpen = toCounts(workOpenByArea, 'areaKey');
  const workOverdue = toCounts(workOverdueByArea, 'areaKey');
  const requestsOpen = toCounts(requestsOpenByArea, 'toAreaKey');
  const requestsOverdue = toCounts(requestsOverdueByArea, 'toAreaKey');
  const incidentsArea = toCounts(incidentsByArea, 'areaKey');
  const severityCounts = toCounts(incidentsBySeverity, 'severity');
  const deliveryCounts = toCounts(deliveriesByStatus, 'status');

  let ai: AreaAiUsage | null = null;
  try {
    ai = await getAreaAiUsage({ from: dayStart, to: now });
  } catch {
    ai = null;
  }

  const ownerIds = overdueOwners.map((row) => row.ownerUserId);
  const ownerNames =
    ownerIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, name: true },
        })
      : [];
  const nameById = new Map(ownerNames.map((user) => [user.id, user.name]));

  const areas: AreaLoadRow[] = AREA_KEYS.map((areaKey) => {
    const aiRow = ai?.areas.find((row) => row.areaKey === areaKey) ?? null;
    return {
      areaKey,
      label: AREA_LABELS[areaKey],
      openWorkItems: sumBy(workOpen, areaKey),
      overdueWorkItems: sumBy(workOverdue, areaKey),
      openRequests: sumBy(requestsOpen, areaKey),
      overdueRequests: sumBy(requestsOverdue, areaKey),
      openIncidents: sumBy(incidentsArea, areaKey),
      aiTokens: aiRow ? aiRow.tokens : null,
      aiUsd: aiRow ? aiRow.usd : null,
    };
  });

  // La consulta ya devuelve LA ÚLTIMA corrida de cada entidad (`latestSyncRunsSql`).
  const runs = toSyncHealthRows(syncRuns, now, SYNC_STALE_MINUTES);
  const failing = runs.filter((run) => isFailedSyncRun(run));
  const failingRuns = failing.length;
  /** Sin noticias hace rato y sin error que lo explique: nadie la está corriendo. */
  const staleSyncRows = runs.filter((run) => run.stale && !isFailedSyncRun(run));

  const projections: ProjectionHealthRow[] = watermarks.map((row) => {
    const minutesAgo = Math.max(0, Math.floor((now.getTime() - row.lastRunAt.getTime()) / 60_000));
    return {
      key: row.key,
      lastRunAt: row.lastRunAt.toISOString(),
      minutesAgo,
      lastDurationMs: row.lastDurationMs,
      stale: minutesAgo > 60,
    };
  });

  const openCasesTotal = statusCounts.reduce((total, row) => total + row.count, 0);
  const overdueWorkTotal = workOverdue.reduce((total, row) => total + row.count, 0);
  const openWorkTotal = workOpen.reduce((total, row) => total + row.count, 0);
  const openRequestsTotal = requestsOpen.reduce((total, row) => total + row.count, 0);
  const overdueRequestsTotal = requestsOverdue.reduce((total, row) => total + row.count, 0);
  const openIncidentsTotal = severityCounts.reduce((total, row) => total + row.count, 0);
  const severeIncidents = severityCounts
    .filter((row) => row.key === 'critical' || row.key === 'high')
    .reduce((total, row) => total + row.count, 0);
  const conflictDeliveries = sumBy(deliveryCounts, 'conflict');
  const pendingExternal = sumBy(deliveryCounts, 'pending_external');
  const failedDeliveries = sumBy(deliveryCounts, 'failed');
  const aiTokensToday = ai ? ai.totals.tokens : 0;
  const aiUsdToday = ai ? ai.totals.usd : 0;

  const tiles: AreaDashboardTile[] = [
    {
      id: 'cases_open',
      label: 'Expedientes abiertos',
      value: fmt(openCasesTotal),
      hint: `${fmt(openedToday)} nuevos hoy · ${fmt(deliveredToday)} entregados`,
      live: true,
    },
    {
      id: 'cases_blocked',
      label: 'Expedientes bloqueados',
      value: fmt(sumBy(statusCounts, 'blocked')),
      tone: sumBy(statusCounts, 'blocked') > 0 ? 'danger' : 'success',
      hint: `${fmt(stuck24h)} sin movimiento en 24 h`,
      live: true,
    },
    {
      id: 'promise_risk',
      label: 'Promesas en riesgo',
      value: fmt(promiseAtRisk + promiseBreached),
      tone: promiseBreached > 0 ? 'danger' : promiseAtRisk > 0 ? 'warning' : 'success',
      hint: `${fmt(promiseBreached)} ya vencidas · ${fmt(promiseAtRisk)} en 48 h`,
      live: true,
    },
    {
      id: 'work_overdue',
      label: 'Trabajos vencidos',
      value: fmt(overdueWorkTotal),
      tone: overdueWorkTotal > 0 ? 'danger' : 'success',
      hint: `${fmt(openWorkTotal)} abiertos · ${fmt(workEscalated)} escalados`,
      live: true,
    },
    {
      id: 'incidents',
      label: 'Incidencias abiertas',
      value: fmt(openIncidentsTotal),
      tone: severeIncidents > 0 ? 'danger' : openIncidentsTotal > 0 ? 'warning' : 'success',
      hint: `${fmt(severeIncidents)} altas o críticas`,
    },
    {
      id: 'requests_waiting',
      label: 'Solicitudes esperando',
      value: fmt(openRequestsTotal),
      tone: overdueRequestsTotal > 0 ? 'warning' : 'default',
      hint: `${fmt(overdueRequestsTotal)} vencidas · ${fmt(blockingRequests)} bloquean entregas`,
    },
    {
      id: 'deliveries_conflict',
      label: 'Entregas en conflicto',
      value: fmt(conflictDeliveries + failedDeliveries),
      tone: conflictDeliveries + failedDeliveries > 0 ? 'danger' : 'success',
      hint: `${fmt(pendingExternal)} esperando a Zoho`,
    },
    {
      id: 'ai_cost',
      label: 'IA hoy',
      value: aiUsdToday > 0 ? money(aiUsdToday) : `${fmt(aiTokensToday)} tokens`,
      hint:
        aiUsdToday > 0
          ? `${fmt(aiTokensToday)} tokens`
          : 'Tokens en tarifa plana (sin costo variable)',
    },
  ];

  const charts: AreaDashboardChart[] = [
    {
      kind: 'status',
      id: 'cases_by_phase',
      title: 'Expedientes por fase',
      segments: CASE_PHASES.map((phase, index) => ({
        key: phase,
        label: CASE_PHASE_LABELS[phase],
        count: sumBy(phaseCounts, phase),
        tone: (['brand', 'info', 'warning', 'success', 'muted'] as const)[index % 5],
      })),
    },
    {
      kind: 'trend',
      id: 'events_per_hour',
      title: 'Actividad de las últimas 24 horas',
      description: 'Eventos operativos por hora (sin los turnos de IA).',
      xKey: 'hour',
      xLabel: 'Hora',
      data: eventsPerHour.map((row) => ({
        hour: new Date(row.hour).toISOString().slice(11, 16),
        eventos: Number(row.total),
      })),
      series: [{ key: 'eventos', label: 'Eventos', tone: 'brand' }],
    },
    {
      kind: 'bar',
      id: 'overdue_by_area',
      title: 'Vencidos por área',
      categoryLabel: 'Área',
      valueLabel: 'Trabajos y solicitudes vencidas',
      data: areas
        .map((area) => ({
          label: area.label,
          value: area.overdueWorkItems + area.overdueRequests,
          tone:
            area.overdueWorkItems + area.overdueRequests > 0
              ? ('danger' as const)
              : ('success' as const),
        }))
        .filter((row) => row.value > 0),
    },
  ];

  // Calidad de datos: expedientes abiertos cuyo dueño ya no está activo (nadie
  // responde por ellos) y áreas activas cuyo `responsibleArea` no tiene fila de
  // `Responsible` activa, que mandan su trabajo a Administración (riesgo §11).
  const caseOwnerIds = caseOwners.map((row) => row.ownerUserId);
  const inactiveOwners =
    caseOwnerIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: caseOwnerIds }, isActive: false },
          select: { id: true },
        })
      : [];
  const inactiveOwnerIds = new Set(inactiveOwners.map((user) => user.id));
  const casesWithInactiveOwner = caseOwners
    .filter((row) => inactiveOwnerIds.has(row.ownerUserId))
    .reduce((total, row) => total + row._count._all, 0);

  const activeResponsibleAreas = new Set(
    responsibleRows.filter((row) => row.active && row.userId).map((row) => row.area)
  );
  const areasWithoutResponsible = areaRows
    .filter((area) => !activeResponsibleAreas.has(area.responsibleArea || area.key))
    .map((area) => area.label);

  const alerts = buildControlTowerAlerts({
    severeIncidents,
    conflictDeliveries,
    failedDeliveries,
    failingRuns,
    failingRunLabels: syncRunLabels(failing),
    staleRuns: staleSyncRows.length,
    staleRunLabels: syncRunLabels(staleSyncRows),
    staleRunMinutes: SYNC_STALE_MINUTES,
    failedJobs: jobStats.failed,
    staleProjectionKeys: projections.filter((row) => row.stale).map((row) => row.key),
    promiseBreached,
    ai: agentHealth,
    aiFailureIncidents,
    areasWithoutResponsible,
    configIncidents,
    casesWithInactiveOwner,
  });

  return {
    computedAt: now.toISOString(),
    cases: {
      open: openCasesTotal,
      blocked: sumBy(statusCounts, 'blocked'),
      waiting: sumBy(statusCounts, 'waiting'),
      openedToday,
      deliveredToday,
      stuck24h,
      promiseAtRisk,
      promiseBreached,
      byPhase: CASE_PHASES.map((phase) => ({
        phase,
        label: CASE_PHASE_LABELS[phase],
        count: sumBy(phaseCounts, phase),
      })),
    },
    work: { open: openWorkTotal, overdue: overdueWorkTotal, escalated: workEscalated },
    requests: {
      open: openRequestsTotal,
      overdue: overdueRequestsTotal,
      blocking: blockingRequests,
    },
    incidents: {
      open: openIncidentsTotal,
      bySeverity: severityCounts.map((row) => ({
        severity: row.key,
        label:
          INCIDENT_SEVERITY_LABELS[row.key as keyof typeof INCIDENT_SEVERITY_LABELS] ?? row.key,
        count: row.count,
      })),
    },
    deliveries: {
      conflict: conflictDeliveries,
      pendingExternal,
      failed: failedDeliveries,
    },
    approvals: { pending: pendingApprovals, proposals: pendingProposals },
    areas,
    overdueByOwner: overdueOwners.map((row) => ({
      userId: row.ownerUserId,
      name: nameById.get(row.ownerUserId) ?? null,
      overdue: row._count._all,
    })),
    sync: {
      runs,
      failing: failingRuns,
      stale: staleSyncRows.length,
      staleMinutes: SYNC_STALE_MINUTES,
    },
    jobs: jobStats,
    ai: {
      tokensToday: aiTokensToday,
      usdToday: aiUsdToday,
      byArea: (ai?.areas ?? []).map((row) => ({
        areaKey: row.areaKey,
        tokens: row.tokens,
        usd: row.usd,
      })),
    },
    projections,
    tiles,
    charts,
    alerts,
  };
}

/** Resumen para una persona (exige `operations.admin`). */
export async function getControlTowerOverview(
  actor: CurrentUser,
  options: { now?: Date } = {}
): Promise<ControlTowerOverview> {
  assertControlTowerAccess(actor);
  return computeControlTowerOverview(options);
}
