import { z } from 'zod';
import { zohoBooksPost, zohoPost } from './client';

/**
 * Zoho writes used to close a sales order ("cierre de ticket").
 *
 * Zoho has no "mark as closed" endpoint: a sales order closes by itself when
 * it is invoiced and/or its shipments are delivered (Sales Order Preferences).
 * - Invoice from sales order → Books  POST /invoices/fromsalesorder?salesorder_id=
 * - Mark invoice as sent     → Books  POST /invoices/{id}/status/sent
 * - Sales order comment      → Books  POST /salesorders/{id}/comments  { description }
 * - Create package           → Inventory POST /packages?salesorder_id=  { date, line_items }
 * Shipment orders and "delivered" live in ./shipments.
 *
 * All functions return the RAW JSON exactly as Zoho provides it.
 */

const idSchema = z.string().min(1).max(30).regex(/^\d+$/, 'id must be numeric');

export async function createInvoiceFromSalesOrder(salesOrderId: string): Promise<unknown> {
  idSchema.parse(salesOrderId);
  return zohoBooksPost('/invoices/fromsalesorder', undefined, { salesorder_id: salesOrderId });
}

export async function markInvoiceSent(invoiceId: string): Promise<unknown> {
  idSchema.parse(invoiceId);
  return zohoBooksPost(`/invoices/${invoiceId}/status/sent`);
}

export async function addSalesOrderComment(salesOrderId: string, description: string): Promise<unknown> {
  idSchema.parse(salesOrderId);
  return zohoBooksPost(`/salesorders/${salesOrderId}/comments`, { description });
}

export interface ZohoNewPackageLine {
  so_line_item_id: string;
  quantity: number;
}

export async function createPackageForSalesOrder(params: {
  salesOrderId: string;
  date: string;
  lineItems: ZohoNewPackageLine[];
  notes?: string;
}): Promise<unknown> {
  idSchema.parse(params.salesOrderId);
  const body: Record<string, unknown> = { date: params.date, line_items: params.lineItems };
  if (params.notes) body.notes = params.notes;
  return zohoPost('/packages', body, { salesorder_id: params.salesOrderId });
}

// ---------------------------------------------------------------------------
// Readers for the loosely-typed Zoho payloads
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface ZohoSalesOrderCloseView {
  status: string | null;
  invoicedStatus: string | null;
  paidStatus: string | null;
  shippedStatus: string | null;
  lineItems: { lineItemId: string; quantity: number; quantityPacked: number | null }[];
  /** null when Zoho did not include a `packages` array in the detail. */
  packages: { packageId: string; status: string | null; shipmentId: string | null }[] | null;
}

/** Reads the fields needed to close a ticket from GET /salesorders/{id}. */
export function readSalesOrderForClose(detail: unknown): ZohoSalesOrderCloseView | null {
  const so = asRecord(asRecord(detail)?.salesorder);
  if (!so) return null;
  const lines = Array.isArray(so.line_items) ? so.line_items : [];
  const packages = Array.isArray(so.packages) ? so.packages : null;
  return {
    status: str(so.order_status) ?? str(so.status),
    invoicedStatus: str(so.invoiced_status),
    paidStatus: str(so.paid_status),
    shippedStatus: str(so.shipped_status),
    lineItems: lines
      .map(asRecord)
      .filter((l): l is Record<string, unknown> => !!l && str(l.line_item_id) !== null)
      .map((l) => ({
        lineItemId: str(l.line_item_id)!,
        quantity: num(l.quantity) ?? 0,
        quantityPacked: num(l.quantity_packed),
      })),
    packages: packages
      ? packages
          .map(asRecord)
          .filter((p): p is Record<string, unknown> => !!p && str(p.package_id) !== null)
          .map((p) => ({
            packageId: str(p.package_id)!,
            status: str(p.status) ?? str(p.shipment_status),
            shipmentId: str(p.shipment_id) ?? str(asRecord(p.shipment_order)?.shipment_id),
          }))
      : null,
  };
}

export function extractInvoice(response: unknown): { invoiceId: string | null; status: string | null; number: string | null } {
  const inv = asRecord(asRecord(response)?.invoice);
  return {
    invoiceId: str(inv?.invoice_id),
    status: str(inv?.status),
    number: str(inv?.invoice_number),
  };
}

export function extractCreatedPackageId(response: unknown): string | null {
  const pkg = asRecord(response)?.package;
  const first = Array.isArray(pkg) ? asRecord(pkg[0]) : asRecord(pkg);
  return str(first?.package_id);
}
