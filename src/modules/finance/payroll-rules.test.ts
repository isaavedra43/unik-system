import { describe, expect, it } from 'vitest';
import { isOperationsError } from '@/modules/operations/errors';
import { assertBalanced, normalizeLedgerLines } from './ledger-rules';
import {
  allocateAdvances,
  assertPayrollLines,
  computePayrollLine,
  computePayrollTotals,
  isPayrollFullyPaid,
  payrollEntryLines,
  payrollPeriod,
} from './payroll-rules';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return isOperationsError(err) ? err.code : 'unexpected';
  }
}

describe('payroll lines', () => {
  it('net = gross − deductions − advances', () => {
    const line = computePayrollLine({
      gross: '8000',
      deductions: [
        { kind: 'tax', label: 'ISR', amount: '650.25' },
        { kind: 'social_security', label: 'IMSS', amount: '49.75' },
      ],
      advancesApplied: '500',
    });
    expect([line.gross, line.deductionsTotal, line.advancesApplied, line.net].map((d) => d.toFixed(2))).toEqual([
      '8000.00',
      '700.00',
      '500.00',
      '6800.00',
    ]);
  });

  it('rejects a negative net or negative amounts', () => {
    expect(codeOf(() => computePayrollLine({ gross: '100', deductions: [{ kind: 'x', label: 'x', amount: '90' }], advancesApplied: '11' }))).toBe('invalid_quantity');
    expect(codeOf(() => computePayrollLine({ gross: '100', deductions: [{ kind: 'x', label: 'x', amount: '-1' }] }))).toBe('invalid_quantity');
    expect(codeOf(() => computePayrollLine({ gross: '-1', deductions: [] }))).toBe('invalid_quantity');
    expect(computePayrollLine({ gross: '100', deductions: [], advancesApplied: '100' }).net.toFixed(2)).toBe('0.00');
  });

  it('totals the run (deductions include applied advances)', () => {
    const totals = computePayrollTotals([
      computePayrollLine({ gross: '8000', deductions: [{ kind: 'tax', label: 'ISR', amount: '700' }], advancesApplied: '500' }),
      computePayrollLine({ gross: '6000', deductions: [] }),
    ]);
    expect([totals.totalGross, totals.totalDeductions, totals.totalNet].map((d) => d.toFixed(2))).toEqual(['14000.00', '1200.00', '12800.00']);
  });
});

describe('periods and validation', () => {
  it('derives the period from the end date', () => {
    expect(payrollPeriod('2026-08-16', '2026-08-31')).toEqual({ periodKey: '2026-08', startKey: '2026-08-16', endKey: '2026-08-31' });
    expect(codeOf(() => payrollPeriod('2026-08-31', '2026-08-16'))).toBe('invalid_payload');
    expect(codeOf(() => payrollPeriod('2026-08-01', '2026-09-01'))).toBe('invalid_payload');
    expect(codeOf(() => payrollPeriod('2026-08-01', '2026-08-32'))).toBe('invalid_payload');
    expect(payrollPeriod('2026-08-01', '2026-08-31').periodKey).toBe('2026-08');
  });

  const employees = new Map([
    ['e1', { name: 'Ana', active: true }],
    ['e2', { name: 'Beto', active: false }],
  ]);

  it.each([
    [[], 'invalid_payload'],
    [[{ employeeId: 'e1' }, { employeeId: 'e1' }], 'invalid_payload'],
    [[{ employeeId: 'e2' }], 'invalid_state'],
    [[{ employeeId: 'nadie' }], 'not_found'],
    [[{ employeeId: 'e1', advancesApplied: '500.01' }], 'over_settlement'],
    [[{ employeeId: 'e1', advancesApplied: '500' }], null],
  ])('%o → %s', (lines, code) => {
    expect(codeOf(() => assertPayrollLines(lines, { employees, openAdvances: new Map([['e1', '500']]) }))).toBe(code);
  });
});

describe('advances', () => {
  const advances = [
    { obligationId: 'new', remaining: '300', createdAt: new Date('2026-09-10') },
    { obligationId: 'old', remaining: '200', createdAt: new Date('2026-08-10') },
  ];

  it('applies FIFO from the oldest advance', () => {
    expect(allocateAdvances('350', advances).map((a) => [a.obligationId, a.amount.toFixed(2)])).toEqual([
      ['old', '200.00'],
      ['new', '150.00'],
    ]);
    expect(allocateAdvances('0', advances)).toEqual([]);
    expect(codeOf(() => allocateAdvances('500.01', advances))).toBe('over_settlement');
  });
});

describe('payroll entry', () => {
  it('Dr payroll per line; Cr withholdings, advances and net payables — balanced', () => {
    const lines = payrollEntryLines({
      runNumber: 'NOM-000001',
      categoryId: 'nomina',
      lines: [
        {
          employeeId: 'e1',
          employeeName: 'Ana',
          computation: computePayrollLine({ gross: '8000', deductions: [{ kind: 'tax', label: 'ISR', amount: '700' }], advancesApplied: '500' }),
          costCenterId: 'cc_admin',
          obligationId: 'ob1',
          advanceAllocations: [{ obligationId: 'adv1', amount: '500' }],
        },
        {
          employeeId: 'e2',
          employeeName: 'Beto',
          computation: computePayrollLine({ gross: '300', deductions: [], advancesApplied: '300' }),
          costCenterId: null,
          obligationId: null,
          advanceAllocations: [{ obligationId: 'adv2', amount: '300' }],
        },
      ],
    });
    expect(lines.map((l) => [l.accountType, l.accountId, l.debit ? 'Dr' : 'Cr', String(l.debit ?? l.credit)])).toEqual([
      ['category', 'nomina', 'Dr', '8000'],
      ['clearing', 'payroll_deductions', 'Cr', '700'],
      ['receivable', 'adv1', 'Cr', '500'],
      ['payable', 'ob1', 'Cr', '6800'],
      ['category', 'nomina', 'Dr', '300'],
      ['receivable', 'adv2', 'Cr', '300'],
    ]);
    expect(assertBalanced(normalizeLedgerLines(lines)).totalDebit.toFixed(2)).toBe('8300.00');
  });

  it('a positive net needs its payable obligation', () => {
    expect(() =>
      payrollEntryLines({
        runNumber: 'NOM-1',
        categoryId: 'nomina',
        lines: [
          {
            employeeId: 'e',
            employeeName: 'E',
            computation: computePayrollLine({ gross: '1', deductions: [] }),
            costCenterId: null,
            obligationId: null,
            advanceAllocations: [],
          },
        ],
      })
    ).toThrow();
  });

  it('is paid when every line is paid', () => {
    expect(isPayrollFullyPaid([{ status: 'paid' }, { status: 'paid' }])).toBe(true);
    expect(isPayrollFullyPaid([{ status: 'paid' }, { status: 'pending' }])).toBe(false);
    expect(isPayrollFullyPaid([])).toBe(false);
  });
});
