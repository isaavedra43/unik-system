import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { areaHref, type AreaMeta } from '@/modules/areas/area-registry';
import type {
  AreaDashboardAlert,
  AreaDashboardPayload,
  AreaDashboardTile,
} from '@/modules/areas/area-server-registry';
import type { LiveTilePatch } from '@/modules/areas/dashboard-model';
import { computeBudgetVsActual } from '@/modules/finance/cashflow-service';
import {
  addDaysToKey,
  localDateKey,
  periodKeyOfKey,
  toDbDate,
} from '@/modules/finance/finance-dates';
import { EXPENSE_PENDING_STATUSES, OBLIGATION_OPEN_STATUSES } from '@/modules/finance/types';
import { AREA_REQUEST_OPEN_STATUSES } from '@/modules/operations/types';
import {
  CONTABILIDAD_BASE_PATH,
  budgetTone,
  budgetUsedPercent,
  formatCount,
  formatDateKey,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatPeriodKey,
  parseCloseChecks,
  summarizeCloseChecks,
} from './contabilidad-model';

/**
 * Panel of Contabilidad (plan 7.3, tabla de KPIs): saldo de cajas ·
 * obligaciones vencidas · por pagar ≤ 7 d · cobranza vencida · gastos sin
 * comprobante · % presupuesto consumido · % cierre del periodo · solicitudes
 * entrantes, con las gráficas de caja a 30 días y presupuesto contra real por
 * categoría, y la lista de alertas (obligaciones vencidas y bloqueos del
 * cierre).
 *
 * SERVER ONLY. Everything comes from real rows; an area with nothing pending
 * shows zeros, never a placeholder. Three tiles are marked `live` (indexed
 * `count()`), the rest are computed in the same request.
 */

const OPEN_OBLIGATIONS = [...OBLIGATION_OPEN_STATUSES];
const PENDING_EXPENSES = [...EXPENSE_PENDING_STATUSES];
const OPEN_REQUESTS = [...AREA_REQUEST_OPEN_STATUSES];
const TREND_DAYS = 30;
const ALERT_LIMIT = 6;
const BUDGET_BARS = 6;

interface CashPoint {
  label: string;
  net: string;
}

interface OpenObligationRow {
  id: string;
  number: string;
  kind: string;
  currency: string;
  counterpartyName: string | null;
  description: string;
  expectedAmount: Prisma.Decimal;
  settledAmount: Prisma.Decimal;
  dueAt: Date | null;
}

function remaining(row: OpenObligationRow): number {
  return Number(row.expectedAmount) - Number(row.settledAmount);
}

function href(section: string, query: Record<string, string> = {}): string {
  const params = new URLSearchParams(query).toString();
  const base = `${CONTABILIDAD_BASE_PATH}/${section}`;
  return params ? `${base}?${params}` : base;
}

// ---------------------------------------------------------------------------
// Live tiles
// ---------------------------------------------------------------------------

/** Ids of the tiles recomputed on every request (three indexed `count()`). */
export const CONTABILIDAD_LIVE_TILE_IDS = {
  overdueObligations: 'overdue-obligations',
  expensesWithoutReceipt: 'expenses-without-receipt',
  requestsIn: 'requests-in',
} as const;

/** Tone and hint of each live tile, shared by the panel and its live refresh. */
const liveCopy = {
  overdueObligations: (count: number) => ({
    tone: (count > 0 ? 'danger' : 'success') as AreaDashboardTile['tone'],
    hint: count > 0 ? 'Ya pasaron su fecha de pago o cobro' : 'Nada vencido',
  }),
  expensesWithoutReceipt: (count: number) => ({
    tone: (count > 0 ? 'warning' : 'success') as AreaDashboardTile['tone'],
    hint: count > 0 ? 'Falta la foto o el PDF del ticket' : 'Todos comprobados',
  }),
  requestsIn: (count: number) => ({
    tone: (count > 0 ? 'warning' : 'default') as AreaDashboardTile['tone'],
    hint: count > 0 ? 'Otras áreas esperan respuesta' : 'Sin solicitudes abiertas',
  }),
};

/**
 * Live tiles of Contabilidad (plan 7.3: ≤3 por área). They are recomputed on
 * every request and once a minute in the browser, so "vencidas" and "sin
 * comprobante" nunca son un número viejo.
 */
export async function contabilidadLiveTiles(
  area: AreaMeta,
  options: { now: Date }
): Promise<LiveTilePatch[]> {
  const todayKey = localDateKey(options.now);
  const [overdueObligations, expensesWithoutReceipt, incomingRequests] = await Promise.all([
    prisma.obligation.count({
      where: { status: { in: OPEN_OBLIGATIONS }, dueAt: { lt: toDbDate(todayKey) } },
    }),
    prisma.expense.count({
      where: { status: { in: PENDING_EXPENSES }, receiptObjectIds: { isEmpty: true } },
    }),
    prisma.areaRequest.count({ where: { toAreaKey: area.key, status: { in: OPEN_REQUESTS } } }),
  ]);
  return [
    {
      id: CONTABILIDAD_LIVE_TILE_IDS.overdueObligations,
      value: formatCount(overdueObligations),
      ...liveCopy.overdueObligations(overdueObligations),
    },
    {
      id: CONTABILIDAD_LIVE_TILE_IDS.expensesWithoutReceipt,
      value: formatCount(expensesWithoutReceipt),
      ...liveCopy.expensesWithoutReceipt(expensesWithoutReceipt),
    },
    {
      id: CONTABILIDAD_LIVE_TILE_IDS.requestsIn,
      value: formatCount(incomingRequests),
      ...liveCopy.requestsIn(incomingRequests),
    },
  ];
}

export async function loadContabilidadDashboard(
  _actor: CurrentUser,
  area: AreaMeta,
  options: { now?: Date } = {}
): Promise<AreaDashboardPayload> {
  const now = options.now ?? new Date();
  const todayKey = localDateKey(now);
  const periodKey = periodKeyOfKey(todayKey);
  const weekKey = addDaysToKey(todayKey, 7);
  const trendFromKey = addDaysToKey(todayKey, -(TREND_DAYS - 1));

  const [
    accounts,
    openObligations,
    overdueObligations,
    expensesWithoutReceipt,
    incomingRequests,
    budget,
    dailyCloses,
    monthlyClose,
    opening,
    trend,
  ] = await Promise.all([
    prisma.cashAccount.findMany({
      where: { status: 'active' },
      select: { id: true, name: true, currency: true, currentBalance: true },
      orderBy: { name: 'asc' },
    }),
    prisma.obligation.findMany({
      where: { status: { in: OPEN_OBLIGATIONS } },
      select: {
        id: true,
        number: true,
        kind: true,
        currency: true,
        counterpartyName: true,
        description: true,
        expectedAmount: true,
        settledAmount: true,
        dueAt: true,
      },
      take: 20_000,
    }),
    prisma.obligation.count({
      where: { status: { in: OPEN_OBLIGATIONS }, dueAt: { lt: toDbDate(todayKey) } },
    }),
    prisma.expense.count({
      where: { status: { in: PENDING_EXPENSES }, receiptObjectIds: { isEmpty: true } },
    }),
    prisma.areaRequest.count({
      where: { toAreaKey: area.key, status: { in: OPEN_REQUESTS } },
    }),
    computeBudgetVsActual(prisma, periodKey).catch(() => null),
    prisma.periodClose.findMany({
      where: { kind: 'daily', periodKey: { startsWith: `${periodKey}-` } },
      select: { periodKey: true, status: true, checks: true, updatedAt: true },
      orderBy: { periodKey: 'desc' },
      take: 40,
    }),
    prisma.periodClose.findFirst({
      where: { kind: 'monthly' },
      select: { periodKey: true, status: true, checks: true, updatedAt: true },
      orderBy: { periodKey: 'desc' },
    }),
    prisma.$queryRaw<Array<{ opening: string }>>`
      SELECT COALESCE(SUM(l."debit" - l."credit"), 0)::text AS "opening"
      FROM "LedgerLine" l
      JOIN "LedgerEntry" e ON e."id" = l."entryId"
      WHERE l."accountType" = 'cash' AND e."date" < ${toDbDate(trendFromKey)}::date`,
    prisma.$queryRaw<CashPoint[]>`
      WITH days AS (
        SELECT generate_series(${toDbDate(trendFromKey)}::date, ${toDbDate(todayKey)}::date, interval '1 day')::date AS day
      ),
      movements AS (
        SELECT e."date"::date AS day, SUM(l."debit" - l."credit") AS net
        FROM "LedgerLine" l
        JOIN "LedgerEntry" e ON e."id" = l."entryId"
        WHERE l."accountType" = 'cash'
          AND e."date" >= ${toDbDate(trendFromKey)}::date
          AND e."date" <= ${toDbDate(todayKey)}::date
        GROUP BY 1
      )
      SELECT to_char(d.day, 'DD/MM') AS "label", COALESCE(m.net, 0)::text AS "net"
      FROM days d LEFT JOIN movements m ON m.day = d.day
      ORDER BY d.day ASC`,
  ]);

  // ----------------------------------------------------------------- Tiles
  const balancesByCurrency = new Map<string, number>();
  for (const account of accounts) {
    balancesByCurrency.set(
      account.currency,
      (balancesByCurrency.get(account.currency) ?? 0) + Number(account.currentBalance)
    );
  }
  const mxnBalance = balancesByCurrency.get('MXN') ?? 0;
  const otherCurrencies = [...balancesByCurrency.entries()].filter(
    ([currency]) => currency !== 'MXN'
  );

  const rows = openObligations as OpenObligationRow[];
  const todayDate = toDbDate(todayKey);
  const weekDate = toDbDate(weekKey);
  let payableSoon = 0;
  let receivableOverdue = 0;
  for (const row of rows) {
    const pending = remaining(row);
    if (pending <= 0) continue;
    if (row.kind === 'payable' && row.dueAt && row.dueAt.getTime() <= weekDate.getTime()) {
      payableSoon += pending;
    }
    if (row.kind === 'receivable' && row.dueAt && row.dueAt.getTime() < todayDate.getTime()) {
      receivableOverdue += pending;
    }
  }

  const budgetPercent = budget
    ? budgetUsedPercent(budget.totals.actual, budget.totals.budget)
    : null;
  const elapsedDays = Number(todayKey.slice(8, 10));
  const closedDays = dailyCloses.filter((close) => close.status === 'closed').length;
  const closePercent = elapsedDays > 0 ? Math.round((closedDays / elapsedDays) * 100) : null;

  const tiles: AreaDashboardTile[] = [
    {
      id: 'cash',
      label: 'Saldo de cajas',
      value: formatMoneyCompact(mxnBalance),
      hint:
        accounts.length === 0
          ? 'Todavía no hay cuentas activas'
          : otherCurrencies.length > 0
            ? `${accounts.length} cuentas · también ${otherCurrencies
                .map(([currency, amount]) => formatMoneyCompact(amount, currency))
                .join(', ')}`
            : `${accounts.length} ${accounts.length === 1 ? 'cuenta activa' : 'cuentas activas'}`,
      tone: mxnBalance < 0 ? 'danger' : 'default',
      href: href('libro'),
    },
    {
      id: CONTABILIDAD_LIVE_TILE_IDS.overdueObligations,
      label: 'Obligaciones vencidas',
      value: formatCount(overdueObligations),
      ...liveCopy.overdueObligations(overdueObligations),
      href: href('obligaciones', { vencidas: '1' }),
      live: true,
    },
    {
      id: 'payable-week',
      label: 'Por pagar ≤ 7 días',
      value: formatMoneyCompact(payableSoon),
      hint: `Compromisos hasta el ${formatDateKey(weekKey)}`,
      tone: payableSoon > 0 ? 'warning' : 'default',
      href: href('obligaciones', { tipo: 'payable' }),
    },
    {
      id: 'receivable-overdue',
      label: 'Cobranza vencida',
      value: formatMoneyCompact(receivableOverdue),
      hint: receivableOverdue > 0 ? 'Dinero que ya debió entrar' : 'Sin cobranza vencida',
      tone: receivableOverdue > 0 ? 'danger' : 'success',
      href: href('obligaciones', { tipo: 'receivable', vencidas: '1' }),
    },
    {
      id: CONTABILIDAD_LIVE_TILE_IDS.expensesWithoutReceipt,
      label: 'Gastos sin comprobante',
      value: formatCount(expensesWithoutReceipt),
      ...liveCopy.expensesWithoutReceipt(expensesWithoutReceipt),
      href: areaHref(area.key, 'gastos'),
      live: true,
    },
    {
      id: 'budget-used',
      label: 'Presupuesto consumido',
      value: formatPercent(budgetPercent),
      hint: budget
        ? `${formatMoney(budget.totals.actual)} de ${formatMoney(budget.totals.budget)} en ${formatPeriodKey(periodKey)}`
        : 'Sin presupuesto capturado para este mes',
      tone: budgetTone(budgetPercent),
      href: href('presupuestos', { periodo: periodKey }),
    },
    {
      id: 'close-progress',
      label: 'Avance del cierre',
      value: formatPercent(closePercent),
      hint: `${closedDays} de ${elapsedDays} días del mes cerrados`,
      tone: closePercent !== null && closePercent < 50 ? 'warning' : 'default',
      href: href('cierre'),
    },
    {
      id: CONTABILIDAD_LIVE_TILE_IDS.requestsIn,
      label: 'Solicitudes entrantes',
      value: formatCount(incomingRequests),
      ...liveCopy.requestsIn(incomingRequests),
      href: `${areaHref(area.key, 'trabajo')}?kind=request_in`,
      live: true,
    },
  ];

  // ---------------------------------------------------------------- Charts
  let balance = Number(opening[0]?.opening ?? 0);
  const cashSeries = trend.map((point) => {
    balance += Number(point.net);
    return { label: point.label, saldo: Math.round(balance * 100) / 100 };
  });

  const budgetBars = (budget?.rows ?? [])
    .map((row) => ({
      label: row.categoryName,
      actual: Number(row.actual),
      budget: Number(row.budget),
      usedPct: row.usedPct,
    }))
    .filter((row) => Number.isFinite(row.actual) && row.actual !== 0)
    .sort((a, b) => Math.abs(b.actual) - Math.abs(a.actual))
    .slice(0, BUDGET_BARS)
    .map((row) => ({
      label:
        row.usedPct === null
          ? `${row.label} (sin presupuesto)`
          : `${row.label} (${formatPercent(row.usedPct)})`,
      value: Math.abs(row.actual),
      tone: (row.usedPct !== null && row.usedPct > 100 ? 'danger' : 'brand') as 'danger' | 'brand',
    }));

  // ---------------------------------------------------------------- Alerts
  const overdueRows = rows
    .filter(
      (row) => row.dueAt !== null && row.dueAt.getTime() < todayDate.getTime() && remaining(row) > 0
    )
    .sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0))
    .slice(0, 4);

  const alerts: AreaDashboardAlert[] = overdueRows.map((row) => ({
    id: `obligation-${row.id}`,
    severity: 'danger' as const,
    title: `${row.number} · ${row.counterpartyName ?? row.description}`.slice(0, 160),
    detail: `${row.kind === 'payable' ? 'Por pagar' : 'Por cobrar'} ${formatMoney(remaining(row), row.currency)} · venció el ${formatDateKey(row.dueAt ? localDateKey(row.dueAt) : null)}`,
    href: href('obligaciones', { obligacion: row.id }),
    ...(row.dueAt ? { at: row.dueAt.toISOString() } : {}),
  }));

  const lastDaily = dailyCloses.find((close) => close.status !== 'closed') ?? null;
  for (const close of [lastDaily, monthlyClose]) {
    if (!close || alerts.length >= ALERT_LIMIT) continue;
    const progress = summarizeCloseChecks(parseCloseChecks(close.checks));
    for (const blocker of progress.blockers.slice(0, 2)) {
      if (alerts.length >= ALERT_LIMIT) break;
      alerts.push({
        id: `close-${close.periodKey}-${blocker.key}`,
        severity: 'warning',
        title: `Cierre ${close.periodKey}: ${blocker.label}`,
        detail: blocker.detail,
        href: href('cierre'),
        at: close.updatedAt.toISOString(),
      });
    }
  }

  return {
    areaKey: area.key,
    tiles,
    charts: [
      {
        kind: 'trend',
        id: 'cash-30d',
        title: 'Caja en los últimos 30 días',
        description: 'Saldo al cierre de cada día, según el libro',
        xKey: 'label',
        xLabel: 'Día',
        data: cashSeries,
        series: [{ key: 'saldo', label: 'Saldo', tone: 'brand' }],
      },
      {
        kind: 'bar',
        id: 'budget-vs-actual',
        title: 'Presupuesto contra real por categoría',
        description: `Gasto real de ${formatPeriodKey(periodKey)}`,
        valueLabel: 'Real',
        categoryLabel: 'Categoría',
        data: budgetBars,
      },
    ],
    alerts: alerts.slice(0, ALERT_LIMIT),
    computedAt: now.toISOString(),
    source: 'live',
    note: budget
      ? null
      : 'No pudimos calcular el presupuesto de este mes; el resto de los indicadores sí está al día.',
  };
}
