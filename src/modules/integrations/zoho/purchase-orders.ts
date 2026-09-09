import { z } from 'zod';
import { zohoGet } from './client';

const purchaseOrderIdSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^\d+$/, 'purchaseOrderId must be numeric');

export interface ListPurchaseOrdersOptions {
  page?: number;
  perPage?: number;
  /** Column to sort by, e.g. 'last_modified_time', 'created_time'. */
  sortColumn?: string;
  /** Zoho API expects 'A' (ascending) or 'D' (descending). */
  sortOrder?: 'A' | 'D';
}

/**
 * Fetches a page of Purchase Orders from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listPurchaseOrders(options?: ListPurchaseOrdersOptions): Promise<unknown> {
  const query: Record<string, string> = {};

  if (options?.page !== undefined) {
    query.page = String(options.page);
  }

  if (options?.perPage !== undefined) {
    query.per_page = String(options.perPage);
  }

  if (options?.sortColumn) {
    query.sort_column = options.sortColumn;
  }

  if (options?.sortOrder) {
    query.sort_order = options.sortOrder;
  }

  return zohoGet('/purchaseorders', Object.keys(query).length > 0 ? query : undefined);
}

/**
 * Fetches a single Purchase Order from Zoho Inventory by its purchaseorder_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getPurchaseOrder(purchaseOrderId: string): Promise<unknown> {
  purchaseOrderIdSchema.parse(purchaseOrderId);
  return zohoGet(`/purchaseorders/${purchaseOrderId}`);
}
