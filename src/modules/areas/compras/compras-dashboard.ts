import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AREA_REQUEST_OPEN_STATUSES } from '@/modules/operations/types';
import {
  ORDER_COMMITTED_STATUSES,
  ORDER_OPEN_STATUSES,
  ORDER_STATUS_LABELS,
  orderStatusLabel,
} from '@/modules/purchases/orders-state';
import { PURCHASE_REQUEST_OPEN_STATUSES } from '@/modules/purchases/purchases-types';
import { areaHref, type AreaMeta } from '../area-registry';
import type {
  AreaDashboardAlert,
  AreaDashboardPayload,
  AreaDashboardTile,
  AreaServerOptions,
} from '../area-server-registry';
import type { LiveTilePatch } from '../dashboard-model';
import type { AreaLiveTileProvider } from '../dashboard-service';
import { formatMoney } from './compras-model';

/**
 * Panel of Compras (plan 7.3, exact tiles of the table):
 *
 *   Solicitudes abiertas · OC en tránsito · Recepciones esperadas hoy ·
 *   Solicitudes de área sin atender · Expedientes esperando compra ·
 *   Sourcing en curso · Proveedores con OC vencidas · Compromiso del mes
 *
 * Charts: lead time semanal and OC por estado. Alerts: OC vencidas and
 * solicitudes sin acuse pasado su SLA.
 *
 * Everything comes from real entities — an area with nothing to do shows zeros,
 * never a placeholder. Only the three cheap indexed `count()` tiles are marked
 * `live` (the cap of plan 7.3).
 */

const TREND_WEEKS = 8;
const ALERT_LIMIT = 6;
const COMMITTED = [...ORDER_COMMITTED_STATUSES];
const OPEN_REQUESTS = [...AREA_REQUEST_OPEN_STATUSES];

const fmt = (value: number) => value.toLocaleString('es-MX');

function workHref(area: AreaMeta, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  const base = areaHref(area.key, 'trabajo');
  return query ? `${base}?${query}` : base;
}

interface LeadTimeRow {
  label: string;
  dias: number;
}

function startOfDay(now: Date): Date {
  const value = new Date(now);
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfDay(now: Date): Date {
  const value = new Date(now);
  value.setHours(23, 59, 59, 999);
  return value;
}

export async function loadComprasDashboard(
  _actor: CurrentUser,
  area: AreaMeta,
  options: AreaServerOptions
): Promise<AreaDashboardPayload> {
  const now = options.now;
  const dayStart = startOfDay(now);
  const dayEnd = endOfDay(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const trendFrom = new Date(dayStart);
  trendFrom.setDate(trendFrom.getDate() - TREND_WEEKS * 7);

  const [
    openRequests,
    ordersInTransit,
    receiptsToday,
    areaRequestsIn,
    areaRequestsOverdue,
    waitingCases,
    sourcingRunning,
    newCandidates,
    overdueSupplierRows,
    monthCommitment,
    byStatus,
    leadTime,
    overdueOrders,
    lateRequests,
  ] = await Promise.all([
    prisma.purchaseRequest.count({
      where: { status: { in: [...PURCHASE_REQUEST_OPEN_STATUSES] } },
    }),
    prisma.procurementOrder.count({
      where: { status: { in: ['awaiting_receipt', 'partially_received'] } },
    }),
    prisma.procurementOrder.count({
      where: { status: { in: COMMITTED }, expectedAt: { gte: dayStart, lte: dayEnd } },
    }),
    prisma.areaRequest.count({ where: { toAreaKey: area.key, status: { in: OPEN_REQUESTS } } }),
    prisma.areaRequest.count({
      where: { toAreaKey: area.key, status: { in: OPEN_REQUESTS }, dueAt: { lt: now } },
    }),
    prisma.demandAllocation
      .findMany({
        where: {
          source: { in: ['purchase', 'direct_supplier'] },
          status: { in: ['planned', 'requested', 'in_progress'] },
        },
        select: { caseId: true },
        distinct: ['caseId'],
      })
      .then((rows) => rows.length),
    prisma.sourcingSearch.count({ where: { status: 'pending' } }),
    prisma.sourcingCandidate.count({ where: { status: 'new', supplierId: null } }),
    prisma.procurementOrder.findMany({
      where: { status: { in: COMMITTED }, expectedAt: { lt: now } },
      select: { supplierId: true },
      distinct: ['supplierId'],
    }),
    prisma.procurementOrder.aggregate({
      _sum: { total: true },
      where: { createdAt: { gte: monthStart }, status: { notIn: ['draft', 'cancelled'] } },
    }),
    prisma.procurementOrder.groupBy({
      by: ['status'],
      where: { status: { in: [...ORDER_OPEN_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<LeadTimeRow[]>`
      WITH weeks AS (
        SELECT generate_series(
          date_trunc('week', ${trendFrom}::timestamptz),
          date_trunc('week', ${now}::timestamptz),
          interval '1 week'
        ) AS week
      ),
      received AS (
        SELECT date_trunc('week', g."receivedAt") AS week,
               avg(
                 EXTRACT(EPOCH FROM (g."receivedAt" - COALESCE(o."sentToSupplierAt", o."createdAt")))
                 / 86400.0
               ) AS dias
        FROM "GoodsReceipt" g
        JOIN "ProcurementOrder" o ON o."id" = g."orderId"
        WHERE g."status" = 'posted' AND g."receivedAt" >= ${trendFrom}
        GROUP BY 1
      )
      SELECT to_char(w.week, 'DD/MM') AS "label",
             COALESCE(round(r.dias::numeric, 1), 0)::float8 AS "dias"
      FROM weeks w
      LEFT JOIN received r ON r.week = w.week
      ORDER BY w.week ASC`,
    prisma.procurementOrder.findMany({
      where: { status: { in: COMMITTED }, expectedAt: { lt: now } },
      orderBy: [{ expectedAt: 'asc' }, { id: 'asc' }],
      take: ALERT_LIMIT,
      select: { id: true, number: true, expectedAt: true, supplierId: true, status: true },
    }),
    prisma.areaRequest.findMany({
      where: { toAreaKey: area.key, status: 'sent', dueAt: { lt: now } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: ALERT_LIMIT,
      select: { id: true, title: true, dueAt: true, fromAreaKey: true },
    }),
  ]);

  const supplierNames = await suppliersByIdOf(overdueOrders.map((order) => order.supplierId));

  const overdueSuppliers = overdueSupplierRows.length;
  const committed = monthCommitment._sum.total ? monthCommitment._sum.total.toString() : '0';

  const tiles: AreaDashboardTile[] = [
    {
      id: 'open_requests',
      label: 'Solicitudes abiertas',
      value: fmt(openRequests),
      hint: 'Material que alguien pidió comprar',
      href: workHref(area, { kind: 'purchase_request' }),
      live: true,
    },
    {
      id: 'orders_in_transit',
      label: 'OC en tránsito',
      value: fmt(ordersInTransit),
      hint: 'Órdenes esperando material del proveedor',
      href: workHref(area, { kind: 'procurement_order' }),
      live: true,
    },
    {
      id: 'receipts_today',
      label: 'Recepciones esperadas hoy',
      value: fmt(receiptsToday),
      tone: receiptsToday > 0 ? 'info' : 'default',
      hint: 'Lo que el proveedor prometió para hoy',
      href: workHref(area, { kind: 'procurement_order' }),
      live: true,
    },
    {
      id: 'area_requests',
      label: 'Solicitudes de área sin atender',
      value: fmt(areaRequestsIn),
      tone: areaRequestsOverdue > 0 ? 'danger' : 'default',
      hint:
        areaRequestsOverdue > 0
          ? `${fmt(areaRequestsOverdue)} ya pasaron su plazo`
          : 'Todas dentro de plazo',
      href: workHref(area, { kind: 'request_in' }),
    },
    {
      id: 'cases_waiting',
      label: 'Expedientes esperando compra',
      value: fmt(waitingCases),
      tone: waitingCases > 0 ? 'warning' : 'default',
      hint: 'Ventas que dependen de que Compras surta',
    },
    {
      id: 'sourcing_running',
      label: 'Sourcing en curso',
      value: fmt(sourcingRunning),
      hint:
        newCandidates > 0
          ? `${fmt(newCandidates)} candidatos nuevos por revisar`
          : 'Sin candidatos nuevos',
      href: areaHref(area.key, area.special.slug),
    },
    {
      id: 'suppliers_overdue',
      label: 'Proveedores con OC vencidas',
      value: fmt(overdueSuppliers),
      tone: overdueSuppliers > 0 ? 'danger' : 'success',
      hint: overdueSuppliers > 0 ? 'Se pasaron de la fecha prometida' : 'Nadie va tarde',
    },
    {
      id: 'month_commitment',
      label: 'Compromiso del mes',
      value: formatMoney(committed),
      hint: 'Órdenes de compra emitidas este mes',
    },
  ];

  const alerts: AreaDashboardAlert[] = [
    ...overdueOrders.map((order): AreaDashboardAlert => {
      const supplier = supplierNames.get(order.supplierId) ?? 'proveedor sin nombre';
      return {
        id: `order-${order.id}`,
        severity: 'danger',
        title: `${order.number} · ${supplier}`,
        detail: order.expectedAt
          ? `Prometida para el ${order.expectedAt.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} · ${orderStatusLabel(order.status)}`
          : orderStatusLabel(order.status),
        href: `${areaHref(area.key, 'ordenes')}/${order.id}`,
        ...(order.expectedAt ? { at: order.expectedAt.toISOString() } : {}),
      };
    }),
    ...lateRequests.map((request): AreaDashboardAlert => ({
      id: `request-${request.id}`,
      severity: 'warning',
      title: request.title,
      detail: 'Solicitud sin acuse pasada su fecha de compromiso',
      href: workHref(area, { kind: 'request_in' }),
      at: request.dueAt.toISOString(),
    })),
  ].slice(0, ALERT_LIMIT);

  return {
    areaKey: area.key,
    tiles,
    charts: [
      {
        kind: 'trend',
        id: 'lead-time',
        title: 'Lead time semanal',
        description: `Días entre el envío de la orden y la recepción · últimas ${TREND_WEEKS} semanas`,
        xKey: 'label',
        xLabel: 'Semana',
        data: leadTime.map((point) => ({ label: point.label, dias: Number(point.dias) })),
        series: [{ key: 'dias', label: 'Días', tone: 'brand' }],
      },
      {
        kind: 'bar',
        id: 'orders-by-status',
        title: 'Órdenes de compra por estado',
        valueLabel: 'Órdenes',
        categoryLabel: 'Estado',
        data: byStatus
          .map((entry) => ({
            label:
              ORDER_STATUS_LABELS[entry.status as keyof typeof ORDER_STATUS_LABELS] ?? entry.status,
            value: entry._count._all,
          }))
          .sort((a, b) => b.value - a.value),
      },
    ],
    alerts,
    computedAt: now.toISOString(),
    source: 'live',
    note: null,
  };
}

async function suppliersByIdOf(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await prisma.supplier.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * The three tiles of Compras marked `live` (plan 7.3 caps them at three), each
 * one an indexed `count()`.
 *
 * Without this provider `applyLiveTiles` would strip the `live` mark from them
 * — correctly, since nobody could recompute their value — and the panel would
 * show the snapshot number of up to five minutes ago. Material in transit and
 * the receipts expected today are exactly the numbers a buyer checks against
 * the clock, so they are recomputed on every request.
 */
export const comprasLiveTiles: AreaLiveTileProvider = async (_area, { now }) => {
  const dayStart = startOfDay(now);
  const dayEnd = endOfDay(now);
  const [openRequests, ordersInTransit, receiptsToday] = await Promise.all([
    prisma.purchaseRequest.count({
      where: { status: { in: [...PURCHASE_REQUEST_OPEN_STATUSES] } },
    }),
    prisma.procurementOrder.count({
      where: { status: { in: ['awaiting_receipt', 'partially_received'] } },
    }),
    prisma.procurementOrder.count({
      where: { status: { in: COMMITTED }, expectedAt: { gte: dayStart, lte: dayEnd } },
    }),
  ]);
  const patches: LiveTilePatch[] = [
    { id: 'open_requests', value: fmt(openRequests) },
    { id: 'orders_in_transit', value: fmt(ordersInTransit) },
    {
      id: 'receipts_today',
      value: fmt(receiptsToday),
      tone: receiptsToday > 0 ? 'info' : 'default',
    },
  ];
  return patches;
};
