import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { AreaMeta } from '@/modules/areas/area-registry';
import type { AreaDashboardPayload } from '@/modules/areas/area-server-registry';
import type { AreaLiveTileProvider } from '@/modules/areas/dashboard-service';
import {
  AREA_LABELS,
  AREA_REQUEST_OPEN_STATUSES,
  CASE_OPEN_STATUSES,
  isAreaKey,
  type AreaKey,
} from '@/modules/operations/types';
import {
  ventasAlerts,
  ventasCharts,
  ventasTiles,
  VENTAS_PROMISE_ALERT_HOURS,
  VENTAS_PROMISE_HORIZON_DAYS,
  VENTAS_TREND_DAYS,
  type VentasDashboardCounts,
  type VentasPhaseCount,
  type VentasTrendPoint,
} from './dashboard-model';
import {
  EXCLUDED_SALES_ORDER_STATUSES,
  formatCount,
  QUOTE_WAITING_STATUSES,
  VENTAS_AREA_KEY,
} from './ventas-constants';

/**
 * Panel de Ventas (plan 7.3). SÓLO SERVIDOR.
 *
 * Todo sale de entidades reales (expedientes, cotizaciones, órdenes de Zoho,
 * señales del radar y solicitudes entre áreas). Los tres tiles marcados `live`
 * son `count()` indexados (`OperationalCase(status)`, `RadarSignal(status,
 * expiresAt)`); el resto se calcula igual en cada petición mientras no exista
 * el job de instantáneas, y la frescura se dice en voz alta en la vista.
 */

const CASE_KIND = 'sales_fulfillment';
const DAY_MS = 86_400_000;
const ALERT_LIMIT = 6;
/** Órdenes de Zoho que revisamos para detectar las que no tienen expediente. */
const ORDERS_WITHOUT_CASE_WINDOW_DAYS = 60;

interface CountRow {
  count: number;
}

interface TrendRow {
  label: string;
  creados: number;
  cerrados: number;
}

function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}

export async function loadVentasDashboard(
  _actor: CurrentUser,
  area: AreaMeta,
  options: { now: Date }
): Promise<AreaDashboardPayload> {
  const now = options.now;
  const openStatuses = [...CASE_OPEN_STATUSES];
  const openCaseWhere = { kind: CASE_KIND, status: { in: openStatuses } };
  const promiseHorizon = new Date(now.getTime() + VENTAS_PROMISE_HORIZON_DAYS * DAY_MS);
  const promiseAlertHorizon = new Date(now.getTime() + VENTAS_PROMISE_ALERT_HOURS * 3_600_000);
  const ordersSince = new Date(now.getTime() - ORDERS_WITHOUT_CASE_WINDOW_DAYS * DAY_MS);
  const trendFrom = new Date(now.getTime() - (VENTAS_TREND_DAYS - 1) * DAY_MS);
  trendFrom.setHours(0, 0, 0, 0);
  const monthStart = startOfMonth(now);
  const excludedOrderStatuses = [...EXCLUDED_SALES_ORDER_STATUSES];
  const openRequestStatuses = [...AREA_REQUEST_OPEN_STATUSES];

  const [
    openCases,
    blockedCases,
    activeSignals,
    promisedAtRiskRows,
    quotesWaiting,
    ordersWithoutCaseRows,
    overdueOutgoingRequests,
    monthSales,
    phaseRows,
    trendRows,
    blockedRows,
    promisedRows,
    requestRows,
  ] = await Promise.all([
    prisma.operationalCase.count({ where: openCaseWhere }),
    prisma.operationalCase.count({ where: { kind: CASE_KIND, status: 'blocked' } }),
    prisma.radarSignal.count({ where: { status: 'active', expiresAt: { gt: now } } }),
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::int AS "count"
      FROM "OperationalCase" c
      WHERE c."kind" = ${CASE_KIND}
        AND c."status" = ANY(${openStatuses})
        AND c."promisedAt" IS NOT NULL
        AND c."promisedAt" <= ${promiseHorizon}
        AND (
          c."status" IN ('blocked', 'waiting')
          OR c."promisedAt" < ${now}
          OR EXISTS (
            SELECT 1 FROM "WorkItem" w
            WHERE w."caseId" = c."id"
              AND w."status" IN ('open', 'in_progress', 'waiting', 'escalated')
              AND w."dueAt" < ${now}
          )
        )`,
    prisma.quote.count({ where: { status: { in: [...QUOTE_WAITING_STATUSES] } } }),
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::int AS "count"
      FROM "SalesOrder" o
      WHERE o."orderDate" >= ${ordersSince}
        AND (o."status" IS NULL OR NOT (o."status" = ANY(${excludedOrderStatuses})))
        AND NOT EXISTS (
          SELECT 1 FROM "OperationalCase" c WHERE c."zohoSalesOrderId" = o."zohoSalesOrderId"
        )`,
    prisma.areaRequest.count({
      where: {
        fromAreaKey: VENTAS_AREA_KEY,
        toAreaKey: { not: VENTAS_AREA_KEY },
        status: { in: openRequestStatuses },
        dueAt: { lt: now },
      },
    }),
    prisma.salesOrder.aggregate({
      _sum: { total: true },
      _count: { _all: true },
      where: {
        orderDate: { gte: monthStart, lte: now },
        OR: [{ status: null }, { status: { notIn: excludedOrderStatuses } }],
      },
    }),
    prisma.operationalCase.groupBy({
      by: ['phase'],
      where: openCaseWhere,
      _count: { _all: true },
    }),
    prisma.$queryRaw<TrendRow[]>`
      WITH days AS (
        SELECT generate_series(${trendFrom}::date, ${now}::date, interval '1 day')::date AS day
      ),
      creados AS (
        SELECT c."openedAt"::date AS day, count(*)::int AS total
        FROM "OperationalCase" c
        WHERE c."kind" = ${CASE_KIND} AND c."openedAt" >= ${trendFrom}
        GROUP BY 1
      ),
      cerrados AS (
        SELECT c."closedAt"::date AS day, count(*)::int AS total
        FROM "OperationalCase" c
        WHERE c."kind" = ${CASE_KIND} AND c."closedAt" >= ${trendFrom}
        GROUP BY 1
      )
      SELECT to_char(d.day, 'DD/MM') AS "label",
             COALESCE(a.total, 0)::int AS "creados",
             COALESCE(b.total, 0)::int AS "cerrados"
      FROM days d
      LEFT JOIN creados a ON a.day = d.day
      LEFT JOIN cerrados b ON b.day = d.day
      ORDER BY d.day ASC`,
    prisma.operationalCase.findMany({
      where: { kind: CASE_KIND, status: 'blocked' },
      orderBy: [{ lastActivityAt: 'asc' }, { id: 'asc' }],
      take: ALERT_LIMIT,
      select: { id: true, caseNumber: true, customerName: true, lastActivityAt: true },
    }),
    prisma.operationalCase.findMany({
      where: {
        kind: CASE_KIND,
        status: { in: openStatuses },
        promisedAt: { not: null, lte: promiseAlertHorizon },
      },
      orderBy: [{ promisedAt: 'asc' }, { id: 'asc' }],
      take: ALERT_LIMIT,
      select: { id: true, caseNumber: true, customerName: true, promisedAt: true },
    }),
    prisma.areaRequest.findMany({
      where: {
        fromAreaKey: VENTAS_AREA_KEY,
        toAreaKey: { not: VENTAS_AREA_KEY },
        status: { in: openRequestStatuses },
        dueAt: { lt: now },
      },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: ALERT_LIMIT,
      select: { id: true, title: true, toAreaKey: true, dueAt: true },
    }),
  ]);

  const counts: VentasDashboardCounts = {
    openCases,
    blockedCases,
    promisedAtRisk: Number(promisedAtRiskRows[0]?.count ?? 0),
    quotesWaiting,
    ordersWithoutCase: Number(ordersWithoutCaseRows[0]?.count ?? 0),
    activeSignals,
    overdueOutgoingRequests,
    monthSalesTotal: Number(monthSales._sum.total ?? 0),
    monthSalesOrders: monthSales._count._all,
  };

  const phases: VentasPhaseCount[] = (
    phaseRows as Array<{ phase: string; _count: { _all: number } }>
  ).map((row) => ({ phase: row.phase, total: row._count._all }));

  const trend: VentasTrendPoint[] = trendRows.map((row) => ({
    label: row.label,
    creados: Number(row.creados),
    cerrados: Number(row.cerrados),
  }));

  return {
    areaKey: area.key,
    tiles: ventasTiles(counts, now),
    charts: ventasCharts(trend, phases),
    alerts: ventasAlerts({
      blocked: blockedRows.map((row) => ({
        id: row.id,
        caseNumber: row.caseNumber,
        customerName: row.customerName,
        since: row.lastActivityAt.toISOString(),
      })),
      promised: promisedRows
        .filter((row) => row.promisedAt !== null)
        .map((row) => ({
          id: row.id,
          caseNumber: row.caseNumber,
          customerName: row.customerName,
          promisedAt: (row.promisedAt as Date).toISOString(),
          overdue: (row.promisedAt as Date).getTime() < now.getTime(),
        })),
      requests: requestRows.map((row) => ({
        id: row.id,
        title: row.title,
        toAreaLabel: isAreaKey(row.toAreaKey)
          ? AREA_LABELS[row.toAreaKey as AreaKey]
          : row.toAreaKey,
        dueAt: (row.dueAt ?? now).toISOString(),
      })),
    }),
    computedAt: now.toISOString(),
    source: 'live',
    note: null,
  };
}

/**
 * Los tres tiles baratos del panel (`VENTAS_LIVE_TILE_IDS`), recalculados en
 * cada petición para que conserven su marca «En vivo»: `applyLiveTiles` se la
 * quita a cualquier tile que nadie recalcule.
 */
export const ventasLiveTiles: AreaLiveTileProvider = async (_area, { now }) => {
  const openCaseWhere = { kind: CASE_KIND, status: { in: [...CASE_OPEN_STATUSES] } };
  const [openCases, blockedCases, activeSignals] = await Promise.all([
    prisma.operationalCase.count({ where: openCaseWhere }),
    prisma.operationalCase.count({ where: { kind: CASE_KIND, status: 'blocked' } }),
    prisma.radarSignal.count({ where: { status: 'active', expiresAt: { gt: now } } }),
  ]);
  return [
    { id: 'open_cases', value: formatCount(openCases) },
    {
      id: 'blocked_cases',
      value: formatCount(blockedCases),
      tone: blockedCases > 0 ? 'danger' : 'success',
      hint:
        blockedCases > 0 ? 'Esperan una decisión para poder avanzar' : 'Ningún expediente detenido',
    },
    {
      id: 'radar_signals',
      value: formatCount(activeSignals),
      tone: activeSignals > 0 ? 'info' : 'default',
      hint: 'Clientes que necesitan un movimiento hoy',
    },
  ];
};
