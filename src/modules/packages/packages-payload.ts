import { z } from 'zod';

/** Bump when the mapping below changes so every stored snapshot is re-normalized. */
export const CURRENT_PACKAGE_NORMALIZER_VERSION = 4;

/**
 * Tolerant reading of a Zoho Inventory package payload.
 *
 * Zoho returns two shapes for the same package: the LIST record (flat, no
 * items, no address) and the DETAIL record, where `shipping_address` is an
 * object, items live in `line_items` and — once the package ships — the
 * carrier, tracking number and dates live in `shipment_order`. Every field is
 * optional here: a payload must never fail to normalize because Zoho added,
 * renamed or omitted a secondary field.
 */

const loose = z.record(z.string(), z.unknown());

export const zohoPackageSchema = z
  .object({
    package_id: z.union([z.string().min(1), z.number()]).transform(String),
    shipping_address: z.union([z.string(), loose, z.null()]).optional(),
    shipment_order: z.union([loose, z.null()]).optional(),
    package_items: z.array(loose).nullish(),
    line_items: z.array(loose).nullish(),
    contact_persons: z.array(loose).nullish(),
  })
  .passthrough();

export type ZohoPackagePayload = z.infer<typeof zohoPackageSchema>;

export interface MappedPackageItem {
  zohoItemId: string | null;
  name: string | null;
  sku: string | null;
  description: string | null;
  quantity: string | null;
  unit: string | null;
  sortOrder: number;
}

export interface MappedPackage {
  zohoPackageId: string;
  packageNumber: string | null;
  status: string | null;
  date: Date | null;
  shipmentType: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  deliveryMethod: string | null;
  shippingCharge: string | null;
  zohoSalesOrderId: string | null;
  zohoCustomerId: string | null;
  customerName: string | null;
  shipmentDate: Date | null;
  shipmentStatus: string | null;
  isCarrierShipment: boolean | null;
  isTrackingEnabled: boolean | null;
  labelFormat: string | null;
  salesChannel: string | null;
  salesorderNumber: string | null;
  quantity: string | null;
  zohoShipmentId: string | null;
  shipmentNumber: string | null;
  deliveryDate: Date | null;
  notes: string | null;
  shippingAttention: string | null;
  shippingAddress: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingZip: string | null;
  shippingCountry: string | null;
  shippingPhone: string | null;
  items: MappedPackageItem[];
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** Decimal-safe string ("1,250.50" → "1250.50"); Prisma.Decimal is built by the caller. */
function num(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/,/g, '');
  if (!cleaned || Number.isNaN(Number(cleaned))) return null;
  return cleaned;
}

function date(value: unknown): Date | null {
  const s = str(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function first(...values: unknown[]): string | null {
  for (const v of values) {
    const s = str(v);
    if (s) return s;
  }
  return null;
}

function joinAddress(parts: unknown[]): string | null {
  const pieces = parts.map(str).filter((p): p is string => Boolean(p));
  return pieces.length > 0 ? pieces.join(', ') : null;
}

export function mapZohoPackage(payload: ZohoPackagePayload): MappedPackage {
  const p = payload as Record<string, unknown> & ZohoPackagePayload;
  const shipment = (p.shipment_order ?? {}) as Record<string, unknown>;
  const address =
    p.shipping_address && typeof p.shipping_address === 'object'
      ? (p.shipping_address as Record<string, unknown>)
      : null;
  const rawItems = p.line_items?.length ? p.line_items : (p.package_items ?? []);

  const items: MappedPackageItem[] = rawItems.map((item, index) => ({
    zohoItemId: str(item.item_id),
    name: str(item.name),
    sku: str(item.sku),
    description: str(item.description),
    quantity: num(item.quantity),
    unit: str(item.unit),
    sortOrder: typeof item.item_order === 'number' ? item.item_order : index,
  }));

  const quantity =
    num(p.quantity) ??
    (items.length > 0
      ? String(items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0))
      : null);

  return {
    zohoPackageId: payload.package_id,
    packageNumber: str(p.package_number),
    status: str(p.status),
    date: date(p.date),
    shipmentType: str(p.shipment_type),
    carrier: first(p.carrier, shipment.carrier),
    trackingNumber: first(p.tracking_number, shipment.tracking_number),
    trackingUrl: first(p.tracking_url, shipment.tracking_url),
    deliveryMethod: first(p.delivery_method, shipment.delivery_method, shipment.service),
    shippingCharge: num(p.shipping_charge) ?? num(shipment.shipping_charge),
    zohoSalesOrderId: str(p.salesorder_id),
    zohoCustomerId: str(p.customer_id),
    customerName: str(p.customer_name),
    shipmentDate: date(p.shipment_date) ?? date(shipment.shipment_date),
    shipmentStatus: first(shipment.status, p.shipment_status, p.detailed_status),
    isCarrierShipment: bool(p.is_carrier_shipment) ?? bool(shipment.is_carrier_shipment),
    isTrackingEnabled: bool(p.is_tracking_enabled) ?? bool(shipment.is_tracking_enabled),
    labelFormat: str(p.label_format),
    salesChannel: str(p.sales_channel),
    salesorderNumber: str(p.salesorder_number),
    quantity,
    zohoShipmentId: first(p.shipment_id, shipment.shipment_id),
    shipmentNumber: first(p.shipment_number, shipment.shipment_number),
    deliveryDate:
      date(shipment.delivery_date) ??
      date(shipment.delivered_date) ??
      date(p.delivery_date) ??
      date(p.delivered_date),
    notes: first(p.notes, shipment.notes),
    shippingAttention: first(p.shipping_attention, address?.attention),
    shippingAddress: address
      ? joinAddress([address.address, address.street2])
      : str(p.shipping_address),
    shippingCity: first(p.shipping_city, address?.city),
    shippingState: first(p.shipping_state, address?.state),
    shippingZip: first(p.shipping_zip, address?.zip),
    shippingCountry: first(p.shipping_country, address?.country),
    shippingPhone: first(p.shipping_phone, address?.phone),
    items,
  };
}

type ExtractResult = { data: ZohoPackagePayload; error: null } | { data: null; error: string };

/** Accepts a bare package or the Zoho envelope `{ code: 0, package: {...} }`. */
export function extractZohoPackage(raw: unknown): ExtractResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }
  const obj = raw as Record<string, unknown>;
  let candidate: unknown = raw;
  if ('code' in obj && !('package_id' in obj)) {
    if (obj.code !== 0) return { data: null, error: `Zoho API error code: ${String(obj.code)}` };
    candidate = obj.package;
  }
  const parsed = zohoPackageSchema.safeParse(candidate);
  if (!parsed.success) {
    return { data: null, error: parsed.error.issues[0]?.message ?? 'Invalid package shape' };
  }
  return { data: parsed.data, error: null };
}
