import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { OperationsError } from '@/modules/operations/errors';
import {
  budgetVsActual,
  buildCashflowWeeks,
  MAX_PROJECTION_WEEKS,
  runningBalances,
  type BudgetVsActualRow,
  type CashflowProjection,
} from './cashflow-rules';
import {
  addDaysToKey,
  compareKeys,
  dateKeyOf,
  dateKeySchema,
  localDateKey,
  periodBounds,
  periodKeySchema,
  toDbDate,
  weekStartKey,
} from './finance-dates';
import { toCashAccountDTO, type CashAccountDTO } from './finance-dto';
import { hasFinancePermission } from './finance-helpers';
import { D, MONEY_TOLERANCE, currencySchema, roundMoney } from './money';
import { obligationLedgerBalance } from './obligation-rules';
import { OBLIGATION_OPEN_STATUSES } from './types';

/**
 * Cash-flow reports (plan 6.4): weekly projection of open obligations
 * against realized cash, budget against actual per period, and the cash book
 * of an account with its running balance. The `compute*` functions take a
 * client (`prisma` or a transaction) so the monthly close snapshot reuses
 * them; the actor-facing functions check `finance.view`.
 */

type Db = Pick<Prisma.TransactionClient, 'obligation' | 'cashAccount' | 'ledgerLine' | 'budget' | 'financeCategory' | 'costCenter'>;

function assertView(actor: CurrentUser): void {
  if (!hasFinancePermission(actor, 'finance.view')) {
    throw new OperationsError('forbidden', 'No tienes permisos para ver la contabilidad');
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export const cashflowProjectionSchema = z.object({
  from: dateKeySchema.optional(),
  weeks: z.number().int().min(1).max(MAX_PROJECTION_WEEKS).default(8),
  currency: currencySchema.default('MXN'),
});

export type CashflowProjectionInput = z.input<typeof cashflowProjectionSchema>;

export interface CashflowProjectionResult extends CashflowProjection {
  currency: string;
  todayKey: string;
  generatedAt: string;
}

export interface ObligationBalanceAt {
  obligationId: string;
  kind: 'receivable' | 'payable';
  remaining: Prisma.Decimal;
  dueAt: Date | null;
  expectedCashAt: Date | null;
}

/**
 * Receivables and payables outstanding at the end of `asOfKey`, read from the
 * ledger (lines of entries dated on or before it: recognition, settlements,
 * write-offs and reversals), so a close run days later still reports the AR/AP
 * of its own cut-off date.
 */
export async function obligationBalancesAt(
  db: Pick<Db, 'ledgerLine' | 'obligation'>,
  asOfKey: string,
  currency?: string | null
): Promise<ObligationBalanceAt[]> {
  const lines = await db.ledgerLine.findMany({
    where: {
      accountType: { in: ['receivable', 'payable'] },
      entry: { date: { lte: toDbDate(asOfKey) }, ...(currency ? { currency } : {}) },
    },
    select: { accountType: true, accountId: true, debit: true, credit: true },
    take: 100_000,
  });
  const sums = new Map<string, { kind: string; debit: Prisma.Decimal; credit: Prisma.Decimal }>();
  for (const line of lines) {
    const current = sums.get(line.accountId) ?? { kind: line.accountType, debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) };
    current.debit = current.debit.plus(D(line.debit));
    current.credit = current.credit.plus(D(line.credit));
    sums.set(line.accountId, current);
  }
  const outstanding = [...sums.entries()]
    .map(([obligationId, sum]) => ({ obligationId, kind: sum.kind, remaining: obligationLedgerBalance(sum.kind, sum.debit, sum.credit) }))
    .filter((row) => row.remaining.greaterThan(MONEY_TOLERANCE));
  if (outstanding.length === 0) return [];
  const rows = await db.obligation.findMany({
    where: { id: { in: outstanding.map((row) => row.obligationId) } },
    select: { id: true, dueAt: true, expectedCashAt: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return outstanding.map((row) => ({
    obligationId: row.obligationId,
    kind: row.kind === 'payable' ? 'payable' : 'receivable',
    remaining: row.remaining,
    dueAt: byId.get(row.obligationId)?.dueAt ?? null,
    expectedCashAt: byId.get(row.obligationId)?.expectedCashAt ?? null,
  }));
}

/** Σ(debit − credit) of the cash lines of entries dated on or before `asOfKey` (one account, or every account of a currency). */
export async function cashBalanceAt(
  db: Pick<Db, 'ledgerLine'>,
  input: { asOfKey: string; cashAccountId?: string; currency?: string }
): Promise<Prisma.Decimal> {
  const sums = await db.ledgerLine.aggregate({
    where: {
      accountType: 'cash',
      ...(input.cashAccountId ? { accountId: input.cashAccountId } : {}),
      entry: { date: { lte: toDbDate(input.asOfKey) }, ...(input.currency ? { currency: input.currency } : {}) },
    },
    _sum: { debit: true, credit: true },
  });
  return roundMoney(D(sums._sum.debit).minus(D(sums._sum.credit)));
}

/**
 * Weekly projection from `fromKey`. Without `asOfKey` it starts from today's
 * cash and today's open obligations; with `asOfKey` (a close snapshot) it is
 * rebuilt as of that date: cash and AR/AP from the ledger up to it, and only
 * the movements realized up to it.
 */
export async function computeCashflowProjection(
  db: Db,
  input: { fromKey: string; weeks: number; currency: string; todayKey: string; asOfKey?: string | null }
): Promise<CashflowProjection> {
  const firstStart = weekStartKey(input.fromKey);
  const lastEnd = addDaysToKey(firstStart, 7 * Math.min(Math.max(1, input.weeks), MAX_PROJECTION_WEEKS) - 1);
  const realizedEnd = input.asOfKey && compareKeys(input.asOfKey, lastEnd) < 0 ? input.asOfKey : lastEnd;
  const [obligations, openingBalance, lines] = await Promise.all([
    input.asOfKey
      ? obligationBalancesAt(db, input.asOfKey, input.currency).then((rows) =>
          rows.map((row) => ({
            kind: row.kind,
            expectedAmount: row.remaining,
            settledAmount: new Prisma.Decimal(0),
            dueAt: row.dueAt,
            expectedCashAt: row.expectedCashAt,
          }))
        )
      : db.obligation.findMany({
          where: { status: { in: [...OBLIGATION_OPEN_STATUSES] }, currency: input.currency },
          select: { kind: true, expectedAmount: true, settledAmount: true, dueAt: true, expectedCashAt: true },
          take: 10_000,
        }),
    input.asOfKey
      ? cashBalanceAt(db, { asOfKey: input.asOfKey, currency: input.currency })
      : db.cashAccount
          .findMany({ where: { status: 'active', currency: input.currency }, select: { currentBalance: true } })
          .then((accounts) => accounts.reduce((acc, a) => acc.plus(D(a.currentBalance)), new Prisma.Decimal(0))),
    db.ledgerLine.findMany({
      where: {
        accountType: 'cash',
        entry: { date: { gte: toDbDate(firstStart), lte: toDbDate(realizedEnd) }, currency: input.currency },
      },
      select: { entryId: true, debit: true, credit: true, entry: { select: { date: true, kind: true } } },
      take: 50_000,
    }),
  ]);
  // Net cash per entry: a transfer (or its reversal) moves nothing in or out.
  const perEntry = new Map<string, { dateKey: string; kind: string; net: Prisma.Decimal }>();
  for (const line of lines) {
    const current = perEntry.get(line.entryId) ?? {
      dateKey: dateKeyOf(line.entry.date),
      kind: line.entry.kind,
      net: new Prisma.Decimal(0),
    };
    current.net = current.net.plus(D(line.debit)).minus(D(line.credit));
    perEntry.set(line.entryId, current);
  }
  return buildCashflowWeeks({
    fromKey: firstStart,
    weeks: input.weeks,
    todayKey: input.todayKey,
    openingBalance,
    items: obligations.map((o) => ({
      kind: o.kind === 'payable' ? 'payable' : 'receivable',
      remaining: D(o.expectedAmount).minus(D(o.settledAmount)),
      expectedKey: o.expectedCashAt ? dateKeyOf(o.expectedCashAt) : o.dueAt ? dateKeyOf(o.dueAt) : null,
    })),
    realized: [...perEntry.values()].map((entry) => ({
      dateKey: entry.dateKey,
      debit: entry.net.greaterThan(0) ? entry.net : 0,
      credit: entry.net.isNegative() ? entry.net.negated() : 0,
      entryKind: entry.kind === 'transfer' ? 'transfer' : 'cash',
    })),
  });
}

/** Weekly projected (open obligations) vs realized (cash lines) from `from` (default: this week). */
export async function getCashflowProjection(
  actor: CurrentUser,
  input: CashflowProjectionInput = {},
  options: { now?: Date } = {}
): Promise<CashflowProjectionResult> {
  assertView(actor);
  const parsed = cashflowProjectionSchema.parse(input);
  const now = options.now ?? new Date();
  const todayKey = localDateKey(now);
  const projection = await computeCashflowProjection(prisma, {
    fromKey: parsed.from ?? todayKey,
    weeks: parsed.weeks,
    currency: parsed.currency,
    todayKey,
  });
  return { ...projection, currency: parsed.currency, todayKey, generatedAt: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Budget vs actual
// ---------------------------------------------------------------------------

export const budgetVsActualSchema = z.object({
  periodKey: periodKeySchema,
  costCenterId: z.string().trim().min(1).max(120).optional(),
});

export type BudgetVsActualInput = z.input<typeof budgetVsActualSchema>;

export interface BudgetVsActualNamedRow extends BudgetVsActualRow {
  costCenterName: string;
  categoryName: string;
  categoryKind: string | null;
}

export interface BudgetVsActualResult {
  periodKey: string;
  rows: BudgetVsActualNamedRow[];
  totals: { budget: string; actual: string; variance: string };
}

export async function computeBudgetVsActual(db: Db, periodKey: string, costCenterId?: string | null): Promise<BudgetVsActualResult> {
  const [budgets, lines, categories, centers] = await Promise.all([
    db.budget.findMany({
      where: { periodKey, ...(costCenterId ? { costCenterId: { in: [costCenterId, ''] } } : {}) },
      orderBy: [{ costCenterId: 'asc' }, { categoryId: 'asc' }],
    }),
    db.ledgerLine.findMany({
      where: { accountType: 'category', entry: { periodKey }, ...(costCenterId ? { costCenterId } : {}) },
      select: { accountId: true, costCenterId: true, debit: true, credit: true },
      take: 100_000,
    }),
    db.financeCategory.findMany({ select: { id: true, name: true, kind: true } }),
    db.costCenter.findMany({ select: { id: true, name: true } }),
  ]);
  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const centersById = new Map(centers.map((c) => [c.id, c]));
  const rows = budgetVsActual(
    budgets.map((b) => ({ costCenterId: b.costCenterId, categoryId: b.categoryId, amount: b.amount })),
    lines
      .filter((line) => categoriesById.get(line.accountId)?.kind !== 'transfer')
      .map((line) => ({
        costCenterId: line.costCenterId,
        categoryId: line.accountId,
        categoryKind: categoriesById.get(line.accountId)?.kind ?? 'expense',
        debit: line.debit,
        credit: line.credit,
      }))
  ).map((row) => ({
    ...row,
    costCenterName: row.costCenterId ? (centersById.get(row.costCenterId)?.name ?? row.costCenterId) : 'Todos los centros',
    categoryName: row.categoryId ? (categoriesById.get(row.categoryId)?.name ?? row.categoryId) : 'Todas las categorías',
    categoryKind: row.categoryId ? (categoriesById.get(row.categoryId)?.kind ?? null) : null,
  }));
  const budget = rows.filter((r) => r.budgeted).reduce((acc, r) => acc.plus(D(r.budget)), new Prisma.Decimal(0));
  const actual = rows.filter((r) => r.budgeted).reduce((acc, r) => acc.plus(D(r.actual)), new Prisma.Decimal(0));
  return {
    periodKey,
    rows,
    totals: {
      budget: roundMoney(budget).toFixed(2),
      actual: roundMoney(actual).toFixed(2),
      variance: roundMoney(budget.minus(actual)).toFixed(2),
    },
  };
}

export async function getBudgetVsActual(actor: CurrentUser, input: BudgetVsActualInput): Promise<BudgetVsActualResult> {
  assertView(actor);
  const parsed = budgetVsActualSchema.parse(input);
  return computeBudgetVsActual(prisma, parsed.periodKey, parsed.costCenterId ?? null);
}

// ---------------------------------------------------------------------------
// Cash book
// ---------------------------------------------------------------------------

export const MAX_CASH_BOOK_LINES = 10_000;

export const cashBookSchema = z.object({
  cashAccountId: z.string().trim().min(1).max(120),
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

export type CashBookInput = z.input<typeof cashBookSchema>;

export interface CashBookRow {
  entryId: string;
  number: string;
  date: string;
  kind: string;
  description: string;
  debit: string;
  credit: string;
  balance: string;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  reversedByEntryId: string | null;
  reversesEntryId: string | null;
}

export interface CashBookResult {
  account: CashAccountDTO;
  from: string;
  to: string;
  openingBalance: string;
  closingBalance: string;
  totalIn: string;
  totalOut: string;
  rows: CashBookRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  truncated: boolean;
}

export async function getCashBook(actor: CurrentUser, input: CashBookInput, options: { now?: Date } = {}): Promise<CashBookResult> {
  assertView(actor);
  const parsed = cashBookSchema.parse(input);
  const todayKey = localDateKey(options.now ?? new Date());
  const from = parsed.from ?? periodBounds(todayKey.slice(0, 7)).startKey;
  const to = parsed.to ?? todayKey;
  if (from > to) throw new OperationsError('invalid_payload', 'El rango del libro de caja es inválido');
  const account = await prisma.cashAccount.findUnique({ where: { id: parsed.cashAccountId } });
  if (!account) throw new OperationsError('not_found', 'No se encontró la cuenta');

  const before = await prisma.ledgerLine.aggregate({
    where: { accountType: 'cash', accountId: account.id, entry: { date: { lt: toDbDate(from) } } },
    _sum: { debit: true, credit: true },
  });
  // The opening balance of an account is posted as an entry when it is created: the ledger alone is the balance.
  const opening = D(before._sum.debit).minus(D(before._sum.credit));
  const lines = await prisma.ledgerLine.findMany({
    where: { accountType: 'cash', accountId: account.id, entry: { date: { gte: toDbDate(from), lte: toDbDate(to) } } },
    include: { entry: true },
    take: MAX_CASH_BOOK_LINES + 1,
  });
  const truncated = lines.length > MAX_CASH_BOOK_LINES;
  const ordered = lines.slice(0, MAX_CASH_BOOK_LINES).sort(
    (a, b) =>
      a.entry.date.getTime() - b.entry.date.getTime() ||
      a.entry.postedAt.getTime() - b.entry.postedAt.getTime() ||
      a.entry.number.localeCompare(b.entry.number) ||
      a.seq - b.seq
  );
  const balances = runningBalances(opening, ordered);
  const totalIn = ordered.reduce((acc, l) => acc.plus(D(l.debit)), new Prisma.Decimal(0));
  const totalOut = ordered.reduce((acc, l) => acc.plus(D(l.credit)), new Prisma.Decimal(0));
  const pageCount = Math.max(1, Math.ceil(ordered.length / parsed.pageSize));
  const page = Math.min(parsed.page, pageCount);
  const start = (page - 1) * parsed.pageSize;
  const rows = ordered.slice(start, start + parsed.pageSize).map((line, i) => ({
    entryId: line.entry.id,
    number: line.entry.number,
    date: dateKeyOf(line.entry.date),
    kind: line.entry.kind,
    description: line.entry.description,
    debit: roundMoney(D(line.debit)).toFixed(2),
    credit: roundMoney(D(line.credit)).toFixed(2),
    balance: balances[start + i].toFixed(2),
    memo: line.memo,
    sourceType: line.entry.sourceType,
    sourceId: line.entry.sourceId,
    reversedByEntryId: line.entry.reversedByEntryId,
    reversesEntryId: line.entry.reversesEntryId,
  }));
  return {
    account: toCashAccountDTO(account),
    from,
    to,
    openingBalance: roundMoney(opening).toFixed(2),
    closingBalance: (balances[balances.length - 1] ?? roundMoney(opening)).toFixed(2),
    totalIn: roundMoney(totalIn).toFixed(2),
    totalOut: roundMoney(totalOut).toFixed(2),
    rows,
    total: ordered.length,
    page,
    pageSize: parsed.pageSize,
    pageCount,
    truncated,
  };
}

/**
 * Σ(debit − credit) of every cash line of the account. The opening balance is
 * an `adjustment` entry against equity posted when the account is created
 * (`CashAccount.openingBalance` is informative only), so the ledger is the
 * single source of every balance.
 */
export async function ledgerBalanceOf(
  db: Pick<Prisma.TransactionClient, 'ledgerLine'>,
  account: { id: string }
): Promise<Prisma.Decimal> {
  const sums = await db.ledgerLine.aggregate({
    where: { accountType: 'cash', accountId: account.id },
    _sum: { debit: true, credit: true },
  });
  return roundMoney(D(sums._sum.debit).minus(D(sums._sum.credit)));
}
