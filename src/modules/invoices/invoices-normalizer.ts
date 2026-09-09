import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { SOURCE, INVOICES_ENTITY_TYPE } from '@/modules/integrations/zoho/invoices-sync';

export const CURRENT_INVOICE_NORMALIZER_VERSION = 2;

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
    super('An invoices normalization batch is already running in this instance');
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

const NORMALIZER_STATE_KEY = '__unikZohoInvoicesNormalizerState' as const;

interface NormalizerState { batchInProgress: boolean; }

type GlobalWithNormalizerState = typeof globalThis & {
  [NORMALIZER_STATE_KEY]?: NormalizerState;
};

function getNormalizerState(): NormalizerState {
  const scope = globalThis as GlobalWithNormalizerState;
  scope[NORMALIZER_STATE_KEY] ??= { batchInProgress: false };
  return scope[NORMALIZER_STATE_KEY];
}

function log(payload: Record<string, unknown>) {
  console.info(JSON.stringify(payload));
}

const invoicePayloadSchema = z
  .object({
    invoice_id: z.union([z.string(), z.number()]).transform(String),
    invoice_number: z.string().nullish(),
    status: z.string().nullish(),
    date: z.string().nullish(),
    due_date: z.string().nullish(),
    customer_id: z.string().nullish(),
    customer_name: z.string().nullish(),
    currency_code: z.string().nullish(),
    sub_total: z.union([z.string(), z.number()]).nullish(),
    tax_total: z.union([z.string(), z.number()]).nullish(),
    discount_total: z.union([z.string(), z.number()]).nullish(),
    shipping_charge: z.union([z.string(), z.number()]).nullish(),
    total: z.union([z.string(), z.number()]).nullish(),
    balance: z.union([z.string(), z.number()]).nullish(),
    salesperson_name: z.string().nullish(),
    last_modified_time: z.string().nullish(),
    // Mexico CFDI fields (custom fields)
    cf_cfdi_uuid: z.string().nullish(),
    cf_uuid: z.string().nullish(),
    cf_cfdi_version: z.string().nullish(),
    cf_uso_cfdi: z.string().nullish(),
    cf_uso_de_cfdi: z.string().nullish(),
    cf_metodo_pago: z.string().nullish(),
    cf_forma_pago: z.string().nullish(),
    cf_regimen_fiscal: z.string().nullish(),
    cf_exportacion: z.string().nullish(),
    // Address fields
    billing_address: z.string().nullish(),
    billing_city: z.string().nullish(),
    billing_state: z.string().nullish(),
    billing_zip: z.string().nullish(),
    billing_country: z.string().nullish(),
    shipping_address: z.string().nullish(),
    shipping_city: z.string().nullish(),
    shipping_state: z.string().nullish(),
    shipping_zip: z.string().nullish(),
    shipping_country: z.string().nullish(),
    // Additional fields
    notes: z.string().nullish(),
    terms: z.string().nullish(),
    reference_number: z.string().nullish(),
    exchange_rate: z.union([z.string(), z.number()]).nullish(),
    discount: z.union([z.string(), z.number()]).nullish(),
    discount_type: z.string().nullish(),
    is_discount_before_tax: z.boolean().nullish(),
    created_time: z.string().nullish(),
    // Line items
    line_items: z
      .array(
        z.object({
          item_id: z.string().nullish(),
          name: z.string().nullish(),
          description: z.string().nullish(),
          quantity: z.union([z.string(), z.number()]).nullish(),
          rate: z.union([z.string(), z.number()]).nullish(),
          unit: z.string().nullish(),
          item_total: z.union([z.string(), z.number()]).nullish(),
          tax_name: z.string().nullish(),
          tax_percentage: z.union([z.string(), z.number()]).nullish(),
          tax_amount: z.union([z.string(), z.number()]).nullish(),
          discount_amount: z.union([z.string(), z.number()]).nullish(),
          salesorder_item_id: z.string().nullish(),
          salesorder_id: z.string().nullish(),
        })
      )
      .nullish(),
  })
  .passthrough();

function toDecimal(value: unknown): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Prisma.Decimal) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? new Prisma.Decimal(value) : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/,/g, '');
  if (cleaned.length === 0) return null;
  try { return new Prisma.Decimal(cleaned); } catch { return null; }
}

function safeDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildInvoiceData(
  snapshotId: string,
  remoteModifiedAt: Date,
  payload: z.infer<typeof invoicePayloadSchema>
): { invoice: Prisma.InvoiceCreateInput; items: Omit<Prisma.InvoiceItemCreateManyInput, 'invoiceId'>[] } {
  const invoiceData: Prisma.InvoiceCreateInput = {
    zohoInvoiceId: payload.invoice_id,
    invoiceNumber: payload.invoice_number ?? null,
    status: payload.status ?? null,
    date: payload.date ? new Date(payload.date) : null,
    dueDate: payload.due_date ? new Date(payload.due_date) : null,
    zohoCustomerId: payload.customer_id ?? null,
    customerName: payload.customer_name ?? null,
    currencyCode: payload.currency_code ?? null,
    subTotal: toDecimal(payload.sub_total),
    taxTotal: toDecimal(payload.tax_total),
    discountTotal: toDecimal(payload.discount_total),
    shippingCharge: toDecimal(payload.shipping_charge),
    total: toDecimal(payload.total),
    balance: toDecimal(payload.balance),
    salespersonName: payload.salesperson_name ?? null,
    // Mexico CFDI fields
    cfdiUuid: payload.cf_cfdi_uuid ?? payload.cf_uuid ?? null,
    cfdiVersion: payload.cf_cfdi_version ?? null,
    usoCfdi: payload.cf_uso_cfdi ?? payload.cf_uso_de_cfdi ?? null,
    metodoPago: payload.cf_metodo_pago ?? null,
    formaPago: payload.cf_forma_pago ?? null,
    regimenFiscal: payload.cf_regimen_fiscal ?? null,
    cfdiExportacion: payload.cf_exportacion ?? null,
    // Address fields
    billingAddress: payload.billing_address ?? null,
    billingCity: payload.billing_city ?? null,
    billingState: payload.billing_state ?? null,
    billingZip: payload.billing_zip ?? null,
    billingCountry: payload.billing_country ?? null,
    shippingAddress: payload.shipping_address ?? null,
    shippingCity: payload.shipping_city ?? null,
    shippingState: payload.shipping_state ?? null,
    shippingZip: payload.shipping_zip ?? null,
    shippingCountry: payload.shipping_country ?? null,
    // Additional fields
    notes: payload.notes ?? null,
    terms: payload.terms ?? null,
    referenceNumber: payload.reference_number ?? null,
    exchangeRate: toDecimal(payload.exchange_rate),
    discount: toDecimal(payload.discount),
    discountType: payload.discount_type ?? null,
    isDiscountBeforeTax: payload.is_discount_before_tax ?? null,
    zohoCreatedTime: payload.created_time ? safeDate(payload.created_time) : null,
    zohoLastModifiedTime: payload.last_modified_time ? safeDate(payload.last_modified_time) : null,
    sourceRemoteModifiedAt: remoteModifiedAt,
    sourceSnapshotId: snapshotId,
    normalizedAt: new Date(),
  };

  const items: Omit<Prisma.InvoiceItemCreateManyInput, 'invoiceId'>[] = (payload.line_items ?? []).map(
    (item, index) => ({
      zohoItemId: item.item_id ?? null,
      name: item.name ?? null,
      description: item.description ?? null,
      quantity: toDecimal(item.quantity),
      rate: toDecimal(item.rate),
      unit: item.unit ?? null,
      lineTotal: toDecimal(item.item_total),
      taxName: item.tax_name ?? null,
      taxPercentage: toDecimal(item.tax_percentage),
      taxAmount: toDecimal(item.tax_amount),
      discountAmount: toDecimal(item.discount_amount),
      zohoSalesOrderId: item.salesorder_id ?? null,
      zohoSalesOrderItemId: item.salesorder_item_id ?? null,
      sortOrder: index,
    })
  );

  return { invoice: invoiceData, items };
}

type ExtractPayloadResult =
  | { data: z.infer<typeof invoicePayloadSchema>; error: null }
  | { data: null; error: string };

function extractInvoicePayload(raw: unknown): ExtractPayloadResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.invoice_id === 'string' || typeof obj.invoice_id === 'number') {
    const parse = invoicePayloadSchema.safeParse(raw);
    if (!parse.success) return { data: null, error: 'Invalid direct invoice shape' };
    return { data: parse.data, error: null };
  }
  if ('code' in obj) {
    if (typeof obj.code !== 'number' || obj.code !== 0) {
      return { data: null, error: `Zoho API error code: ${obj.code}` };
    }
    if (typeof obj.invoice !== 'object' || obj.invoice === null || Array.isArray(obj.invoice)) {
      return { data: null, error: 'Missing or invalid invoice in Zoho wrapper' };
    }
    const parse = invoicePayloadSchema.safeParse(obj.invoice);
    if (!parse.success) return { data: null, error: 'Invalid wrapped invoice shape' };
    return { data: parse.data, error: null };
  }
  return { data: null, error: 'Unrecognized snapshot payload shape' };
}

async function markSnapshotProcessed(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  snapshotId: string, normalizationVersion: number, errorCode: string | null
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

async function markSnapshotFailed(snapshotId: string, existingVersion: number, errorCode: string): Promise<void> {
  await prisma.integrationSnapshot.update({
    where: { id: snapshotId },
    data: { normalizedAt: null, normalizationVersion: existingVersion, normalizationErrorCode: errorCode },
  });
}

function logFailure(snapshotId: string, externalId: string, errorCode: string) {
  log({ event: 'zoho.invoices.normalization.failed', snapshotId, externalId, normalizerVersion: CURRENT_INVOICE_NORMALIZER_VERSION, errorCode });
}

export async function normalizeInvoiceSnapshot(
  snapshot: SnapshotInput
): Promise<{ invoiceId: string; status: 'normalized' | 'skipped' }> {
  if (snapshot.source !== SOURCE || snapshot.entityType !== INVOICES_ENTITY_TYPE) {
    await markSnapshotFailed(snapshot.id, snapshot.normalizationVersion, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID, snapshot.id, 'Snapshot source/entity type does not match Zoho invoices');
  }

  const extraction = extractInvoicePayload(snapshot.payload);
  if (extraction.data === null) {
    await markSnapshotFailed(snapshot.id, snapshot.normalizationVersion, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID, snapshot.id, extraction.error ?? 'Invalid snapshot payload shape');
  }

  const payload = extraction.data;
  const { invoice: invoiceData, items } = buildInvoiceData(snapshot.id, snapshot.remoteModifiedAt, payload);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.invoice.findUnique({
      where: { zohoInvoiceId: payload.invoice_id },
      select: { id: true, sourceRemoteModifiedAt: true },
    });

    if (existing && existing.sourceRemoteModifiedAt.getTime() > snapshot.remoteModifiedAt.getTime()) {
      await markSnapshotProcessed(tx, snapshot.id, CURRENT_INVOICE_NORMALIZER_VERSION, null);
      return { invoiceId: existing.id, status: 'skipped' };
    }

    const invoice = await tx.invoice.upsert({
      where: { zohoInvoiceId: payload.invoice_id },
      create: invoiceData,
      update: invoiceData,
    });

    // Delete old items and insert new ones
    await tx.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } });
    if (items.length > 0) {
      await tx.invoiceItem.createMany({
        data: items.map((item) => ({ ...item, invoiceId: invoice.id })),
      });
    }

    await markSnapshotProcessed(tx, snapshot.id, CURRENT_INVOICE_NORMALIZER_VERSION, null);

    log({
      event: 'zoho.invoices.normalization.completed',
      snapshotId: snapshot.id, externalId: snapshot.externalId,
      normalizerVersion: CURRENT_INVOICE_NORMALIZER_VERSION,
      invoiceId: invoice.id, itemCount: items.length,
    });

    return { invoiceId: invoice.id, status: 'normalized' };
  });
}

export interface NormalizePendingSnapshotsResult {
  seen: number; normalized: number; skipped: number; failed: number; alreadyRunning: boolean;
}

export async function normalizePendingInvoiceSnapshots(options: { limit: number }): Promise<NormalizePendingSnapshotsResult> {
  const state = getNormalizerState();
  if (state.batchInProgress) throw new NormalizationAlreadyRunningError();
  state.batchInProgress = true;

  try {
    const pending = await prisma.integrationSnapshot.findMany({
      where: { source: SOURCE, entityType: INVOICES_ENTITY_TYPE, normalizationVersion: { lt: CURRENT_INVOICE_NORMALIZER_VERSION } },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(options.limit, 500)),
    });

    let normalized = 0, skipped = 0, failed = 0;

    for (const snapshot of pending) {
      try {
        const result = await normalizeInvoiceSnapshot(snapshot as SnapshotInput);
        if (result.status === 'normalized') normalized += 1; else skipped += 1;
      } catch (error) {
        failed += 1;
        const errorCode = error instanceof NormalizationError ? error.errorCode : NORMALIZATION_ERROR_CODE.UNEXPECTED_ERROR;
        const snapshotId = error instanceof NormalizationError ? error.snapshotId : snapshot.id;
        try { await markSnapshotFailed(snapshotId, 'normalizationVersion' in snapshot ? snapshot.normalizationVersion : 0, errorCode); } catch { /* continue */ }
        logFailure(snapshotId, snapshot.externalId, errorCode);
      }
    }

    log({ event: 'zoho.invoices.normalization.batch_completed', seen: pending.length, normalized, skipped, failed, normalizerVersion: CURRENT_INVOICE_NORMALIZER_VERSION });
    return { seen: pending.length, normalized, skipped, failed, alreadyRunning: false };
  } finally {
    state.batchInProgress = false;
  }
}
