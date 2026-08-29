import { z } from 'zod';
import { zohoGet } from './client';

const salesOrderIdSchema = z.string().min(1).max(30).regex(/^\d+$/, 'salesOrderId must be numeric');

/**
 * Fetches the list of Sales Orders from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listSalesOrders(): Promise<unknown> {
  return zohoGet('/salesorders');
}

/**
 * Fetches a single Sales Order from Zoho Inventory by its salesorder_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getSalesOrder(salesOrderId: string): Promise<unknown> {
  salesOrderIdSchema.parse(salesOrderId);

  return zohoGet(`/salesorders/${salesOrderId}`);
}
