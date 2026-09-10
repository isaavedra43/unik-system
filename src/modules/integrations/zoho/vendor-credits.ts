import { z } from 'zod';
import { zohoGet } from './client';

const vendorCreditIdSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^\d+$/, 'vendorCreditId must be numeric');

interface ListVendorCreditsOptions {
  page?: number;
  perPage?: number;
  /** Column to sort by, e.g. 'last_modified_time', 'created_time'. */
  sortColumn?: string;
  /** Zoho API expects 'A' (ascending) or 'D' (descending). */
  sortOrder?: 'A' | 'D';
}

/**
 * Fetches a page of Vendor Credits from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listVendorCredits(options?: ListVendorCreditsOptions): Promise<unknown> {
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

  return zohoGet('/vendorcredits', Object.keys(query).length > 0 ? query : undefined);
}

/**
 * Fetches a single Vendor Credit from Zoho Inventory by its vendorcredit_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getVendorCredit(vendorCreditId: string): Promise<unknown> {
  vendorCreditIdSchema.parse(vendorCreditId);
  return zohoGet(`/vendorcredits/${vendorCreditId}`);
}
