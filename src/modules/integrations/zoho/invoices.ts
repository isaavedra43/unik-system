import { z } from 'zod';
import { zohoGet } from './client';

const invoiceIdSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^\d+$/, 'invoiceId must be numeric');

interface ListInvoicesOptions {
  page?: number;
  perPage?: number;
  /** Column to sort by, e.g. 'last_modified_time', 'created_time'. */
  sortColumn?: string;
  /** Zoho API expects 'A' (ascending) or 'D' (descending). */
  sortOrder?: 'A' | 'D';
}

/**
 * Fetches a page of Invoices from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listInvoices(options?: ListInvoicesOptions): Promise<unknown> {
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

  return zohoGet('/invoices', Object.keys(query).length > 0 ? query : undefined);
}

/**
 * Fetches a single Invoice from Zoho Inventory by its invoice_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getInvoice(invoiceId: string): Promise<unknown> {
  invoiceIdSchema.parse(invoiceId);

  return zohoGet(`/invoices/${invoiceId}`);
}

/**
 * Fetches the payments applied to a single Invoice.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listInvoicePayments(invoiceId: string): Promise<unknown> {
  invoiceIdSchema.parse(invoiceId);

  return zohoGet(`/invoices/${invoiceId}/payments`);
}
