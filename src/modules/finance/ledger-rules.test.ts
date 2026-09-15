import { describe, expect, it } from 'vitest';
import { isOperationsError } from '@/modules/operations/errors';
import {
  accountKey,
  assertBalanced,
  assertDateOpen,
  assertReversible,
  balanceFor,
  cashDeltas,
  closedPeriodFor,
  computeAccountBalances,
  ledgerTotals,
  mirrorForReversal,
  normalizeLedgerLines,
  periodKeyOf,
  reversalDateKey,
  type LedgerLineInput,
} from './ledger-rules';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return isOperationsError(err) ? err.code : 'unexpected';
  }
}

const cashIn: LedgerLineInput[] = [
  { accountType: 'cash', accountId: 'caja', debit: '100.00', memo: 'venta' },
  { accountType: 'category', accountId: 'ventas', credit: 100, costCenterId: 'cc1', caseId: 'case1' },
];

describe('normalizeLedgerLines', () => {
  it('numbers the lines, rounds to cents and keeps the dimensions', () => {
    const lines = normalizeLedgerLines([
      { accountType: 'cash', accountId: ' caja ', debit: '10.005' },
      { accountType: 'category', accountId: 'gastos', credit: '10.01', projectRef: 'P-1', memo: '  nota ' },
    ]);
    expect(lines.map((l) => [l.seq, l.accountId, l.debit.toFixed(2), l.credit.toFixed(2)])).toEqual([
      [1, 'caja', '10.01', '0.00'],
      [2, 'gastos', '0.00', '10.01'],
    ]);
    expect(lines[1]).toMatchObject({ projectRef: 'P-1', memo: 'nota', costCenterId: null, caseId: null });
  });

  it.each([
    ['one line', [{ accountType: 'cash', accountId: 'a', debit: 1 }], 'unbalanced_entry'],
    [
      'debit and credit on the same line',
      [
        { accountType: 'cash', accountId: 'a', debit: 1, credit: 1 },
        { accountType: 'cash', accountId: 'b', credit: 1 },
      ],
      'invalid_line',
    ],
    [
      'a line without amount',
      [
        { accountType: 'cash', accountId: 'a', debit: 0 },
        { accountType: 'cash', accountId: 'b', credit: 1 },
      ],
      'invalid_line',
    ],
    [
      'a negative amount',
      [
        { accountType: 'cash', accountId: 'a', debit: -1 },
        { accountType: 'cash', accountId: 'b', credit: 1 },
      ],
      'invalid_line',
    ],
    [
      'an unknown account type',
      [
        { accountType: 'bank', accountId: 'a', debit: 1 },
        { accountType: 'cash', accountId: 'b', credit: 1 },
      ],
      'invalid_line',
    ],
    [
      'an empty account',
      [
        { accountType: 'cash', accountId: ' ', debit: 1 },
        { accountType: 'cash', accountId: 'b', credit: 1 },
      ],
      'invalid_line',
    ],
    [
      'a non numeric amount',
      [
        { accountType: 'cash', accountId: 'a', debit: 'diez' },
        { accountType: 'cash', accountId: 'b', credit: 1 },
      ],
      'invalid_line',
    ],
  ])('rejects %s', (_label, lines, code) => {
    expect(codeOf(() => normalizeLedgerLines(lines as LedgerLineInput[]))).toBe(code);
  });
});

describe('assertBalanced', () => {
  it('accepts Σdebit = Σcredit and returns the totals', () => {
    const totals = assertBalanced(normalizeLedgerLines(cashIn));
    expect([totals.totalDebit.toFixed(2), totals.totalCredit.toFixed(2)]).toEqual(['100.00', '100.00']);
  });

  it('rejects an unbalanced entry with both totals', () => {
    const lines = normalizeLedgerLines([
      { accountType: 'cash', accountId: 'caja', debit: '100.00' },
      { accountType: 'category', accountId: 'ventas', credit: '99.99' },
    ]);
    try {
      assertBalanced(lines);
      expect.unreachable();
    } catch (err) {
      expect(isOperationsError(err) && err.code).toBe('unbalanced_entry');
      expect(isOperationsError(err) && err.httpStatus).toBe(422);
      expect(isOperationsError(err) && err.details).toEqual({ totalDebit: '100.00', totalCredit: '99.99' });
    }
  });

  it('compares after rounding each line to cents', () => {
    const lines = normalizeLedgerLines([
      { accountType: 'cash', accountId: 'caja', debit: '0.005' },
      { accountType: 'category', accountId: 'ventas', credit: '0.01' },
    ]);
    expect(ledgerTotals(lines).totalDebit.toFixed(2)).toBe('0.01');
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it('rejects fewer than two lines', () => {
    expect(codeOf(() => assertBalanced([{ debit: 1, credit: 0 }]))).toBe('unbalanced_entry');
  });
});

describe('reversal rules', () => {
  it('mirrors every line (debit ↔ credit) keeping accounts and dimensions', () => {
    const mirrored = mirrorForReversal(normalizeLedgerLines(cashIn));
    expect(mirrored).toEqual([
      expect.objectContaining({ accountType: 'cash', accountId: 'caja', memo: 'Reverso: venta' }),
      expect.objectContaining({ accountType: 'category', accountId: 'ventas', costCenterId: 'cc1', caseId: 'case1', memo: 'Reverso' }),
    ]);
    const normalized = normalizeLedgerLines(mirrored);
    expect(normalized.map((l) => [l.debit.toFixed(2), l.credit.toFixed(2)])).toEqual([
      ['0.00', '100.00'],
      ['100.00', '0.00'],
    ]);
    // original + reversal leave every account at zero
    const all = [...normalizeLedgerLines(cashIn), ...normalized];
    expect([...computeAccountBalances(all).values()].every((b) => b.isZero())).toBe(true);
  });

  it('never reverses a reversal nor an entry twice', () => {
    expect(codeOf(() => assertReversible({ kind: 'reversal', reversedByEntryId: null }))).toBe('not_reversible');
    expect(codeOf(() => assertReversible({ kind: 'expense', reversedByEntryId: 'x', number: 'AS-1' }))).toBe('already_reversed');
    expect(codeOf(() => assertReversible({ kind: 'expense', reversedByEntryId: null }))).toBeNull();
  });

  it('dates the reversal today, never before the original', () => {
    expect(reversalDateKey('2026-08-10', '2026-09-15')).toBe('2026-09-15');
    expect(reversalDateKey('2026-09-20', '2026-09-15')).toBe('2026-09-20');
    expect(reversalDateKey('2026-08-10', '2026-09-15', '2026-09-01')).toBe('2026-09-01');
    expect(codeOf(() => reversalDateKey('2026-08-10', '2026-09-15', '2026-08-01'))).toBe('invalid_payload');
    expect(codeOf(() => reversalDateKey('2026-08-10', '2026-09-15', '2026-02-30'))).toBe('invalid_payload');
  });
});

describe('periods and balances', () => {
  const closes = [
    { periodKey: '2026-08', kind: 'monthly', status: 'closed' },
    { periodKey: '2026-09-10', kind: 'daily', status: 'closed' },
    { periodKey: '2026-07', kind: 'monthly', status: 'reopened' },
    { periodKey: '2026-09-11', kind: 'daily', status: 'open' },
  ];

  it('finds the closed month or day that contains a date', () => {
    expect(periodKeyOf('2026-08-31')).toBe('2026-08');
    expect(closedPeriodFor(closes, '2026-08-31')).toMatchObject({ kind: 'monthly' });
    expect(closedPeriodFor(closes, '2026-09-10')).toMatchObject({ kind: 'daily' });
    expect(closedPeriodFor(closes, '2026-07-15')).toBeNull();
    expect(closedPeriodFor(closes, '2026-09-11')).toBeNull();
    expect(codeOf(() => assertDateOpen(closes, '2026-08-01'))).toBe('period_closed');
    expect(codeOf(() => assertDateOpen(closes, '2026-09-10'))).toBe('period_closed');
    expect(codeOf(() => assertDateOpen(closes, '2026-09-12'))).toBeNull();
    expect(codeOf(() => assertDateOpen(closes, 'ayer'))).toBe('invalid_payload');
  });

  it('computes balances per account and the cash movement of an entry', () => {
    const lines = normalizeLedgerLines([
      { accountType: 'cash', accountId: 'caja', credit: 30 },
      { accountType: 'cash', accountId: 'banco', debit: 30 },
      { accountType: 'cash', accountId: 'caja', debit: 5 },
      { accountType: 'category', accountId: 'ajustes', credit: 5 },
    ]);
    expect(balanceFor(lines, 'cash', 'caja').toFixed(2)).toBe('-25.00');
    expect(computeAccountBalances(lines).get(accountKey('category', 'ajustes'))?.toFixed(2)).toBe('-5.00');
    expect(Object.fromEntries([...cashDeltas(lines)].map(([k, v]) => [k, v.toFixed(2)]))).toEqual({
      caja: '-25.00',
      banco: '30.00',
    });
    const transfer = normalizeLedgerLines([
      { accountType: 'cash', accountId: 'caja', debit: 10 },
      { accountType: 'cash', accountId: 'caja', credit: 10 },
    ]);
    expect(cashDeltas(transfer).size).toBe(0);
  });
});

describe('close serialization keys and manual cash outflow', () => {
  it('a posting holds its month and day; a close holds its own key', async () => {
    const { closeLockKey, postingLockKeys } = await import('./ledger-rules');
    expect(postingLockKeys('2026-08-31')).toEqual(['finance:period:2026-08', 'finance:day:2026-08-31']);
    expect(closeLockKey('monthly', '2026-08')).toBe('finance:period:2026-08');
    expect(closeLockKey('daily', '2026-08-31')).toBe('finance:day:2026-08-31');
  });

  it.each([
    ['income', [{ accountType: 'cash', debit: '100' }, { accountType: 'category', credit: '100' }], '0'],
    ['expense', [{ accountType: 'category', debit: '80' }, { accountType: 'cash', credit: '80' }], '80'],
    ['transfer', [{ accountType: 'cash', debit: '500' }, { accountType: 'cash', credit: '500' }], '0'],
    ['partial transfer', [{ accountType: 'cash', debit: '200' }, { accountType: 'cash', credit: '500' }, { accountType: 'equity', debit: '300' }], '300'],
    ['adjustment without cash', [{ accountType: 'category', debit: '10' }, { accountType: 'equity', credit: '10' }], '0'],
    ['null amounts', [{ accountType: 'cash', debit: null, credit: '12.345' }], '12.35'],
  ])('%s → %s out of cash', async (_label, lines, expected) => {
    const { manualCashOutflow } = await import('./ledger-rules');
    expect(manualCashOutflow(lines as Array<{ accountType: string; debit?: string | null; credit?: string | null }>).toFixed(2)).toBe(
      Number(expected).toFixed(2)
    );
  });
});
