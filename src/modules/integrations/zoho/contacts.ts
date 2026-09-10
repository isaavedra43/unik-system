import { z } from 'zod';
import { zohoGet } from './client';

const contactIdSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^\d+$/, 'contactId must be numeric');

interface ListContactsOptions {
  page?: number;
  perPage?: number;
  /** Column to sort by, e.g. 'last_modified_time', 'created_time'. */
  sortColumn?: string;
  /** Zoho API expects 'A' (ascending) or 'D' (descending). */
  sortOrder?: 'A' | 'D';
  /** Filter by contact type: 'customer' or 'vendor'. Omit for all. */
  contactType?: 'customer' | 'vendor';
}

/**
 * Fetches a page of Contacts (customers + vendors) from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 *
 * When `contactType` is omitted, both customers and vendors are returned.
 * When `sortColumn` is 'last_modified_time' and `sortOrder` is 'D',
 * the most recently modified records appear on page 1.
 */
export async function listContacts(options?: ListContactsOptions): Promise<unknown> {
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

  if (options?.contactType) {
    query.contact_type = options.contactType;
  }

  return zohoGet('/contacts', Object.keys(query).length > 0 ? query : undefined);
}

/**
 * Fetches a single Contact from Zoho Inventory by its contact_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getContact(contactId: string): Promise<unknown> {
  contactIdSchema.parse(contactId);
  return zohoGet(`/contacts/${contactId}`);
}

/**
 * Fetches a page of Vendors from Zoho Inventory.
 * Convenience wrapper around listContacts with contactType='vendor'.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listVendors(options?: {
  page?: number;
  perPage?: number;
}): Promise<unknown> {
  return listContacts({
    ...options,
    contactType: 'vendor',
  });
}

/**
 * Fetches a single Vendor (contact) from Zoho Inventory by its contact_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getVendor(contactId: string): Promise<unknown> {
  contactIdSchema.parse(contactId);
  return zohoGet(`/contacts/${contactId}`);
}
