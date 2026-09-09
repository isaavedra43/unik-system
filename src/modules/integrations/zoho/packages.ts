import { z } from 'zod';
import { zohoGet } from './client';

const packageIdSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^\d+$/, 'packageId must be numeric');

export interface ListPackagesOptions {
  page?: number;
  perPage?: number;
  /** Column to sort by, e.g. 'last_modified_time', 'created_time'. */
  sortColumn?: string;
  /** Zoho API expects 'A' (ascending) or 'D' (descending). */
  sortOrder?: 'A' | 'D';
  /** Filter packages for a specific sales order. */
  salesorderId?: string;
}

/**
 * Fetches a page of Packages from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listPackages(options?: ListPackagesOptions): Promise<unknown> {
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

  if (options?.salesorderId) {
    query.salesorder_id = options.salesorderId;
  }

  return zohoGet('/packages', Object.keys(query).length > 0 ? query : undefined);
}

/**
 * Fetches a single Package from Zoho Inventory by its package_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getPackage(packageId: string): Promise<unknown> {
  packageIdSchema.parse(packageId);

  return zohoGet(`/packages/${packageId}`);
}
