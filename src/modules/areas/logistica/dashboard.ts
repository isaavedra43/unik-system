import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { AreaMeta } from '../area-registry';
import type { AreaLiveTileProvider } from '../dashboard-service';
import { areaHref } from '../area-registry';
import type {
  AreaDashboardAlert,
  AreaDashboardPayload,
  AreaDashboardTile,
  AreaServerOptions,
} from '../area-server-registry';
import { getFleetAvailability } from '@/modules/logistics/fleet-service';
import {
  DELIVERY_ORDER_CLOSED_STATUSES,
  DELIVERY_ORDER_OPEN_STATUSES,
  DELIVERY_ORDER_STATUS_LABELS,
  TRIP_ACTIVE_STATUSES,
  type DeliveryOrderStatus,
} from '@/modules/logistics/types';
import type { ChartTone } from '@/components/patterns/dashboard/chart-theme';
import type { StatusSegment } from '@/components/patterns/dashboard/dashboard-utils';
import {
  dispatchHref,
  formatDayLabel,
  operationDay,
  tripHref,
  FLEET_PATH,
} from './logistics-view-model';

/**
 * Panel of Logística (plan 7.3, exact row of the table):
 *
 * tiles  · Entregas hoy · En ruta · Sin asignar · Esperando a Zoho / conflicto
 *          · Fallidas 7 d · Vehículos disponibles · Viajes activos · Confirmadas hoy
 * charts · Planeadas vs entregadas por día (14 d) · Entregas por estado
 * alerts · Conflictos con Zoho · Entregas fallidas · Viajes en riesgo
 *
 * Every number comes from a real query over `DeliveryOrder`, `Trip`, `Vehicle`
 * and `Driver`; an area with nothing to do shows zeros, never a placeholder.
 * Only the three cheap indexed counts are marked `live` (plan 13).
 *
 * The operation works in Mexico City time (UTC−6 all year since 2022, the same
 * assumption `defaultTripStart` already makes): day columns (`plannedDate`,
 * `Trip.date`) are calendar days stored at midnight UTC, while instants
 * (`deliveredAt`, `updatedAt`) are compared against the local day window.
 */

const TREND_DAYS = 14;
const ALERT_LIMIT = 6;
const LOCAL_OFFSET_HOURS = 6;

const OPEN_STATUSES = [...DELIVERY_ORDER_OPEN_STATUSES];
const CLOSED_STATUSES = [...DELIVERY_ORDER_CLOSED_STATUSES];
const ACTIVE_TRIPS = [...TRIP_ACTIVE_STATUSES];

const fmt = (value: number) => value.toLocaleString('es-MX');

/** `[00:00, 24:00)` of a calendar day for the date-typed columns (midnight UTC). */
function dayRange(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

/** The same calendar day as an instant window in Mexico City time. */
function instantRange(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  start.setUTCHours(start.getUTCHours() + LOCAL_OFFSET_HOURS);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

interface StatusFilter {
  field: 'status';
  operator: 'in';
  value: string[];
}

/** Link to the work centre already filtered by row kind and status. */
function workHref(
  area: AreaMeta,
  options: { kind?: string; scope?: 'open' | 'closed' | 'all'; statuses?: string[] } = {}
): string {
  const params = new URLSearchParams();
  if (options.kind) params.set('kind', options.kind);
  if (options.scope && options.scope !== 'open') params.set('scope', options.scope);
  if (options.statuses && options.statuses.length > 0) {
    const rules: StatusFilter[] = [{ field: 'status', operator: 'in', value: options.statuses }];
    params.set('filters', JSON.stringify({ logic: 'AND', rules }));
  }
  const query = params.toString();
  const base = areaHref(area.key, 'trabajo');
  return query ? `${base}?${query}` : base;
}

interface TrendRow {
  label: string;
  planeadas: number;
  entregadas: number;
}

const STATUS_TONES: Readonly<Record<string, ChartTone>> = {
  pending: 'muted',
  planned: 'brand',
  assigned: 'info',
  pending_external: 'warning',
  conflict: 'danger',
  dispatched: 'info',
  delivered: 'success',
  partially_delivered: 'warning',
  failed: 'danger',
};

export async function loadLogisticsDashboard(
  _actor: CurrentUser,
  area: AreaMeta,
  options: AreaServerOptions
): Promise<AreaDashboardPayload> {
  const now = options.now;
  const today = operationDay(now);
  const day = dayRange(today);
  const instants = instantRange(today);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const trendFrom = new Date(now.getTime() - (TREND_DAYS - 1) * 24 * 60 * 60_000);
  trendFrom.setUTCHours(0, 0, 0, 0);

  const [
    dueToday,
    inTransit,
    unassigned,
    zohoWaiting,
    failedWeek,
    activeTrips,
    confirmedToday,
    fleet,
    byStatus,
    trend,
    conflicts,
    failures,
    trips,
  ] = await Promise.all([
    prisma.deliveryOrder.count({
      where: {
        status: { in: OPEN_STATUSES },
        plannedDate: { gte: day.start, lt: day.end },
      },
    }),
    prisma.deliveryOrder.count({ where: { status: 'dispatched' } }),
    prisma.deliveryOrder.count({ where: { status: { in: ['pending', 'planned'] }, tripId: null } }),
    prisma.deliveryOrder.count({ where: { status: { in: ['pending_external', 'conflict'] } } }),
    prisma.deliveryOrder.count({ where: { status: 'failed', updatedAt: { gte: weekAgo } } }),
    prisma.trip.count({ where: { status: { in: ACTIVE_TRIPS } } }),
    prisma.deliveryOrder.count({
      where: {
        status: { in: ['delivered', 'partially_delivered'] },
        deliveredAt: { gte: instants.start, lt: instants.end },
      },
    }),
    getFleetAvailability(today).catch(() => null),
    prisma.deliveryOrder.groupBy({
      by: ['status'],
      where: {
        OR: [
          { status: { in: OPEN_STATUSES } },
          { status: { in: CLOSED_STATUSES }, deliveredAt: { gte: weekAgo } },
        ],
      },
      _count: { _all: true },
    }),
    prisma.$queryRaw<TrendRow[]>`
      WITH days AS (
        SELECT generate_series(${trendFrom}::date, ${now}::date, interval '1 day')::date AS day
      ),
      planeadas AS (
        SELECT "plannedDate"::date AS day, count(*)::int AS total
        FROM "DeliveryOrder"
        WHERE "plannedDate" >= ${trendFrom} AND "status" <> 'cancelled'
        GROUP BY 1
      ),
      entregadas AS (
        SELECT ("deliveredAt" - interval '6 hours')::date AS day, count(*)::int AS total
        FROM "DeliveryOrder"
        WHERE "deliveredAt" >= ${trendFrom}
        GROUP BY 1
      )
      SELECT to_char(d.day, 'DD/MM') AS "label",
             COALESCE(p.total, 0)::int AS "planeadas",
             COALESCE(e.total, 0)::int AS "entregadas"
      FROM days d
      LEFT JOIN planeadas p ON p.day = d.day
      LEFT JOIN entregadas e ON e.day = d.day
      ORDER BY d.day ASC`,
    prisma.deliveryOrder.findMany({
      where: { status: 'conflict' },
      orderBy: [{ updatedAt: 'desc' }],
      take: ALERT_LIMIT,
      select: { id: true, caseId: true, city: true, carrier: true, updatedAt: true },
    }),
    prisma.deliveryOrder.findMany({
      where: { status: 'failed', updatedAt: { gte: weekAgo } },
      orderBy: [{ updatedAt: 'desc' }],
      take: ALERT_LIMIT,
      select: { id: true, city: true, zohoError: true, updatedAt: true, zohoSyncState: true },
    }),
    prisma.trip.findMany({
      where: { status: { in: ACTIVE_TRIPS } },
      orderBy: [{ date: 'asc' }],
      take: 50,
      select: {
        id: true,
        number: true,
        date: true,
        status: true,
        driverId: true,
        startedAt: true,
      },
    }),
  ]);

  const caseIds = [...new Set(conflicts.map((row) => row.caseId))];
  const cases =
    caseIds.length > 0
      ? await prisma.operationalCase.findMany({
          where: { id: { in: caseIds } },
          select: { id: true, caseNumber: true, customerName: true },
        })
      : [];
  const caseById = new Map(cases.map((row) => [row.id, row]));

  const driverIds = [...new Set(trips.map((trip) => trip.driverId))];
  const drivers =
    driverIds.length > 0
      ? await prisma.driver.findMany({
          where: { id: { in: driverIds } },
          select: { id: true, name: true, active: true, userId: true },
        })
      : [];
  const driverById = new Map(drivers.map((driver) => [driver.id, driver]));

  const availableVehicles = fleet
    ? fleet.vehicles.filter((vehicle) => vehicle.available).length
    : 0;
  const totalVehicles = fleet ? fleet.vehicles.length : 0;

  const tiles: AreaDashboardTile[] = [
    {
      id: 'due_today',
      label: 'Entregas hoy',
      value: fmt(dueToday),
      hint: `Planeadas para el ${formatDayLabel(today)}`,
      href: dispatchHref({ date: today }),
      live: true,
    },
    {
      id: 'in_transit',
      label: 'En ruta',
      value: fmt(inTransit),
      tone: inTransit > 0 ? 'info' : 'default',
      hint: inTransit > 0 ? 'Van en camino al cliente' : 'Nada en la calle ahora',
      href: workHref(area, { kind: 'delivery_order', statuses: ['dispatched'] }),
      live: true,
    },
    {
      id: 'unassigned',
      label: 'Sin asignar',
      value: fmt(unassigned),
      tone: unassigned > 0 ? 'warning' : 'success',
      hint: unassigned > 0 ? 'Falta transportista o viaje' : 'Todo con transporte',
      href: dispatchHref({ date: today }),
      live: true,
    },
    {
      id: 'zoho',
      label: 'Esperando a Zoho',
      value: fmt(zohoWaiting),
      tone: zohoWaiting > 0 ? 'warning' : 'success',
      hint:
        zohoWaiting > 0
          ? 'Embarques por confirmar o con valores distintos'
          : 'Zoho al día con los embarques',
      href: workHref(area, {
        kind: 'delivery_order',
        statuses: ['pending_external', 'conflict'],
      }),
    },
    {
      id: 'failed',
      label: 'Fallidas 7 días',
      value: fmt(failedWeek),
      tone: failedWeek > 0 ? 'danger' : 'success',
      hint: failedWeek > 0 ? 'Hay que reprogramarlas' : 'Sin entregas fallidas',
      href: workHref(area, { kind: 'delivery_order', scope: 'all', statuses: ['failed'] }),
    },
    {
      id: 'vehicles',
      label: 'Vehículos disponibles',
      value: fleet ? `${fmt(availableVehicles)} de ${fmt(totalVehicles)}` : 'Sin datos',
      tone: !fleet ? 'default' : availableVehicles === 0 ? 'danger' : 'default',
      hint: fleet
        ? availableVehicles === 0
          ? 'Todos ocupados o en mantenimiento'
          : 'Libres para un viaje de hoy'
        : 'No pudimos leer la flotilla',
      href: FLEET_PATH,
    },
    {
      id: 'trips',
      label: 'Viajes activos',
      value: fmt(activeTrips),
      hint: activeTrips > 0 ? 'Planeados o en ruta' : 'Sin viajes abiertos',
      href: workHref(area, { kind: 'trip' }),
    },
    {
      id: 'confirmed',
      label: 'Confirmadas hoy',
      value: fmt(confirmedToday),
      tone: confirmedToday > 0 ? 'success' : 'default',
      hint: 'Entregas cerradas con evidencia',
      href: workHref(area, {
        kind: 'delivery_order',
        scope: 'closed',
        statuses: ['delivered', 'partially_delivered'],
      }),
    },
  ];

  const counts = new Map(
    (byStatus as Array<{ status: string; _count: { _all: number } }>).map((row) => [
      row.status,
      row._count._all,
    ])
  );
  const segments: StatusSegment[] = (
    Object.keys(DELIVERY_ORDER_STATUS_LABELS) as DeliveryOrderStatus[]
  )
    .filter((status) => status !== 'cancelled' && (counts.get(status) ?? 0) > 0)
    .map((status) => ({
      key: status,
      label: DELIVERY_ORDER_STATUS_LABELS[status],
      count: counts.get(status) ?? 0,
      tone: STATUS_TONES[status] ?? 'muted',
    }));

  const alerts: AreaDashboardAlert[] = [];
  for (const row of conflicts) {
    const reference = caseById.get(row.caseId);
    alerts.push({
      id: `conflict-${row.id}`,
      severity: 'danger',
      title: `Zoho guardó otro embarque${reference?.customerName ? ` · ${reference.customerName}` : ''}`,
      detail: `${reference?.caseNumber ?? 'Expediente'}${row.city ? ` · ${row.city}` : ''}. Decide si se reescribe o se aceptan los valores de Zoho.`,
      href: dispatchHref({ date: today, delivery: row.id }),
      at: row.updatedAt.toISOString(),
    });
  }
  for (const row of failures) {
    alerts.push({
      id: `failed-${row.id}`,
      severity: 'danger',
      title: `Entrega fallida${row.city ? ` en ${row.city}` : ''}`,
      detail:
        row.zohoSyncState === 'failed' && row.zohoError
          ? `Falló la escritura en Zoho: ${row.zohoError.slice(0, 160)}`
          : 'Hay que reprogramarla con el cliente.',
      href: dispatchHref({ date: today, delivery: row.id }),
      at: row.updatedAt.toISOString(),
    });
  }
  for (const trip of trips) {
    const driver = driverById.get(trip.driverId);
    const overdue = trip.status === 'planned' && trip.date.getTime() < day.start.getTime();
    if (driver?.active && !overdue) continue;
    alerts.push({
      id: `trip-${trip.id}`,
      severity: driver?.active ? 'warning' : 'danger',
      title: !driver
        ? `Viaje ${trip.number} sin chofer registrado`
        : !driver.active
          ? `Viaje ${trip.number} con chofer inactivo (${driver.name})`
          : `Viaje ${trip.number} sin salir desde el ${formatDayLabel(trip.date.toISOString())}`,
      detail: !driver?.active
        ? 'Reasigna el viaje a un chofer activo antes de que salga.'
        : 'Sigue planeado después de su fecha: inícialo o reprográmalo.',
      href: tripHref(trip.id),
      at: trip.date.toISOString(),
    });
  }

  return {
    areaKey: area.key,
    tiles,
    charts: [
      {
        kind: 'trend',
        id: 'planned-vs-delivered',
        title: 'Planeadas vs. entregadas',
        description: `Últimos ${TREND_DAYS} días`,
        xKey: 'label',
        xLabel: 'Día',
        data: trend.map((point) => ({
          label: point.label,
          planeadas: Number(point.planeadas),
          entregadas: Number(point.entregadas),
        })),
        series: [
          { key: 'planeadas', label: 'Planeadas', tone: 'brand' },
          { key: 'entregadas', label: 'Entregadas', tone: 'success' },
        ],
      },
      {
        kind: 'status',
        id: 'by-status',
        title: 'Entregas por estado',
        description: 'Abiertas y las cerradas de los últimos 7 días',
        segments,
      },
    ],
    alerts: alerts
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1))
      .slice(0, ALERT_LIMIT),
    computedAt: now.toISOString(),
    source: 'live',
    note: fleet
      ? null
      : 'No pudimos calcular la disponibilidad de la flotilla; el resto del panel está al día.',
  };
}

/**
 * The three cheap tiles of the panel, recomputed on every request so they keep
 * their "En vivo" mark (`applyLiveTiles` removes it from any tile nobody
 * recalculates). The ids MUST match the ones marked `live` above.
 */
export const LOGISTICS_LIVE_TILE_IDS = ['due_today', 'in_transit', 'unassigned'] as const;

export const logisticsLiveTiles: AreaLiveTileProvider = async (_area, { now }) => {
  const today = operationDay(now);
  const day = dayRange(today);
  const [dueToday, inTransit, unassigned] = await Promise.all([
    prisma.deliveryOrder.count({
      where: { status: { in: OPEN_STATUSES }, plannedDate: { gte: day.start, lt: day.end } },
    }),
    prisma.deliveryOrder.count({ where: { status: 'dispatched' } }),
    prisma.deliveryOrder.count({ where: { status: { in: ['pending', 'planned'] }, tripId: null } }),
  ]);
  return [
    { id: 'due_today', value: fmt(dueToday), hint: `Planeadas para el ${formatDayLabel(today)}` },
    {
      id: 'in_transit',
      value: fmt(inTransit),
      tone: inTransit > 0 ? 'info' : 'default',
      hint: inTransit > 0 ? 'Van en camino al cliente' : 'Nada en la calle ahora',
    },
    {
      id: 'unassigned',
      value: fmt(unassigned),
      tone: unassigned > 0 ? 'warning' : 'success',
      hint: unassigned > 0 ? 'Falta transportista o viaje' : 'Todo con transporte',
    },
  ];
};
