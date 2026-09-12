import { describe, it, expect } from 'vitest';
import { buildReportSubtitle, buildSummaryCards, money, parseNumeric, sumColumn } from './ai-report-helpers';

describe('buildSummaryCards — count vs. money (the "$55.00" bug)', () => {
  it('list mode: total is a COUNT of orders, totalSum is the money', () => {
    const cards = buildSummaryCards({ mode: 'list', total: 55, totalSum: '915098.92', balanceSum: '469373.84' });
    expect(cards).toEqual([
      { label: 'Órdenes', value: '55' },
      { label: 'Total', value: '$915,098.92' },
      { label: 'Saldo pendiente', value: '$469,373.84' },
    ]);
    expect(cards.map((c) => c.value)).not.toContain('$55.00');
  });

  it('list mode without balance omits the balance card', () => {
    const cards = buildSummaryCards({ mode: 'list', total: 3, totalSum: '100', balanceSum: '0' });
    expect(cards.map((c) => c.label)).toEqual(['Órdenes', 'Total']);
  });

  it('grouped mode uses totalOrders / totalRevenue / totalBalance', () => {
    const cards = buildSummaryCards({ mode: 'grouped', totalOrders: 76, groupCount: 4, totalRevenue: '2500000', totalBalance: '10' });
    expect(cards).toEqual([
      { label: 'Órdenes', value: '76' },
      { label: 'Grupos', value: '4' },
      { label: 'Total', value: '$2,500,000.00' },
      { label: 'Saldo pendiente', value: '$10.00' },
    ]);
  });

  it('generic tools never format a count as money', () => {
    const cards = buildSummaryCards({ count: 12, totalAmount: '999.5' });
    expect(cards).toEqual([
      { label: 'Registros', value: '12' },
      { label: 'Total', value: '$999.50' },
    ]);
  });
});

describe('buildReportSubtitle', () => {
  it('states period, filters and "X de Y" so a narrowed report is never mistaken for the full set', () => {
    const subtitle = buildReportSubtitle(
      { dateRange: 'this_month', deliveryType: 'pie_de_obra', ticketStatus: 'pendiente de entrega' },
      { statusReconciliation: { totalWithoutStatusFilters: 76, matched: 55 } }
    );
    expect(subtitle).toContain('Periodo: Este mes');
    expect(subtitle).toContain('Estado: pendiente de entrega');
    expect(subtitle).toContain('Tipo de entrega: pie_de_obra');
    expect(subtitle).toContain('55 de 76 órdenes del periodo');
  });

  it('uses explicit dates when given', () => {
    const subtitle = buildReportSubtitle({ dateRange: 'custom', dateFrom: '2026-08-01', dateTo: '2026-08-31' }, null);
    expect(subtitle).toContain('Periodo: 2026-08-01 a 2026-08-31');
  });

  it('returns undefined without args', () => {
    expect(buildReportSubtitle(null, null)).toBeUndefined();
  });
});

describe('parseNumeric / sumColumn — no more "$NaN" from hand-typed amounts', () => {
  it('parses raw Decimal strings, numbers and already-formatted amounts', () => {
    expect(parseNumeric('1797.00')).toBe(1797);
    expect(parseNumeric(2500.5)).toBe(2500.5);
    expect(parseNumeric('$1,797.00 MXN')).toBe(1797);
    expect(parseNumeric('$ 5,210,244.55')).toBe(5210244.55);
    expect(parseNumeric('1.797,00')).toBe(1797);
    expect(parseNumeric('-$20,800.00')).toBe(-20800);
  });

  it('returns null for text that is not a number', () => {
    expect(parseNumeric('')).toBeNull();
    expect(parseNumeric(null)).toBeNull();
    expect(parseNumeric('OMAR BARAJAS')).toBeNull();
    expect(parseNumeric('N/A')).toBeNull();
  });

  it('money() never prints NaN', () => {
    expect(money('$1,797.00')).toBe('$1,797.00');
    expect(money('abc')).toBe('abc');
    expect(money(undefined)).toBe('$0.00');
  });

  it('sums a column across mixed representations', () => {
    const rows = [{ total: '100.00' }, { total: '$250.50' }, { total: null }, { total: 'x' }];
    expect(sumColumn(rows, 'total')).toBe(350.5);
    expect(sumColumn([{ total: 'x' }], 'total')).toBeNull();
  });
});
