import { describe, expect, it } from 'vitest';
import {
  extractInvoiceRefs,
  manualAllocationIssues,
  matchPayment,
  orderFifo,
  remainingToApply,
  type PaymentToMatch,
  type ReceivableCandidate,
} from './collections-matcher';

const receivable = (overrides: Partial<ReceivableCandidate> & { obligationId: string }): ReceivableCandidate => ({
  number: `OB-${overrides.obligationId}`,
  zohoContactId: 'C1',
  zohoSalesOrderId: null,
  currency: 'MXN',
  remaining: '1000',
  dueKey: '2026-09-10',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...overrides,
});

const payment = (overrides: Partial<PaymentToMatch> = {}): PaymentToMatch => ({
  zohoPaymentId: 'P1',
  amount: '1000',
  applied: '0',
  currency: 'MXN',
  zohoCustomerId: 'C1',
  invoiceSalesOrderIds: [],
  ...overrides,
});

const allocations = (outcome: ReturnType<typeof matchPayment>) =>
  'allocations' in outcome ? outcome.allocations.map((a) => [a.obligationId, a.amount.toFixed(2)]) : [];

describe('matchPayment', () => {
  it('does nothing when the payment is already applied', () => {
    expect(matchPayment(payment({ applied: '1000' }), [receivable({ obligationId: 'a' })]).status).toBe('nothing_to_apply');
    expect(remainingToApply({ amount: '1000', applied: '-200' }).toFixed(2)).toBe('1200.00');
  });

  it('invoice link: the orders of the invoices take it FIFO even when older receivables exist', () => {
    const outcome = matchPayment(payment({ amount: '1500', invoiceSalesOrderIds: ['SO-9'] }), [
      receivable({ obligationId: 'older', dueKey: '2026-08-01', remaining: '1500' }),
      receivable({ obligationId: 'so9', zohoSalesOrderId: 'SO-9', remaining: '1500' }),
    ]);
    expect(outcome).toMatchObject({ status: 'matched', rule: 'invoice' });
    expect(allocations(outcome)).toEqual([['so9', '1500.00']]);
  });

  it('invoice link: an excess or orders without balance are ambiguous', () => {
    const excess = matchPayment(payment({ amount: '1600', invoiceSalesOrderIds: ['SO-9'] }), [
      receivable({ obligationId: 'so9', zohoSalesOrderId: 'SO-9', remaining: '1500' }),
    ]);
    expect(excess).toMatchObject({ status: 'ambiguous' });
    expect(allocations(excess)).toEqual([['so9', '1500.00']]);
    expect(excess.status === 'ambiguous' && excess.remainder.toFixed(2)).toBe('100.00');
    const none = matchPayment(payment({ invoiceSalesOrderIds: ['SO-X'] }), [receivable({ obligationId: 'a' })]);
    expect(none).toMatchObject({ status: 'ambiguous', allocations: [] });
  });

  it('without a customer it cannot be matched', () => {
    expect(matchPayment(payment({ zohoCustomerId: null }), [receivable({ obligationId: 'a' })])).toMatchObject({ status: 'unmatched' });
  });

  it('customer without open receivables (other currency ignored) is unmatched', () => {
    expect(
      matchPayment(payment(), [
        receivable({ obligationId: 'usd', currency: 'USD' }),
        receivable({ obligationId: 'other', zohoContactId: 'C2' }),
        receivable({ obligationId: 'paid', remaining: '0' }),
      ])
    ).toMatchObject({ status: 'unmatched' });
  });

  it('a single receivable with the exact balance takes it over FIFO', () => {
    const outcome = matchPayment(payment({ amount: '750' }), [
      receivable({ obligationId: 'oldest', dueKey: '2026-08-01', remaining: '2000' }),
      receivable({ obligationId: 'exact', dueKey: '2026-09-30', remaining: '750.004' }),
    ]);
    expect(outcome).toMatchObject({ status: 'matched', rule: 'exact_amount' });
    expect(allocations(outcome)).toEqual([['exact', '750.00']]);
  });

  it('several receivables with the exact balance are ambiguous', () => {
    expect(
      matchPayment(payment({ amount: '1500' }), [
        receivable({ obligationId: 'a', remaining: '1500' }),
        receivable({ obligationId: 'b', remaining: '1500' }),
      ])
    ).toMatchObject({ status: 'ambiguous', allocations: [] });
  });

  it('FIFO spreads one payment over several receivables (due date, then creation)', () => {
    const outcome = matchPayment(payment({ amount: '5000' }), [
      receivable({ obligationId: 'late', dueKey: '2026-09-30', remaining: '2500' }),
      receivable({ obligationId: 'undated', dueKey: null, remaining: '9000' }),
      receivable({ obligationId: 'early', dueKey: '2026-09-05', remaining: '3000' }),
    ]);
    expect(outcome).toMatchObject({ status: 'matched', rule: 'fifo' });
    expect(allocations(outcome)).toEqual([
      ['early', '3000.00'],
      ['late', '2000.00'],
    ]);
  });

  it('an overpayment applies everything pending and flags the remainder', () => {
    const outcome = matchPayment(payment({ amount: '2500', applied: '0' }), [
      receivable({ obligationId: 'a', remaining: '1000' }),
      receivable({ obligationId: 'b', remaining: '1000', dueKey: '2026-09-11' }),
    ]);
    expect(outcome.status).toBe('ambiguous');
    expect(allocations(outcome)).toEqual([
      ['a', '1000.00'],
      ['b', '1000.00'],
    ]);
    expect(outcome.status === 'ambiguous' && outcome.remainder.toFixed(2)).toBe('500.00');
  });

  it('matches only the unapplied remainder of a payment already split', () => {
    const outcome = matchPayment(payment({ amount: '5000', applied: '3000' }), [receivable({ obligationId: 'b', remaining: '2000' })]);
    expect(allocations(outcome)).toEqual([['b', '2000.00']]);
  });
});

describe('helpers', () => {
  it('orders FIFO with undated last', () => {
    const rows = orderFifo([
      receivable({ obligationId: 'n', dueKey: null }),
      receivable({ obligationId: 'b', dueKey: '2026-09-10', createdAt: new Date('2026-09-02') }),
      receivable({ obligationId: 'a', dueKey: '2026-09-10', createdAt: new Date('2026-09-01') }),
      receivable({ obligationId: 'z', dueKey: '2026-09-01' }),
    ]);
    expect(rows.map((r) => r.obligationId)).toEqual(['z', 'a', 'b', 'n']);
  });

  it('validates manual assignments', () => {
    const candidates = new Map([
      ['a', { number: 'OB-a', currency: 'MXN', remaining: '600', kind: 'receivable' }],
      ['p', { number: 'OB-p', currency: 'MXN', remaining: '600', kind: 'payable' }],
      ['u', { number: 'OB-u', currency: 'USD', remaining: '600', kind: 'receivable' }],
    ]);
    const pay = { amount: '1000', applied: '500', currency: 'MXN' };
    expect(manualAllocationIssues(pay, [{ obligationId: 'a', amount: '500' }], candidates)).toEqual([]);
    expect(manualAllocationIssues(pay, [{ obligationId: 'a', amount: '500.01' }], candidates)).toEqual([
      'La asignación excede lo que queda por aplicar del pago',
    ]);
    expect(manualAllocationIssues(pay, [{ obligationId: 'a', amount: '601' }], candidates)).toContain('El importe para OB-a excede su saldo pendiente');
    expect(manualAllocationIssues(pay, [{ obligationId: 'p', amount: '1' }], candidates)).toContain('OB-p no es una cuenta por cobrar');
    expect(manualAllocationIssues(pay, [{ obligationId: 'u', amount: '1' }], candidates)).toContain('OB-u está en otra moneda');
    expect(manualAllocationIssues(pay, [{ obligationId: 'x', amount: '1' }], candidates)).toContain('Una obligación no existe');
    expect(manualAllocationIssues(pay, [{ obligationId: 'a', amount: '1' }, { obligationId: 'a', amount: '1' }], candidates)).toContain(
      'Una obligación aparece dos veces'
    );
    expect(manualAllocationIssues(pay, [], candidates)).toContain('Indica al menos una obligación');
  });

  it('extracts invoice references from both Zoho payload shapes', () => {
    expect(
      extractInvoiceRefs({ invoices: [{ invoice_id: 123, invoice_number: 'INV-1' }, { invoice_id: '', invoice_number: ' INV-2 ' }, null] })
    ).toEqual({ invoiceIds: ['123'], invoiceNumbers: ['INV-1', 'INV-2'] });
    expect(extractInvoiceRefs({ invoice_numbers: 'INV-3, INV-4;INV-3' })).toEqual({ invoiceIds: [], invoiceNumbers: ['INV-3', 'INV-4'] });
    expect(extractInvoiceRefs(null)).toEqual({ invoiceIds: [], invoiceNumbers: [] });
  });
});

describe('overapplicationIssue', () => {
  it.each([
    [{ amount: '100', status: 'paid' }, '100', null],
    [{ amount: '100', status: 'paid' }, '0', null],
    [null, '0', null],
    [null, '50', 'missing'],
    [{ amount: '100', status: 'void' }, '100', 'void'],
    [{ amount: '100', status: 'Draft ' }, '10', 'void'],
    [{ amount: '60', status: null }, '100', 'over_applied'],
    [{ amount: '99.995', status: null }, '100', null],
    [{ amount: null, status: 'paid' }, '1', 'over_applied'],
  ])('payment %j with %s applied → %s', async (payment, applied, expected) => {
    const { overapplicationIssue } = await import('./collections-matcher');
    expect(overapplicationIssue(payment as { amount: string | null; status: string | null } | null, applied)).toBe(expected);
  });
});
