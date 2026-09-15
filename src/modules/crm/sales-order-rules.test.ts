import { describe, expect, it } from 'vitest';
import {
  buildMockSalesOrderResponse,
  buildSalesOrderPayload,
  compareSalesOrderReadback,
  describeReadbackDifferences,
  expectedSalesOrderFromQuote,
  extractSalesOrderReadback,
  normalizeLineDiscount,
  orderDateFor,
  quoteConversionBlocker,
  readbackModifiedAt,
  type QuoteLineRow,
  type QuoteRow,
} from './sales-order-rules';

/** Accepted quote → sales order: convertibility, POST body, mock response and read-back comparison. */

const line = (overrides: Partial<QuoteLineRow> = {}): QuoteLineRow => ({
  zohoItemId: '4600000400',
  sku: 'POR-6060',
  name: 'Porcelanato 60x60',
  description: null,
  quantity: '15',
  rate: '320',
  unit: 'm2',
  discount: null,
  discountAmount: null,
  taxId: 'tax-iva',
  taxName: 'IVA',
  taxPercentage: '16',
  taxAmount: '768',
  lineTotal: '4800',
  sortOrder: 0,
  ...overrides,
});

const quote = (overrides: Partial<QuoteRow> = {}): QuoteRow => ({
  id: 'quote-1',
  zohoEstimateId: '4600009001',
  estimateNumber: 'COT-00042',
  status: 'accepted',
  zohoCustomerId: '4600000300',
  customerName: 'Constructora Norte',
  currencyCode: 'MXN',
  salespersonId: '4600000777',
  salespersonName: 'Ana López',
  discount: null,
  discountType: 'entity_level',
  isDiscountBeforeTax: true,
  shippingCharge: '0',
  adjustment: null,
  adjustmentDescription: null,
  notes: 'Entrega en obra',
  terms: null,
  subTotal: '4800',
  taxTotal: '768',
  discountTotal: '0',
  total: '5568',
  createdByUserId: 'u-ana',
  items: [line()],
  ...overrides,
});

describe('quoteConversionBlocker', () => {
  it('accepts an accepted quote with customer and lines', () => {
    expect(quoteConversionBlocker(quote())).toBeNull();
  });

  it('rejects quotes that are not accepted, without customer, lines or quantities', () => {
    expect(quoteConversionBlocker(quote({ status: 'sent' }))).toBe(
      'La cotización COT-00042 está «Enviada»: sólo una cotización aceptada se convierte en orden de venta'
    );
    expect(quoteConversionBlocker(quote({ status: null }))).toContain('«sin estado»');
    expect(quoteConversionBlocker(quote({ zohoCustomerId: null }))).toBe('La cotización COT-00042 no tiene un cliente de Zoho');
    expect(quoteConversionBlocker(quote({ items: [] }))).toBe('La cotización COT-00042 no tiene conceptos');
    expect(quoteConversionBlocker(quote({ items: [line({ quantity: '0' })] }))).toContain('«Porcelanato 60x60»');
  });
});

describe('buildSalesOrderPayload', () => {
  it('maps customer, reference, salesperson, lines and notes without folios', () => {
    const payload = buildSalesOrderPayload(quote(), '2026-09-15');
    expect(payload).toEqual({
      customer_id: '4600000300',
      date: '2026-09-15',
      reference_number: 'COT-00042',
      salesperson_id: '4600000777',
      salesperson_name: 'Ana López',
      notes: 'Entrega en obra',
      is_discount_before_tax: true,
      discount_type: 'entity_level',
      line_items: [
        { item_id: '4600000400', name: 'Porcelanato 60x60', quantity: 15, rate: 320, unit: 'm2', tax_id: 'tax-iva', item_order: 1 },
      ],
    });
    expect(payload).not.toHaveProperty('salesorder_number');
  });

  it('sends the entity discount as a percentage and non-zero charges', () => {
    const payload = buildSalesOrderPayload(
      quote({ discount: '10', shippingCharge: '350', adjustment: '-20', adjustmentDescription: 'Redondeo' }),
      '2026-09-15'
    );
    expect(payload).toMatchObject({ discount: '10%', shipping_charge: 350, adjustment: -20, adjustment_description: 'Redondeo' });
  });

  it('sends item-level discounts per line, sorted by the quote order', () => {
    const payload = buildSalesOrderPayload(
      quote({
        discountType: 'item_level',
        discount: '10',
        items: [line({ name: 'B', sortOrder: 1, discount: '150' }), line({ name: 'A', sortOrder: 0, discount: '5%' })],
      }),
      '2026-09-15'
    );
    expect(payload).not.toHaveProperty('discount');
    expect(payload.discount_type).toBe('item_level');
    expect(payload.line_items.map((l) => [l.name, l.discount, l.item_order])).toEqual([
      ['A', '5%', 1],
      ['B', 150, 2],
    ]);
  });

  it('normalizes line discounts', () => {
    expect(normalizeLineDiscount(null)).toBeUndefined();
    expect(normalizeLineDiscount('0%')).toBeUndefined();
    expect(normalizeLineDiscount('12.5%')).toBe('12.5%');
    expect(normalizeLineDiscount('80')).toBe(80);
    expect(normalizeLineDiscount('abc')).toBeUndefined();
  });
});

describe('mock response and read-back', () => {
  const now = new Date('2026-09-15T18:00:00.000Z');
  const payload = buildSalesOrderPayload(quote(), '2026-09-15');
  const response = buildMockSalesOrderResponse({ payload, quote: quote(), salesOrderId: '91757959200001', salesOrderNumber: 'SO-MOCK-00001', now });

  it('simulates a confirmed order with the quote totals', () => {
    expect(response.salesorder).toMatchObject({
      salesorder_id: '91757959200001',
      salesorder_number: 'SO-MOCK-00001',
      reference_number: 'COT-00042',
      order_status: 'confirmed',
      customer_id: '4600000300',
      customer_name: 'Constructora Norte',
      total: 5568,
      sub_total: 4800,
      tax_total: 768,
      created_time: now.toISOString(),
    });
    expect((response.salesorder.line_items as Array<Record<string, unknown>>)[0]).toMatchObject({
      item_id: '4600000400',
      quantity: 15,
      rate: 320,
      item_total: 4800,
      tax_percentage: 16,
    });
  });

  it('extracts the read-back from the wrapper or the order itself', () => {
    expect(extractSalesOrderReadback(response)?.salesorder_id).toBe('91757959200001');
    expect(extractSalesOrderReadback(response.salesorder)?.salesorder_number).toBe('SO-MOCK-00001');
    expect(extractSalesOrderReadback({ code: 1001, message: 'error' })).toBeNull();
    expect(extractSalesOrderReadback({ code: 0, salesorder: { salesorder_number: 'x' } })).toBeNull();
    expect(extractSalesOrderReadback([response])).toBeNull();
    expect(extractSalesOrderReadback(null)).toBeNull();
  });

  it('uses Zoho last_modified_time or the fallback', () => {
    expect(readbackModifiedAt({ last_modified_time: '2026-09-15T10:00:00-0600' }, now).toISOString()).toBe('2026-09-15T16:00:00.000Z');
    expect(readbackModifiedAt({ last_modified_time: 'nope' }, now)).toBe(now);
    expect(readbackModifiedAt({}, now)).toBe(now);
  });

  it('finds no difference for a faithful order and tolerates rounding', () => {
    const expected = expectedSalesOrderFromQuote(quote());
    expect(compareSalesOrderReadback(expected, extractSalesOrderReadback(response)!)).toEqual([]);
    expect(compareSalesOrderReadback(expected, { ...extractSalesOrderReadback(response)!, total: 5568.9 })).toEqual([]);
  });

  it('reports customer, reference, lines, quantities and total differences', () => {
    const expected = expectedSalesOrderFromQuote(quote({ items: [line(), line({ zohoItemId: '4600000401', quantity: '2', sortOrder: 1 })] }));
    const readback = {
      salesorder_id: '1',
      customer_id: '999',
      reference_number: 'OTRA',
      total: 4000,
      line_items: [{ item_id: '4600000400', quantity: 12 }],
    };
    const diffs = compareSalesOrderReadback(expected, readback);
    expect(diffs.map((d) => d.field)).toEqual(['customer', 'reference', 'line_count', 'line_quantity', 'total']);
    expect(describeReadbackDifferences(diffs)).toContain('Cantidad del concepto 1: esperado 15, Zoho 12');
    const swapped = compareSalesOrderReadback(expectedSalesOrderFromQuote(quote()), { salesorder_id: '1', customer_id: '4600000300', reference_number: 'COT-00042', total: 5568, line_items: [{ item_id: '777', quantity: 15 }] });
    expect(swapped).toEqual([{ field: 'line_item', label: 'Producto del concepto 1', expected: '4600000400', actual: '777', line: 1 }]);
  });

  it('computes the order date in Mexico City', () => {
    expect(orderDateFor(new Date('2026-09-16T03:00:00.000Z'))).toBe('2026-09-15');
  });
});

describe('entityDiscountFor', () => {
  it.each([
    [{ discount: 10, discountTotal: 100, subTotal: 1000, taxTotal: 160, discountType: 'entity_level' }, '10%'],
    [{ discount: 10, discountTotal: 116, subTotal: 1000, taxTotal: 160, discountType: 'entity_level' }, '10%'],
    [{ discount: 5000, discountTotal: 5000, subTotal: 80000, taxTotal: 0, discountType: 'entity_level' }, 5000],
    [{ discount: 50, discountTotal: 50, subTotal: 2000, taxTotal: 0, discountType: 'entity_level' }, 50],
    [{ discount: 12.5, discountTotal: null, subTotal: 1000, taxTotal: 0, discountType: null }, '12.5%'],
    [{ discount: 300, discountTotal: null, subTotal: 1000, taxTotal: 0, discountType: null }, 300],
    [{ discount: 0, discountTotal: 0, subTotal: 1000, taxTotal: 0, discountType: 'entity_level' }, null],
    [{ discount: 10, discountTotal: 100, subTotal: 1000, taxTotal: 0, discountType: 'item_level' }, null],
  ])('%j → %s', async (quote, expected) => {
    const { entityDiscountFor } = await import('./sales-order-rules');
    expect(entityDiscountFor(quote as never)).toBe(expected);
  });
});
