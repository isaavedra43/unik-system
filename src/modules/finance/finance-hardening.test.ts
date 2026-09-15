import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hardening of the internal accounting on FakePrisma (review of phase 4):
 * a Zoho payment is serialized and never applied beyond its amount, postings
 * and closes serialize on advisory locks, closes read balances and AR/AP at
 * their cut-off date, reversed payroll payments reopen the payroll, manual
 * payables and cash-outs follow the approval policies, voided payments are
 * reviewed, payroll/purchase payables are never written off, a reversed
 * collection waits for a person and the opening balance of a cash account is
 * an entry.
 *
 * FakePrisma has no isolation nor rollback: races are reproduced with a stale
 * read injected into the transaction client.
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

import { decideApproval } from '@/modules/operations/approvals-service';
import { executeCommand, registerCommand } from '@/modules/operations/commands';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { advisoryLocksOf } from '@/modules/operations/testing/fixtures';
import { ledgerBalanceOf } from './cashflow-service';
import { ensureFinanceSeed } from './catalog-service';
import { applyPaymentInTx, listOverappliedPayments, reconcileCollections } from './collections-service';
import { runDailyCloseInTx } from './close-service';
import {
  createCashAccount,
  createEmployee,
  createManualObligation,
  createPayrollObligations,
  createPayrollRun,
  matchPaymentToObligation,
  payPayrollLine,
  postManualEntry,
  requestPaymentAuthorization,
  reverseSettlement,
  runDailyClose,
  runMonthlyClose,
  submitPayrollRun,
  writeOffObligation,
} from './finance-commands';
import { invalidateFinanceSettingsCache } from './finance-config';
import { settleObligation, createObligation, type CreateObligationInput } from './obligations-service';
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
  seedSalesOrderCase,
  type FinanceTeam,
} from './testing/finance-fixtures';
import { FINANCE_COMMANDS } from './types';

const { fake } = mocks;
const NOW = FINANCE_TEST_NOW;
const tx = fake.client as unknown as Prisma.TransactionClient;
let team: FinanceTeam;
let seq = 0;
const opts = () => ({ commandId: `hard-${++seq}`, now: NOW });
const cash = (key: string) => byKey(fake, 'cashAccount', key);
const cat = (key: string) => byKey(fake, 'financeCategory', key).id as string;
const receivableOf = (zohoSalesOrderId: string) =>
  fake.rows('obligation').find((o) => o.zohoSalesOrderId === zohoSalesOrderId && o.kind === 'receivable')!;

/** Proxy of an object whose methods stay bound to the original (overrides win). */
function overlay<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = Reflect.get(obj, prop);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}

/** Transaction client whose first read of the applied amounts of a payment misses what another transaction committed. */
function staleAppliedClient(): Prisma.TransactionClient {
  let stale = true;
  const real = fake.client.obligationSettlement as unknown as { findMany: (args: unknown) => Promise<unknown> };
  const settlements = overlay(real, {
    findMany: async (args: { where?: { zohoPaymentId?: unknown } }) => {
      if (stale && args?.where?.zohoPaymentId) {
        stale = false;
        return [];
      }
      return real.findMany(args);
    },
  });
  return overlay(fake.client as object, { obligationSettlement: settlements }) as Prisma.TransactionClient;
}

async function approvePayrollForTest(payrollRunId: string) {
  const submitted = await submitPayrollRun(team.admin, { payrollRunId }, opts());
  const approvalRequestId = submitted.data!.approvalRequestId;
  await decideApproval(team.approver, { approvalRequestId, decision: 'approve' }, { commandId: `p1-${payrollRunId}`, now: NOW });
  await decideApproval(team.approver2, { approvalRequestId, decision: 'approve' }, { commandId: `p2-${payrollRunId}`, now: NOW });
}

registerCommand<{ zohoPaymentId: string; obligationId: string; amount: string }, unknown>('test.finance.apply_stale', {
  schema: z.object({ zohoPaymentId: z.string(), obligationId: z.string(), amount: z.string() }),
  aggregate: 'none',
  actorTypes: ['system'],
  async handler(_tx, cmd, ctx) {
    const result = await applyPaymentInTx(
      staleAppliedClient(),
      { zohoPaymentId: cmd.payload.zohoPaymentId, allocations: [{ obligationId: cmd.payload.obligationId, amount: new Prisma.Decimal(cmd.payload.amount) }] },
      ctx,
      { manual: false }
    );
    return { data: result };
  },
});

/** A second close of the same day that did not see the row the first one created (P2002 on insert). */
registerCommand<{ date: string }, unknown>('test.finance.close_race', {
  schema: z.object({ date: z.string() }),
  aggregate: 'none',
  actorTypes: ['system'],
  async handler(_tx, cmd, ctx) {
    const periodClose = overlay(fake.client.periodClose as object, { findFirst: async () => null });
    const blind = overlay(fake.client as object, { periodClose }) as Prisma.TransactionClient;
    return { data: await runDailyCloseInTx(blind, { date: cmd.payload.date, counts: [] }, ctx) };
  },
});

registerCommand<Record<string, unknown>, unknown>('test.finance.payable', {
  schema: z.record(z.unknown()),
  aggregate: 'none',
  actorTypes: ['system'],
  async handler(innerTx, cmd, ctx) {
    const obligation = await createObligation(innerTx, cmd.payload as CreateObligationInput, ctx);
    return { data: { obligationId: obligation.id } };
  },
});

async function expectCase(caseId: string) {
  return executeCommand(
    {
      commandId: `finance:expect_case:${caseId}`,
      type: FINANCE_COMMANDS.collectionExpectCase,
      actor: { type: 'system', id: 'finance' },
      aggregate: { type: 'operational_case', id: caseId },
      payload: { caseId },
    },
    null,
    { now: NOW }
  );
}

function income(date: string, amount: string, account = 'caja_general') {
  return postManualEntry(
    team.admin,
    {
      kind: 'income',
      date,
      description: 'Venta de mostrador',
      lines: [
        { accountType: 'cash', accountId: cash(account).id, debit: amount },
        { accountType: 'category', accountId: cat('otros_ingresos'), credit: amount },
      ],
    },
    opts()
  );
}

beforeEach(async () => {
  await resetFinanceFake(fake);
  advisoryLocksOf(fake, { clear: true });
  invalidateOperationsConfigCache();
  invalidateFinanceSettingsCache();
  seedOperationsConfig(fake);
  team = seedFinanceTeam(fake);
  await ensureFinanceSeed(tx);
});

describe('a Zoho payment is applied at most once', () => {
  it('serializes on the payment and rejects an application that a concurrent one already consumed', async () => {
    seedSalesOrderCase(fake, { caseId: 'case-a', zohoSalesOrderId: 'SO-A', total: '100', zohoCustomerId: 'C1', orderDate: '2026-09-01' });
    seedSalesOrderCase(fake, { caseId: 'case-b', zohoSalesOrderId: 'SO-B', total: '100', zohoCustomerId: 'C1', orderDate: '2026-09-02' });
    await expectCase('case-a');
    await expectCase('case-b');
    seedCustomerPayment(fake, { zohoPaymentId: 'P-1', amount: '100', zohoCustomerId: 'C1', date: '2026-09-10' });

    const first = await matchPaymentToObligation(
      team.admin,
      { zohoPaymentId: 'P-1', allocations: [{ obligationId: receivableOf('SO-A').id, amount: '100' }] },
      opts()
    );
    expect(first.status).toBe('completed');
    expect(advisoryLocksOf(fake)).toEqual(expect.arrayContaining([{ key: 'finance:zoho_payment:P-1', mode: 'exclusive' }]));

    // The reconciler read "nothing applied" before the person's settlement committed.
    const race = await executeCommand(
      {
        commandId: 'race-1',
        type: 'test.finance.apply_stale',
        actor: { type: 'system', id: 'finance' },
        aggregate: { type: 'customer_payment', id: 'P-1' },
        payload: { zohoPaymentId: 'P-1', obligationId: receivableOf('SO-B').id, amount: '100' },
      },
      null,
      { now: NOW }
    );
    expect(race).toMatchObject({ status: 'rejected', errorCode: 'payment_overapplied' });
  });
});

describe('postings and closes serialize on the period', () => {
  it('a posting holds its month and day shared; a close holds its key exclusive; a lost insert race retries', async () => {
    await income('2026-09-15', '10');
    expect(advisoryLocksOf(fake, { clear: true })).toEqual(
      expect.arrayContaining([
        { key: 'finance:day:2026-09-15', mode: 'shared' },
        { key: 'finance:period:2026-09', mode: 'shared' },
      ])
    );
    await runDailyClose(team.admin, { date: '2026-09-15', counts: [{ cashAccountId: cash('caja_general').id, counted: '10' }] }, opts());
    expect(advisoryLocksOf(fake, { clear: true })).toEqual([{ key: 'finance:day:2026-09-15', mode: 'exclusive' }]);
    await runMonthlyClose(team.admin, { periodKey: '2026-08' }, opts());
    expect(advisoryLocksOf(fake, { clear: true })).toEqual(
      expect.arrayContaining([{ key: 'finance:period:2026-08', mode: 'exclusive' }])
    );

    const race = await executeCommand(
      {
        commandId: 'close-race',
        type: 'test.finance.close_race',
        actor: { type: 'system', id: 'finance' },
        aggregate: { type: 'period_close', id: 'daily:2026-09-15' },
        payload: { date: '2026-09-15' },
      },
      null,
      { now: NOW }
    );
    expect(race).toMatchObject({ status: 'rejected', errorCode: 'concurrency_conflict' });
  });
});

describe('closes read their cut-off date', () => {
  it('a day closed the next morning counts against that day, not against later movements', async () => {
    await income('2026-09-14', '250');
    await income('2026-09-15', '500');
    const closed = await runDailyClose(
      team.admin,
      { date: '2026-09-14', counts: [{ cashAccountId: cash('caja_general').id, counted: '250' }] },
      opts()
    );
    expect(closed.data).toMatchObject({ closed: true });
    const count = closed.data!.checks.find((c) => c.key === `cash_count:${cash('caja_general').id}`)!;
    expect(count).toMatchObject({ ok: true, data: { counted: '250.00', balanceAtCutoff: '250.00', currentBalance: '750.00' } });
    const integrity = closed.data!.checks.find((c) => c.key === `cash_integrity:${cash('caja_general').id}`)!;
    expect(integrity.ok).toBe(true);
  });

  it('a month closed later stores the balances and the aging of its last day', async () => {
    await income('2026-08-10', '1000');
    seedSalesOrderCase(fake, { caseId: 'case-aug', zohoSalesOrderId: 'SO-AUG', total: '300', zohoCustomerId: 'C2', orderDate: '2026-08-01' });
    // Recognized in August (dated entry) and still open.
    await executeCommand(
      {
        commandId: 'aug-receivable',
        type: 'test.finance.payable',
        actor: { type: 'system', id: 'finance' },
        aggregate: { type: 'obligation', id: 'aug' },
        payload: {
          kind: 'receivable',
          counterpartyType: 'customer',
          counterpartyName: 'Cliente agosto',
          description: 'Venta de agosto',
          expectedAmount: '300',
          dueAt: '2026-08-20',
          date: '2026-08-05',
        },
      },
      null,
      { now: NOW }
    );
    // September: more cash and a new receivable that did not exist on August 31.
    await income('2026-09-02', '4000');
    await expectCase('case-aug');

    const closed = await runMonthlyClose(team.admin, { periodKey: '2026-08' }, opts());
    expect(closed.data).toMatchObject({ closed: true });
    const snapshot = rowById(fake, 'periodClose', closed.data!.closeId).snapshot as {
      cashAccounts: Array<{ name: string; balanceAtCutoff: string; currentBalance: string }>;
      aging: { receivable: Record<string, string> };
      projectedVsRealized: { openingBalance: string };
    };
    expect(snapshot.cashAccounts.find((a) => a.name === 'Caja general')).toMatchObject({
      balanceAtCutoff: '1000.00',
      currentBalance: '5000.00',
    });
    expect(snapshot.aging.receivable.total).toBe('300.00');
    expect(snapshot.aging.receivable.d1_30).toBe('300.00');
    expect(snapshot.projectedVsRealized.openingBalance).toBe('1000.00');
  });
});

describe('reversing a payroll payment reopens the payroll', () => {
  it('the line owes again, the run goes back to obligations_created and is paid again through payroll', async () => {
    const ana = await createEmployee(team.admin, { name: 'Ana López' }, opts());
    const employeeId = ana.data!.employeeId;
    const created = await createPayrollRun(team.admin, { periodStart: '2026-09-01', periodEnd: '2026-09-15', lines: [{ employeeId, gross: '2000' }] }, opts());
    const payrollRunId = created.data!.payrollRunId;
    await approvePayrollForTest(payrollRunId);
    const obligations = await createPayrollObligations(team.admin, { payrollRunId }, opts());
    const obligationId = obligations.data!.obligationIds[0];
    const paid = await payPayrollLine(team.admin, { payrollRunId, employeeId, cashAccountId: cash('banco_zoho').id }, opts());
    expect(paid.data).toMatchObject({ runStatus: 'paid' });

    const reversed = await reverseSettlement(
      team.admin,
      { obligationId, settlementId: paid.data!.settlementId, reason: 'Se pagó desde la cuenta equivocada' },
      opts()
    );
    expect(reversed.data).toMatchObject({ status: 'expected', paymentWorkItemId: null });
    expect(rowById(fake, 'payrollRun', payrollRunId).status).toBe('obligations_created');
    expect(fake.rows('payrollLine').find((l) => l.payrollRunId === payrollRunId)!.status).toBe('pending');
    expect(eventsOf(fake, 'finance.payroll.reopened')).toHaveLength(1);
    expect(eventsOf(fake, 'finance.payroll.line_unpaid')).toHaveLength(1);

    const again = await payPayrollLine(team.admin, { payrollRunId, employeeId, cashAccountId: cash('caja_general').id }, opts());
    expect(again.data).toMatchObject({ runStatus: 'paid' });
  });
});

describe('approval policies cannot be bypassed', () => {
  it('a manual payable is paid only after its payment authorization by another person', async () => {
    const created = await createManualObligation(
      team.admin,
      { kind: 'payable', counterpartyType: 'supplier', counterpartyName: 'Proveedor X', description: 'Anticipo por fuera', expectedAmount: '500000' },
      opts()
    );
    const obligationId = created.data!.obligationId;
    const bank = cash('banco_zoho').id;
    const early = await settleObligation(team.admin, { obligationId, amount: '500000', cashAccountId: bank }, opts());
    expect(early).toMatchObject({ status: 'rejected', errorCode: 'payment_not_authorized' });

    const auth = await requestPaymentAuthorization(team.admin, { obligationId }, opts());
    expect(auth.data).toMatchObject({ status: 'pending', requiredApprovals: 2 });
    const self = await decideApproval(team.admin, { approvalRequestId: auth.data!.approvalRequestId, decision: 'approve' }, { commandId: 'self', now: NOW });
    expect(self.status).toBe('rejected');
    await decideApproval(team.approver, { approvalRequestId: auth.data!.approvalRequestId, decision: 'approve' }, { commandId: 'a1', now: NOW });
    const oneSignature = await settleObligation(team.admin, { obligationId, amount: '1', cashAccountId: bank }, opts());
    expect(oneSignature).toMatchObject({ status: 'rejected', errorCode: 'payment_not_authorized' });
    await decideApproval(team.approver2, { approvalRequestId: auth.data!.approvalRequestId, decision: 'approve' }, { commandId: 'a2', now: NOW });
    const paid = await settleObligation(team.admin, { obligationId, amount: '500000', cashAccountId: bank }, opts());
    expect(paid.data).toMatchObject({ status: 'settled' });
  });

  it('a manual entry that takes money out of cash above the expense auto-approval threshold is rejected', async () => {
    await income('2026-09-15', '10000');
    const big = await postManualEntry(
      team.admin,
      {
        kind: 'expense',
        date: '2026-09-15',
        description: 'Retiro grande',
        lines: [
          { accountType: 'category', accountId: cat('papeleria'), debit: '5000' },
          { accountType: 'cash', accountId: cash('caja_general').id, credit: '5000' },
        ],
      },
      opts()
    );
    expect(big).toMatchObject({ status: 'rejected', errorCode: 'approval_required' });
    const equity = await postManualEntry(
      team.admin,
      {
        kind: 'adjustment',
        date: '2026-09-15',
        description: 'Retiro del socio',
        lines: [
          { accountType: 'equity', accountId: 'retiros_socios', debit: '9000' },
          { accountType: 'cash', accountId: cash('caja_general').id, credit: '9000' },
        ],
      },
      opts()
    );
    expect(equity).toMatchObject({ status: 'rejected', errorCode: 'approval_required' });
    const small = await postManualEntry(
      team.admin,
      {
        kind: 'adjustment',
        date: '2026-09-15',
        description: 'Diferencia de arqueo',
        lines: [
          { accountType: 'category', accountId: cat('gastos_generales'), debit: '35' },
          { accountType: 'cash', accountId: cash('caja_general').id, credit: '35' },
        ],
      },
      opts()
    );
    expect(small.status).toBe('completed');
    const transfer = await postManualEntry(
      team.admin,
      {
        kind: 'transfer',
        date: '2026-09-15',
        description: 'Depósito al banco',
        lines: [
          { accountType: 'cash', accountId: cash('banco_zoho').id, debit: '9000' },
          { accountType: 'cash', accountId: cash('caja_general').id, credit: '9000' },
        ],
      },
      opts()
    );
    expect(transfer.status).toBe('completed');
  });
});

describe('payments voided or reduced in Zoho after being applied', () => {
  it('opens one review work item and blocks the monthly close until it is solved', async () => {
    seedSalesOrderCase(fake, { caseId: 'case-v', zohoSalesOrderId: 'SO-V', total: '800', zohoCustomerId: 'C3', orderDate: '2026-08-02' });
    await expectCase('case-v');
    const payment = seedCustomerPayment(fake, { zohoPaymentId: 'P-V', amount: '800', zohoCustomerId: 'C3', date: '2026-08-20', paymentNumber: 'PAGO-V', customerName: 'Cliente V' });
    const applied = await reconcileCollections({ now: NOW });
    expect(applied).toMatchObject({ settlements: 1, overapplied: 0 });

    payment.status = 'void';
    expect(await listOverappliedPayments(tx)).toEqual([
      expect.objectContaining({ zohoPaymentId: 'P-V', issue: 'void', applied: '800.00', excess: '800.00', openWorkItemId: null }),
    ]);
    const summary = await reconcileCollections({ now: NOW });
    expect(summary).toMatchObject({ overapplied: 1, errors: 0 });
    const items = fake.rows('workItem').filter((w) => w.objectType === 'customer_payment' && w.objectId === 'P-V');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Revisar cobro anulado en Zoho: PAGO-V de Cliente V');
    expect(eventsOf(fake, 'finance.collection.overapplied')).toHaveLength(1);
    expect((await reconcileCollections({ now: NOW })).overapplied).toBe(0);
    expect(fake.rows('workItem').filter((w) => w.objectId === 'P-V')).toHaveLength(1);

    const blocked = await runMonthlyClose(team.admin, { periodKey: '2026-08' }, opts());
    expect(blocked.data).toMatchObject({ closed: false });
    expect(blocked.data!.checks.find((c) => c.key === 'overapplied_collections')).toMatchObject({ ok: false, blocking: true });

    // Reduced instead of voided: only the excess is reported.
    payment.status = 'paid';
    payment.amount = D('500');
    expect(await listOverappliedPayments(tx)).toEqual([expect.objectContaining({ issue: 'over_applied', excess: '300.00' })]);
  });
});

describe('payroll and purchase payables are never written off', () => {
  it('rejects the write-off and points to their own flow', async () => {
    const po = await executeCommand<{ obligationId: string }>(
      {
        commandId: 'po-payable',
        type: 'test.finance.payable',
        actor: { type: 'system', id: 'purchases' },
        aggregate: { type: 'procurement_order', id: 'po-9' },
        payload: { kind: 'payable', counterpartyType: 'supplier', counterpartyName: 'Aceros', procurementOrderId: 'po-9', description: 'OC-9', expectedAmount: '900' },
      },
      null,
      { now: NOW }
    );
    const poWriteOff = await writeOffObligation(team.admin, { obligationId: po.data!.obligationId, reason: 'Ya no se pagará' }, opts());
    expect(poWriteOff).toMatchObject({ status: 'rejected', errorCode: 'domain_entry' });
    expect(poWriteOff.message).toContain('orden de compra');

    const ana = await createEmployee(team.admin, { name: 'Ana López' }, opts());
    const created = await createPayrollRun(team.admin, { periodStart: '2026-09-01', periodEnd: '2026-09-15', lines: [{ employeeId: ana.data!.employeeId, gross: '1500' }] }, opts());
    await approvePayrollForTest(created.data!.payrollRunId);
    const obligations = await createPayrollObligations(team.admin, { payrollRunId: created.data!.payrollRunId }, opts());
    const payrollWriteOff = await writeOffObligation(team.admin, { obligationId: obligations.data!.obligationIds[0], reason: 'Renunció sin cobrar' }, opts());
    expect(payrollWriteOff).toMatchObject({ status: 'rejected', errorCode: 'domain_entry' });
    expect(payrollWriteOff.message).toContain('nómina');
    expect(fake.rows('ledgerEntry').filter((e) => e.kind === 'adjustment')).toHaveLength(0);
  });
});

describe('a reversed collection waits for a person', () => {
  it('opens "Asignar cobro", the reconciler skips it, and a person reassigns it', async () => {
    seedSalesOrderCase(fake, { caseId: 'case-r1', zohoSalesOrderId: 'SO-R1', total: '600', zohoCustomerId: 'C4', orderDate: '2026-09-01' });
    seedSalesOrderCase(fake, { caseId: 'case-r2', zohoSalesOrderId: 'SO-R2', total: '600', zohoCustomerId: 'C4', orderDate: '2026-09-03' });
    await expectCase('case-r1');
    await expectCase('case-r2');
    seedCustomerPayment(fake, { zohoPaymentId: 'P-R', amount: '600', zohoCustomerId: 'C4', date: '2026-09-12', paymentNumber: 'PAGO-R' });
    await matchPaymentToObligation(team.admin, { zohoPaymentId: 'P-R', allocations: [{ obligationId: receivableOf('SO-R1').id, amount: '600' }] }, opts());
    const settlement = fake.rows('obligationSettlement').find((s) => s.zohoPaymentId === 'P-R')!;

    const reversed = await reverseSettlement(
      team.admin,
      { obligationId: receivableOf('SO-R1').id, settlementId: settlement.id, reason: 'Era el pago de la otra orden' },
      opts()
    );
    const workItemId = reversed.data!.paymentWorkItemId!;
    expect(rowById(fake, 'workItem', workItemId)).toMatchObject({ title: 'Asignar cobro PAGO-R de Cliente C4', status: 'open' });
    expect(eventsOf(fake, 'finance.collection.held')).toHaveLength(1);

    const summary = await reconcileCollections({ now: NOW });
    expect(summary).toMatchObject({ held: 1, payments: 0, settlements: 0 });
    expect(fake.rows('obligationSettlement').filter((s) => s.zohoPaymentId === 'P-R')).toHaveLength(2);

    const assigned = await matchPaymentToObligation(
      team.admin,
      { zohoPaymentId: 'P-R', allocations: [{ obligationId: receivableOf('SO-R2').id, amount: '600' }] },
      opts()
    );
    expect(assigned.data).toMatchObject({ remaining: '0.00', completedWorkItemIds: [workItemId] });
    expect(receivableOf('SO-R2').status).toBe('settled');
    expect(receivableOf('SO-R1').status).toBe('expected');
  });
});

describe('opening balance of a cash account', () => {
  it('is an adjustment entry against equity, so the ledger alone explains the balance', async () => {
    const created = await createCashAccount(team.admin, { key: 'caja_chica', name: 'Caja chica', kind: 'petty_cash', openingBalance: '1500' }, opts());
    expect(created.data).toMatchObject({ openingBalance: '1500.00', currentBalance: '1500.00' });
    const account = byKey(fake, 'cashAccount', 'caja_chica');
    const entry = fake.rows('ledgerEntry').find((e) => e.kind === 'adjustment')!;
    expect(linesOf(fake, entry.id)).toEqual([
      ['cash', account.id, '1500.00', '0.00', null],
      ['equity', 'saldo_inicial', '0.00', '1500.00', null],
    ]);
    expect((await ledgerBalanceOf(tx, { id: account.id as string })).toFixed(2)).toBe('1500.00');
    const zero = await createCashAccount(team.admin, { key: 'tarjeta', name: 'Tarjeta', kind: 'card' }, opts());
    expect(zero.data).toMatchObject({ currentBalance: '0.00' });
    expect(fake.rows('ledgerEntry').filter((e) => e.kind === 'adjustment')).toHaveLength(1);
  });
});
