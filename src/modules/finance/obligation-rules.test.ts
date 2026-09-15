import { describe, expect, it } from 'vitest';
import { isOperationsError } from '@/modules/operations/errors';
import { assertBalanced, normalizeLedgerLines } from './ledger-rules';
import { D } from './money';
import {
  agingBucket,
  assertPaymentAuthorized,
  assertSettleable,
  daysOverdue,
  nextObligationStatus,
  nextSettlementExternalRef,
  obligationEntryLines,
  obligationSourceOf,
  paymentAuthorizationState,
  remainingOf,
  reversalExternalRef,
  settlementEntryLines,
  settlementExternalRef,
  summarizeAging,
  writeOffEntryLines,
} from './obligation-rules';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return isOperationsError(err) ? err.code : 'unexpected';
  }
}

const due = (key: string) => new Date(`${key}T00:00:00.000Z`);

describe('balances and status', () => {
  it('computes the remaining balance (never negative)', () => {
    expect(remainingOf({ expectedAmount: '1000', settledAmount: '250.5' }).toFixed(2)).toBe('749.50');
    expect(remainingOf({ expectedAmount: '1000', settledAmount: '1200' }).toFixed(2)).toBe('0.00');
  });

  it.each([
    ['expected', '1000', '0', 'expected'],
    ['expected', '1000', '0.004', 'expected'],
    ['expected', '1000', '10', 'partially_settled'],
    ['partially_settled', '1000', '999.996', 'settled'],
    ['settled', '1000', '500', 'partially_settled'],
    ['cancelled', '1000', '0', 'cancelled'],
    ['written_off', '1000', '100', 'written_off'],
  ])('status %s with %s expected and %s settled → %s', (current, expected, settled, next) => {
    expect(nextObligationStatus(current, expected, settled)).toBe(next);
  });

  it('validates a settlement', () => {
    const open = { status: 'expected', expectedAmount: '1000', settledAmount: '400', currency: 'MXN', number: 'OB-1' };
    expect(codeOf(() => assertSettleable(open, D('600')))).toBeNull();
    expect(codeOf(() => assertSettleable(open, D('600.004')))).toBeNull();
    expect(codeOf(() => assertSettleable(open, D('600.01')))).toBe('over_settlement');
    expect(codeOf(() => assertSettleable(open, D('0')))).toBe('invalid_quantity');
    expect(codeOf(() => assertSettleable(open, D('10'), 'USD'))).toBe('currency_mismatch');
    expect(codeOf(() => assertSettleable({ ...open, status: 'settled' }, D('1')))).toBe('invalid_state');
    expect(codeOf(() => assertSettleable({ ...open, status: 'cancelled' }, D('1')))).toBe('invalid_state');
  });
});

describe('source of an obligation', () => {
  it.each([
    [{ kind: 'payable', procurementOrderId: 'po1', expenseId: 'e1' }, 'procurement_order'],
    [{ kind: 'payable', payrollRunId: 'nom1', employeeId: 'emp' }, 'payroll_run'],
    [{ kind: 'payable', expenseId: 'e1' }, 'expense'],
    [{ kind: 'receivable', zohoSalesOrderId: 'so1' }, 'sales_order'],
    [{ kind: 'receivable', employeeId: 'emp' }, 'employee_advance'],
    [{ kind: 'payable', employeeId: 'emp' }, 'manual'],
    [{ kind: 'payable' }, 'manual'],
  ])('%o → %s', (links, source) => {
    expect(obligationSourceOf(links)).toBe(source);
  });
});

describe('entry lines', () => {
  const balanced = (lines: ReturnType<typeof obligationEntryLines>) => assertBalanced(normalizeLedgerLines(lines));

  it('receivable: Dr receivable / Cr income category', () => {
    const lines = obligationEntryLines({ kind: 'receivable', obligationId: 'ob1', amount: '1500', categoryId: 'ventas', caseId: 'c1', costCenterId: 'cc' });
    expect(lines).toEqual([
      expect.objectContaining({ accountType: 'receivable', accountId: 'ob1', debit: D('1500'), caseId: 'c1' }),
      expect.objectContaining({ accountType: 'category', accountId: 'ventas', credit: D('1500'), costCenterId: 'cc' }),
    ]);
    expect(balanced(lines).totalDebit.toFixed(2)).toBe('1500.00');
  });

  it('payable split between cost centers: Dr category per split / Cr payable', () => {
    const lines = obligationEntryLines({
      kind: 'payable',
      obligationId: 'ob2',
      amount: '1000',
      categoryId: 'fletes',
      allocations: [
        { amount: '600', costCenterId: 'cc_logistica' },
        { amount: '400', costCenterId: 'cc_ventas', caseId: 'c9' },
      ],
    });
    expect(lines.map((l) => [l.accountType, l.costCenterId ?? null, String(l.debit ?? ''), String(l.credit ?? '')])).toEqual([
      ['category', 'cc_logistica', '600', ''],
      ['category', 'cc_ventas', '400', ''],
      ['payable', null, '', '1000'],
    ]);
    expect(balanced(lines).totalCredit.toFixed(2)).toBe('1000.00');
  });

  it('rejects allocations that do not add up', () => {
    expect(
      codeOf(() =>
        obligationEntryLines({ kind: 'payable', obligationId: 'x', amount: '1000', categoryId: 'c', allocations: [{ amount: '999.99' }] })
      )
    ).toBe('unbalanced_entry');
    expect(codeOf(() => obligationEntryLines({ kind: 'payable', obligationId: 'x', amount: '0', categoryId: 'c' }))).toBe('invalid_quantity');
  });

  it('employee advance offsets cash instead of a category', () => {
    const lines = obligationEntryLines({
      kind: 'receivable',
      obligationId: 'adv',
      amount: '500',
      categoryId: 'nomina_anticipos',
      offset: { accountType: 'cash', accountId: 'caja' },
      allocations: [{ amount: '1' }],
    });
    expect(lines.map((l) => [l.accountType, l.accountId])).toEqual([
      ['receivable', 'adv'],
      ['cash', 'caja'],
    ]);
    balanced(lines);
  });

  it('settlements move cash in the right direction', () => {
    expect(settlementEntryLines({ kind: 'receivable', obligationId: 'r', amount: 10, cashAccountId: 'banco' }).map((l) => [l.accountType, l.debit ? 'Dr' : 'Cr'])).toEqual([
      ['cash', 'Dr'],
      ['receivable', 'Cr'],
    ]);
    const pay = settlementEntryLines({ kind: 'payable', obligationId: 'p', amount: 10, cashAccountId: 'banco', procurementOrderId: 'po' });
    expect(pay.map((l) => [l.accountType, l.debit ? 'Dr' : 'Cr', l.procurementOrderId])).toEqual([
      ['payable', 'Dr', 'po'],
      ['cash', 'Cr', 'po'],
    ]);
    balanced(pay);
  });

  it('write-off lines', () => {
    expect(writeOffEntryLines({ kind: 'receivable', obligationId: 'r', amount: 5, categoryId: 'incobrables' }).map((l) => [l.accountType, l.debit ? 'Dr' : 'Cr'])).toEqual([
      ['category', 'Dr'],
      ['receivable', 'Cr'],
    ]);
    expect(writeOffEntryLines({ kind: 'payable', obligationId: 'p', amount: 5, categoryId: 'otros' }).map((l) => [l.accountType, l.debit ? 'Dr' : 'Cr'])).toEqual([
      ['payable', 'Dr'],
      ['category', 'Cr'],
    ]);
  });
});

describe('aging', () => {
  it.each([
    [null, 'no_due_date'],
    ['2026-09-20', 'not_due'],
    ['2026-09-15', 'not_due'],
    ['2026-09-14', 'd1_30'],
    ['2026-08-16', 'd1_30'],
    ['2026-08-15', 'd31_60'],
    ['2026-07-17', 'd31_60'],
    ['2026-07-16', 'd61_90'],
    ['2026-06-17', 'd61_90'],
    ['2026-06-16', 'd90_plus'],
  ])('due %s on 2026-09-15 → %s', (key, bucket) => {
    expect(agingBucket(key ? due(key) : null, '2026-09-15')).toBe(bucket);
  });

  it('counts overdue days and totals per kind and bucket', () => {
    expect(daysOverdue(due('2026-09-10'), '2026-09-15')).toBe(5);
    expect(daysOverdue(due('2026-09-20'), '2026-09-15')).toBe(0);
    expect(daysOverdue(null, '2026-09-15')).toBeNull();
    const summary = summarizeAging(
      [
        { kind: 'receivable', remaining: '100', dueAt: due('2026-09-01') },
        { kind: 'receivable', remaining: '50.5', dueAt: due('2026-09-30') },
        { kind: 'payable', remaining: '10', dueAt: null },
        { kind: 'payable', remaining: '0', dueAt: due('2026-01-01') },
        { kind: 'other', remaining: '999', dueAt: null },
      ],
      '2026-09-15'
    );
    expect(summary.receivable).toMatchObject({ d1_30: '100.00', not_due: '50.50', total: '150.50' });
    expect(summary.payable).toMatchObject({ no_due_date: '10.00', d90_plus: '0.00', total: '10.00' });
  });
});

describe('payment authorization', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 8, 15, 12, s));

  it.each([
    [{ kind: 'receivable' }, [], 'not_required'],
    [{ kind: 'payable', expenseId: 'e' }, [], 'not_required'],
    [{ kind: 'payable', payrollRunId: 'n' }, [{ status: 'rejected', createdAt: at(1) }], 'not_required'],
    [{ kind: 'payable', procurementOrderId: 'po' }, [], 'missing'],
    [{ kind: 'payable' }, [], 'missing'],
    [{ kind: 'payable', counterpartyType: 'supplier' }, [], 'missing'],
    [{ kind: 'payable', counterpartyType: 'tax' }, [{ status: 'approved', createdAt: at(1) }], 'approved'],
    [{ kind: 'payable' }, [{ status: 'pending', createdAt: at(1) }], 'pending'],
    [{ kind: 'payable', procurementOrderId: 'po' }, [{ status: 'approved', createdAt: at(1) }], 'approved'],
    [
      { kind: 'payable', procurementOrderId: 'po' },
      [
        { status: 'approved', createdAt: at(1) },
        { status: 'rejected', createdAt: at(2) },
      ],
      'rejected',
    ],
    [
      { kind: 'payable', procurementOrderId: 'po' },
      [
        { status: 'expired', createdAt: at(1) },
        { status: 'approved', createdAt: at(3) },
      ],
      'approved',
    ],
  ])('%o with %o → %s', (obligation, approvals, state) => {
    expect(paymentAuthorizationState(obligation, approvals)).toBe(state);
  });

  it('blocks payments that are not authorized', () => {
    expect(codeOf(() => assertPaymentAuthorized('approved'))).toBeNull();
    expect(codeOf(() => assertPaymentAuthorized('not_required'))).toBeNull();
    for (const state of ['pending', 'rejected', 'missing'] as const) {
      expect(codeOf(() => assertPaymentAuthorized(state, 'OB-1'))).toBe('payment_not_authorized');
    }
  });
});

describe('Zoho payment references', () => {
  it('builds the idempotency key and the next attempt after reversals', () => {
    const base = settlementExternalRef('P1', 'OB1');
    expect(base).toBe('zoho_payment:P1:OB1');
    expect(settlementExternalRef('P1', 'OB1', 2)).toBe('zoho_payment:P1:OB1#2');
    expect(nextSettlementExternalRef([], 'P1', 'OB1')).toBe(base);
    expect(nextSettlementExternalRef([base], 'P1', 'OB1')).toBeNull();
    expect(nextSettlementExternalRef([base, reversalExternalRef(base)], 'P1', 'OB1')).toBe('zoho_payment:P1:OB1#2');
    const second = settlementExternalRef('P1', 'OB1', 2);
    expect(nextSettlementExternalRef([base, reversalExternalRef(base), second], 'P1', 'OB1')).toBeNull();
    expect(nextSettlementExternalRef([base, reversalExternalRef(base), second, reversalExternalRef(second)], 'P1', 'OB1')).toBe(
      'zoho_payment:P1:OB1#3'
    );
  });
});

describe('settlement references and ledger balances', () => {
  it('reads the obligation of a payment reference and the obligations a person reversed', async () => {
    const { obligationIdOfSettlementRef, reversedObligationIdsOf } = await import('./obligation-rules');
    expect(obligationIdOfSettlementRef('zoho_payment:P1:ob_1', 'P1')).toBe('ob_1');
    expect(obligationIdOfSettlementRef('zoho_payment:P1:ob_1#3', 'P1')).toBe('ob_1');
    expect(obligationIdOfSettlementRef('zoho_payment:P1:ob_1#2:reversal', 'P1')).toBe('ob_1');
    expect(obligationIdOfSettlementRef('zoho_payment:P10:ob_1', 'P1')).toBeNull();
    expect(obligationIdOfSettlementRef(null, 'P1')).toBeNull();
    expect(obligationIdOfSettlementRef('zoho_payment:P1:', 'P1')).toBeNull();
    expect(
      reversedObligationIdsOf(
        ['zoho_payment:P1:ob_2', 'zoho_payment:P1:ob_1:reversal', 'zoho_payment:P1:ob_1#2:reversal', 'zoho_payment:P1:ob_3#2', null],
        'P1'
      )
    ).toEqual(['ob_1']);
  });

  it.each([
    ['receivable', '1000', '400', '600.00'],
    ['receivable', '400', '1000', '0.00'],
    ['payable', '250', '1000', '750.00'],
    ['payable', '1000', '1000', '0.00'],
  ])('%s with debit %s and credit %s owes %s', async (kind, debit, credit, expected) => {
    const { obligationLedgerBalance } = await import('./obligation-rules');
    expect(obligationLedgerBalance(kind, debit, credit).toFixed(2)).toBe(expected);
  });
});
