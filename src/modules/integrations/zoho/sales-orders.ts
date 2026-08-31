import { z } from 'zod';
import { zohoGet } from './client';

const salesOrderIdSchema = z.string().min(1).max(30).regex(/^\d+$/, 'salesOrderId must be numeric');

export interface ListSalesOrdersOptions {
  page?: number;
  perPage?: number;
}

/**
 * Fetches a page of Sales Orders from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 * Calling it without options preserves the original unpaginated behaviour.
 */
export async function listSalesOrders(options?: ListSalesOrdersOptions): Promise<unknown> {
  const query: Record<string, string> = {};

  if (options?.page !== undefined) {
    query.page = String(options.page);
  }

  if (options?.perPage !== undefined) {
    query.per_page = String(options.perPage);
  }

  return zohoGet('/salesorders', Object.keys(query).length > 0 ? query : undefined);
}

/**
 * Fetches a single Sales Order from Zoho Inventory by its salesorder_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getSalesOrder(salesOrderId: string): Promise<unknown> {
  salesOrderIdSchema.parse(salesOrderId);

  return zohoGet(`/salesorders/${salesOrderId}`);
}
