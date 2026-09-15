import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ledger and closes on FakePrisma (plan 9.1): an unbalanced entry is
 * rejected, the monthly close is blocked by pending expenses and unassigned
 * collections, closes with a snapshot once they are resolved, rejects entries
 * of the closed month, lets a reversal of a closed-month entry be dated in the
 * open period, reopens with a reason and runs the daily close with a cash
 * count.
 */

const mocks = await vi.hoisted(async () => {
  const { createFinanceFake } = await import('./testing/finance-fixtures');
  return {
    fake: createFinanceFake(),
    notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({ id: '1', channel: '', type: '', payload: {}, createdAt: '' })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/auth/permissions')>();
  const { withFinancePermissions } = await import('./testing/finance-permissions');
  return withFinancePermissions(actual);
});
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  wakeJobWorker: vi.fn(),
  registerJobHandler: vi.fn(),
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: vi.fn() }));
vi.mock('@/modules/operations/case-service', () => ({ onCaseStarted: vi.fn(() => () => undefined) }));
vi.mock('@/modules/ai/ai-client', () => ({ chatCompletion: vi.fn() }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({})) }));
vi.mock('@/modules/ai/ai-attachments-service', () => ({ processAttachment: vi.fn() }));
vi.mock('@/modules/ai/json-utils', () => ({ parseJsonObject: vi.fn() }));

import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { getCashBook, getBudgetVsActual, getCashflowProjection } from './cashflow-service';
import { ensureFinanceSeed } from './catalog-service';
import {
  captureExpense,
  postManualEntry,
  recordUnexpectedCollection,
  rejectExpense,
  reopenPeriod,
  reverseEntry,
  runDailyClose,
  runMonthlyClose,
  setBudget,
} from './finance-commands';
import { invalidateFinanceSettingsCache } from './finance-config';
import { getFinanceBoardSummary, listLedgerEntries, listPeriodCloses } from './finance-queries';
import {
  byKey,
  D,
  eventsOf,
  FINANCE_TEST_NOW,
  linesOf,
  resetFinanceFake,
  rowById,
  seedCustomerPayment,
  seedFinanceTeam,
  seedOperationsConfig,
  type FinanceTeam,
} from './testing/finance-fixtures';

const { fake } = mocks;
const NOW = FINANCE_TEST_NOW;
const tx = fake.client as unknown as Prisma.TransactionClient;
let team: FinanceTeam;
let seq = 0;
const opts = () => ({ commandId: `cmd-${++seq}`, now: NOW });
const cash = (key: string) => byKey(fake, 'cashAccount', key);
const cat = (key: string) => byKey(fake, 'financeCategory', key).id as string;

beforeEach(async () => {
  await resetFinanceFake(fake);
  invalidateOperationsConfigCache();
  invalidateFinanceSettingsCache();
  seedOperationsConfig(fake);
  team = seedFinanceTeam(fake);
  await ensureFinanceSeed(tx);
});

function income(date: string, amount: string, description = 'Venta de mostrador') {
  return postManualEntry(
    team.admin,
    {
      kind: 'income',
      date,
      description,
      lines: [
        { accountType: 'cash', accountId: cash('caja_general').id, debit: amount },
        { accountType: 'category', accountId: cat('otros_ingresos'), credit: amount },
      ],
    },
    opts()
  );
}

describe('ledger', () => {
  it('rejects an unbalanced manual entry without writing anything', async () => {
    const result = await postManualEntry(
      team.admin,
      {
        kind: 'expense',
        date: '2026-09-15',
        description: 'Descuadre',
        lines: [
          { accountType: 'category', accountId: cat('papeleria'), debit: '100' },
          { accountType: 'cash', accountId: cash('caja_general').id, credit: '99.99' },
        ],
      },
      opts()
    );
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'unbalanced_entry' });
    expect(fake.rows('ledgerEntry')).toHaveLength(0);
    expect(D(cash('caja_general').currentBalance).toFixed(2)).toBe('0.00');
    const receivableByHand = await postManualEntry(
      team.admin,
      {
        kind: 'income',
        date: '2026-09-15',
        description: 'Intento directo',
        lines: [
          { accountType: 'receivable' as 'cash', accountId: 'x', debit: '1' },
          { accountType: 'cash', accountId: cash('caja_general').id, credit: '1' },
        ],
      },
      opts()
    );
    expect(receivableByHand).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
    const capturerPost = await income('2026-09-15', '1');
    expect(capturerPost.status).toBe('completed');
    const noPermission = await postManualEntry(team.capturer, { kind: 'income', date: '2026-09-15', description: 'x', lines: [] }, opts());
    expect(noPermission).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
  });
});

describe('monthly close', () => {
  it('blocks, closes with a snapshot, rejects the closed month, reverses into the open period and reopens', async () => {
    const august = await income('2026-08-10', '1000');
    expect(august.data).toMatchObject({ number: 'AS-000001', periodKey: '2026-08' });
    const draft = await captureExpense(team.capturer, { captureMode: 'form', amount: '300', date: '2026-08-20', categoryId: cat('papeleria') }, opts());
    seedCustomerPayment(fake, { zohoPaymentId: 'P-A', amount: '800', zohoCustomerId: 'CX', date: '2026-08-25', customerName: 'Cliente mostrador' });
    await setBudget(team.admin, { periodKey: '2026-08', categoryId: cat('otros_ingresos'), amount: '1500' }, opts());

    const blocked = await runMonthlyClose(team.admin, { periodKey: '2026-08' }, opts());
    expect(blocked.data).toMatchObject({ closed: false, status: 'open' });
    expect(blocked.data!.checks.filter((c) => c.blocking && !c.ok).map((c) => c.key)).toEqual(['pending_expenses', 'unassigned_collections']);
    expect(eventsOf(fake, 'finance.period.close_blocked')).toHaveLength(1);

    await rejectExpense(team.capturer, { expenseId: draft.data!.expenseId, reason: 'Capturado por error' }, opts());
    const collected = await recordUnexpectedCollection(team.admin, { zohoPaymentId: 'P-A' }, opts());
    expect(collected.status).toBe('completed');
    expect(D(cash('banco_zoho').currentBalance).toFixed(2)).toBe('800.00');

    const closed = await runMonthlyClose(team.admin, { periodKey: '2026-08' }, opts());
    expect(closed.data).toMatchObject({ closed: true, status: 'closed' });
    const close = rowById(fake, 'periodClose', closed.data!.closeId);
    expect(close).toMatchObject({ kind: 'monthly', periodKey: '2026-08', closedByUserId: 'u-conta', version: 2 });
    const snapshot = close.snapshot as {
      cashAccounts: unknown[];
      budgetVsActual: { rows: unknown[] };
      collections: Record<string, unknown>;
      projectedVsRealized: { weeks: unknown[] };
    };
    expect(snapshot.cashAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Caja general', currentBalance: '1000.00', ledgerBalance: '1000.00' }),
        expect.objectContaining({ name: 'Banco (Zoho)', currentBalance: '800.00' }),
      ])
    );
    expect(snapshot.budgetVsActual.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ categoryId: cat('otros_ingresos'), budget: '1500.00', actual: '1000.00' })])
    );
    expect(snapshot.collections).toMatchObject({ unassigned: 0 });
    expect(snapshot.projectedVsRealized.weeks.length).toBeGreaterThan(0);
    const again = await runMonthlyClose(team.admin, { periodKey: '2026-08' }, opts());
    expect(again).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });

    const late = await income('2026-08-31', '50', 'Venta olvidada');
    expect(late).toMatchObject({ status: 'rejected', errorCode: 'period_closed' });

    const intoClosed = await reverseEntry(team.admin, { entryId: august.data!.id, reason: 'Venta duplicada', date: '2026-08-31' }, opts());
    expect(intoClosed).toMatchObject({ status: 'rejected', errorCode: 'period_closed' });
    expect(rowById(fake, 'ledgerEntry', august.data!.id).reversedByEntryId).toBeNull();

    const reversal = await reverseEntry(team.admin, { entryId: august.data!.id, reason: 'Venta duplicada' }, opts());
    expect(reversal.data?.reversal).toMatchObject({ kind: 'reversal', date: '2026-09-15', periodKey: '2026-09', reversesEntryId: august.data!.id });
    expect(rowById(fake, 'ledgerEntry', august.data!.id).reversedByEntryId).toBe(reversal.data!.reversal.id);
    expect(linesOf(fake, reversal.data!.reversal.id)).toEqual([
      ['cash', cash('caja_general').id, '0.00', '1000.00', null],
      ['category', cat('otros_ingresos'), '1000.00', '0.00', null],
    ]);
    expect(D(cash('caja_general').currentBalance).toFixed(2)).toBe('0.00');
    expect((await reverseEntry(team.admin, { entryId: august.data!.id, reason: 'Otra vez' }, opts())).errorCode).toBe('already_reversed');
    expect((await reverseEntry(team.admin, { entryId: reversal.data!.reversal.id, reason: 'Deshacer' }, opts())).errorCode).toBe('not_reversible');
    const domainEntry = fake.rows('ledgerEntry').find((e) => e.sourceType === 'obligation')!;
    expect((await reverseEntry(team.admin, { entryId: domainEntry.id, reason: 'No así' }, opts())).errorCode).toBe('domain_entry');

    const short = await reopenPeriod(team.admin, { kind: 'monthly', periodKey: '2026-08', reason: 'corto' }, opts());
    expect(short).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
    const noRight = await reopenPeriod(team.approver, { kind: 'monthly', periodKey: '2026-08', reason: 'Falta registrar la renta de agosto' }, opts());
    expect(noRight).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    const reopened = await reopenPeriod(team.admin, { kind: 'monthly', periodKey: '2026-08', reason: 'Falta registrar la renta de agosto' }, opts());
    expect(reopened.data).toMatchObject({ status: 'reopened' });
    expect(rowById(fake, 'periodClose', closed.data!.closeId).reopenReason).toBe('Falta registrar la renta de agosto');
    expect(fake.rows('auditLog').some((a) => a.action === 'finance.period.reopened')).toBe(true);
    expect((await income('2026-08-31', '50', 'Venta olvidada')).status).toBe('completed');

    const current = await runMonthlyClose(team.admin, { periodKey: '2026-09' }, opts());
    expect(current).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });

    const closes = await listPeriodCloses(team.admin, { kind: 'monthly' });
    expect(closes.rows).toEqual([expect.objectContaining({ periodKey: '2026-08', status: 'reopened' })]);
  });
});

describe('daily close and reports', () => {
  it('requires the cash count, then closes the day and locks its entries', async () => {
    await income('2026-09-15', '250');
    const noCount = await runDailyClose(team.admin, { date: '2026-09-15' }, opts());
    expect(noCount.data).toMatchObject({ closed: false });
    expect(noCount.data!.checks.find((c) => c.key === `cash_count:${cash('caja_general').id}`)).toMatchObject({ ok: false, blocking: true });
    const wrongCount = await runDailyClose(team.admin, { date: '2026-09-15', counts: [{ cashAccountId: cash('caja_general').id, counted: '240' }] }, opts());
    expect(wrongCount.data).toMatchObject({ closed: false });
    const closed = await runDailyClose(team.admin, { date: '2026-09-15', counts: [{ cashAccountId: cash('caja_general').id, counted: '250' }] }, opts());
    expect(closed.data).toMatchObject({ closed: true, status: 'closed' });
    expect((await income('2026-09-15', '10')).errorCode).toBe('period_closed');
    expect((await income('2026-09-14', '10')).status).toBe('completed');
    expect((await runDailyClose(team.admin, { date: '2026-09-16' }, opts())).errorCode).toBe('invalid_payload');
  });

  it('serves the cash book, the projection, budget vs actual and the board', async () => {
    await income('2026-09-01', '1000');
    await postManualEntry(
      team.admin,
      {
        kind: 'transfer',
        date: '2026-09-02',
        description: 'Depósito al banco',
        lines: [
          { accountType: 'cash', accountId: cash('banco_zoho').id, debit: '600' },
          { accountType: 'cash', accountId: cash('caja_general').id, credit: '600' },
        ],
      },
      opts()
    );
    await postManualEntry(
      team.admin,
      {
        kind: 'expense',
        date: '2026-09-10',
        description: 'Papelería',
        lines: [
          { accountType: 'category', accountId: cat('papeleria'), debit: '150', costCenterId: byKey(fake, 'costCenter', 'cc_administracion').id },
          { accountType: 'cash', accountId: cash('caja_general').id, credit: '150' },
        ],
      },
      opts()
    );
    const book = await getCashBook(team.admin, { cashAccountId: cash('caja_general').id, from: '2026-09-01', to: '2026-09-30' }, { now: NOW });
    expect(book).toMatchObject({ openingBalance: '0.00', closingBalance: '250.00', totalIn: '1000.00', totalOut: '750.00', total: 3 });
    expect(book.rows.map((r) => [r.date, r.debit, r.credit, r.balance])).toEqual([
      ['2026-09-01', '1000.00', '0.00', '1000.00'],
      ['2026-09-02', '0.00', '600.00', '400.00'],
      ['2026-09-10', '0.00', '150.00', '250.00'],
    ]);
    const projection = await getCashflowProjection(team.admin, { from: '2026-09-01', weeks: 3 }, { now: NOW });
    expect(projection.weeks[0]).toMatchObject({ weekStart: '2026-08-31', realizedIn: '1000.00', realizedOut: '0.00' });
    expect(projection.weeks[1]).toMatchObject({ realizedOut: '150.00' });
    await setBudget(team.admin, { periodKey: '2026-09', categoryId: cat('papeleria'), amount: '100' }, opts());
    const budget = await getBudgetVsActual(team.admin, { periodKey: '2026-09' });
    expect(budget.rows.find((r) => r.categoryId === cat('papeleria'))).toMatchObject({ budget: '100.00', actual: '150.00', variance: '-50.00', usedPct: 150 });
    const board = await getFinanceBoardSummary(team.admin, { now: NOW });
    expect(board.cash).toEqual([{ currency: 'MXN', balance: '850.00', accounts: 2 }]);
    const entries = await listLedgerEntries(team.admin, { periodKey: '2026-09', pageSize: 2 });
    expect(entries).toMatchObject({ total: 3, pageCount: 2 });
    await expect(getCashBook(team.capturer, { cashAccountId: cash('caja_general').id })).rejects.toThrow('No tienes permisos');
  });
});
