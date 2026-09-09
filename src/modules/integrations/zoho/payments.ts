import { z } from 'zod';
import { zohoGet } from './client';

const paymentIdSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^\d+$/, 'paymentId must be numeric');

export interface ListCustomerPaymentsOptions {
  page?: number;
  perPage?: number;
  /** Column to sort by, e.g. 'last_modified_time', 'created_time'. */
  sortColumn?: string;
  /** Zoho API expects 'A' (ascending) or 'D' (descending). */
  sortOrder?: 'A' | 'D';
}

/**
 * Fetches a page of Customer Payments from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listCustomerPayments(options?: ListCustomerPaymentsOptions): Promise<unknown> {
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

  return zohoGet('/customerpayments', Object.keys(query).length > 0 ? query : undefined);
}

/**
 * Fetches a single Customer Payment from Zoho Inventory by its payment_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getCustomerPayment(paymentId: string): Promise<unknown> {
  paymentIdSchema.parse(paymentId);

  return zohoGet(`/customerpayments/${paymentId}`);
}
