import { describe, it, expect } from 'vitest';
import {
  getQuoteStatusConfig,
  getQuoteExpiryInfo,
  isQuoteEditable,
  canMarkSent,
  canDecide,
  toDateInputValue,
} from './quotes-helpers';
import { quoteFormInputSchema, estimateTotals } from './quotes-form-schema';

describe('quotes-helpers status', () => {
  it('maps Zoho statuses to Spanish labels', () => {
    expect(getQuoteStatusConfig('draft').label).toBe('Borrador');
    expect(getQuoteStatusConfig('Sent').label).toBe('Enviada');
    expect(getQuoteStatusConfig('accepted').tone).toBe('success');
    expect(getQuoteStatusConfig(null).label).toBe('—');
    expect(getQuoteStatusConfig('something_new').label).toBe('Something New');
  });

  it('respects Zoho edit / transition rules', () => {
    expect(isQuoteEditable('draft')).toBe(true);
    expect(isQuoteEditable('sent')).toBe(true);
    expect(isQuoteEditable('accepted')).toBe(false);
    expect(isQuoteEditable('invoiced')).toBe(false);
    expect(canMarkSent('draft')).toBe(true);
    expect(canMarkSent('sent')).toBe(false);
    expect(canDecide('sent')).toBe(true);
    expect(canDecide('draft')).toBe(false);
  });
});

describe('quotes-helpers expiry', () => {
  it('returns null for closed quotes or missing expiry', () => {
    expect(getQuoteExpiryInfo(null, 'sent')).toBeNull();
    expect(getQuoteExpiryInfo('2030-01-01', 'accepted')).toBeNull();
  });

  it('flags expired and soon-to-expire quotes', () => {
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    expect(getQuoteExpiryInfo(past, 'sent')?.tone).toBe('danger');
    expect(getQuoteExpiryInfo(soon, 'sent')?.tone).toBe('warning');
    expect(getQuoteExpiryInfo(far, 'draft')?.tone).toBe('success');
  });

  it('extracts yyyy-mm-dd for date inputs', () => {
    expect(toDateInputValue('2026-09-12T00:00:00.000Z')).toBe('2026-09-12');
    expect(toDateInputValue(null)).toBe('');
  });
});

describe('quote form schema', () => {
  const base = {
    requestKey: '11111111-2222-3333-4444-555555555555',
    customerId: '123',
    date: '2026-09-12',
    items: [{ name: 'Producto', quantity: 2, rate: 100 }],
  };

  it('accepts a minimal valid payload and never carries an estimate number', () => {
    const parsed = quoteFormInputSchema.parse(base);
    expect(parsed.discountMode).toBe('none');
    expect('estimateNumber' in parsed).toBe(false);
  });

  it('rejects expiry before date and empty lines', () => {
    expect(() => quoteFormInputSchema.parse({ ...base, expiryDate: '2026-09-01' })).toThrow();
    expect(() => quoteFormInputSchema.parse({ ...base, items: [] })).toThrow();
    expect(() => quoteFormInputSchema.parse({ ...base, items: [{ name: 'x', quantity: 0, rate: 1 }] })).toThrow();
  });

  it('previews totals with entity and line discounts', () => {
    const entity = estimateTotals({
      items: [{ quantity: 2, rate: 100, taxPercent: 16 }],
      discountMode: 'entity', discountValue: 10, discountIsPercent: true, shippingCharge: 50, adjustment: 0,
    });
    expect(entity.subTotal).toBe(180);
    expect(entity.taxTotal).toBeCloseTo(28.8, 2);
    expect(entity.total).toBeCloseTo(258.8, 2);

    const line = estimateTotals({
      items: [{ quantity: 1, rate: 200, discountPercent: 50, taxPercent: 0 }],
      discountMode: 'item', discountIsPercent: true,
    });
    expect(line.subTotal).toBe(100);
    expect(line.discountTotal).toBe(100);
  });
});
