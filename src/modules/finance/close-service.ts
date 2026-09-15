import { Prisma, type PeriodClose } from '@prisma/client';
import { z } from 'zod';
import { lockAdvisoryKeys } from '@/modules/operations/advisory-locks';
import { ConcurrencyConflict, type CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { toOperationalJson } from '@/modules/operations/events-service';
import { getOperationsConfig } from '@/modules/operations/operations-config';
import {
  cashBalanceAt,
  computeBudgetVsActual,
  computeCashflowProjection,
  ledgerBalanceOf,
  obligationBalancesAt,
} from './cashflow-service';
import {
  assertCloseKey,
  assertCloseTransition,
  assertReopenReason,
  canClose,
  closeSummary,
  evaluateCloseChecks,
  REOPEN_REASON_MIN,
  type CloseCheck,
  type CloseRulesInput,
} from './close-rules';
import { listOverappliedPayments, listUnmatchedPayments } from './collections-service';
import { financeError } from './finance-errors';
import {
  compareKeys,
  daysBetweenKeys,
  localDateKey,
  periodBounds,
  periodKeyOfKey,
  periodKeySchema,
  dateKeySchema,
  previousPeriodKey,
  toDbDate,
  dateKeyOf,
} from './finance-dates';
import { actorUserIdOf, financeEventOptions, publishBoard, todayKeyOf } from './finance-helpers';
import { closeLockKey } from './ledger-rules';
import { D, nonNegativeMoneySchema, roundMoney } from './money';
import { summarizeAging } from './obligation-rules';
import {
  EXPENSE_PENDING_STATUSES,
  FINANCE_EVENTS,
  FINANCE_OBJECT_TYPES,
  PERIOD_CLOSE_KINDS,
  type PeriodCloseKind,
} from './types';

/**
 * Daily and monthly closes (plan 6.4). The checks of `close-rules.ts` run
 * against the period: pending expenses, unassigned collections, cash
 * integrity and counts, balanced ledger (plus warnings). When every blocking
 * check passes the period becomes `closed` with a snapshot (balances, budget
 * vs actual, aging of AR/AP, projected vs realized) and the ledger rejects
 * its dates; otherwise the attempt is stored with its checks and the period
 * stays open. `reopenPeriod` needs `finance.close` and a reason.
 */

type Db = Prisma.TransactionClient;

const countsSchema = z
  .array(z.object({ cashAccountId: z.string().trim().min(1).max(120), counted: nonNegativeMoneySchema }))
  .max(50)
  .default([]);

export const dailyCloseSchema = z.object({ date: dateKeySchema, counts: countsSchema });
export const monthlyCloseSchema = z.object({ periodKey: periodKeySchema, counts: countsSchema });
export const reopenPeriodSchema = z.object({
  kind: z.enum(PERIOD_CLOSE_KINDS),
  periodKey: z.string().trim().min(7).max(10),
  reason: z.string().trim().min(REOPEN_REASON_MIN).max(1000),
});

export interface CloseResultData {
  closeId: string;
  kind: PeriodCloseKind;
  periodKey: string;
  status: string;
  closed: boolean;
  checks: CloseCheck[];
  summary: { ok: number; failed: number; warnings: number };
}

interface Range {
  fromKey: string;
  toKey: string;
}

function rangeOf(kind: PeriodCloseKind, periodKey: string): Range {
  if (kind === 'daily') return { fromKey: periodKey, toKey: periodKey };
  const bounds = periodBounds(periodKey);
  return { fromKey: bounds.startKey, toKey: bounds.endKey };
}

async function gatherInputs(
  tx: Db,
  kind: PeriodCloseKind,
  periodKey: string,
  counts: ReadonlyArray<{ cashAccountId: string; counted: Prisma.Decimal }>
): Promise<{ input: CloseRulesInput; range: Range; unassignedAmount: Prisma.Decimal }> {
  const range = rangeOf(kind, periodKey);
  const dateRange = { gte: toDbDate(range.fromKey), lte: toDbDate(range.toKey) };
  const [pending, pendingCount, accounts, entries] = await Promise.all([
    tx.expense.findMany({
      where: { status: { in: [...EXPENSE_PENDING_STATUSES] }, date: dateRange },
      select: { number: true },
      orderBy: { number: 'asc' },
      take: 20,
    }),
    tx.expense.count({ where: { status: { in: [...EXPENSE_PENDING_STATUSES] }, date: dateRange } }),
    tx.cashAccount.findMany({ where: { status: 'active' }, orderBy: { key: 'asc' } }),
    tx.ledgerEntry.findMany({
      where: kind === 'monthly' ? { periodKey } : { date: toDbDate(periodKey) },
      select: { id: true },
    }),
  ]);
  for (const count of counts) {
    if (!accounts.some((a) => a.id === count.cashAccountId)) {
      throw new OperationsError('not_found', 'Una cuenta del arqueo no existe o está cerrada');
    }
  }
  const sums = entries.length
    ? await tx.ledgerLine.aggregate({
        where: { entryId: { in: entries.map((e) => e.id) } },
        _sum: { debit: true, credit: true },
      })
    : { _sum: { debit: null, credit: null } };

  const config = await getOperationsConfig();
  const cutoverKey = localDateKey(new Date(config.cutoverDate));
  const unassignedFrom = compareKeys(cutoverKey, range.fromKey) > 0 ? cutoverKey : range.fromKey;
  const unassigned =
    compareKeys(unassignedFrom, range.toKey) > 0
      ? []
      : await listUnmatchedPayments(tx, { fromKey: unassignedFrom, toKey: range.toKey, limit: 2000 });
  const unassignedAmount = unassigned.reduce((acc, p) => acc.plus(D(p.remaining)), new Prisma.Decimal(0));
  const overapplied = await listOverappliedPayments(tx, { limit: 2000 });

  const cashAccounts = [];
  for (const account of accounts) {
    const counted = counts.find((c) => c.cashAccountId === account.id)?.counted ?? null;
    cashAccounts.push({
      cashAccountId: account.id,
      name: account.name,
      kind: account.kind,
      currency: account.currency,
      currentBalance: account.currentBalance,
      // Integrity: today's stored balance against the whole ledger.
      ledgerBalance: await ledgerBalanceOf(tx, account),
      // Cash count and snapshot: the balance at the end of the closed period.
      balanceAtCutoff: await cashBalanceAt(tx, { asOfKey: range.toKey, cashAccountId: account.id }),
      counted,
    });
  }

  const input: CloseRulesInput = {
    kind,
    periodKey,
    pendingExpenses: { count: pendingCount, numbers: pending.map((p) => p.number) },
    unassignedCollections: { count: unassigned.length, amount: unassignedAmount },
    overappliedCollections: {
      count: overapplied.length,
      amount: overapplied.reduce((acc, p) => acc.plus(D(p.excess)), new Prisma.Decimal(0)),
      numbers: overapplied.map((p) => p.paymentNumber ?? p.zohoPaymentId),
    },
    cashAccounts,
    ledgerTotals: { debit: D(sums._sum.debit), credit: D(sums._sum.credit), entries: entries.length },
  };
  if (kind === 'monthly') {
    const previous = await tx.periodClose.findFirst({
      where: { periodKey: previousPeriodKey(periodKey), kind: 'monthly' },
      select: { status: true },
    });
    input.previousPeriodClosed = previous?.status === 'closed';
    const runs = await tx.payrollRun.findMany({
      where: { periodKey, status: { in: ['draft', 'pending_approval', 'approved', 'obligations_created'] } },
      select: { number: true },
      take: 20,
    });
    input.openPayrollRuns = { count: runs.length, numbers: runs.map((r) => r.number) };
  }
  return { input, range, unassignedAmount };
}

async function buildSnapshot(
  tx: Db,
  kind: PeriodCloseKind,
  periodKey: string,
  gathered: Awaited<ReturnType<typeof gatherInputs>>,
  ctx: CommandContext
): Promise<Record<string, unknown>> {
  const { input, range } = gathered;
  // AR/AP outstanding at the cut-off date (from the ledger), not today's open obligations.
  const open = await obligationBalancesAt(tx, range.toKey);
  const posted = await tx.expense.findMany({
    where: { status: 'posted', date: { gte: toDbDate(range.fromKey), lte: toDbDate(range.toKey) } },
    select: { amount: true },
  });
  const snapshot: Record<string, unknown> = {
    generatedAt: ctx.now.toISOString(),
    kind,
    periodKey,
    from: range.fromKey,
    to: range.toKey,
    cashAccounts: input.cashAccounts.map((a) => ({
      cashAccountId: a.cashAccountId,
      name: a.name,
      currency: a.currency,
      balanceAtCutoff: roundMoney(D(a.balanceAtCutoff ?? a.currentBalance)).toFixed(2),
      currentBalance: roundMoney(D(a.currentBalance)).toFixed(2),
      ledgerBalance: roundMoney(D(a.ledgerBalance)).toFixed(2),
      counted: a.counted === null || a.counted === undefined ? null : roundMoney(D(a.counted)).toFixed(2),
    })),
    ledger: {
      entries: input.ledgerTotals.entries,
      debit: roundMoney(D(input.ledgerTotals.debit)).toFixed(2),
      credit: roundMoney(D(input.ledgerTotals.credit)).toFixed(2),
    },
    expenses: {
      posted: posted.length,
      postedAmount: roundMoney(posted.reduce((acc, e) => acc.plus(D(e.amount)), new Prisma.Decimal(0))).toFixed(2),
      pending: input.pendingExpenses.count,
    },
    collections: {
      unassigned: input.unassignedCollections.count,
      unassignedAmount: roundMoney(gathered.unassignedAmount).toFixed(2),
    },
    overappliedCollections: {
      count: input.overappliedCollections?.count ?? 0,
      amount: roundMoney(D(input.overappliedCollections?.amount ?? 0)).toFixed(2),
    },
    aging: summarizeAging(
      open.map((o) => ({ kind: o.kind, remaining: o.remaining, dueAt: o.dueAt })),
      range.toKey
    ),
  };
  if (kind === 'monthly') {
    snapshot.budgetVsActual = await computeBudgetVsActual(tx, periodKey);
    const weeks = Math.min(6, Math.ceil((daysBetweenKeys(range.fromKey, range.toKey) + 1) / 7) + 1);
    snapshot.projectedVsRealized = await computeCashflowProjection(tx, {
      fromKey: range.fromKey,
      weeks,
      currency: 'MXN',
      todayKey: range.toKey,
      asOfKey: range.toKey,
    });
  }
  return snapshot;
}

async function upsertClose(
  tx: Db,
  existing: PeriodClose | null,
  kind: PeriodCloseKind,
  periodKey: string,
  data: Omit<Prisma.PeriodCloseCreateInput, 'kind' | 'periodKey'>
): Promise<PeriodClose> {
  if (!existing) {
    try {
      return await tx.periodClose.create({ data: { ...data, kind, periodKey } });
    } catch (err) {
      // Another close of the same period created the row first: retry (the engine re-runs the command).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConcurrencyConflict();
      throw err;
    }
  }
  const updated = await tx.periodClose.updateMany({
    where: { id: existing.id, version: existing.version },
    data: { ...(data as Prisma.PeriodCloseUpdateManyMutationInput), version: { increment: 1 } },
  });
  if (updated.count !== 1) throw new ConcurrencyConflict();
  return tx.periodClose.findUniqueOrThrow({ where: { id: existing.id } });
}

async function runCloseInTx(
  tx: Db,
  kind: PeriodCloseKind,
  periodKey: string,
  counts: ReadonlyArray<{ cashAccountId: string; counted: Prisma.Decimal }>,
  ctx: CommandContext
): Promise<CloseResultData> {
  assertCloseKey(kind, periodKey);
  // Exclusive against every posting dated in the period (they hold it shared): the checks,
  // the snapshot and the `closed` status see a ledger nobody is writing into.
  await lockAdvisoryKeys(tx, [closeLockKey(kind, periodKey)]);
  const existing = await tx.periodClose.findFirst({ where: { periodKey, kind } });
  assertCloseTransition(existing?.status ?? null, 'close');
  const gathered = await gatherInputs(tx, kind, periodKey, counts);
  const checks = evaluateCloseChecks(gathered.input);
  const closed = canClose(checks);
  const summary = closeSummary(checks);
  let row: PeriodClose;
  if (closed) {
    const snapshot = await buildSnapshot(tx, kind, periodKey, gathered, ctx);
    row = await upsertClose(tx, existing, kind, periodKey, {
      status: 'closed',
      closedByUserId: actorUserIdOf(ctx),
      closedAt: ctx.now,
      snapshot: toOperationalJson(snapshot),
      checks: toOperationalJson(checks),
    });
    ctx.emit(
      FINANCE_EVENTS.period.closed,
      { closeId: row.id, kind, periodKey, summary },
      financeEventOptions(FINANCE_OBJECT_TYPES.periodClose, row.id)
    );
  } else {
    row = await upsertClose(tx, existing, kind, periodKey, {
      status: existing?.status === 'reopened' ? 'reopened' : 'open',
      checks: toOperationalJson(checks),
    });
    ctx.emit(
      FINANCE_EVENTS.period.closeBlocked,
      {
        closeId: row.id,
        kind,
        periodKey,
        summary,
        failed: checks.filter((c) => c.blocking && !c.ok).map((c) => ({ key: c.key, detail: c.detail })),
      },
      financeEventOptions(FINANCE_OBJECT_TYPES.periodClose, row.id)
    );
  }
  publishBoard(ctx, 'finance.close', { closeId: row.id, kind, periodKey, status: row.status });
  return { closeId: row.id, kind, periodKey, status: row.status, closed, checks, summary };
}

export async function runDailyCloseInTx(
  tx: Db,
  input: z.output<typeof dailyCloseSchema>,
  ctx: CommandContext
): Promise<CloseResultData> {
  if (compareKeys(input.date, todayKeyOf(ctx)) > 0) {
    throw financeError('invalid_payload', 'No se cierra un día que aún no llega');
  }
  const month = await tx.periodClose.findFirst({
    where: { periodKey: periodKeyOfKey(input.date), kind: 'monthly', status: 'closed' },
    select: { id: true },
  });
  if (month) throw financeError('period_closed', `El mes ${periodKeyOfKey(input.date)} ya está cerrado`);
  return runCloseInTx(tx, 'daily', input.date, input.counts.map((c) => ({ ...c, counted: roundMoney(c.counted) })), ctx);
}

export async function runMonthlyCloseInTx(
  tx: Db,
  input: z.output<typeof monthlyCloseSchema>,
  ctx: CommandContext
): Promise<CloseResultData> {
  const { endKey } = periodBounds(input.periodKey);
  if (compareKeys(endKey, todayKeyOf(ctx)) >= 0) {
    throw financeError('invalid_state', `El mes ${input.periodKey} aún no termina`);
  }
  return runCloseInTx(tx, 'monthly', input.periodKey, input.counts.map((c) => ({ ...c, counted: roundMoney(c.counted) })), ctx);
}

export async function reopenPeriodInTx(
  tx: Db,
  input: z.output<typeof reopenPeriodSchema>,
  ctx: CommandContext
): Promise<{ closeId: string; kind: string; periodKey: string; status: string }> {
  assertCloseKey(input.kind, input.periodKey);
  const reason = assertReopenReason(input.reason);
  await lockAdvisoryKeys(tx, [closeLockKey(input.kind, input.periodKey)]);
  const existing = await tx.periodClose.findFirst({ where: { periodKey: input.periodKey, kind: input.kind } });
  assertCloseTransition(existing?.status ?? null, 'reopen');
  const row = await upsertClose(tx, existing, input.kind, input.periodKey, { status: 'reopened', reopenReason: reason });
  ctx.emit(
    FINANCE_EVENTS.period.reopened,
    {
      closeId: row.id,
      kind: row.kind,
      periodKey: row.periodKey,
      reason,
      closedAt: existing?.closedAt ? existing.closedAt.toISOString() : null,
      closedByUserId: existing?.closedByUserId ?? null,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.periodClose, row.id)
  );
  ctx.audit({
    action: 'finance.period.reopened',
    targetType: FINANCE_OBJECT_TYPES.periodClose,
    targetId: row.id,
    metadata: { kind: row.kind, periodKey: row.periodKey, reason },
  });
  publishBoard(ctx, 'finance.close', { closeId: row.id, kind: row.kind, periodKey: row.periodKey, status: row.status });
  return { closeId: row.id, kind: row.kind, periodKey: row.periodKey, status: row.status };
}

/** The last day not closed yet before `todayKey` (for the reminder), or null. */
export function yesterdayKeyOf(todayKey: string): string {
  return dateKeyOf(new Date(toDbDate(todayKey).getTime() - 86_400_000));
}
