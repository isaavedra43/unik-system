import { describe, expect, it } from 'vitest';
import { balanceGap, parsePageParams, parseVendorTransactionType } from './vendor-profile-helpers';

describe('vendor profile helpers', () => {
  it('accepts only known transaction types', () => {
    expect(parseVendorTransactionType('purchase_orders')).toBe('purchase_orders');
    expect(parseVendorTransactionType('vendor_credits')).toBe('vendor_credits');
    expect(parseVendorTransactionType('invoices')).toBeNull();
    expect(parseVendorTransactionType(null)).toBeNull();
  });

  it('clamps paging', () => {
    expect(parsePageParams(null, null)).toEqual({ page: 1, pageSize: 25 });
    expect(parsePageParams('3', '500')).toEqual({ page: 3, pageSize: 100 });
    expect(parsePageParams('-2', '1')).toEqual({ page: 1, pageSize: 10 });
  });

  it('reports a balance gap only beyond the tolerance', () => {
    expect(balanceGap('516420.00', '330915.00')).toBe(185505);
    expect(balanceGap('1000.40', '1000')).toBeNull();
    expect(balanceGap(null, '10')).toBeNull();
  });
});
