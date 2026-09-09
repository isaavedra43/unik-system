import { z } from 'zod';
import { zohoGet } from './client';

const itemIdSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^\d+$/, 'itemId must be numeric');

export interface ListItemsOptions {
  page?: number;
  perPage?: number;
  /** Column to sort by, e.g. 'last_modified_time', 'created_time'. */
  sortColumn?: string;
  /** Zoho API expects 'A' (ascending) or 'D' (descending). */
  sortOrder?: 'A' | 'D';
}

/**
 * Fetches a page of Items (products) from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listItems(options?: ListItemsOptions): Promise<unknown> {
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

  return zohoGet('/items', Object.keys(query).length > 0 ? query : undefined);
}

/**
 * Fetches a single Item (product) from Zoho Inventory by its item_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getItem(itemId: string): Promise<unknown> {
  itemIdSchema.parse(itemId);

  return zohoGet(`/items/${itemId}`);
}

/**
 * Fetches detailed information for multiple items in a single API call
 * using the bulk /itemdetails endpoint.
 *
 * The batch size is configurable via the `batchSize` parameter.
 * Zoho accepts a comma-separated list of item_ids in the `item_ids` query param.
 *
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listItemDetails(
  itemIds: string[],
  batchSize?: number
): Promise<unknown> {
  if (itemIds.length === 0) {
    return { code: 0, message: 'success', itemdetails: [] };
  }

  // Validate all IDs
  for (const id of itemIds) {
    itemIdSchema.parse(id);
  }

  const ids = batchSize && batchSize > 0 ? itemIds.slice(0, batchSize) : itemIds;
  const query: Record<string, string> = {
    item_ids: ids.join(','),
  };

  return zohoGet('/itemdetails', query);
}
