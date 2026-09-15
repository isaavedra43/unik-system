import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Payroll on FakePrisma (plan 9.1): employees, an advance, a run with
 * withholdings and an applied advance → two signatures → one payable per
 * employee in a single balanced payroll entry → payments line by line →
 * paid → closed; cancelling a run with obligations gives the advance back.
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
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { ensureFinanceSeed } from './catalog-service';
import {
  cancelPayrollRun,
  closePayrollRun,
  createEmployee,
  createPayrollObligations,
  createPayrollRun,
  grantEmployeeAdvance,
  payPayrollLine,
  submitPayrollRun,
} from './finance-commands';
import { invalidateFinanceSettingsCache } from './finance-config';
import { assertBalanced } from './ledger-rules';
import {
  byKey,
  D,
  eventsOf,
  FINANCE_TEST_NOW,
  linesOf,
  resetFinanceFake,
  rowById,
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
const run = (id: string) => rowById(fake, 'payrollRun', id);

beforeEach(async () => {
  await resetFinanceFake(fake);
  invalidateOperationsConfigCache();
  invalidateFinanceSettingsCache();
  seedOperationsConfig(fake);
  team = seedFinanceTeam(fake);
  await ensureFinanceSeed(tx);
});

async function approveRun(payrollRunId: string) {
  const submitted = await submitPayrollRun(team.admin, { payrollRunId }, opts());
  expect(submitted.data).toMatchObject({ status: 'pending_approval', requiredApprovals: 2 });
  const approvalRequestId = submitted.data!.approvalRequestId;
  const first = await decideApproval(team.approver, { approvalRequestId, decision: 'approve' }, { commandId: `v1-${payrollRunId}`, now: NOW });
  expect(first.data?.status).toBe('pending');
  expect(run(payrollRunId).status).toBe('pending_approval');
  const second = await decideApproval(team.approver2, { approvalRequestId, decision: 'approve' }, { commandId: `v2-${payrollRunId}`, now: NOW });
  expect(second.data?.status).toBe('approved');
  expect(run(payrollRunId).status).toBe('approved');
}

describe('payroll', () => {
  it('runs a complete payroll with withholdings and an advance', async () => {
    const administration = byKey(fake, 'costCenter', 'cc_administracion');
    const ana = await createEmployee(team.admin, { name: 'Ana López', position: 'Vendedora', areaKey: 'ventas', costCenterId: byKey(fake, 'costCenter', 'cc_ventas').id }, opts());
    const beto = await createEmployee(team.admin, { name: 'Beto Ruiz', position: 'Chofer' }, opts());
    expect([ana.data?.number, beto.data?.number]).toEqual(['EMP-000001', 'EMP-000002']);

    const caja = cash('caja_general');
    const advance = await grantEmployeeAdvance(team.admin, { employeeId: ana.data!.employeeId, amount: '500', cashAccountId: caja.id, date: '2026-08-20' }, opts());
    const advanceObligation = rowById(fake, 'obligation', advance.data!.obligationId);
    expect(advanceObligation).toMatchObject({ kind: 'receivable', counterpartyType: 'employee', employeeId: ana.data!.employeeId });
    expect(linesOf(fake, advance.data!.ledgerEntryId!)).toEqual([
      ['receivable', advanceObligation.id, '500.00', '0.00', null],
      ['cash', caja.id, '0.00', '500.00', null],
    ]);
    expect(D(cash('caja_general').currentBalance).toFixed(2)).toBe('-500.00');

    const tooMuch = await createPayrollRun(
      team.admin,
      { periodStart: '2026-08-16', periodEnd: '2026-08-31', lines: [{ employeeId: ana.data!.employeeId, gross: '8000', advancesApplied: '600' }] },
      opts()
    );
    expect(tooMuch).toMatchObject({ status: 'rejected', errorCode: 'over_settlement' });

    const created = await createPayrollRun(
      team.admin,
      {
        periodStart: '2026-08-16',
        periodEnd: '2026-08-31',
        lines: [
          { employeeId: ana.data!.employeeId, gross: '8000', deductions: [{ kind: 'tax', label: 'ISR', amount: '700' }], advancesApplied: '500' },
          { employeeId: beto.data!.employeeId, gross: '6000', costCenterId: administration.id },
        ],
      },
      opts()
    );
    expect(created.data).toMatchObject({ number: 'NOM-000001', totalNet: '12800.00' });
    const payrollRunId = created.data!.payrollRunId;
    expect(run(payrollRunId)).toMatchObject({ periodKey: '2026-08', status: 'draft' });
    expect([D(run(payrollRunId).totalGross).toFixed(2), D(run(payrollRunId).totalDeductions).toFixed(2)]).toEqual(['14000.00', '1200.00']);

    await approveRun(payrollRunId);

    const obligations = await createPayrollObligations(team.admin, { payrollRunId }, opts());
    expect(obligations.data).toMatchObject({ status: 'obligations_created' });
    expect(obligations.data?.obligationIds).toHaveLength(2);
    const entry = rowById(fake, 'ledgerEntry', obligations.data!.ledgerEntryId);
    expect(entry).toMatchObject({ kind: 'payroll', sourceType: 'payroll_run', sourceId: payrollRunId, periodKey: '2026-09' });
    const lines = fake.rows('ledgerLine').filter((l) => l.entryId === entry.id) as Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }>;
    expect(assertBalanced(lines).totalDebit.toFixed(2)).toBe('14000.00');
    const byAccount = linesOf(fake, entry.id).map(([type, , debit, credit]) => [type, debit, credit]);
    expect(byAccount).toEqual(
      expect.arrayContaining([
        ['clearing', '0.00', '700.00'],
        ['receivable', '0.00', '500.00'],
        ['payable', '0.00', '6800.00'],
        ['payable', '0.00', '6000.00'],
      ])
    );
    expect(rowById(fake, 'obligation', advanceObligation.id)).toMatchObject({ status: 'settled' });
    expect(fake.rows('obligationSettlement').find((s) => s.obligationId === advanceObligation.id)).toMatchObject({
      ledgerEntryId: entry.id,
      cashAccountId: null,
    });
    const payables = obligations.data!.obligationIds.map((id) => rowById(fake, 'obligation', id));
    expect(payables.every((o) => o.ledgerEntryId === entry.id && o.payrollRunId === payrollRunId && o.counterpartyType === 'employee')).toBe(true);
    expect(D(cash('caja_general').currentBalance).toFixed(2)).toBe('-500.00');

    const bank = cash('banco_zoho');
    const payAna = await payPayrollLine(team.admin, { payrollRunId, employeeId: ana.data!.employeeId, cashAccountId: bank.id }, opts());
    expect(payAna.data).toMatchObject({ runStatus: 'obligations_created' });
    const again = await payPayrollLine(team.admin, { payrollRunId, employeeId: ana.data!.employeeId, cashAccountId: bank.id }, opts());
    expect(again).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
    const early = await closePayrollRun(team.admin, { payrollRunId }, opts());
    expect(early).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
    const payBeto = await payPayrollLine(team.admin, { payrollRunId, employeeId: beto.data!.employeeId, cashAccountId: bank.id }, opts());
    expect(payBeto.data).toMatchObject({ runStatus: 'paid' });
    expect(fake.rows('payrollLine').every((l) => l.status === 'paid')).toBe(true);
    expect(D(cash('banco_zoho').currentBalance).toFixed(2)).toBe('-12800.00');
    expect(eventsOf(fake, 'finance.payroll.paid')).toHaveLength(1);

    const closed = await closePayrollRun(team.admin, { payrollRunId }, opts());
    expect(closed.data).toMatchObject({ status: 'closed' });
  });

  it('cancelling a run with obligations reverses its entry and gives the advance back', async () => {
    const ana = await createEmployee(team.admin, { name: 'Ana López' }, opts());
    const employeeId = ana.data!.employeeId;
    const advance = await grantEmployeeAdvance(team.admin, { employeeId, amount: '300', cashAccountId: cash('caja_general').id }, opts());
    const created = await createPayrollRun(
      team.admin,
      { periodStart: '2026-09-01', periodEnd: '2026-09-15', lines: [{ employeeId, gross: '2000', advancesApplied: '300' }] },
      opts()
    );
    const payrollRunId = created.data!.payrollRunId;
    await approveRun(payrollRunId);
    const obligations = await createPayrollObligations(team.admin, { payrollRunId }, opts());
    expect(rowById(fake, 'obligation', advance.data!.obligationId).status).toBe('settled');

    const cancelled = await cancelPayrollRun(team.admin, { payrollRunId, reason: 'Se capturó el periodo equivocado' }, opts());
    expect(cancelled.data).toMatchObject({ status: 'cancelled' });
    const entry = rowById(fake, 'ledgerEntry', obligations.data!.ledgerEntryId);
    expect(entry.reversedByEntryId).toBe(cancelled.data!.reversalEntryId);
    expect(rowById(fake, 'obligation', obligations.data!.obligationIds[0]).status).toBe('cancelled');
    const restored = rowById(fake, 'obligation', advance.data!.obligationId);
    expect(restored.status).toBe('expected');
    expect(D(restored.settledAmount).toFixed(2)).toBe('0.00');
    expect(fake.rows('obligationSettlement').filter((s) => s.obligationId === restored.id).map((s) => D(s.amount).toFixed(2))).toEqual(['300.00', '-300.00']);
    expect(eventsOf(fake, 'finance.payroll.cancelled')).toHaveLength(1);
  });

  it('a rejected payroll goes back to draft', async () => {
    const ana = await createEmployee(team.admin, { name: 'Ana López' }, opts());
    const created = await createPayrollRun(team.admin, { periodStart: '2026-09-01', periodEnd: '2026-09-15', lines: [{ employeeId: ana.data!.employeeId, gross: '1000' }] }, opts());
    const submitted = await submitPayrollRun(team.admin, { payrollRunId: created.data!.payrollRunId }, opts());
    await decideApproval(team.approver, { approvalRequestId: submitted.data!.approvalRequestId, decision: 'reject', note: 'Falta el bono' }, { commandId: 'reject', now: NOW });
    expect(run(created.data!.payrollRunId).status).toBe('draft');
    expect(eventsOf(fake, 'finance.payroll.rejected')).toHaveLength(1);
  });
});
