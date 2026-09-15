import { Prisma } from '@prisma/client';
import { addDaysToKey, compareKeys, isDateKey, weekStartKey } from './finance-dates';
import { D, roundMoney, type Money } from './money';

/**
 * Pure cash-flow computations (plan 6.4): weekly projection of open
 * obligations against realized cash movements, budget against actual and the
 * running balance of the cash book.
 */

export const MAX_PROJECTION_WEEKS = 26;

export interface ProjectionItem {
  kind: 'receivable' | 'payable';
  remaining: Prisma.Decimal.Value;
  /** expectedCashAt, else dueAt (date key); null when undated. */
  expectedKey: string | null;
}

export interface RealizedCashLine {
  dateKey: string;
  debit: Prisma.Decimal.Value;
  credit: Prisma.Decimal.Value;
  /** Kind of the entry: transfers between cash accounts are not cash flow. */
  entryKind: string;
}

export interface CashflowWeek {
  weekStart: string;
  weekEnd: string;
  projectedIn: string;
  projectedOut: string;
  projectedNet: string;
  realizedIn: string;
  realizedOut: string;
  realizedNet: string;
  /** Running projected cash from the current week on; null for past weeks. */
  projectedBalance: string | null;
}

export interface CashflowProjection {
  weeks: CashflowWeek[];
  openingBalance: string;
  /** Overdue items counted in the first week. */
  overdue: { in: string; out: string };
  /** Items without a date (not in any week). */
  undated: { in: string; out: string };
}

const fixed = (value: Money) => roundMoney(value).toFixed(2);

export function buildCashflowWeeks(input: {
  fromKey: string;
  weeks: number;
  todayKey: string;
  openingBalance: Prisma.Decimal.Value;
  items: readonly ProjectionItem[];
  realized: readonly RealizedCashLine[];
}): CashflowProjection {
  const count = Math.min(Math.max(1, Math.trunc(input.weeks)), MAX_PROJECTION_WEEKS);
  const firstStart = weekStartKey(input.fromKey);
  const starts = Array.from({ length: count }, (_, i) => addDaysToKey(firstStart, 7 * i));
  const buckets = starts.map(() => ({
    pIn: new Prisma.Decimal(0),
    pOut: new Prisma.Decimal(0),
    rIn: new Prisma.Decimal(0),
    rOut: new Prisma.Decimal(0),
  }));
  const indexOf = (key: string): number => {
    const start = weekStartKey(key);
    const index = starts.indexOf(start);
    return index;
  };
  let overdueIn = new Prisma.Decimal(0);
  let overdueOut = new Prisma.Decimal(0);
  let undatedIn = new Prisma.Decimal(0);
  let undatedOut = new Prisma.Decimal(0);

  for (const item of input.items) {
    const amount = D(item.remaining);
    if (!amount.greaterThan(0)) continue;
    const incoming = item.kind === 'receivable';
    if (!item.expectedKey || !isDateKey(item.expectedKey)) {
      if (incoming) undatedIn = undatedIn.plus(amount);
      else undatedOut = undatedOut.plus(amount);
      continue;
    }
    let index = indexOf(item.expectedKey);
    if (compareKeys(item.expectedKey, firstStart) < 0) {
      index = 0;
      if (incoming) overdueIn = overdueIn.plus(amount);
      else overdueOut = overdueOut.plus(amount);
    }
    if (index < 0) continue;
    if (incoming) buckets[index].pIn = buckets[index].pIn.plus(amount);
    else buckets[index].pOut = buckets[index].pOut.plus(amount);
  }

  for (const line of input.realized) {
    if (line.entryKind === 'transfer' || !isDateKey(line.dateKey)) continue;
    const index = indexOf(line.dateKey);
    if (index < 0) continue;
    buckets[index].rIn = buckets[index].rIn.plus(D(line.debit));
    buckets[index].rOut = buckets[index].rOut.plus(D(line.credit));
  }

  const currentWeek = weekStartKey(input.todayKey);
  let balance = D(input.openingBalance);
  const weeks = starts.map((start, i) => {
    const b = buckets[i];
    const projectedNet = b.pIn.minus(b.pOut);
    let projectedBalance: string | null = null;
    if (compareKeys(start, currentWeek) >= 0) {
      balance = balance.plus(projectedNet);
      projectedBalance = fixed(balance);
    }
    return {
      weekStart: start,
      weekEnd: addDaysToKey(start, 6),
      projectedIn: fixed(b.pIn),
      projectedOut: fixed(b.pOut),
      projectedNet: fixed(projectedNet),
      realizedIn: fixed(b.rIn),
      realizedOut: fixed(b.rOut),
      realizedNet: fixed(b.rIn.minus(b.rOut)),
      projectedBalance,
    };
  });
  return {
    weeks,
    openingBalance: fixed(D(input.openingBalance)),
    overdue: { in: fixed(overdueIn), out: fixed(overdueOut) },
    undated: { in: fixed(undatedIn), out: fixed(undatedOut) },
  };
}

export interface BudgetInputRow {
  costCenterId: string;
  categoryId: string;
  amount: Prisma.Decimal.Value;
}

export interface ActualInputRow {
  costCenterId: string | null;
  categoryId: string;
  /** Kind of the category: income is credit-normal, everything else debit-normal. */
  categoryKind: string;
  debit: Prisma.Decimal.Value;
  credit: Prisma.Decimal.Value;
}

export interface BudgetVsActualRow {
  costCenterId: string;
  categoryId: string;
  budget: string;
  actual: string;
  variance: string;
  /** actual / budget × 100 (null without budget). */
  usedPct: number | null;
  budgeted: boolean;
}

export function actualAmount(row: Pick<ActualInputRow, 'categoryKind' | 'debit' | 'credit'>): Money {
  return row.categoryKind === 'income' ? D(row.credit).minus(D(row.debit)) : D(row.debit).minus(D(row.credit));
}

/**
 * One row per budget (`''` = all centers / all categories) with the actual of
 * the lines it covers, plus one unbudgeted row per center+category whose lines
 * no budget covers.
 */
export function budgetVsActual(
  budgets: readonly BudgetInputRow[],
  actuals: readonly ActualInputRow[]
): BudgetVsActualRow[] {
  const covers = (budget: BudgetInputRow, row: ActualInputRow) =>
    (budget.costCenterId === '' || budget.costCenterId === (row.costCenterId ?? '')) &&
    (budget.categoryId === '' || budget.categoryId === row.categoryId);

  const rows: BudgetVsActualRow[] = budgets.map((budget) => {
    const actual = actuals.filter((row) => covers(budget, row)).reduce((acc, row) => acc.plus(actualAmount(row)), new Prisma.Decimal(0));
    const amount = D(budget.amount);
    return {
      costCenterId: budget.costCenterId,
      categoryId: budget.categoryId,
      budget: fixed(amount),
      actual: fixed(actual),
      variance: fixed(amount.minus(actual)),
      usedPct: amount.isZero() ? null : Math.round(actual.dividedBy(amount).times(10000).toNumber()) / 100,
      budgeted: true,
    };
  });

  const unbudgeted = new Map<string, { costCenterId: string; categoryId: string; actual: Money }>();
  for (const row of actuals) {
    if (budgets.some((budget) => covers(budget, row))) continue;
    const key = `${row.costCenterId ?? ''}|${row.categoryId}`;
    const current = unbudgeted.get(key) ?? {
      costCenterId: row.costCenterId ?? '',
      categoryId: row.categoryId,
      actual: new Prisma.Decimal(0),
    };
    current.actual = current.actual.plus(actualAmount(row));
    unbudgeted.set(key, current);
  }
  for (const entry of [...unbudgeted.values()].sort((a, b) => `${a.costCenterId}|${a.categoryId}`.localeCompare(`${b.costCenterId}|${b.categoryId}`))) {
    if (entry.actual.isZero()) continue;
    rows.push({
      costCenterId: entry.costCenterId,
      categoryId: entry.categoryId,
      budget: '0.00',
      actual: fixed(entry.actual),
      variance: fixed(entry.actual.negated()),
      usedPct: null,
      budgeted: false,
    });
  }
  return rows;
}

/** Running balance of a debit-normal account after each line. */
export function runningBalances(
  opening: Prisma.Decimal.Value,
  lines: ReadonlyArray<{ debit: Prisma.Decimal.Value; credit: Prisma.Decimal.Value }>
): Money[] {
  let balance = D(opening);
  return lines.map((line) => {
    balance = balance.plus(D(line.debit)).minus(D(line.credit));
    return roundMoney(balance);
  });
}
