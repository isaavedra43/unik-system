import { z } from 'zod';
import { zohoGet, zohoPost } from './client';

export interface EstimateLineItem {
  item_id?: string;
  name?: string;
  description?: string;
  quantity?: number;
  unit?: string;
  rate?: number;
  discount?: number | string;
  tax_id?: string;
  tax_name?: string;
  tax_percentage?: number;
  item_total?: number;
}

/**
 * Zoho Inventory v1 estimate creation payload.
 * See https://www.zoho.com/inventory/api/estimates/ for the canonical shape.
 */
export interface CreateEstimatePayload {
  customer_id: string;
  date?: string;
  expiry_date?: string;
  estimate_number?: string;
  reference_number?: string;
  salesperson_id?: string;
  salesperson_name?: string;
  currency_code?: string;
  notes?: string;
  terms?: string;
  custom_field_hash?: Record<string, unknown>;
  billing_address?: Record<string, unknown>;
  shipping_address?: Record<string, unknown>;
  line_items: EstimateLineItem[];
  /** Optional contact persons array as expected by Zoho. */
  contact_persons?: Array<{ contact_person_id?: string }>;
}

const estimateIdSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^\d+$/, 'estimateId must be numeric');

export interface ListEstimatesOptions {
  page?: number;
  perPage?: number;
}

/**
 * Creates an Estimate in Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function createEstimate(payload: CreateEstimatePayload): Promise<unknown> {
  return zohoPost('/estimates', payload as unknown as Record<string, unknown>);
}

/**
 * Fetches a page of Estimates from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function listEstimates(options?: ListEstimatesOptions): Promise<unknown> {
  const query: Record<string, string> = {};

  if (options?.page !== undefined) {
    query.page = String(options.page);
  }

  if (options?.perPage !== undefined) {
    query.per_page = String(options.perPage);
  }

  return zohoGet('/estimates', Object.keys(query).length > 0 ? query : undefined);
}

/**
 * Fetches a single Estimate from Zoho Inventory by its estimate_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getEstimate(estimateId: string): Promise<unknown> {
  estimateIdSchema.parse(estimateId);

  return zohoGet(`/estimates/${estimateId}`);
}
