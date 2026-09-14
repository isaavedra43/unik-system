import { describe, expect, it, vi } from 'vitest';

// The quick scan depends on these exact Zoho query params: newest documents by `date`
// and only OPEN documents for the balance refresh pass.
vi.mock('./client', () => ({ zohoGet: vi.fn(async (path: string, query?: Record<string, string>) => ({ path, query })) }));

describe('quick-scan adapters ask Zoho for recent and open documents', () => {
  it('bills: date desc + Status.Unpaid', async () => {
    const { billsAdapter } = await import('./bills-sync');
    expect(await billsAdapter.listRecentPage!({ page: 1, perPage: 200 })).toEqual({ path: '/bills', query: { page: '1', per_page: '200', sort_column: 'date', sort_order: 'D' } });
    expect(await billsAdapter.listOpenPage!({ page: 2, perPage: 200 })).toEqual({ path: '/bills', query: { page: '2', per_page: '200', filter_by: 'Status.Unpaid' } });
  });

  it('vendor credits: date desc + Status.Open', async () => {
    const { vendorCreditsAdapter } = await import('./vendor-credits-sync');
    expect((await vendorCreditsAdapter.listRecentPage!({ page: 1, perPage: 200 })) as object).toMatchObject({ query: { sort_column: 'date', sort_order: 'D' } });
    expect((await vendorCreditsAdapter.listOpenPage!({ page: 1, perPage: 200 })) as object).toMatchObject({ query: { filter_by: 'Status.Open' } });
  });

  it('invoices, purchase orders and payments expose the recent pass', async () => {
    const { invoicesAdapter } = await import('./invoices-sync');
    const { purchaseOrdersAdapter } = await import('./purchase-orders-sync');
    const { paymentsAdapter } = await import('./payments-sync');
    for (const adapter of [invoicesAdapter, purchaseOrdersAdapter, paymentsAdapter]) {
      expect((await adapter.listRecentPage!({ page: 1, perPage: 50 })) as object).toMatchObject({ query: { sort_column: 'date', sort_order: 'D', per_page: '50' } });
    }
    expect((await purchaseOrdersAdapter.listOpenPage!({ page: 1, perPage: 50 })) as object).toMatchObject({ query: { filter_by: 'Status.Issued' } });
    expect(paymentsAdapter.listOpenPage).toBeUndefined();
  });
});
