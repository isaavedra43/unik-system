import { z } from 'zod';
import {
  zohoBooksGet,
  zohoBooksPost,
  zohoBooksPut,
  zohoBooksDelete,
  zohoBooksGetBinary,
} from './client';

/**
 * Zoho Books — Estimates (cotizaciones).
 * Docs: https://www.zoho.com/books/api/v3/estimates/
 *
 * All functions return the RAW JSON exactly as Zoho provides it. Business
 * normalization lives in `@/modules/quotes/quotes-normalizer`.
 *
 * Required OAuth scope on the refresh token: ZohoBooks.estimates.ALL
 * (plus ZohoBooks.contacts.READ and ZohoBooks.items.READ are recommended).
 */

const estimateIdSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^\d+$/, 'estimateId must be numeric');

export interface ListEstimatesOptions {
  page?: number;
  perPage?: number;
  /** Allowed by Zoho: customer_name, estimate_number, date, total, created_time. */
  sortColumn?: string;
  sortOrder?: 'A' | 'D';
  /** e.g. Status.All, Status.Sent, Status.Draft, Status.Accepted, Status.Declined, Status.Expired, Status.Invoiced */
  filterBy?: string;
  customerId?: string;
  searchText?: string;
  /** ISO timestamp — only estimates modified after this time (server-side filter). */
  lastModifiedTime?: string;
}

export async function listEstimates(options?: ListEstimatesOptions): Promise<unknown> {
  const query: Record<string, string> = {};
  if (options?.page !== undefined) query.page = String(options.page);
  if (options?.perPage !== undefined) query.per_page = String(options.perPage);
  if (options?.sortColumn) query.sort_column = options.sortColumn;
  if (options?.sortOrder) query.sort_order = options.sortOrder;
  if (options?.filterBy) query.filter_by = options.filterBy;
  if (options?.customerId) query.customer_id = options.customerId;
  if (options?.searchText) query.search_text = options.searchText;
  if (options?.lastModifiedTime) query.last_modified_time = options.lastModifiedTime;
  return zohoBooksGet('/estimates', Object.keys(query).length > 0 ? query : undefined);
}

export async function getEstimate(estimateId: string): Promise<unknown> {
  estimateIdSchema.parse(estimateId);
  return zohoBooksGet(`/estimates/${estimateId}`);
}

// ---------------------------------------------------------------------------
// Write payloads
// ---------------------------------------------------------------------------

export interface ZohoEstimateLineItemInput {
  /** Existing line id — required on update to keep the same line (otherwise Zoho replaces it). */
  line_item_id?: string;
  item_id?: string;
  name?: string;
  description?: string;
  quantity: number;
  rate: number;
  unit?: string;
  /** Percentage or absolute depending on discount_type of the estimate. */
  discount?: number | string;
  tax_id?: string;
  item_order?: number;
}

export interface ZohoEstimateWriteInput {
  customer_id: string;
  /** NEVER send estimate_number — Zoho auto-numbers to avoid folio collisions. */
  reference_number?: string;
  date?: string;
  expiry_date?: string;
  currency_id?: string;
  exchange_rate?: number;
  discount?: number | string;
  is_discount_before_tax?: boolean;
  discount_type?: 'entity_level' | 'item_level';
  is_inclusive_tax?: boolean;
  salesperson_name?: string;
  notes?: string;
  terms?: string;
  shipping_charge?: number;
  adjustment?: number;
  adjustment_description?: string;
  template_id?: string;
  custom_fields?: { customfield_id?: string; label?: string; value: unknown }[];
  line_items: ZohoEstimateLineItemInput[];
}

/**
 * Creates an estimate in Zoho Books. Zoho assigns `estimate_number` using
 * the organization's auto-numbering sequence, which is atomic on Zoho's side
 * — two users (Zoho UI + UNIK) can never receive the same folio.
 */
export async function createEstimate(input: ZohoEstimateWriteInput): Promise<unknown> {
  return zohoBooksPost('/estimates', input, { ignore_auto_number_generation: 'false' });
}

export async function updateEstimate(
  estimateId: string,
  input: ZohoEstimateWriteInput
): Promise<unknown> {
  estimateIdSchema.parse(estimateId);
  return zohoBooksPut(`/estimates/${estimateId}`, input);
}

export async function deleteEstimate(estimateId: string): Promise<unknown> {
  estimateIdSchema.parse(estimateId);
  return zohoBooksDelete(`/estimates/${estimateId}`);
}

export type ZohoEstimateStatusAction = 'sent' | 'accepted' | 'declined';

export async function markEstimateStatus(
  estimateId: string,
  status: ZohoEstimateStatusAction
): Promise<unknown> {
  estimateIdSchema.parse(estimateId);
  return zohoBooksPost(`/estimates/${estimateId}/status/${status}`);
}

export interface EmailEstimateInput {
  to_mail_ids: string[];
  cc_mail_ids?: string[];
  subject?: string;
  body?: string;
  send_from_org_email_id?: boolean;
}

/** Sends the estimate by e-mail using Zoho's own template and PDF. */
export async function emailEstimate(estimateId: string, input: EmailEstimateInput): Promise<unknown> {
  estimateIdSchema.parse(estimateId);
  return zohoBooksPost(`/estimates/${estimateId}/email`, input);
}

/** Returns the default e-mail content Zoho would use (subject/body/recipients). */
export async function getEstimateEmailContent(estimateId: string): Promise<unknown> {
  estimateIdSchema.parse(estimateId);
  return zohoBooksGet(`/estimates/${estimateId}/email`);
}

/** Downloads the official Zoho PDF for the estimate. */
export async function getEstimatePdf(
  estimateId: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  estimateIdSchema.parse(estimateId);
  return zohoBooksGetBinary(`/estimates/${estimateId}`);
}

/** Lists PDF templates available for estimates (for the template picker). */
export async function listEstimateTemplates(): Promise<unknown> {
  return zohoBooksGet('/estimates/templates');
}
