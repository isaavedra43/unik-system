import { describe, expect, it } from 'vitest';
import { isOperationsError } from '@/modules/operations/errors';
import { budgetVsActual, buildCashflowWeeks, runningBalances } from './cashflow-rules';
import {
  assertCloseKey,
  assertCloseTransition,
  assertReopenReason,
  blockingFailures,
  canClose,
  closeSummary,
  evaluateCloseChecks,
  type CloseRulesInput,
} from './close-rules';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return isOperationsError(err) ? err.code : 'unexpected';
  }
}

const clean = (kind: 'daily' | 'monthly'): CloseRulesInput => ({
  kind,
  periodKey: kind === 'monthly' ? '2026-08' : '2026-09-14',
  pendingExpenses: { count: 0, numbers: [] },
  unassignedCollections: { count: 0, amount: '0' },
  cashAccounts: [
    { cashAccountId: 'caja', name: 'Caja general', kind: 'cash', currency: 'MXN', currentBalance: '500', ledgerBalance: '500', counted: kind === 'daily' ? '500' : null },
    { cashAccountId: 'banco', name: 'Banco (Zoho)', kind: 'bank', currency: 'MXN', currentBalance: '9000', ledgerBalance: '9000' },
  ],
  ledgerTotals: { debit: '1200', credit: '1200', entries: 3 },
});

const failed = (input: CloseRulesInput) => blockingFailures(evaluateCloseChecks(input)).map((c) => c.key);

describe('close checks', () => {
  it('a clean monthly and daily close pass', () => {
    expect(canClose(evaluateCloseChecks(clean('monthly')))).toBe(true);
    expect(canClose(evaluateCloseChecks(clean('daily')))).toBe(true);
  });

  it('pending expenses and unassigned collections block the month but only warn the day', () => {
    const monthly = { ...clean('monthly'), pendingExpenses: { count: 7, numbers: ['GX-1', 'GX-2', 'GX-3', 'GX-4', 'GX-5', 'GX-6', 'GX-7'] }, unassignedCollections: { count: 1, amount: '250' } };
    expect(failed(monthly)).toEqual(['pending_expenses', 'unassigned_collections']);
    const detail = evaluateCloseChecks(monthly).find((c) => c.key === 'pending_expenses')!.detail;
    expect(detail).toContain('GX-5 y 2 más');
    const daily = { ...clean('daily'), pendingExpenses: monthly.pendingExpenses, unassignedCollections: monthly.unassignedCollections };
    const checks = evaluateCloseChecks(daily);
    expect(canClose(checks)).toBe(true);
    expect(closeSummary(checks)).toMatchObject({ failed: 0, warnings: 2 });
  });

  it('cash integrity (ledger vs balance) always blocks', () => {
    const input = clean('monthly');
    input.cashAccounts = [{ ...input.cashAccounts[0], ledgerBalance: '499.99' }, input.cashAccounts[1]];
    expect(failed(input)).toEqual(['cash_integrity:caja']);
  });

  it('daily close requires the count of cash accounts (not banks) and it must match', () => {
    const missing = clean('daily');
    missing.cashAccounts = [{ ...missing.cashAccounts[0], counted: null }, missing.cashAccounts[1]];
    expect(failed(missing)).toEqual(['cash_count:caja']);
    const wrong = clean('daily');
    wrong.cashAccounts = [{ ...wrong.cashAccounts[0], counted: '480' }, wrong.cashAccounts[1]];
    const check = evaluateCloseChecks(wrong).find((c) => c.key === 'cash_count:caja')!;
    expect(check).toMatchObject({ ok: false, blocking: true, data: { difference: '-20.00' } });
  });

  it('a provided count must also match in a monthly close', () => {
    const input = clean('monthly');
    input.cashAccounts = [input.cashAccounts[0], { ...input.cashAccounts[1], counted: '8999' }];
    expect(failed(input)).toEqual(['cash_count:banco']);
  });

  it('an unbalanced ledger blocks; previous month and open payroll only warn', () => {
    expect(failed({ ...clean('monthly'), ledgerTotals: { debit: '10', credit: '9.99', entries: 1 } })).toEqual(['ledger_balanced']);
    const warnings = evaluateCloseChecks({ ...clean('monthly'), previousPeriodClosed: false, openPayrollRuns: { count: 1, numbers: ['NOM-1'] } });
    expect(canClose(warnings)).toBe(true);
    expect(warnings.filter((c) => !c.ok).map((c) => [c.key, c.blocking])).toEqual([
      ['previous_period_closed', false],
      ['open_payroll_runs', false],
    ]);
  });
});

describe('close transitions', () => {
  it('validates keys, transitions and the reopen reason', () => {
    expect(codeOf(() => assertCloseKey('monthly', '2026-08'))).toBeNull();
    expect(codeOf(() => assertCloseKey('monthly', '2026-08-01'))).toBe('invalid_payload');
    expect(codeOf(() => assertCloseKey('daily', '2026-08'))).toBe('invalid_payload');
    for (const status of [null, 'open', 'closing', 'reopened']) expect(codeOf(() => assertCloseTransition(status, 'close'))).toBeNull();
    expect(codeOf(() => assertCloseTransition('closed', 'close'))).toBe('invalid_state');
    expect(codeOf(() => assertCloseTransition('closed', 'reopen'))).toBeNull();
    expect(codeOf(() => assertCloseTransition('reopened', 'reopen'))).toBe('invalid_state');
    expect(codeOf(() => assertReopenReason('corto'))).toBe('invalid_payload');
    expect(assertReopenReason('  Faltó un gasto de agosto  ')).toBe('Faltó un gasto de agosto');
  });
});

describe('cash-flow projection', () => {
  it('buckets by week, overdue into the first week, undated apart, transfers excluded', () => {
    const projection = buildCashflowWeeks({
      fromKey: '2026-09-15',
      weeks: 3,
      todayKey: '2026-09-15',
      openingBalance: '10000',
      items: [
        { kind: 'receivable', remaining: '3000', expectedKey: '2026-09-16' },
        { kind: 'payable', remaining: '1000', expectedKey: '2026-09-01' },
        { kind: 'receivable', remaining: '500', expectedKey: '2026-09-28' },
        { kind: 'payable', remaining: '200', expectedKey: null },
        { kind: 'payable', remaining: '999', expectedKey: '2026-12-01' },
        { kind: 'receivable', remaining: '0', expectedKey: '2026-09-16' },
      ],
      realized: [
        { dateKey: '2026-09-14', debit: '700', credit: '0', entryKind: 'cash' },
        { dateKey: '2026-09-15', debit: '0', credit: '300', entryKind: 'cash' },
        { dateKey: '2026-09-15', debit: '5000', credit: '0', entryKind: 'transfer' },
      ],
    });
    expect(projection.weeks.map((w) => [w.weekStart, w.projectedIn, w.projectedOut, w.realizedIn, w.realizedOut, w.projectedBalance])).toEqual([
      ['2026-09-14', '3000.00', '1000.00', '700.00', '300.00', '12000.00'],
      ['2026-09-21', '0.00', '0.00', '0.00', '0.00', '12000.00'],
      ['2026-09-28', '500.00', '0.00', '0.00', '0.00', '12500.00'],
    ]);
    expect(projection.overdue).toEqual({ in: '0.00', out: '1000.00' });
    expect(projection.undated).toEqual({ in: '0.00', out: '200.00' });
    expect(projection.openingBalance).toBe('10000.00');
  });

  it('past weeks carry no projected balance', () => {
    const projection = buildCashflowWeeks({ fromKey: '2026-09-01', weeks: 3, todayKey: '2026-09-15', openingBalance: 0, items: [], realized: [] });
    expect(projection.weeks.map((w) => w.projectedBalance)).toEqual([null, null, '0.00']);
    expect(buildCashflowWeeks({ fromKey: '2026-09-15', weeks: 99, todayKey: '2026-09-15', openingBalance: 0, items: [], realized: [] }).weeks).toHaveLength(26);
  });
});

describe('budget vs actual', () => {
  it('matches budgets (empty = all) and lists unbudgeted spend; income is credit-normal', () => {
    const rows = budgetVsActual(
      [
        { costCenterId: 'cc_log', categoryId: 'combustible', amount: '5000' },
        { costCenterId: '', categoryId: 'papeleria', amount: '1000' },
        { costCenterId: 'cc_ventas', categoryId: '', amount: '2000' },
        { costCenterId: '', categoryId: 'ventas', amount: '100000' },
      ],
      [
        { costCenterId: 'cc_log', categoryId: 'combustible', categoryKind: 'expense', debit: '4000', credit: '0' },
        { costCenterId: 'cc_log', categoryId: 'combustible', categoryKind: 'expense', debit: '0', credit: '500' },
        { costCenterId: 'cc_admin', categoryId: 'papeleria', categoryKind: 'expense', debit: '300', credit: '0' },
        { costCenterId: 'cc_ventas', categoryId: 'papeleria', categoryKind: 'expense', debit: '200', credit: '0' },
        { costCenterId: 'cc_ventas', categoryId: 'ventas', categoryKind: 'income', debit: '0', credit: '80000' },
        { costCenterId: null, categoryId: 'renta', categoryKind: 'expense', debit: '15000', credit: '0' },
      ]
    );
    expect(rows.map((r) => [r.costCenterId, r.categoryId, r.budget, r.actual, r.variance, r.usedPct, r.budgeted])).toEqual([
      ['cc_log', 'combustible', '5000.00', '3500.00', '1500.00', 70, true],
      ['', 'papeleria', '1000.00', '500.00', '500.00', 50, true],
      ['cc_ventas', '', '2000.00', '80200.00', '-78200.00', 4010, true],
      ['', 'ventas', '100000.00', '80000.00', '20000.00', 80, true],
      ['', 'renta', '0.00', '15000.00', '-15000.00', null, false],
    ]);
  });

  it('running balance of a cash book', () => {
    expect(runningBalances('100', [{ debit: '50', credit: '0' }, { debit: '0', credit: '175.5' }]).map((b) => b.toFixed(2))).toEqual(['150.00', '-25.50']);
  });
});

describe('close checks at the cut-off date', () => {
  const base = {
    periodKey: '2026-09-14',
    pendingExpenses: { count: 0, numbers: [] as string[] },
    unassignedCollections: { count: 0, amount: '0' },
    ledgerTotals: { debit: '0', credit: '0', entries: 0 },
  };

  it('compares the count with the balance at the cut-off, not with today', async () => {
    const { evaluateCloseChecks } = await import('./close-rules');
    const account = { cashAccountId: 'caja', name: 'Caja', kind: 'cash', currency: 'MXN', currentBalance: '750', ledgerBalance: '750' };
    const atCutoff = evaluateCloseChecks({ ...base, kind: 'daily', cashAccounts: [{ ...account, balanceAtCutoff: '250', counted: '250' }] });
    expect(atCutoff.find((c) => c.key === 'cash_count:caja')).toMatchObject({ ok: true, data: { balanceAtCutoff: '250.00' } });
    const today = evaluateCloseChecks({ ...base, kind: 'daily', cashAccounts: [{ ...account, balanceAtCutoff: '250', counted: '750' }] });
    expect(today.find((c) => c.key === 'cash_count:caja')).toMatchObject({ ok: false, data: { difference: '500.00' } });
    const legacy = evaluateCloseChecks({ ...base, kind: 'daily', cashAccounts: [{ ...account, counted: '750' }] });
    expect(legacy.find((c) => c.key === 'cash_count:caja')?.ok).toBe(true);
  });

  it('over-applied collections block the monthly close and warn in the daily close', async () => {
    const { evaluateCloseChecks } = await import('./close-rules');
    const over = { count: 2, amount: '1300', numbers: ['PAGO-1', 'PAGO-2'] };
    const monthly = evaluateCloseChecks({ ...base, kind: 'monthly', periodKey: '2026-08', cashAccounts: [], overappliedCollections: over });
    expect(monthly.find((c) => c.key === 'overapplied_collections')).toMatchObject({ ok: false, blocking: true });
    const daily = evaluateCloseChecks({ ...base, kind: 'daily', cashAccounts: [], overappliedCollections: over });
    expect(daily.find((c) => c.key === 'overapplied_collections')).toMatchObject({ ok: false, blocking: false });
    const clean = evaluateCloseChecks({ ...base, kind: 'monthly', periodKey: '2026-08', cashAccounts: [], overappliedCollections: { count: 0, amount: '0', numbers: [] } });
    expect(clean.find((c) => c.key === 'overapplied_collections')?.ok).toBe(true);
    const absent = evaluateCloseChecks({ ...base, kind: 'monthly', periodKey: '2026-08', cashAccounts: [] });
    expect(absent.some((c) => c.key === 'overapplied_collections')).toBe(false);
  });
});
