import { z } from 'zod';
import { zohoGet } from './client';

const contactIdSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^\d+$/, 'contactId must be numeric');

export interface ListVendorsOptions {
  page?: number;
  perPage?: number;
}

/**
 * Fetches a page of Vendors from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listVendors(options?: ListVendorsOptions): Promise<unknown> {
  const query: Record<string, string> = { contact_type: 'vendor' };

  if (options?.page !== undefined) {
    query.page = String(options.page);
  }

  if (options?.perPage !== undefined) {
    query.per_page = String(options.perPage);
  }

  return zohoGet('/contacts', query);
}

/**
 * Fetches a single Vendor (contact) from Zoho Inventory by its contact_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getVendor(contactId: string): Promise<unknown> {
  contactIdSchema.parse(contactId);

  return zohoGet(`/contacts/${contactId}`);
}
