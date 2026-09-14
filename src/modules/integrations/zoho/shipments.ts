import { z } from 'zod';
import { zohoDelete, zohoGet, zohoPost, zohoPut } from './client';

/**
 * Zoho Inventory — Shipment orders ("órdenes de envío", NE-xxxxx) and package edits.
 * Docs: https://www.zoho.com/inventory/api/v1/shipmentorders/
 *
 * A shipment order belongs to one or more packages of a sales order. The carrier
 * ("transportista") lives here, not on the package. Creating / updating it does NOT
 * bump the package's last_modified_time, so callers must re-read the package detail
 * afterwards (see packages-shipping-service).
 *
 * All functions return the RAW JSON exactly as Zoho provides it.
 */

const idSchema = z.string().min(1).max(30).regex(/^\d+$/, 'id must be numeric');

export interface ZohoShipmentWriteInput {
  /** YYYY-MM-DD */
  date: string;
  /** Carrier name as configured in Zoho (manual carrier list) or free text. */
  delivery_method: string;
  tracking_number?: string;
  tracking_url?: string;
  shipping_charge?: number;
  notes?: string;
  /** Leave empty so Zoho auto-numbers (NE-xxxxx). */
  shipment_number?: string;
}

function compact(input: ZohoShipmentWriteInput): Record<string, unknown> {
  const body: Record<string, unknown> = { date: input.date, delivery_method: input.delivery_method };
  if (input.tracking_number) body.tracking_number = input.tracking_number;
  if (input.tracking_url) body.tracking_url = input.tracking_url;
  if (input.shipping_charge !== undefined && Number.isFinite(input.shipping_charge)) body.shipping_charge = input.shipping_charge;
  if (input.notes !== undefined) body.notes = input.notes;
  if (input.shipment_number) body.shipment_number = input.shipment_number;
  return body;
}

export async function createShipmentOrder(params: { packageId: string; salesOrderId: string; input: ZohoShipmentWriteInput }): Promise<unknown> {
  idSchema.parse(params.packageId);
  idSchema.parse(params.salesOrderId);
  return zohoPost('/shipmentorders', compact(params.input), { package_ids: params.packageId, salesorder_id: params.salesOrderId });
}

export async function updateShipmentOrder(params: { shipmentId: string; packageId: string; salesOrderId: string; input: ZohoShipmentWriteInput }): Promise<unknown> {
  idSchema.parse(params.shipmentId);
  idSchema.parse(params.packageId);
  idSchema.parse(params.salesOrderId);
  return zohoPut(`/shipmentorders/${params.shipmentId}`, compact(params.input), { package_ids: params.packageId, salesorder_id: params.salesOrderId });
}

export async function getShipmentOrder(shipmentId: string): Promise<unknown> {
  idSchema.parse(shipmentId);
  return zohoGet(`/shipmentorders/${shipmentId}`);
}

export async function deleteShipmentOrder(shipmentId: string): Promise<unknown> {
  idSchema.parse(shipmentId);
  return zohoDelete(`/shipmentorders/${shipmentId}`);
}

export async function markShipmentDelivered(shipmentId: string, deliveredDate?: string): Promise<unknown> {
  idSchema.parse(shipmentId);
  return zohoPost(`/shipmentorders/${shipmentId}/status/delivered`, deliveredDate ? { delivered_date: deliveredDate } : undefined);
}

export interface ZohoPackageLineItem {
  line_item_id: string;
  so_line_item_id?: string;
  quantity: number;
}

export interface ZohoPackageWriteInput {
  /** YYYY-MM-DD — required by Zoho on update. */
  date: string;
  notes?: string;
  /** Required by Zoho on update; pass the current lines (from the last snapshot) to keep them. */
  line_items: ZohoPackageLineItem[];
}

/** Edits the package itself (date / notes). Zoho requires `date` and `line_items` on every update. */
export async function updatePackage(params: { packageId: string; salesOrderId: string; input: ZohoPackageWriteInput }): Promise<unknown> {
  idSchema.parse(params.packageId);
  idSchema.parse(params.salesOrderId);
  const body: Record<string, unknown> = { date: params.input.date, line_items: params.input.line_items };
  if (params.input.notes !== undefined) body.notes = params.input.notes;
  return zohoPut(`/packages/${params.packageId}`, body, { salesorder_id: params.salesOrderId });
}

/** Current line items of a package as Zoho last sent them (needed to update the package). */
export function extractPackageLineItems(detail: unknown): ZohoPackageLineItem[] {
  const pkg = (detail as { package?: { line_items?: unknown } } | null)?.package;
  const lines = Array.isArray(pkg?.line_items) ? (pkg!.line_items as Record<string, unknown>[]) : [];
  return lines
    .filter((l) => l && l.line_item_id !== undefined && l.line_item_id !== null)
    .map((l) => ({
      line_item_id: String(l.line_item_id),
      ...(l.so_line_item_id !== undefined && l.so_line_item_id !== null ? { so_line_item_id: String(l.so_line_item_id) } : {}),
      quantity: Number(l.quantity ?? 0),
    }));
}

/** Zoho answers with `shipment_order` (documented) or `shipmentorder`; read whichever is present. */
export function extractShipmentOrder(response: unknown): { shipment_id?: string; shipment_number?: string; status?: string } | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  const so = (r.shipment_order ?? r.shipmentorder) as Record<string, unknown> | undefined;
  if (!so || typeof so !== 'object') return null;
  return {
    shipment_id: so.shipment_id !== undefined ? String(so.shipment_id) : undefined,
    shipment_number: typeof so.shipment_number === 'string' ? so.shipment_number : undefined,
    status: typeof so.status === 'string' ? so.status : undefined,
  };
}
