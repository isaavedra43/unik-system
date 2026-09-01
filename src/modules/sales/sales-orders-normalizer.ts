import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ENTITY_TYPE, SOURCE } from '@/modules/integrations/zoho/sales-orders-sync';

export const CURRENT_SALES_ORDER_NORMALIZER_VERSION = 2;

export const NORMALIZATION_ERROR_CODE = {
  SNAPSHOT_SHAPE_INVALID: 'SNAPSHOT_SHAPE_INVALID',
  MAPPING_ERROR: 'MAPPING_ERROR',
  PERSISTENCE_ERROR: 'PERSISTENCE_ERROR',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
} as const;

class NormalizationError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly snapshotId: string,
    message: string
  ) {
    super(message);
    this.name = 'NormalizationError';
  }
}

export class NormalizationAlreadyRunningError extends Error {
  constructor() {
    super('A sales orders normalization batch is already running in this instance');
    this.name = 'NormalizationAlreadyRunningError';
  }
}

type SnapshotInput = {
  id: string;
  source: string;
  entityType: string;
  externalId: string;
  remoteModifiedAt: Date;
  normalizationVersion: number;
  payload: Prisma.JsonValue;
};

const NORMALIZER_STATE_KEY = '__unikZohoSalesOrdersNormalizerState' as const;

interface NormalizerState {
  batchInProgress: boolean;
}

type GlobalWithNormalizerState = typeof globalThis & {
  [NORMALIZER_STATE_KEY]?: NormalizerState;
};

function getNormalizerState(): NormalizerState {
  const scope = globalThis as GlobalWithNormalizerState;
  scope[NORMALIZER_STATE_KEY] ??= { batchInProgress: false };
  return scope[NORMALIZER_STATE_KEY];
}

/**
 * Minimal Zod schema for the Zoho Sales Order detail payload.
 * All fields except `salesorder_id` are treated as optional; a missing optional
 * field becomes `null`. The whole payload is `.passthrough()` so unknown fields
 * are ignored without failing the parse.
 */
const addressSchema = z
  .object({
    attention: z.string().nullish(),
    address: z.string().nullish(),
    street2: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    zip: z.string().nullish(),
    country: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .passthrough()
  .optional();

const contactPersonSchema = z
  .object({
    phone: z.string().nullish(),
    mobile: z.string().nullish(),
    email: z.string().nullish(),
  })
  .passthrough();

const lineItemTaxSchema = z
  .object({
    tax_name: z.string().nullish(),
    tax_amount: z.number().nullish(),
    tax_percentage: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

const lineItemSchema = z
  .object({
    line_item_id: z.string().nullish(),
    item_id: z.string().nullish(),
    sku: z.string().nullish(),
    name: z.string().nullish(),
    item_name: z.string().nullish(),
    description: z.string().nullish(),
    quantity: z.number().nullish(),
    unit: z.string().nullish(),
    rate: z.number().nullish(),
    discount_amount: z.number().nullish(),
    discount: z.union([z.string(), z.number()]).nullish(),
    tax_name: z.string().nullish(),
    tax_percentage: z.union([z.string(), z.number()]).nullish(),
    tax_amount: z.number().nullish(),
    line_item_taxes: z.array(lineItemTaxSchema).nullish(),
    item_total: z.number().nullish(),
    item_order: z.number().nullish(),
    location_id: z.string().nullish(),
    location_name: z.string().nullish(),
  })
  .passthrough();

const customFieldHashSchema = z.record(z.unknown()).optional();

const salesOrderPayloadSchema = z
  .object({
    salesorder_id: z.string().min(1),
    salesorder_number: z.string().nullish(),
    reference_number: z.string().nullish(),
    date: z.string().nullish(),
    created_time: z.string().nullish(),
    order_status: z.string().nullish(),
    current_sub_status: z.string().nullish(),
    paid_status: z.string().nullish(),
    invoiced_status: z.string().nullish(),
    shipped_status: z.string().nullish(),
    customer_id: z.string().nullish(),
    customer_name: z.string().nullish(),
    contact_person_details: z.array(contactPersonSchema).nullish(),
    salesperson_id: z.string().nullish(),
    salesperson_name: z.string().nullish(),
    payment_terms_label: z.string().nullish(),
    delivery_method: z.string().nullish(),
    delivery_method_id: z.string().nullish(),
    location_id: z.string().nullish(),
    location_name: z.string().nullish(),
    branch_id: z.string().nullish(),
    branch_name: z.string().nullish(),
    shipping_address: addressSchema,
    currency_code: z.string().nullish(),
    sub_total: z.number().nullish(),
    total: z.number().nullish(),
    tax_total: z.number().nullish(),
    discount_total: z.number().nullish(),
    shipping_charge: z.number().nullish(),
    adjustment: z.number().nullish(),
    balance: z.number().nullish(),
    notes: z.string().nullish(),
    custom_field_hash: customFieldHashSchema,
    line_items: z.array(lineItemSchema).nullish(),
  })
  .passthrough();

function log(payload: Record<string, unknown>) {
  console.info(JSON.stringify(payload));
}

function parseZohoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parses a commercial date that must be a calendar date without time.
 * Accepts `YYYY-MM-DD`. Stores it as UTC midnight so PostgreSQL DATE keeps
 * the same calendar day.
 */
function parseZohoCommercialDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDecimal(value: unknown): Prisma.Decimal | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Prisma.Decimal(value) : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.trim().replace(/\,/g, '');
  if (cleaned.length === 0) {
    return null;
  }
  try {
    return new Prisma.Decimal(cleaned);
  } catch {
    return null;
  }
}

async function persistNormalizedOrder(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  zohoSalesOrderId: string,
  salesOrderData: Omit<Prisma.SalesOrderCreateInput, 'items'>,
  items: Omit<Prisma.SalesOrderItemCreateManyInput, 'salesOrderId'>[]
): Promise<{ salesOrderId: string }> {
  const salesOrder = await tx.salesOrder.upsert({
    where: { zohoSalesOrderId },
    create: salesOrderData,
    update: salesOrderData,
  });

  await tx.salesOrderItem.deleteMany({ where: { salesOrderId: salesOrder.id } });

  if (items.length > 0) {
    await tx.salesOrderItem.createMany({
      data: items.map((item) => ({
        ...item,
        salesOrderId: salesOrder.id,
      })),
      skipDuplicates: true,
    });
  }

  return { salesOrderId: salesOrder.id };
}

function extractCustomerContact(
  contacts: z.infer<typeof contactPersonSchema>[] | null | undefined
): { phone: string | null; email: string | null } {
  if (!contacts || contacts.length === 0) {
    return { phone: null, email: null };
  }

  const firstWithPhone = contacts.find((c) => typeof c.phone === 'string' && c.phone.length > 0);
  const firstWithMobile = contacts.find((c) => typeof c.mobile === 'string' && c.mobile.length > 0);
  const firstWithEmail = contacts.find((c) => typeof c.email === 'string' && c.email.length > 0);

  return {
    phone: firstWithPhone?.phone ?? firstWithMobile?.mobile ?? null,
    email: firstWithEmail?.email ?? null,
  };
}

function extractSaleMadeInWarehouse(value: unknown): boolean | null {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === 'string') {
    const clean = value.trim().toLowerCase();
    if (clean === 'true' || clean === '1' || clean === 'yes') return true;
    if (clean === 'false' || clean === '0' || clean === 'no') return false;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return null;
}

function buildSalesOrderData(
  snapshotId: string,
  remoteModifiedAt: Date,
  payload: z.infer<typeof salesOrderPayloadSchema>
): Omit<Prisma.SalesOrderCreateInput, 'items'> {
  const shipping = payload.shipping_address;
  const contact = extractCustomerContact(payload.contact_person_details);

  const warehouseFlag =
    extractSaleMadeInWarehouse(
      payload.custom_field_hash?.cf_la_venta_se_realizo_en_alma_unformatted
    ) ?? extractSaleMadeInWarehouse(payload.custom_field_hash?.cf_la_venta_se_realizo_en_alma);

  return {
    zohoSalesOrderId: payload.salesorder_id,
    salesOrderNumber: payload.salesorder_number ?? null,
    referenceNumber: payload.reference_number ?? null,
    orderDate: parseZohoCommercialDate(payload.date),
    createdTime: parseZohoDate(payload.created_time),
    status: payload.order_status ?? null,
    subStatus: payload.current_sub_status ?? null,
    paidStatus: payload.paid_status ?? null,
    invoicedStatus: payload.invoiced_status ?? null,
    shippedStatus: payload.shipped_status ?? null,
    zohoCustomerId: payload.customer_id ?? null,
    customerName: payload.customer_name ?? null,
    customerEmail: contact.email,
    customerPhone: contact.phone,
    zohoSalespersonId: payload.salesperson_id ?? null,
    salespersonName: payload.salesperson_name ?? null,
    paymentMethod: payload.payment_terms_label ?? null,
    deliveryMethod: payload.delivery_method ?? null,
    deliveryMethodId: payload.delivery_method_id ?? null,
    locationId: payload.location_id ?? null,
    locationName: payload.location_name ?? null,
    branchId: payload.branch_id ?? null,
    branchName: payload.branch_name ?? null,
    shippingAttention: shipping?.attention ?? null,
    shippingAddressLine1: shipping?.address ?? null,
    shippingAddressLine2: shipping?.street2 ?? null,
    shippingCity: shipping?.city ?? null,
    shippingState: shipping?.state ?? null,
    shippingPostalCode: shipping?.zip ?? null,
    shippingCountry: shipping?.country ?? null,
    shippingPhone: shipping?.phone ?? null,
    currencyCode: payload.currency_code ?? null,
    subtotal: toDecimal(payload.sub_total),
    discountTotal: toDecimal(payload.discount_total),
    taxTotal: toDecimal(payload.tax_total),
    shippingCharge: toDecimal(payload.shipping_charge),
    adjustment: toDecimal(payload.adjustment),
    total: toDecimal(payload.total),
    balance: toDecimal(payload.balance),
    notes: payload.notes ?? null,
    saleMadeInWarehouse: warehouseFlag,
    sourceRemoteModifiedAt: remoteModifiedAt,
    sourceSnapshotId: snapshotId,
    normalizedAt: new Date(),
  };
}

function buildItems(
  lineItems: z.infer<typeof lineItemSchema>[]
): Omit<Prisma.SalesOrderItemCreateManyInput, 'salesOrderId'>[] {
  return lineItems.map((item, index) => {
    let taxAmount: Prisma.Decimal | null = null;
    if (Array.isArray(item.line_item_taxes) && item.line_item_taxes.length > 0) {
      const sum = item.line_item_taxes.reduce((acc, tax) => {
        const amount = toDecimal(tax.tax_amount);
        return amount ? acc.plus(amount) : acc;
      }, new Prisma.Decimal(0));
      taxAmount = sum;
    } else {
      taxAmount = toDecimal(item.tax_amount);
    }

    const sortOrder = typeof item.item_order === 'number' ? item.item_order : index + 1;

    return {
      zohoLineItemId: item.line_item_id ?? null,
      zohoItemId: item.item_id ?? null,
      sku: item.sku ?? null,
      name: item.name ?? item.item_name ?? null,
      description: item.description ?? null,
      quantity: toDecimal(item.quantity),
      unit: item.unit ?? null,
      rate: toDecimal(item.rate),
      discountAmount: toDecimal(item.discount_amount),
      taxName: item.tax_name ?? null,
      taxPercentage: toDecimal(item.tax_percentage),
      taxAmount,
      lineTotal: toDecimal(item.item_total),
      locationId: item.location_id ?? null,
      locationName: item.location_name ?? null,
      sortOrder,
    };
  });
}

async function markSnapshotProcessed(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  snapshotId: string,
  normalizationVersion: number,
  errorCode: string | null
): Promise<void> {
  await tx.integrationSnapshot.update({
    where: { id: snapshotId },
    data: {
      normalizedAt: errorCode === null ? new Date() : null,
      normalizationVersion,
      normalizationErrorCode: errorCode,
    },
  });
}

async function markSnapshotFailed(
  snapshotId: string,
  existingVersion: number,
  errorCode: string
): Promise<void> {
  await prisma.integrationSnapshot.update({
    where: { id: snapshotId },
    data: {
      normalizedAt: null,
      normalizationVersion: existingVersion,
      normalizationErrorCode: errorCode,
    },
  });
}

function logFailure(snapshotId: string, externalId: string, errorCode: string) {
  log({
    event: 'zoho.sales_orders.normalization.failed',
    snapshotId,
    externalId,
    normalizerVersion: CURRENT_SALES_ORDER_NORMALIZER_VERSION,
    errorCode,
  });
}

type ExtractPayloadResult =
  { data: z.infer<typeof salesOrderPayloadSchema>; error: null } | { data: null; error: string };

/**
 * Accepts the two payload shapes we may have persisted in IntegrationSnapshot:
 * 1) Zoho API wrapper: { code, message, salesorder: {...} }
 * 2) Sales order direct: { salesorder_id, ... }
 *
 * Returns the inner sales order object or an error string.
 * Does NOT modify the RAW payload.
 */
function extractSalesOrderPayload(raw: unknown): ExtractPayloadResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }

  const obj = raw as Record<string, unknown>;

  // Direct sales order shape
  if (typeof obj.salesorder_id === 'string' && obj.salesorder_id.length > 0) {
    const parse = salesOrderPayloadSchema.safeParse(raw);
    if (!parse.success) {
      return { data: null, error: 'Invalid direct sales order shape' };
    }
    return { data: parse.data, error: null };
  }

  // Zoho API wrapper shape
  if ('code' in obj) {
    if (typeof obj.code !== 'number' || obj.code !== 0) {
      return { data: null, error: `Zoho API error code: ${obj.code}` };
    }
    if (
      typeof obj.salesorder !== 'object' ||
      obj.salesorder === null ||
      Array.isArray(obj.salesorder)
    ) {
      return { data: null, error: 'Missing or invalid salesorder in Zoho wrapper' };
    }
    const parse = salesOrderPayloadSchema.safeParse(obj.salesorder);
    if (!parse.success) {
      return { data: null, error: 'Invalid wrapped sales order shape' };
    }
    return { data: parse.data, error: null };
  }

  return { data: null, error: 'Unrecognized snapshot payload shape' };
}

/**
 * Normalizes a single IntegrationSnapshot into SalesOrder + SalesOrderItem.
 * Stale snapshots (older than the currently normalized version) are skipped but
 * marked as processed so they are not retried forever.
 */
export async function normalizeSalesOrderSnapshot(
  snapshot: SnapshotInput
): Promise<{ salesOrderId: string; status: 'normalized' | 'skipped' }> {
  if (snapshot.source !== SOURCE || snapshot.entityType !== ENTITY_TYPE) {
    await markSnapshotFailed(
      snapshot.id,
      snapshot.normalizationVersion,
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID
    );
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
      snapshot.id,
      'Snapshot source/entity type does not match Zoho sales orders'
    );
  }

  const extraction = extractSalesOrderPayload(snapshot.payload);
  if (extraction.data === null) {
    await markSnapshotFailed(
      snapshot.id,
      snapshot.normalizationVersion,
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID
    );
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
      snapshot.id,
      extraction.error ?? 'Invalid snapshot payload shape'
    );
  }

  const payload = extraction.data;
  const salesOrderData = buildSalesOrderData(snapshot.id, snapshot.remoteModifiedAt, payload);
  const items = buildItems(payload.line_items ?? []);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.salesOrder.findUnique({
      where: { zohoSalesOrderId: payload.salesorder_id },
      select: { id: true, sourceRemoteModifiedAt: true },
    });

    if (
      existing &&
      existing.sourceRemoteModifiedAt.getTime() > snapshot.remoteModifiedAt.getTime()
    ) {
      await markSnapshotProcessed(tx, snapshot.id, CURRENT_SALES_ORDER_NORMALIZER_VERSION, null);
      return { salesOrderId: existing.id, status: 'skipped' };
    }

    const order = await persistNormalizedOrder(tx, payload.salesorder_id, salesOrderData, items);
    await markSnapshotProcessed(tx, snapshot.id, CURRENT_SALES_ORDER_NORMALIZER_VERSION, null);

    log({
      event: 'zoho.sales_orders.normalization.completed',
      snapshotId: snapshot.id,
      externalId: snapshot.externalId,
      normalizerVersion: CURRENT_SALES_ORDER_NORMALIZER_VERSION,
      salesOrderId: order.salesOrderId,
    });

    return { salesOrderId: order.salesOrderId, status: 'normalized' };
  });
}

export interface NormalizePendingSnapshotsResult {
  seen: number;
  normalized: number;
  skipped: number;
  failed: number;
  alreadyRunning: boolean;
}

/**
 * Processes a bounded number of unnormalized Zoho Sales Order snapshots.
 * Never throws: each snapshot is processed in isolation and the batch returns
 * a summary. This function does NOT call Zoho.
 */
export async function normalizePendingSalesOrderSnapshots(options: {
  limit: number;
}): Promise<NormalizePendingSnapshotsResult> {
  const state = getNormalizerState();
  if (state.batchInProgress) {
    throw new NormalizationAlreadyRunningError();
  }

  state.batchInProgress = true;

  try {
    const pending = await prisma.integrationSnapshot.findMany({
      where: {
        source: SOURCE,
        entityType: ENTITY_TYPE,
        normalizationVersion: { lt: CURRENT_SALES_ORDER_NORMALIZER_VERSION },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(options.limit, 500)),
    });

    let normalized = 0;
    let skipped = 0;
    let failed = 0;

    for (const snapshot of pending) {
      try {
        const result = await normalizeSalesOrderSnapshot(snapshot as SnapshotInput);
        if (result.status === 'normalized') {
          normalized += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        const errorCode =
          error instanceof NormalizationError
            ? error.errorCode
            : NORMALIZATION_ERROR_CODE.UNEXPECTED_ERROR;
        const snapshotId = error instanceof NormalizationError ? error.snapshotId : snapshot.id;

        try {
          await markSnapshotFailed(
            snapshotId,
            'normalizationVersion' in snapshot ? snapshot.normalizationVersion : 0,
            errorCode
          );
        } catch {
          // If even the error marker update fails, just log and continue.
        }

        logFailure(snapshotId, snapshot.externalId, errorCode);
      }
    }

    log({
      event: 'zoho.sales_orders.normalization.batch_completed',
      seen: pending.length,
      normalized,
      skipped,
      failed,
      normalizerVersion: CURRENT_SALES_ORDER_NORMALIZER_VERSION,
    });

    return { seen: pending.length, normalized, skipped, failed, alreadyRunning: false };
  } finally {
    state.batchInProgress = false;
  }
}
