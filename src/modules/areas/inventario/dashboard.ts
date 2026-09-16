import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { areaHref, type AreaMeta } from '@/modules/areas/area-registry';
import type { AreaLiveTileProvider } from '@/modules/areas/dashboard-service';
import type {
  AreaDashboardAlert,
  AreaDashboardPayload,
  AreaDashboardTile,
} from '@/modules/areas/area-server-registry';
import {
  confidenceSegments,
  controlledShare,
  inventoryHref,
  INVENTORY_SPACES,
  STALE_COUNT_DAYS,
} from '@/components/areas/inventario/inventario-model';
import {
  getConfidenceSummary,
  listDisputedSkusBlockingCases,
} from '@/modules/inventory/inventory-queries';
import { COUNT_OPEN_STATUSES } from '@/modules/inventory/inventory-types';
import { getOperationsConfig } from '@/modules/operations/operations-config';
import { AREA_REQUEST_OPEN_STATUSES, WORK_ITEM_OPEN_STATUSES } from '@/modules/operations/types';
import { countStaleLocations } from './inventory-area-queries';
import { COUNT_SLA_HOURS, VERIFICATION_WORK_ITEM_KIND, startOfLocalDay } from './work-rows';

/**
 * Panel of Inventario (plan 7.3): the eight tiles of the table, the two charts
 * and the alert list, all computed from real entities.
 *
 * Every number comes from an indexed count or from an aggregate the database
 * resolves; the three cheap ones (verificaciones, conteos y SKUs en disputa)
 * are marked `live` and the rest are computed for the request as well — there
 * is no snapshot job for this area yet, so `source` is always `live` and the
 * freshness the panel shows is honest.
 *
 * Nothing is invented: an area with nothing to do shows zeros and an empty
 * alert list.
 */

const TREND_DAYS = 14;
const ALERT_LIMIT = 6;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const OPEN_WORK = [...WORK_ITEM_OPEN_STATUSES];
const OPEN_REQUESTS = [...AREA_REQUEST_OPEN_STATUSES];
const OPEN_COUNTS = [...COUNT_OPEN_STATUSES];

const fmt = (value: number) => value.toLocaleString('es-MX');

interface TrendRow {
  label: string;
  creadas: number;
  resueltas: number;
}

function workHref(area: AreaMeta, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  const base = areaHref(area.key, 'trabajo');
  return query ? `${base}?${query}` : base;
}

function shortDate(value: Date): string {
  return value.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
}

/** Panel of the area. Never throws: a slow part degrades into a note. */
export async function loadInventoryDashboard(
  actor: CurrentUser,
  area: AreaMeta,
  options: { now?: Date } = {}
): Promise<AreaDashboardPayload> {
  const now = options.now ?? new Date();
  const startOfToday = startOfLocalDay(now);
  const trendFrom = new Date(now);
  trendFrom.setDate(trendFrom.getDate() - (TREND_DAYS - 1));
  trendFrom.setHours(0, 0, 0, 0);

  const verificationWhere = {
    areaKey: area.key,
    kind: VERIFICATION_WORK_ITEM_KIND,
    status: { in: OPEN_WORK },
  };
  const countSlaThreshold = new Date(now.getTime() - COUNT_SLA_HOURS * HOUR_MS);

  const config = await getOperationsConfig().catch(() => null);
  const reservationAlertDays = config?.reservationAlertDays ?? 7;
  const staleReservationThreshold = new Date(now.getTime() - reservationAlertDays * DAY_MS);

  const notes: string[] = [];
  const safe = async <T>(run: () => Promise<T>, fallback: T, note: string): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      console.error(
        JSON.stringify({
          component: 'inventario-dashboard',
          event: 'partial_failure',
          note,
          message: error instanceof Error ? error.message : String(error),
        })
      );
      notes.push(note);
      return fallback;
    }
  };

  const [
    pendingVerifications,
    overdueVerifications,
    openCounts,
    countsWithDifferences,
    disputedItems,
    activeReservations,
    staleReservations,
    movementsToday,
    requestsIn,
    requestsInOverdue,
    staleLocations,
    confidence,
    trend,
    overdueCounts,
    blockingDisputes,
  ] = await Promise.all([
    prisma.workItem.count({ where: verificationWhere }),
    prisma.workItem.count({ where: { ...verificationWhere, dueAt: { lt: now } } }),
    prisma.stockCount.count({ where: { status: { in: OPEN_COUNTS } } }),
    prisma.stockCountLine.count({
      where: { resolution: { in: ['pending', 'disputed'] }, count: { status: 'closed' } },
    }),
    prisma.productInventoryProfile.count({ where: { confidence: 'DISPUTED' } }),
    prisma.stockReservation.count({ where: { status: 'active' } }),
    prisma.stockReservation.count({
      where: { status: 'active', createdAt: { lte: staleReservationThreshold } },
    }),
    prisma.stockMovement.count({ where: { occurredAt: { gte: startOfToday } } }),
    prisma.areaRequest.count({ where: { toAreaKey: area.key, status: { in: OPEN_REQUESTS } } }),
    prisma.areaRequest.count({
      where: { toAreaKey: area.key, status: { in: OPEN_REQUESTS }, dueAt: { lt: now } },
    }),
    safe(
      () => countStaleLocations(actor, { days: STALE_COUNT_DAYS, now }),
      0,
      'No pudimos calcular las ubicaciones sin conteo reciente.'
    ),
    safe(
      () => getConfidenceSummary(actor),
      [] as Array<{ confidence: string; label: string; items: number }>,
      'No pudimos calcular la distribución de confianza.'
    ),
    safe(
      () => prisma.$queryRaw<TrendRow[]>`
        WITH days AS (
          SELECT generate_series(${trendFrom}::date, ${now}::date, interval '1 day')::date AS day
        ),
        creadas AS (
          SELECT "createdAt"::date AS day, count(*)::int AS total
          FROM "WorkItem"
          WHERE "areaKey" = ${area.key} AND "kind" = ${VERIFICATION_WORK_ITEM_KIND}
            AND "createdAt" >= ${trendFrom}
          GROUP BY 1
        ),
        resueltas AS (
          SELECT "completedAt"::date AS day, count(*)::int AS total
          FROM "WorkItem"
          WHERE "areaKey" = ${area.key} AND "kind" = ${VERIFICATION_WORK_ITEM_KIND}
            AND "completedAt" >= ${trendFrom}
          GROUP BY 1
        )
        SELECT to_char(d.day, 'DD/MM') AS "label",
               COALESCE(c.total, 0)::int AS "creadas",
               COALESCE(r.total, 0)::int AS "resueltas"
        FROM days d
        LEFT JOIN creadas c ON c.day = d.day
        LEFT JOIN resueltas r ON r.day = d.day
        ORDER BY d.day ASC`,
      [] as TrendRow[],
      'No pudimos calcular la tendencia de verificaciones.'
    ),
    prisma.stockCount.findMany({
      where: { status: { in: OPEN_COUNTS }, createdAt: { lt: countSlaThreshold } },
      orderBy: [{ createdAt: 'asc' }],
      take: ALERT_LIMIT,
      select: { id: true, scope: true, createdAt: true, warehouseId: true },
    }),
    safe(
      () => listDisputedSkusBlockingCases(actor, { pageSize: 3 }),
      { rows: [], total: 0, page: 1, pageSize: 3, pageCount: 1 },
      'No pudimos revisar las disputas que bloquean expedientes.'
    ),
  ]);

  const warehouseNames = overdueCounts.length
    ? new Map(
        (
          await prisma.warehouse.findMany({
            where: { id: { in: [...new Set(overdueCounts.map((row) => row.warehouseId))] } },
            select: { id: true, name: true },
          })
        ).map((warehouse) => [warehouse.id, warehouse.name])
      )
    : new Map<string, string>();

  const controlled = controlledShare(confidence);

  const tiles: AreaDashboardTile[] = [
    {
      id: 'verifications',
      label: 'Verificaciones pendientes',
      value: fmt(pendingVerifications),
      hint:
        overdueVerifications > 0
          ? `${fmt(overdueVerifications)} fuera de tiempo`
          : 'Ninguna fuera de tiempo',
      tone: overdueVerifications > 0 ? 'danger' : pendingVerifications > 0 ? 'default' : 'success',
      href: workHref(area, { kind: 'verification' }),
      live: true,
    },
    {
      id: 'open-counts',
      label: 'Conteos en curso',
      value: fmt(openCounts),
      hint:
        countsWithDifferences > 0
          ? `${fmt(countsWithDifferences)} líneas cerradas esperan decisión`
          : 'Sin diferencias por decidir',
      tone: countsWithDifferences > 0 ? 'warning' : 'default',
      href: inventoryHref(INVENTORY_SPACES.counts),
      live: true,
    },
    {
      id: 'stale-locations',
      label: `Ubicaciones sin conteo >${STALE_COUNT_DAYS} d`,
      value: fmt(staleLocations),
      hint: staleLocations > 0 ? 'Prográmalas en el mapa' : 'Todas contadas al día',
      tone: staleLocations > 0 ? 'warning' : 'success',
      href: inventoryHref(INVENTORY_SPACES.map),
    },
    {
      id: 'disputed',
      label: 'SKUs en disputa',
      value: fmt(disputedItems),
      hint: disputedItems > 0 ? 'No se pueden prometer hasta resolverse' : 'Sin disputas abiertas',
      tone: disputedItems > 0 ? 'danger' : 'success',
      href: inventoryHref(INVENTORY_SPACES.stock, { confianza: 'DISPUTED' }),
      live: true,
    },
    {
      id: 'reservations',
      label: 'Reservas activas',
      value: fmt(activeReservations),
      hint:
        staleReservations > 0
          ? `${fmt(staleReservations)} con más de ${reservationAlertDays} días`
          : 'Todas recientes',
      tone: staleReservations > 0 ? 'warning' : 'default',
      href: workHref(area, { kind: 'reservation' }),
    },
    {
      id: 'movements-today',
      label: 'Movimientos hoy',
      value: fmt(movementsToday),
      hint: 'Entradas, salidas, traspasos y ajustes del día',
      href: inventoryHref(INVENTORY_SPACES.movements),
    },
    {
      id: 'controlled',
      label: 'Perfiles controlados',
      value: `${fmt(controlled)} %`,
      hint: 'Artículos con dos conteos buenos seguidos',
      tone: controlled >= 60 ? 'success' : controlled >= 30 ? 'warning' : 'danger',
      href: inventoryHref(INVENTORY_SPACES.stock, { confianza: 'CONTROLLED' }),
    },
    {
      id: 'requests-in',
      label: 'Solicitudes recibidas',
      value: fmt(requestsIn),
      hint:
        requestsInOverdue > 0
          ? `${fmt(requestsInOverdue)} sin atender a tiempo`
          : 'Todas dentro de plazo',
      tone: requestsInOverdue > 0 ? 'danger' : 'default',
      href: workHref(area, { kind: 'request_in' }),
    },
  ];

  const alerts: AreaDashboardAlert[] = [
    ...blockingDisputes.rows.map((row) => ({
      id: `dispute-${row.zohoItemId}`,
      severity: 'danger' as const,
      title: `${row.productName ?? row.sku ?? row.zohoItemId} bloquea ${row.cases.length} ${
        row.cases.length === 1 ? 'expediente' : 'expedientes'
      }`,
      detail: `En disputa desde ${shortDate(new Date(row.disputedSince))}. Resuelve la diferencia para poder prometer.`,
      href: inventoryHref(INVENTORY_SPACES.stock, { confianza: 'DISPUTED', q: row.sku ?? '' }),
      at: row.disputedSince,
    })),
    ...overdueCounts.map((row) => ({
      id: `count-${row.id}`,
      severity: 'warning' as const,
      title: `Conteo abierto en ${warehouseNames.get(row.warehouseId) ?? 'una bodega'}`,
      detail: `Lleva abierto desde el ${shortDate(row.createdAt)}. Ciérralo o cancélalo.`,
      href: inventoryHref(INVENTORY_SPACES.map, { count: row.id }),
      at: row.createdAt.toISOString(),
    })),
    ...(staleReservations > 0
      ? [
          {
            id: 'stale-reservations',
            severity: 'warning' as const,
            title: `${fmt(staleReservations)} reservas con más de ${reservationAlertDays} días`,
            detail: 'Ventas debe confirmarlas o liberarlas para no bloquear disponible.',
            href: workHref(area, { kind: 'reservation' }),
          },
        ]
      : []),
  ].slice(0, ALERT_LIMIT);

  return {
    areaKey: area.key,
    tiles,
    charts: [
      {
        kind: 'trend',
        id: 'verifications',
        title: 'Verificaciones creadas vs. resueltas',
        description: `Últimos ${TREND_DAYS} días`,
        xKey: 'label',
        xLabel: 'Día',
        data: trend.map((point) => ({
          label: point.label,
          creadas: Number(point.creadas),
          resueltas: Number(point.resueltas),
        })),
        series: [
          { key: 'creadas', label: 'Creadas', tone: 'brand' },
          { key: 'resueltas', label: 'Resueltas', tone: 'success' },
        ],
      },
      {
        kind: 'status',
        id: 'confidence',
        title: 'Distribución de confianza',
        description: 'Artículos por nivel de confianza del inventario',
        segments: confidenceSegments(confidence),
      },
    ],
    alerts,
    computedAt: now.toISOString(),
    source: 'live',
    note: notes.length > 0 ? notes.join(' ') : null,
  };
}

/**
 * The three cheap tiles of the panel, recomputed on every request so they keep
 * their "En vivo" mark (`applyLiveTiles` removes it from any tile nobody
 * recalculates). The ids MUST match the ones marked `live` in `inventoryTiles`.
 */
export const INVENTORY_LIVE_TILE_IDS = ['verifications', 'open-counts', 'disputed'] as const;

export const inventoryLiveTiles: AreaLiveTileProvider = async (area, { now }) => {
  const verificationWhere = {
    areaKey: area.key,
    kind: VERIFICATION_WORK_ITEM_KIND,
    status: { in: OPEN_WORK },
  };
  const [
    pendingVerifications,
    overdueVerifications,
    openCounts,
    countsWithDifferences,
    disputedItems,
  ] = await Promise.all([
    prisma.workItem.count({ where: verificationWhere }),
    prisma.workItem.count({ where: { ...verificationWhere, dueAt: { lt: now } } }),
    prisma.stockCount.count({ where: { status: { in: OPEN_COUNTS } } }),
    prisma.stockCountLine.count({
      where: { resolution: { in: ['pending', 'disputed'] }, count: { status: 'closed' } },
    }),
    prisma.productInventoryProfile.count({ where: { confidence: 'DISPUTED' } }),
  ]);
  return [
    {
      id: 'verifications',
      value: fmt(pendingVerifications),
      tone: overdueVerifications > 0 ? 'danger' : pendingVerifications > 0 ? 'default' : 'success',
      hint:
        overdueVerifications > 0
          ? `${fmt(overdueVerifications)} fuera de tiempo`
          : 'Ninguna fuera de tiempo',
    },
    {
      id: 'open-counts',
      value: fmt(openCounts),
      tone: countsWithDifferences > 0 ? 'warning' : 'default',
      hint:
        countsWithDifferences > 0
          ? `${fmt(countsWithDifferences)} líneas cerradas esperan decisión`
          : 'Sin diferencias por decidir',
    },
    {
      id: 'disputed',
      value: fmt(disputedItems),
      tone: disputedItems > 0 ? 'danger' : 'success',
      hint: disputedItems > 0 ? 'No se pueden prometer hasta resolverse' : 'Sin disputas abiertas',
    },
  ];
};
