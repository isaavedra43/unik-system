import { z } from 'zod';
import type {
  ZohoSalesOrderLineItemInput,
  ZohoSalesOrderWriteInput,
} from '@/modules/integrations/zoho/sales-orders';
import { toNumber, truncateText } from './opportunity-rules';

/**
 * Pure rules of "accepted quote → sales order in Zoho" (plan 6.5):
 * convertibility, the POST body, the mock response (ZOHO_BOOKS_MOCK) and the
 * comparison of Zoho's read-back with what the quote asked for.
 */

type NumericLike = number | string | { toString(): string } | null;

export interface QuoteLineRow {
  zohoItemId: string | null;
  sku: string | null;
  name: string | null;
  description: string | null;
  quantity: NumericLike;
  rate: NumericLike;
  unit: string | null;
  discount: string | null;
  discountAmount: NumericLike;
  taxId: string | null;
  taxName: string | null;
  taxPercentage: NumericLike;
  taxAmount: NumericLike;
  lineTotal: NumericLike;
  sortOrder: number;
}

export interface QuoteRow {
  id: string;
  zohoEstimateId: string;
  estimateNumber: string | null;
  status: string | null;
  zohoCustomerId: string | null;
  customerName: string | null;
  currencyCode: string | null;
  salespersonId: string | null;
  salespersonName: string | null;
  discount: NumericLike;
  discountType: string | null;
  isDiscountBeforeTax: boolean | null;
  shippingCharge: NumericLike;
  adjustment: NumericLike;
  adjustmentDescription: string | null;
  notes: string | null;
  terms: string | null;
  subTotal: NumericLike;
  taxTotal: NumericLike;
  discountTotal: NumericLike;
  total: NumericLike;
  createdByUserId: string | null;
  items: QuoteLineRow[];
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: 'Borrador',
  sent: 'Enviada',
  viewed: 'Vista por cliente',
  accepted: 'Aceptada',
  declined: 'Rechazada',
  invoiced: 'Facturada',
  expired: 'Vencida',
};

export function isAcceptedQuoteStatus(status: string | null | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === 'accepted';
}

export function quoteFolio(quote: Pick<QuoteRow, 'estimateNumber' | 'zohoEstimateId'>): string {
  return quote.estimateNumber ?? quote.zohoEstimateId;
}

/** Why a quote cannot become a sales order (Spanish), or null. */
export function quoteConversionBlocker(quote: QuoteRow): string | null {
  const folio = quoteFolio(quote);
  if (!isAcceptedQuoteStatus(quote.status)) {
    const status = (quote.status ?? '').trim().toLowerCase();
    return `La cotización ${folio} está «${STATUS_LABELS[status] ?? (quote.status || 'sin estado')}»: sólo una cotización aceptada se convierte en orden de venta`;
  }
  if (!quote.zohoCustomerId) return `La cotización ${folio} no tiene un cliente de Zoho`;
  if (quote.items.length === 0) return `La cotización ${folio} no tiene conceptos`;
  const invalid = quote.items.find((item) => (toNumber(item.quantity) ?? 0) <= 0);
  if (invalid) return `El concepto «${invalid.name ?? invalid.sku ?? 'sin nombre'}» de la cotización ${folio} no tiene cantidad`;
  return null;
}

/** "10%" stays a percentage, "150" becomes an amount; empty or zero is omitted. */
export function normalizeLineDiscount(discount: string | null | undefined): string | number | undefined {
  const raw = (discount ?? '').trim();
  if (!raw) return undefined;
  if (raw.endsWith('%')) {
    const pct = Number(raw.slice(0, -1));
    return Number.isFinite(pct) && pct > 0 ? `${pct}%` : undefined;
  }
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

/**
 * Body of `POST /salesorders` from an accepted quote: customer, reference =
 * quote folio, salesperson, lines (item, quantity, rate, unit, discount, tax),
 * notes/terms, charges. The entity-level discount is stored by the quote
 * normalizer as a number and sent as a percentage, the same convention as the
 * quote form (`quoteToFormInput`); a different convention in the organization
 * shows up as a total mismatch in the read-back.
 */
export function buildSalesOrderPayload(quote: QuoteRow, date: string): ZohoSalesOrderWriteInput {
  if (!quote.zohoCustomerId) throw new Error('quote without customer');
  const itemLevel = quote.discountType === 'item_level';
  const lines = [...quote.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const lineItems: ZohoSalesOrderLineItemInput[] = lines.map((item, index) => {
    const line: ZohoSalesOrderLineItemInput = {
      quantity: toNumber(item.quantity) ?? 0,
      rate: toNumber(item.rate) ?? 0,
      item_order: index + 1,
    };
    if (item.zohoItemId) line.item_id = item.zohoItemId;
    if (item.name) line.name = item.name;
    if (item.description) line.description = item.description;
    if (item.unit) line.unit = item.unit;
    if (item.taxId) line.tax_id = item.taxId;
    if (itemLevel) {
      const discount = normalizeLineDiscount(item.discount);
      if (discount !== undefined) line.discount = discount;
    }
    return line;
  });
  const payload: ZohoSalesOrderWriteInput = {
    customer_id: quote.zohoCustomerId,
    date,
    line_items: lineItems,
    discount_type: itemLevel ? 'item_level' : 'entity_level',
  };
  if (quote.estimateNumber) payload.reference_number = quote.estimateNumber;
  if (quote.salespersonId) payload.salesperson_id = quote.salespersonId;
  if (quote.salespersonName) payload.salesperson_name = quote.salespersonName;
  if (quote.notes) payload.notes = quote.notes;
  if (quote.terms) payload.terms = quote.terms;
  if (quote.isDiscountBeforeTax !== null) payload.is_discount_before_tax = quote.isDiscountBeforeTax;
  const entityDiscount = entityDiscountFor(quote);
  if (!itemLevel && entityDiscount !== null) payload.discount = entityDiscount;
  const shipping = toNumber(quote.shippingCharge);
  if (shipping !== null && shipping !== 0) payload.shipping_charge = shipping;
  const adjustment = toNumber(quote.adjustment);
  if (adjustment !== null && adjustment !== 0) {
    payload.adjustment = adjustment;
    if (quote.adjustmentDescription) payload.adjustment_description = quote.adjustmentDescription;
  }
  return payload;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Document discount as Zoho expects it: `"10%"` for a percentage, the amount
 * as a number otherwise. The normalized quote keeps the number and the
 * resulting `discount_total`: it is a percentage when the number applied to the
 * subtotal (before or after tax) gives that total, an amount when the number
 * itself is the total. Null when there is no document discount.
 */
export function entityDiscountFor(
  quote: Pick<QuoteRow, 'discount' | 'discountTotal' | 'subTotal' | 'taxTotal' | 'discountType'>
): string | number | null {
  if (quote.discountType === 'item_level') return null;
  const discount = toNumber(quote.discount);
  if (discount === null || discount <= 0) return null;
  const total = toNumber(quote.discountTotal);
  const subTotal = toNumber(quote.subTotal) ?? 0;
  const taxTotal = toNumber(quote.taxTotal) ?? 0;
  if (total === null || total <= 0) return discount <= 100 ? `${discount}%` : discount;
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.0005);
  if (close(total, discount) && !(discount <= 100 && (close((subTotal * discount) / 100, total) || close(((subTotal + taxTotal) * discount) / 100, total)))) {
    return discount;
  }
  if (discount <= 100 && (close((subTotal * discount) / 100, total) || close(((subTotal + taxTotal) * discount) / 100, total))) {
    return `${discount}%`;
  }
  return close(total, discount) ? discount : `${discount}%`;
}

/**
 * Simulated Zoho response (ZOHO_BOOKS_MOCK=true): folio `SO-MOCK-00001`, the
 * totals of the accepted quote (Zoho computes the same document) and status
 * `confirmed`, so the normalizer and the operations hook behave as with a real
 * order.
 */
export function buildMockSalesOrderResponse(input: {
  payload: ZohoSalesOrderWriteInput;
  quote: QuoteRow;
  salesOrderId: string;
  salesOrderNumber: string;
  now: Date;
}): { code: 0; message: string; salesorder: Record<string, unknown> } {
  const { payload, quote, salesOrderId, salesOrderNumber, now } = input;
  const nowIso = now.toISOString();
  const lines = [...quote.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const lineItems = payload.line_items.map((line, index) => {
    const source = lines[index];
    const quantity = line.quantity;
    const rate = line.rate;
    return {
      line_item_id: `${salesOrderId}${String(index + 1).padStart(3, '0')}`,
      item_id: line.item_id ?? null,
      sku: source?.sku ?? null,
      name: line.name ?? null,
      description: line.description ?? null,
      quantity,
      unit: line.unit ?? null,
      rate,
      discount: line.discount ?? 0,
      discount_amount: toNumber(source?.discountAmount ?? null) ?? 0,
      tax_id: line.tax_id ?? null,
      tax_name: source?.taxName ?? null,
      tax_percentage: toNumber(source?.taxPercentage ?? null) ?? 0,
      tax_amount: toNumber(source?.taxAmount ?? null) ?? 0,
      item_total: toNumber(source?.lineTotal ?? null) ?? round2(quantity * rate),
      item_order: index + 1,
    };
  });
  const subTotal = toNumber(quote.subTotal) ?? round2(lineItems.reduce((sum, line) => sum + line.item_total, 0));
  const total = toNumber(quote.total) ?? subTotal;
  return {
    code: 0,
    message: 'mock',
    salesorder: {
      salesorder_id: salesOrderId,
      salesorder_number: salesOrderNumber,
      reference_number: payload.reference_number ?? '',
      date: payload.date ?? nowIso.slice(0, 10),
      created_time: nowIso,
      last_modified_time: nowIso,
      order_status: 'confirmed',
      current_sub_status: 'confirmed',
      paid_status: 'unpaid',
      invoiced_status: 'not_invoiced',
      shipped_status: 'pending',
      customer_id: payload.customer_id,
      customer_name: quote.customerName ?? 'Cliente',
      salesperson_id: payload.salesperson_id ?? '',
      salesperson_name: payload.salesperson_name ?? '',
      currency_code: quote.currencyCode ?? 'MXN',
      sub_total: subTotal,
      tax_total: toNumber(quote.taxTotal) ?? 0,
      discount_total: toNumber(quote.discountTotal) ?? 0,
      shipping_charge: payload.shipping_charge ?? 0,
      adjustment: payload.adjustment ?? 0,
      total,
      balance: total,
      notes: payload.notes ?? '',
      line_items: lineItems,
    },
  };
}

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

const readbackLineSchema = z
  .object({
    item_id: z.string().nullish(),
    name: z.string().nullish(),
    quantity: z.number().nullish(),
    rate: z.number().nullish(),
  })
  .passthrough();

export const salesOrderReadbackSchema = z
  .object({
    salesorder_id: z.string().min(1),
    salesorder_number: z.string().nullish(),
    reference_number: z.string().nullish(),
    customer_id: z.string().nullish(),
    customer_name: z.string().nullish(),
    order_status: z.string().nullish(),
    total: z.number().nullish(),
    currency_code: z.string().nullish(),
    last_modified_time: z.string().nullish(),
    line_items: z.array(readbackLineSchema).nullish(),
  })
  .passthrough();

export type SalesOrderReadback = z.infer<typeof salesOrderReadbackSchema>;

/** Accepts Zoho's wrapper `{ code: 0, salesorder }` or the sales order itself. */
export function extractSalesOrderReadback(raw: unknown): SalesOrderReadback | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const candidate = 'salesorder' in obj ? obj.salesorder : obj;
  if ('code' in obj && obj.code !== 0) return null;
  const parsed = salesOrderReadbackSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Zoho's last_modified_time, or `fallback` when missing or invalid. */
export function readbackModifiedAt(readback: Pick<SalesOrderReadback, 'last_modified_time'>, fallback: Date): Date {
  const parsed = readback.last_modified_time ? new Date(readback.last_modified_time) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback;
}

export interface ExpectedSalesOrder {
  customerId: string | null;
  referenceNumber: string | null;
  total: number | null;
  lines: Array<{ itemId: string | null; name: string | null; quantity: number }>;
}

export function expectedSalesOrderFromQuote(quote: QuoteRow): ExpectedSalesOrder {
  return {
    customerId: quote.zohoCustomerId,
    referenceNumber: quote.estimateNumber,
    total: toNumber(quote.total),
    lines: [...quote.items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => ({ itemId: item.zohoItemId, name: item.name, quantity: toNumber(item.quantity) ?? 0 })),
  };
}

export type ReadbackDifferenceField = 'customer' | 'reference' | 'line_count' | 'line_item' | 'line_quantity' | 'total';

export interface ReadbackDifference {
  field: ReadbackDifferenceField;
  label: string;
  expected: string | number | null;
  actual: string | number | null;
  /** 1-based line for line differences. */
  line?: number;
}

/** Totals may differ by rounding between Books and Inventory. */
export const READBACK_TOTAL_TOLERANCE = 1;
const QUANTITY_TOLERANCE = 0.0001;

/** Differences between what the quote asked for and what Zoho stored. Empty = consistent. */
export function compareSalesOrderReadback(expected: ExpectedSalesOrder, actual: SalesOrderReadback): ReadbackDifference[] {
  const diffs: ReadbackDifference[] = [];
  if ((actual.customer_id ?? null) !== expected.customerId) {
    diffs.push({ field: 'customer', label: 'Cliente', expected: expected.customerId, actual: actual.customer_id ?? null });
  }
  if (expected.referenceNumber && (actual.reference_number ?? '').trim() !== expected.referenceNumber) {
    diffs.push({ field: 'reference', label: 'Referencia', expected: expected.referenceNumber, actual: actual.reference_number ?? null });
  }
  const lines = actual.line_items ?? [];
  if (lines.length !== expected.lines.length) {
    diffs.push({ field: 'line_count', label: 'Número de conceptos', expected: expected.lines.length, actual: lines.length });
  }
  const shared = Math.min(lines.length, expected.lines.length);
  for (let i = 0; i < shared; i++) {
    const want = expected.lines[i];
    const got = lines[i];
    if (want.itemId && got.item_id && want.itemId !== got.item_id) {
      diffs.push({ field: 'line_item', label: `Producto del concepto ${i + 1}`, expected: want.itemId, actual: got.item_id, line: i + 1 });
    }
    const quantity = got.quantity ?? 0;
    if (Math.abs(quantity - want.quantity) > QUANTITY_TOLERANCE) {
      diffs.push({ field: 'line_quantity', label: `Cantidad del concepto ${i + 1}`, expected: want.quantity, actual: quantity, line: i + 1 });
    }
  }
  if (expected.total !== null && actual.total !== null && actual.total !== undefined) {
    if (Math.abs(actual.total - expected.total) > READBACK_TOTAL_TOLERANCE) {
      diffs.push({ field: 'total', label: 'Total', expected: expected.total, actual: actual.total });
    }
  }
  return diffs;
}

/** "Cantidad del concepto 1: esperado 15, Zoho 12; Total: esperado 4800, Zoho 3840" */
export function describeReadbackDifferences(diffs: readonly ReadbackDifference[]): string {
  return truncateText(
    diffs
      .map((diff) => `${diff.label}: esperado ${diff.expected ?? '—'}, Zoho ${diff.actual ?? '—'}`)
      .join('; '),
    900
  );
}

/** YYYY-MM-DD in Mexico City for the order date. */
export function orderDateFor(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
