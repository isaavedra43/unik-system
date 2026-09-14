import { describe, expect, it } from 'vitest';
import { buildVendorStatement, isIsoDay, presetRange, type StatementDocument } from './vendor-statement';

const doc = (kind: 'bill' | 'credit', number: string, date: string, total: number, status = kind === 'bill' ? 'open' : 'closed'): StatementDocument => ({
  id: number,
  kind,
  number,
  status,
  date: `${date}T00:00:00.000Z`,
  dueDate: null,
  total: String(total),
  balance: null,
  notes: null,
  href: `/x/${number}`,
});

// AARON ROJAS as Zoho shows it for September 2026: opening 530,915 → 466,420.
const history = [
  doc('bill', 'FN-1567', '2026-07-31', 247875),
  doc('bill', 'FN-1576', '2026-08-05', 95600),
  doc('bill', 'FN-1592', '2026-08-20', 193500),
  doc('credit', 'UNKNC-01644', '2026-07-25', 6060),
  doc('credit', 'UNKNC-01715', '2026-09-02', 100000),
  doc('bill', 'FN-1611', '2026-09-04', 185505),
  doc('credit', 'UNKNC-01723', '2026-09-07', 100000),
  doc('credit', 'UNKNC-01734', '2026-09-09', 50000, 'open'),
  doc('bill', 'FN-0000', '2026-06-01', 999999, 'draft'),
];

describe('vendor statement', () => {
  it('period: opening balance is everything before the period, then a running balance like Zoho', () => {
    const s = buildVendorStatement(history, { from: '2026-09-01', to: '2026-09-30' });
    expect(s.openingBalance).toBe(530915);
    expect(s.rows.map((r) => [r.number, r.amount, r.runningBalance])).toEqual([
      ['UNKNC-01715', -100000, 430915],
      ['FN-1611', 185505, 616420],
      ['UNKNC-01723', -100000, 516420],
      ['UNKNC-01734', -50000, 466420],
    ]);
    expect(s.billsTotal).toBe(185505);
    expect(s.creditsTotal).toBe(250000);
    expect(s.closingBalance).toBe(466420);
    expect(s.excluded).toBe(1);
  });

  it('no period: starts at the first document with opening 0 and ends at the same real balance', () => {
    const s = buildVendorStatement(history);
    expect(s.openingBalance).toBe(0);
    expect(s.rows[0].number).toBe('UNKNC-01644');
    expect(s.firstDocumentDate).toBe('2026-07-25T00:00:00.000Z');
    expect(s.closingBalance).toBe(466420);
    expect(s.rows).toHaveLength(8);
  });

  it('same-day documents: charge first, then credit', () => {
    const s = buildVendorStatement([doc('credit', 'C', '2026-09-04', 10), doc('bill', 'B', '2026-09-04', 100)]);
    expect(s.rows.map((r) => r.number)).toEqual(['B', 'C']);
    expect(s.closingBalance).toBe(90);
  });

  it('presets produce inclusive ISO days and custom validation works', () => {
    const r = presetRange('this_month', new Date('2026-09-14T12:00:00Z'));
    expect(r).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetRange('last_month', new Date('2026-01-10T12:00:00Z'))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presetRange('all')).toEqual({ from: null, to: null });
    expect(isIsoDay('2026-09-31')).toBe(false === false);
    expect(isIsoDay('hoy')).toBe(false);
  });
});
