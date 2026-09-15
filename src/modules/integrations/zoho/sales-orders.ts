import { z } from 'zod';
import { zohoGet, zohoPost } from './client';

const salesOrderIdSchema = z.string().min(1).max(30).regex(/^\d+$/, 'salesOrderId must be numeric');

interface ListSalesOrdersOptions {
  page?: number;
  perPage?: number;
  /** Column to sort by, e.g. 'last_modified_time', 'created_time'. */
  sortColumn?: string;
  /** Zoho API expects 'A' (ascending) or 'D' (descending), NOT 'ascending'/'descending'. */
  sortOrder?: 'A' | 'D';
}

/**
 * Fetches a page of Sales Orders from Zoho Inventory.
 * Returns the RAW JSON response exactly as Zoho provides it.
 * Calling it without options preserves the original unpaginated behaviour.
 */
export async function listSalesOrders(options?: ListSalesOrdersOptions): Promise<unknown> {
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

  return zohoGet('/salesorders', Object.keys(query).length > 0 ? query : undefined);
}

/**
 * Fetches a single Sales Order from Zoho Inventory by its salesorder_id.
 * Returns the RAW JSON response exactly as Zoho provides it.
 */
export async function getSalesOrder(salesOrderId: string): Promise<unknown> {
  salesOrderIdSchema.parse(salesOrderId);

  return zohoGet(`/salesorders/${salesOrderId}`);
}

/** Line of a sales order created from UNIK (Zoho Inventory field names). */
export interface ZohoSalesOrderLineItemInput {
  item_id?: string;
  name?: string;
  description?: string;
  quantity: number;
  rate: number;
  unit?: string;
  /** Percentage as "10%" or an absolute amount. */
  discount?: number | string;
  tax_id?: string;
  item_order?: number;
}

/**
 * Body of `POST /inventory/v1/salesorders`. `salesorder_number` is never sent:
 * Zoho assigns it from the organization sequence (same as the Zoho UI).
 */
export interface ZohoSalesOrderWriteInput {
  customer_id: string;
  /** YYYY-MM-DD */
  date?: string;
  /** Folio of the source quote (traceability in Zoho). */
  reference_number?: string;
  salesperson_id?: string;
  salesperson_name?: string;
  line_items: ZohoSalesOrderLineItemInput[];
  notes?: string;
  terms?: string;
  discount?: number | string;
  is_discount_before_tax?: boolean;
  discount_type?: 'entity_level' | 'item_level';
  shipping_charge?: number;
  adjustment?: number;
  adjustment_description?: string;
}

/**
 * Creates a Sales Order in Zoho Inventory. Returns the RAW JSON response
 * (`{ code: 0, salesorder: {...} }`). The exact field set accepted by the real
 * organization must be validated before enabling `crm.create_sales_order`.
 */
export async function createSalesOrder(input: ZohoSalesOrderWriteInput): Promise<unknown> {
  return zohoPost('/salesorders', input, { ignore_auto_number_generation: 'false' });
}
