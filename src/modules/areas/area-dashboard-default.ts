import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  AREA_REQUEST_OPEN_STATUSES,
  INCIDENT_OPEN_STATUSES,
  INCIDENT_SEVERITY_LABELS,
  WORK_ITEM_KIND_LABELS,
  WORK_ITEM_OPEN_STATUSES,
  type IncidentSeverity,
} from '@/modules/operations/types';
import { areaHref, type AreaMeta } from './area-registry';
import type {
  AreaDashboardAlert,
  AreaDashboardPayload,
  AreaDashboardTile,
} from './area-server-registry';

/**
 * Default panel of an area (plan 7.3). SERVER ONLY.
 *
 * It only reads entities the core owns — work items, area requests and
 * incidents — so every area shows real numbers from the first minute, even
 * before its own dashboard service exists. An area that registers
 * `loadDashboard` replaces this entirely.
 *
 * No invented data: an area with nothing to do shows zeros and an empty alert
 * list, never a placeholder number.
 */

const TREND_DAYS = 14;
const ALERT_LIMIT = 6;

const OPEN_WORK = [...WORK_ITEM_OPEN_STATUSES];
const OPEN_REQUESTS = [...AREA_REQUEST_OPEN_STATUSES];
const OPEN_INCIDENTS = [...INCIDENT_OPEN_STATUSES];

interface TrendRow {
  label: string;
  creados: number;
  terminados: number;
}

interface KindRow {
  kind: string;
  total: number;
}

function workHref(area: AreaMeta, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  const base = areaHref(area.key, 'trabajo');
  return query ? `${base}?${query}` : base;
}

const fmt = (value: number) => value.toLocaleString('es-MX');

export async function loadDefaultAreaDashboard(
  _actor: CurrentUser,
  area: AreaMeta,
  options: { now?: Date } = {}
): Promise<AreaDashboardPayload> {
  const now = options.now ?? new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - (TREND_DAYS - 1));
  from.setHours(0, 0, 0, 0);

  const openWork = { areaKey: area.key, status: { in: OPEN_WORK } };

  const [
    openWorkCount,
    overdueCount,
    waitingCount,
    escalatedCount,
    requestsIn,
    requestsInOverdue,
    requestsOut,
    incidentsOpen,
    byKind,
    trend,
    overdueItems,
    incidentRows,
  ] = await Promise.all([
    prisma.workItem.count({ where: openWork }),
    prisma.workItem.count({ where: { ...openWork, dueAt: { lt: now } } }),
    prisma.workItem.count({ where: { areaKey: area.key, status: 'waiting' } }),
    prisma.workItem.count({ where: { ...openWork, escalationLevel: { gt: 0 } } }),
    prisma.areaRequest.count({ where: { toAreaKey: area.key, status: { in: OPEN_REQUESTS } } }),
    prisma.areaRequest.count({
      where: { toAreaKey: area.key, status: { in: OPEN_REQUESTS }, dueAt: { lt: now } },
    }),
    prisma.areaRequest.count({
      where: {
        fromAreaKey: area.key,
        toAreaKey: { not: area.key },
        status: { in: OPEN_REQUESTS },
      },
    }),
    prisma.incident.count({ where: { areaKey: area.key, status: { in: OPEN_INCIDENTS } } }),
    prisma.workItem.groupBy({
      by: ['kind'],
      where: openWork,
      _count: { _all: true },
      orderBy: { _count: { kind: 'desc' } },
      take: 6,
    }),
    prisma.$queryRaw<TrendRow[]>`
      WITH days AS (
        SELECT generate_series(${from}::date, ${now}::date, interval '1 day')::date AS day
      ),
      created AS (
        SELECT "createdAt"::date AS day, count(*)::int AS total
        FROM "WorkItem"
        WHERE "areaKey" = ${area.key} AND "createdAt" >= ${from}
        GROUP BY 1
      ),
      finished AS (
        SELECT "completedAt"::date AS day, count(*)::int AS total
        FROM "WorkItem"
        WHERE "areaKey" = ${area.key} AND "completedAt" >= ${from}
        GROUP BY 1
      )
      SELECT to_char(d.day, 'DD/MM') AS "label",
             COALESCE(c.total, 0)::int AS "creados",
             COALESCE(f.total, 0)::int AS "terminados"
      FROM days d
      LEFT JOIN created c ON c.day = d.day
      LEFT JOIN finished f ON f.day = d.day
      ORDER BY d.day ASC`,
    prisma.workItem.findMany({
      where: { ...openWork, dueAt: { lt: now } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: ALERT_LIMIT,
      select: { id: true, title: true, dueAt: true, caseId: true, escalationLevel: true },
    }),
    prisma.incident.findMany({
      where: { areaKey: area.key, status: { in: OPEN_INCIDENTS } },
      orderBy: [{ severity: 'desc' }, { openedAt: 'desc' }],
      take: ALERT_LIMIT,
      select: { id: true, title: true, severity: true, openedAt: true },
    }),
  ]);

  const tiles: AreaDashboardTile[] = [
    {
      id: 'open',
      label: 'Trabajos abiertos',
      value: fmt(openWorkCount),
      hint: 'Lo que el área tiene a cargo ahora',
      href: workHref(area),
      live: true,
    },
    {
      id: 'overdue',
      label: 'Vencidos',
      value: fmt(overdueCount),
      tone: overdueCount > 0 ? 'danger' : 'success',
      hint: overdueCount > 0 ? 'Ya pasaron su fecha de compromiso' : 'Nada fuera de tiempo',
      href: workHref(area, { vencidos: '1' }),
      live: true,
    },
    {
      id: 'waiting',
      label: 'En espera',
      value: fmt(waitingCount),
      tone: waitingCount > 0 ? 'warning' : 'default',
      hint: 'Detenidos esperando a alguien más',
      href: workHref(area, { kind: 'work_item' }),
    },
    {
      id: 'escalated',
      label: 'Escalados',
      value: fmt(escalatedCount),
      tone: escalatedCount > 0 ? 'warning' : 'default',
      hint: 'Subieron de nivel por vencimiento',
    },
    {
      id: 'requests_in',
      label: 'Solicitudes recibidas',
      value: fmt(requestsIn),
      hint:
        requestsInOverdue > 0
          ? `${fmt(requestsInOverdue)} sin atender a tiempo`
          : 'Todas dentro de plazo',
      tone: requestsInOverdue > 0 ? 'danger' : 'default',
      href: workHref(area, { kind: 'request_in' }),
      live: true,
    },
    {
      id: 'requests_out',
      label: 'Solicitudes enviadas',
      value: fmt(requestsOut),
      hint: 'Esperando respuesta de otra área',
      href: workHref(area, { kind: 'request_out' }),
    },
    {
      id: 'incidents',
      label: 'Incidencias abiertas',
      value: fmt(incidentsOpen),
      tone: incidentsOpen > 0 ? 'warning' : 'success',
      hint: incidentsOpen > 0 ? 'Necesitan una decisión' : 'Sin incidencias',
    },
  ];

  const alerts: AreaDashboardAlert[] = [
    ...overdueItems.map((item) => ({
      id: `work-${item.id}`,
      severity: (item.escalationLevel > 1 ? 'danger' : 'warning') as AreaDashboardAlert['severity'],
      title: item.title,
      detail: `Venció el ${item.dueAt.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}`,
      href: workHref(area, { vencidos: '1' }),
      at: item.dueAt.toISOString(),
    })),
    ...incidentRows.map((incident) => ({
      id: `incident-${incident.id}`,
      severity: (incident.severity === 'critical' || incident.severity === 'high'
        ? 'danger'
        : 'warning') as AreaDashboardAlert['severity'],
      title: incident.title,
      detail: `Incidencia ${(INCIDENT_SEVERITY_LABELS[incident.severity as IncidentSeverity] ?? incident.severity).toLowerCase()}`,
      at: incident.openedAt.toISOString(),
    })),
  ].slice(0, ALERT_LIMIT);

  const kinds: KindRow[] = (byKind as Array<{ kind: string; _count: { _all: number } }>).map(
    (entry) => ({ kind: entry.kind, total: entry._count._all })
  );

  return {
    areaKey: area.key,
    tiles,
    charts: [
      {
        kind: 'trend',
        id: 'flow',
        title: 'Trabajo creado vs. terminado',
        description: `Últimos ${TREND_DAYS} días`,
        xKey: 'label',
        xLabel: 'Día',
        data: trend.map((point) => ({
          label: point.label,
          creados: Number(point.creados),
          terminados: Number(point.terminados),
        })),
        series: [
          { key: 'creados', label: 'Creados', tone: 'brand' },
          { key: 'terminados', label: 'Terminados', tone: 'success' },
        ],
      },
      {
        kind: 'bar',
        id: 'by-kind',
        title: 'Trabajo abierto por tipo',
        valueLabel: 'Trabajos',
        categoryLabel: 'Tipo',
        data: kinds.map((entry) => ({
          label: (WORK_ITEM_KIND_LABELS as Record<string, string>)[entry.kind] ?? entry.kind,
          value: entry.total,
        })),
      },
    ],
    alerts,
    computedAt: now.toISOString(),
    source: 'live',
    note: null,
  };
}
