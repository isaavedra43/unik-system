import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { normalizeQuoteItems } from './quotes-tools';

describe('normalizeQuoteItems', () => {
  it('maps the aliases the model uses and never sends line_item_id on create', () => {
    const [line] = normalizeQuoteItems([{ lineItemId: '4459650000005734021', qty: 20, price: 349, description: 'Piel de Elefante Cafe 10xLL' }]);
    expect(line.lineItemId).toBeNull();
    expect(line.itemId).toBe('4459650000005734021');
    expect(line.name).toBe('Piel de Elefante Cafe 10xLL');
    expect(line.quantity).toBe(20);
    expect(line.rate).toBe(349);
  });

  it('keeps lineItemId only when updating and defaults sensibly', () => {
    const [edit] = normalizeQuoteItems([{ line_item_id: 'L1', item_id: 'I1', productName: 'Loseta', cantidad: 2, precio: 10 }], { forUpdate: true });
    expect(edit.lineItemId).toBe('L1');
    expect(edit.itemId).toBe('I1');
    expect(edit.name).toBe('Loseta');
    const [bare] = normalizeQuoteItems([{ sku: 'PE-10XLL' }]);
    expect(bare.name).toBe('PE-10XLL');
    expect(bare.quantity).toBe(1);
    expect(bare.rate).toBe(0);
  });
});
