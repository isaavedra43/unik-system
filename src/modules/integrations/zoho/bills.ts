import { z } from 'zod';
import { zohoGet } from './client';

const billIdSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^\d+$/, 'billId must be numeric');

interface ListBillsOptions {
  page?: number;
  perPage?: number;
  /** Column to sort by, e.g. 'last_modified_time', 'created_time'. */
  sortColumn?: string;
  /** Zoho API expects 'A' (ascending) or 'D' (descending). */
  sortOrder?: 'A' | 'D';
}

/**
 * Fetches a page of Bills (vendor invoices) from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listBills(options?: ListBillsOptions): Promise<unknown> {
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

  return zohoGet('/bills', Object.keys(query).length > 0 ? query : undefined);
}

/**
 * Fetches a single Bill from Zoho Inventory by its bill_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getBill(billId: string): Promise<unknown> {
  billIdSchema.parse(billId);
  return zohoGet(`/bills/${billId}`);
}
