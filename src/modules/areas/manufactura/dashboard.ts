import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { areaHref, type AreaMeta } from '@/modules/areas/area-registry';
import type {
  AreaDashboardAlert,
  AreaDashboardPayload,
  AreaDashboardTile,
} from '@/modules/areas/area-server-registry';
import type { LiveTilePatch } from '@/modules/areas/dashboard-model';
import { loadWorkCenterLoads } from '@/modules/manufacturing/capacity-service';
import { summarizeShiftLoads } from '@/modules/manufacturing/capacity-rules';
import {
  CAPACITY_UNIT_LABELS,
  PRODUCTION_ORDER_OPEN_STATUSES,
  PRODUCTION_ORDER_STATUS_LABELS,
  type CapacityUnit,
  type ProductionOrderStatus,
} from '@/modules/manufacturing/manufacturing-types';

/**
 * Panel of Manufactura (plan 7.3, exact tiles of its row in the table):
 * OP activas · operaciones en cola · capacidad usada hoy · OP atrasadas ·
 * merma 7 d · expedientes esperando manufactura · OP con material faltante ·
 * entregas a inventario hoy; gráficas de capacidad por centro y de OP
 * completadas por día; alertas de atrasadas y bloqueadas por material.
 *
 * SERVER ONLY. Every number comes from a real entity — an empty plant shows
 * zeros, never a placeholder. Only the three cheap indexed `count()` are marked
 * `live`; the rest travel with the panel's own freshness stamp.
 */

const TREND_DAYS = 14;
const SCRAP_DAYS = 7;
const ALERT_LIMIT = 6;
const MAX_CENTERS_IN_CHART = 8;

/** Orders that are actually moving (draft and blocked have their own tiles). */
const ACTIVE_STATUSES: ProductionOrderStatus[] = [
  'reserved',
  'prepared',
  'in_progress',
  'inspection',
  'completed',
];

const OPEN_STATUSES = [...PRODUCTION_ORDER_OPEN_STATUSES];

interface TrendRow {
  label: string;
  creadas: number;
  completadas: number;
}

const fmt = (value: number) => value.toLocaleString('es-MX');

function workHref(area: AreaMeta, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  const base = areaHref(area.key, 'trabajo');
  return query ? `${base}?${query}` : base;
}

function startOfDay(now: Date): Date {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date;
}

function quantityText(value: unknown): string {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed === 0) return '0';
  return parsed.toLocaleString('es-MX', { maximumFractionDigits: 2 });
}

interface CenterLoad {
  name: string;
  unitLabel: string;
  load: number;
  capacity: number;
  utilizationPct: number;
  overloaded: boolean;
}

/** Load of today's shifts per active work centre (the basis of the capacity tile and chart). */
async function loadTodayCapacity(
  now: Date
): Promise<{ centers: CenterLoad[]; note: string | null }> {
  const centers = await prisma.workCenter.findMany({
    where: { status: 'active' },
    orderBy: [{ key: 'asc' }],
    take: 40,
  });
  if (centers.length === 0) return { centers: [], note: null };

  const from = startOfDay(now);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);

  const out: CenterLoad[] = [];
  let failed = 0;
  for (const center of centers) {
    try {
      const { loads } = await loadWorkCenterLoads(prisma, center, from, to);
      const summary = summarizeShiftLoads(loads);
      out.push({
        name: center.name,
        unitLabel: CAPACITY_UNIT_LABELS[center.capacityUnit as CapacityUnit] ?? center.capacityUnit,
        load: summary.totalLoad,
        capacity: summary.totalCapacity,
        utilizationPct:
          summary.totalCapacity > 0
            ? Math.round((summary.totalLoad / summary.totalCapacity) * 1000) / 10
            : 0,
        overloaded: summary.overloadedWindows > 0,
      });
    } catch {
      failed += 1;
    }
  }
  return {
    centers: out,
    note:
      failed > 0
        ? `No pudimos calcular la carga de ${failed} ${failed === 1 ? 'centro' : 'centros'} de trabajo; revisa sus turnos.`
        : null,
  };
}

/**
 * The three tiles of Manufactura that are recomputed on EVERY request (plan
 * 7.3: at most three per area, indexed `count()` only), so "OP atrasadas" is
 * never a number from the last snapshot. Their ids must match the panel's.
 */
export async function loadManufacturaLiveTiles(
  _area: AreaMeta,
  options: { now: Date }
): Promise<LiveTilePatch[]> {
  const { now } = options;
  const [activeOrders, queuedOperations, lateOrders] = await Promise.all([
    prisma.productionOrder.count({ where: { status: { in: ACTIVE_STATUSES } } }),
    prisma.productionOperation.count({
      where: {
        status: { in: ['pending', 'paused'] },
        productionOrder: { status: { in: OPEN_STATUSES } },
      },
    }),
    prisma.productionOrder.count({
      where: { status: { in: OPEN_STATUSES }, plannedEndAt: { lt: now } },
    }),
  ]);
  return [
    { id: 'active_orders', value: fmt(activeOrders) },
    { id: 'queued_operations', value: fmt(queuedOperations) },
    {
      id: 'late_orders',
      value: fmt(lateOrders),
      tone: lateOrders > 0 ? 'danger' : 'success',
      hint:
        lateOrders > 0 ? 'Ya pasaron la fecha en que debían terminar' : 'Todas dentro de su fecha',
    },
  ];
}

export async function loadManufacturaDashboard(
  _actor: CurrentUser,
  area: AreaMeta,
  options: { now?: Date } = {}
): Promise<AreaDashboardPayload> {
  const now = options.now ?? new Date();
  const dayStart = startOfDay(now);
  const trendFrom = new Date(dayStart);
  trendFrom.setDate(trendFrom.getDate() - (TREND_DAYS - 1));
  const scrapFrom = new Date(dayStart);
  scrapFrom.setDate(scrapFrom.getDate() - (SCRAP_DAYS - 1));

  const [
    activeOrders,
    queuedOperations,
    lateOrders,
    blockedOrders,
    scrapTotals,
    casesWaiting,
    finishedToday,
    capacity,
    trend,
    lateRows,
    blockedRows,
  ] = await Promise.all([
    prisma.productionOrder.count({ where: { status: { in: ACTIVE_STATUSES } } }),
    prisma.productionOperation.count({
      where: {
        status: { in: ['pending', 'paused'] },
        productionOrder: { status: { in: OPEN_STATUSES } },
      },
    }),
    prisma.productionOrder.count({
      where: { status: { in: OPEN_STATUSES }, plannedEndAt: { lt: now } },
    }),
    prisma.productionOrder.count({ where: { status: 'blocked' } }),
    prisma.productionOutput.aggregate({
      _sum: { qty: true },
      where: { kind: 'scrap', createdAt: { gte: scrapFrom } },
    }),
    prisma.productionOrder.groupBy({
      by: ['caseId'],
      where: { status: { in: OPEN_STATUSES }, caseId: { not: null } },
    }),
    prisma.productionOutput.count({ where: { kind: 'finished', createdAt: { gte: dayStart } } }),
    loadTodayCapacity(now),
    prisma.$queryRaw<TrendRow[]>`
      WITH days AS (
        SELECT generate_series(${trendFrom}::date, ${now}::date, interval '1 day')::date AS day
      ),
      created AS (
        SELECT "createdAt"::date AS day, count(*)::int AS total
        FROM "ProductionOrder"
        WHERE "createdAt" >= ${trendFrom}
        GROUP BY 1
      ),
      completed AS (
        SELECT "completedAt"::date AS day, count(*)::int AS total
        FROM "ProductionOrder"
        WHERE "completedAt" >= ${trendFrom}
        GROUP BY 1
      )
      SELECT to_char(d.day, 'DD/MM') AS "label",
             COALESCE(c.total, 0)::int AS "creadas",
             COALESCE(f.total, 0)::int AS "completadas"
      FROM days d
      LEFT JOIN created c ON c.day = d.day
      LEFT JOIN completed f ON f.day = d.day
      ORDER BY d.day ASC`,
    prisma.productionOrder.findMany({
      where: { status: { in: OPEN_STATUSES }, plannedEndAt: { lt: now } },
      orderBy: [{ plannedEndAt: 'asc' }, { id: 'asc' }],
      take: ALERT_LIMIT,
      select: {
        id: true,
        number: true,
        status: true,
        plannedEndAt: true,
        outputName: true,
        outputZohoItemId: true,
      },
    }),
    prisma.productionOrder.findMany({
      where: { status: 'blocked' },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: ALERT_LIMIT,
      select: {
        id: true,
        number: true,
        blockedReason: true,
        updatedAt: true,
        outputName: true,
        outputZohoItemId: true,
      },
    }),
  ]);

  const totalLoad = capacity.centers.reduce((sum, center) => sum + center.load, 0);
  const totalCapacity = capacity.centers.reduce((sum, center) => sum + center.capacity, 0);
  const usedPct = totalCapacity > 0 ? Math.round((totalLoad / totalCapacity) * 1000) / 10 : null;
  const scrapQty = quantityText(scrapTotals._sum.qty);

  const tiles: AreaDashboardTile[] = [
    {
      id: 'active_orders',
      label: 'OP activas',
      value: fmt(activeOrders),
      hint: 'Reservadas, preparadas, en proceso, en inspección o terminadas',
      href: workHref(area, { kind: 'production_order' }),
      live: true,
    },
    {
      id: 'queued_operations',
      label: 'Operaciones en cola',
      value: fmt(queuedOperations),
      hint: 'Pendientes o en pausa en los centros de trabajo',
      href: workHref(area, { kind: 'production_operation' }),
      live: true,
    },
    {
      id: 'capacity_today',
      label: 'Capacidad usada hoy',
      value: usedPct === null ? '—' : `${usedPct.toLocaleString('es-MX')} %`,
      hint:
        capacity.centers.length === 0
          ? 'Todavía no hay centros de trabajo activos'
          : `${capacity.centers.length} ${capacity.centers.length === 1 ? 'centro activo' : 'centros activos'} · turnos de hoy`,
      tone:
        usedPct === null
          ? 'default'
          : usedPct > 100
            ? 'danger'
            : usedPct > 85
              ? 'warning'
              : 'success',
      href: areaHref(area.key, area.special.slug),
    },
    {
      id: 'late_orders',
      label: 'OP atrasadas',
      value: fmt(lateOrders),
      tone: lateOrders > 0 ? 'danger' : 'success',
      hint:
        lateOrders > 0 ? 'Ya pasaron la fecha en que debían terminar' : 'Todas dentro de su fecha',
      href: workHref(area, { kind: 'production_order', vencidos: '1' }),
      live: true,
    },
    {
      id: 'scrap_7d',
      label: `Merma ${SCRAP_DAYS} d`,
      value: scrapQty,
      hint: 'Cantidad registrada como merma en la última semana',
      tone: scrapTotals._sum.qty && Number(scrapTotals._sum.qty) > 0 ? 'warning' : 'default',
    },
    {
      id: 'cases_waiting',
      label: 'Expedientes esperando',
      value: fmt(casesWaiting.length),
      hint: 'Ventas espera producción para poder entregar',
      href: workHref(area, { kind: 'production_order' }),
    },
    {
      id: 'material_missing',
      label: 'OP con material faltante',
      value: fmt(blockedOrders),
      tone: blockedOrders > 0 ? 'danger' : 'success',
      hint: blockedOrders > 0 ? 'Bloqueadas hasta que llegue el material' : 'Ninguna bloqueada',
      href: workHref(area, { kind: 'production_order' }),
    },
    {
      id: 'finished_today',
      label: 'Entregas a inventario hoy',
      value: fmt(finishedToday),
      hint: 'Registros de producto terminado capturados hoy',
    },
  ];

  const alerts: AreaDashboardAlert[] = [
    ...lateRows.map((order) => ({
      id: `late-${order.id}`,
      severity: 'danger' as const,
      title: `${order.number} · ${order.outputName ?? order.outputZohoItemId}`,
      detail: order.plannedEndAt
        ? `Debía terminar el ${order.plannedEndAt.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} · ${
            PRODUCTION_ORDER_STATUS_LABELS[order.status as ProductionOrderStatus] ?? order.status
          }`
        : 'Sin fecha de término',
      href: workHref(area, { kind: 'production_order', vencidos: '1' }),
      ...(order.plannedEndAt ? { at: order.plannedEndAt.toISOString() } : {}),
    })),
    ...blockedRows.map((order) => ({
      id: `blocked-${order.id}`,
      severity: 'warning' as const,
      title: `${order.number} · ${order.outputName ?? order.outputZohoItemId}`,
      detail: order.blockedReason?.trim() || 'Bloqueada por falta de material',
      href: workHref(area, { kind: 'production_order' }),
      at: order.updatedAt.toISOString(),
    })),
  ].slice(0, ALERT_LIMIT);

  return {
    areaKey: area.key,
    tiles,
    charts: [
      {
        kind: 'bar',
        id: 'capacity-by-center',
        title: 'Capacidad por centro (hoy)',
        description: 'Carga de los turnos de hoy contra la capacidad del centro',
        valueLabel: '% usado',
        categoryLabel: 'Centro',
        data: capacity.centers.slice(0, MAX_CENTERS_IN_CHART).map((center) => ({
          label: center.name,
          value: center.utilizationPct,
          tone:
            center.overloaded || center.utilizationPct > 100
              ? ('danger' as const)
              : center.utilizationPct > 85
                ? ('warning' as const)
                : ('success' as const),
        })),
      },
      {
        kind: 'trend',
        id: 'orders-per-day',
        title: 'Órdenes creadas vs. completadas',
        description: `Últimos ${TREND_DAYS} días`,
        xKey: 'label',
        xLabel: 'Día',
        data: trend.map((point) => ({
          label: point.label,
          creadas: Number(point.creadas),
          completadas: Number(point.completadas),
        })),
        series: [
          { key: 'creadas', label: 'Creadas', tone: 'brand' },
          { key: 'completadas', label: 'Completadas', tone: 'success' },
        ],
      },
    ],
    alerts,
    computedAt: now.toISOString(),
    source: 'live',
    note: capacity.note,
  };
}
