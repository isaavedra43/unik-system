import type {
  AreaDashboardAlert,
  AreaDashboardChart,
  AreaDashboardTile,
} from '@/modules/areas/area-server-registry';
import { CASE_PHASE_LABELS, type CasePhase } from '@/modules/operations/types';
import type { ChartTone } from '@/components/patterns/dashboard/chart-theme';
import {
  formatCount,
  formatMoney,
  SALES_ORDERS_HREF,
  ventasRadarHref,
  ventasWorkHref,
} from './ventas-constants';

/**
 * Modelo PURO del panel de Ventas (plan 7.3): convierte conteos reales en los
 * ocho tiles, las dos gráficas y la lista de alertas de la tabla del plan. Sin
 * Prisma y sin React, así que se prueba solo y `ventas-dashboard.ts` sólo hace
 * las consultas.
 *
 * Nada aquí inventa datos: un área sin movimiento muestra ceros y una lista de
 * alertas vacía.
 */

/** Tiles marcados `live` (≤3 por área, `count()` indexado). */
export const VENTAS_LIVE_TILES = ['open_cases', 'blocked_cases', 'radar_signals'] as const;

export interface VentasDashboardCounts {
  /** Expedientes de venta abiertos (open, waiting, blocked, ready_to_close). */
  openCases: number;
  /** Expedientes bloqueados ahora. */
  blockedCases: number;
  /** Expedientes prometidos dentro de 7 días que ya están en riesgo. */
  promisedAtRisk: number;
  /** Cotizaciones enviadas o vistas que siguen sin decisión del cliente. */
  quotesWaiting: number;
  /** Órdenes de venta recientes sin expediente operativo. */
  ordersWithoutCase: number;
  /** Señales del radar activas y vigentes. */
  activeSignals: number;
  /** Solicitudes que Ventas envió a otra área y ya vencieron. */
  overdueOutgoingRequests: number;
  /** Suma de las órdenes del mes en curso (moneda del sistema). */
  monthSalesTotal: number;
  /** Órdenes contadas en `monthSalesTotal`. */
  monthSalesOrders: number;
}

export interface VentasTrendPoint {
  label: string;
  creados: number;
  cerrados: number;
}

export interface VentasPhaseCount {
  phase: string;
  total: number;
}

export interface VentasAlertInput {
  /** Expedientes bloqueados, del más antiguo al más reciente. */
  blocked: Array<{ id: string; caseNumber: string; customerName: string | null; since: string }>;
  /** Expedientes abiertos cuya promesa vence en ≤48 h. */
  promised: Array<{
    id: string;
    caseNumber: string;
    customerName: string | null;
    promisedAt: string;
    overdue: boolean;
  }>;
  /** Solicitudes enviadas por Ventas y vencidas. */
  requests: Array<{ id: string; title: string; toAreaLabel: string; dueAt: string }>;
}

const PHASE_TONES: Readonly<Record<string, ChartTone>> = {
  planning: 'muted',
  sourcing: 'info',
  preparing: 'brand',
  delivering: 'warning',
  closing: 'success',
};

export const VENTAS_TREND_DAYS = 30;
export const VENTAS_PROMISE_HORIZON_DAYS = 7;
export const VENTAS_PROMISE_ALERT_HOURS = 48;
const ALERT_LIMIT = 6;

function monthLabel(now: Date): string {
  try {
    return new Intl.DateTimeFormat('es-MX', { month: 'long', timeZone: 'America/Mexico_City' })
      .format(now)
      .toLowerCase();
  } catch {
    return 'este mes';
  }
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('es-MX', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/Mexico_City',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Los ocho tiles de Ventas, en el orden de la tabla del plan 7.3. */
export function ventasTiles(counts: VentasDashboardCounts, now: Date): AreaDashboardTile[] {
  return [
    {
      id: 'open_cases',
      label: 'Expedientes abiertos',
      value: formatCount(counts.openCases),
      hint: 'Ventas comprometidas que siguen en curso',
      href: ventasWorkHref({ kind: 'case' }),
      live: true,
    },
    {
      id: 'blocked_cases',
      label: 'Bloqueados',
      value: formatCount(counts.blockedCases),
      tone: counts.blockedCases > 0 ? 'danger' : 'success',
      hint:
        counts.blockedCases > 0
          ? 'Esperan una decisión para poder avanzar'
          : 'Ningún expediente detenido',
      href: ventasWorkHref({ kind: 'case' }),
      live: true,
    },
    {
      id: 'promised_at_risk',
      label: `Prometidos ≤${VENTAS_PROMISE_HORIZON_DAYS} d en riesgo`,
      value: formatCount(counts.promisedAtRisk),
      tone: counts.promisedAtRisk > 0 ? 'warning' : 'default',
      hint:
        counts.promisedAtRisk > 0
          ? 'Con trabajo vencido, en espera o bloqueados'
          : 'Las promesas de la semana van a tiempo',
      href: ventasWorkHref({ kind: 'case', vencidos: '1' }),
    },
    {
      id: 'quotes_waiting',
      label: 'Cotizaciones sin respuesta',
      value: formatCount(counts.quotesWaiting),
      tone: counts.quotesWaiting > 0 ? 'warning' : 'default',
      hint: 'Enviadas o vistas, sin aceptar ni rechazar',
      href: ventasWorkHref({ kind: 'quote' }),
    },
    {
      id: 'orders_without_case',
      label: 'Órdenes sin expediente',
      value: formatCount(counts.ordersWithoutCase),
      tone: counts.ordersWithoutCase > 0 ? 'warning' : 'success',
      hint:
        counts.ordersWithoutCase > 0
          ? 'Órdenes recientes de Zoho que nadie está siguiendo'
          : 'Toda orden reciente tiene expediente',
      href: SALES_ORDERS_HREF,
    },
    {
      id: 'radar_signals',
      label: 'Señales del radar',
      value: formatCount(counts.activeSignals),
      tone: counts.activeSignals > 0 ? 'info' : 'default',
      hint: 'Clientes que necesitan un movimiento hoy',
      href: ventasRadarHref(),
      live: true,
    },
    {
      id: 'requests_overdue',
      label: 'Solicitudes enviadas vencidas',
      value: formatCount(counts.overdueOutgoingRequests),
      tone: counts.overdueOutgoingRequests > 0 ? 'danger' : 'default',
      hint: 'Otras áreas nos deben una respuesta',
      href: ventasWorkHref({ kind: 'request_out', vencidos: '1' }),
    },
    {
      id: 'month_sales',
      label: 'Ventas del mes',
      value: formatMoney(counts.monthSalesTotal),
      hint:
        counts.monthSalesOrders === 1
          ? `1 orden en ${monthLabel(now)}`
          : `${formatCount(counts.monthSalesOrders)} órdenes en ${monthLabel(now)}`,
    },
  ];
}

/** Las dos gráficas: flujo de expedientes y reparto por fase. */
export function ventasCharts(
  trend: readonly VentasTrendPoint[],
  phases: readonly VentasPhaseCount[]
): AreaDashboardChart[] {
  const known = new Map(phases.map((row) => [row.phase, row.total]));
  return [
    {
      kind: 'trend',
      id: 'cases_flow',
      title: 'Expedientes creados vs. cerrados',
      description: `Últimos ${VENTAS_TREND_DAYS} días`,
      xKey: 'label',
      xLabel: 'Día',
      data: trend.map((point) => ({
        label: point.label,
        creados: point.creados,
        cerrados: point.cerrados,
      })),
      series: [
        { key: 'creados', label: 'Creados', tone: 'brand' },
        { key: 'cerrados', label: 'Cerrados', tone: 'success' },
      ],
    },
    {
      kind: 'status',
      id: 'cases_by_phase',
      title: 'Expedientes abiertos por fase',
      description: 'Dónde está detenida la venta',
      segments: (Object.keys(CASE_PHASE_LABELS) as CasePhase[])
        .map((phase) => ({
          key: phase,
          label: CASE_PHASE_LABELS[phase],
          count: known.get(phase) ?? 0,
          tone: PHASE_TONES[phase] ?? ('muted' as ChartTone),
        }))
        .filter((segment) => segment.count > 0),
    },
  ];
}

/** Alertas: bloqueados, promesas de ≤48 h y solicitudes vencidas (máx. 6). */
export function ventasAlerts(input: VentasAlertInput): AreaDashboardAlert[] {
  const blocked: AreaDashboardAlert[] = input.blocked.map((row) => ({
    id: `case-blocked-${row.id}`,
    severity: 'danger',
    title: `${row.caseNumber} bloqueado${row.customerName ? ` · ${row.customerName}` : ''}`,
    detail: `Sin avanzar desde el ${shortDate(row.since)}`,
    href: ventasWorkHref({ kind: 'case' }),
    at: row.since,
  }));

  const promised: AreaDashboardAlert[] = input.promised.map((row) => ({
    id: `case-promised-${row.id}`,
    severity: row.overdue ? 'danger' : 'warning',
    title: `${row.caseNumber} ${row.overdue ? 'pasó la fecha prometida' : 'se entrega en menos de 48 h'}`,
    detail: `${row.customerName ?? 'Sin cliente'} · ${shortDate(row.promisedAt)}`,
    href: ventasWorkHref({ kind: 'case' }),
    at: row.promisedAt,
  }));

  const requests: AreaDashboardAlert[] = input.requests.map((row) => ({
    id: `request-${row.id}`,
    severity: 'warning',
    title: row.title,
    detail: `${row.toAreaLabel} no ha respondido · venció el ${shortDate(row.dueAt)}`,
    href: ventasWorkHref({ kind: 'request_out', vencidos: '1' }),
    at: row.dueAt,
  }));

  return [...blocked, ...promised, ...requests].slice(0, ALERT_LIMIT);
}
