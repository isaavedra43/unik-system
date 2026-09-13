import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import {
  SOURCE,
  ESTIMATES_ENTITY_TYPE,
  ESTIMATES_NORMALIZER_VERSION,
} from '@/modules/integrations/zoho/estimates-sync';
import { getQuoteSnapshot, getQuoteSnapshotByZohoId, recordQuoteChange } from './quotes-change-events';

const CURRENT_QUOTE_NORMALIZER_VERSION = ESTIMATES_NORMALIZER_VERSION;

export const NORMALIZATION_ERROR_CODE = {
  SNAPSHOT_SHAPE_INVALID: 'SNAPSHOT_SHAPE_INVALID',
  MAPPING_ERROR: 'MAPPING_ERROR',
  PERSISTENCE_ERROR: 'PERSISTENCE_ERROR',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
} as const;

class NormalizationError extends Error {
  constructor(public readonly errorCode: string, public readonly snapshotId: string, message: string) {
    super(message);
    this.name = 'NormalizationError';
  }
}

export class NormalizationAlreadyRunningError extends Error {
  constructor() {
    super('A quotes normalization batch is already running in this instance');
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

const NORMALIZER_STATE_KEY = '__unikZohoQuotesNormalizerState' as const;
interface NormalizerState { batchInProgress: boolean; }
type GlobalWithNormalizerState = typeof globalThis & { [NORMALIZER_STATE_KEY]?: NormalizerState };

function getNormalizerState(): NormalizerState {
  const scope = globalThis as GlobalWithNormalizerState;
  scope[NORMALIZER_STATE_KEY] ??= { batchInProgress: false };
  return scope[NORMALIZER_STATE_KEY];
}

function log(payload: Record<string, unknown>) {
  console.info(JSON.stringify(payload));
}

const numberish = z.union([z.string(), z.number()]).nullish();
const idish = z.union([z.string(), z.number()]).transform(String).nullish();

const addressSchema = z.object({
  address: z.string().nullish(),
  street2: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  zip: z.union([z.string(), z.number()]).transform((v) => (v === null || v === undefined ? null : String(v))).nullish(),
  country: z.string().nullish(),
}).passthrough().nullish();

const lineItemSchema = z.object({
  line_item_id: idish,
  item_id: idish,
  sku: z.string().nullish(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  quantity: numberish,
  rate: numberish,
  unit: z.string().nullish(),
  discount: numberish,
  discount_amount: numberish,
  tax_id: idish,
  tax_name: z.string().nullish(),
  tax_percentage: numberish,
  tax_amount: numberish,
  item_total: numberish,
  item_order: numberish,
}).passthrough();

export const estimatePayloadSchema = z
  .object({
    estimate_id: z.union([z.string(), z.number()]).transform(String),
    estimate_number: z.string().nullish(),
    reference_number: z.string().nullish(),
    status: z.string().nullish(),
    date: z.string().nullish(),
    expiry_date: z.string().nullish(),
    customer_id: idish,
    customer_name: z.string().nullish(),
    currency_id: idish,
    currency_code: z.string().nullish(),
    exchange_rate: numberish,
    discount: numberish,
    is_discount_before_tax: z.boolean().nullish(),
    discount_type: z.string().nullish(),
    is_inclusive_tax: z.boolean().nullish(),
    shipping_charge: numberish,
    adjustment: numberish,
    adjustment_description: z.string().nullish(),
    sub_total: numberish,
    tax_total: numberish,
    discount_total: numberish,
    total: numberish,
    salesperson_id: idish,
    salesperson_name: z.string().nullish(),
    template_id: idish,
    template_name: z.string().nullish(),
    billing_address: addressSchema,
    shipping_address: addressSchema,
    notes: z.string().nullish(),
    terms: z.string().nullish(),
    custom_fields: z.array(z.unknown()).nullish(),
    is_viewed_by_client: z.boolean().nullish(),
    accepted_date: z.string().nullish(),
    declined_date: z.string().nullish(),
    created_time: z.string().nullish(),
    last_modified_time: z.string().nullish(),
    line_items: z.array(lineItemSchema).nullish(),
  })
  .passthrough();

export type EstimatePayload = z.infer<typeof estimatePayloadSchema>;

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

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function buildQuoteData(
  snapshotId: string,
  remoteModifiedAt: Date,
  payload: EstimatePayload
): { quote: Prisma.QuoteCreateInput; items: Omit<Prisma.QuoteItemCreateManyInput, 'quoteId'>[] } {
  const billing = payload.billing_address ?? null;
  const shipping = payload.shipping_address ?? null;

  const quoteData: Prisma.QuoteCreateInput = {
    zohoEstimateId: payload.estimate_id,
    estimateNumber: emptyToNull(payload.estimate_number),
    referenceNumber: emptyToNull(payload.reference_number),
    status: emptyToNull(payload.status)?.toLowerCase() ?? null,
    date: safeDate(payload.date),
    expiryDate: safeDate(payload.expiry_date),
    zohoCustomerId: emptyToNull(payload.customer_id),
    customerName: emptyToNull(payload.customer_name),
    currencyId: emptyToNull(payload.currency_id),
    currencyCode: emptyToNull(payload.currency_code),
    exchangeRate: toDecimal(payload.exchange_rate),
    subTotal: toDecimal(payload.sub_total),
    taxTotal: toDecimal(payload.tax_total),
    discountTotal: toDecimal(payload.discount_total),
    discount: toDecimal(payload.discount),
    discountType: emptyToNull(payload.discount_type),
    isDiscountBeforeTax: payload.is_discount_before_tax ?? null,
    isInclusiveTax: payload.is_inclusive_tax ?? null,
    shippingCharge: toDecimal(payload.shipping_charge),
    adjustment: toDecimal(payload.adjustment),
    adjustmentDescription: emptyToNull(payload.adjustment_description),
    total: toDecimal(payload.total),
    salespersonId: emptyToNull(payload.salesperson_id),
    salespersonName: emptyToNull(payload.salesperson_name),
    templateId: emptyToNull(payload.template_id),
    templateName: emptyToNull(payload.template_name),
    billingAddress: emptyToNull(billing?.address),
    billingStreet2: emptyToNull(billing?.street2),
    billingCity: emptyToNull(billing?.city),
    billingState: emptyToNull(billing?.state),
    billingZip: emptyToNull(billing?.zip ?? null),
    billingCountry: emptyToNull(billing?.country),
    shippingAddress: emptyToNull(shipping?.address),
    shippingStreet2: emptyToNull(shipping?.street2),
    shippingCity: emptyToNull(shipping?.city),
    shippingState: emptyToNull(shipping?.state),
    shippingZip: emptyToNull(shipping?.zip ?? null),
    shippingCountry: emptyToNull(shipping?.country),
    notes: emptyToNull(payload.notes),
    terms: emptyToNull(payload.terms),
    customFields: payload.custom_fields && payload.custom_fields.length > 0
      ? (payload.custom_fields as Prisma.InputJsonValue)
      : Prisma.JsonNull,
    isViewedByClient: payload.is_viewed_by_client ?? null,
    acceptedDate: safeDate(payload.accepted_date),
    declinedDate: safeDate(payload.declined_date),
    zohoCreatedTime: safeDate(payload.created_time),
    zohoLastModifiedTime: safeDate(payload.last_modified_time),
    sourceRemoteModifiedAt: remoteModifiedAt,
    sourceSnapshotId: snapshotId,
    normalizedAt: new Date(),
  };

  const rawItems = [...(payload.line_items ?? [])];
  rawItems.sort((a, b) => Number(a.item_order ?? 0) - Number(b.item_order ?? 0));

  const items: Omit<Prisma.QuoteItemCreateManyInput, 'quoteId'>[] = rawItems.map((item, index) => ({
    zohoLineItemId: emptyToNull(item.line_item_id),
    zohoItemId: emptyToNull(item.item_id),
    sku: emptyToNull(item.sku),
    name: emptyToNull(item.name),
    description: emptyToNull(item.description),
    quantity: toDecimal(item.quantity),
    rate: toDecimal(item.rate),
    unit: emptyToNull(item.unit),
    discount: item.discount === null || item.discount === undefined ? null : String(item.discount),
    discountAmount: toDecimal(item.discount_amount),
    taxId: emptyToNull(item.tax_id),
    taxName: emptyToNull(item.tax_name),
    taxPercentage: toDecimal(item.tax_percentage),
    taxAmount: toDecimal(item.tax_amount),
    lineTotal: toDecimal(item.item_total),
    sortOrder: index,
  }));

  return { quote: quoteData, items };
}

type ExtractPayloadResult =
  | { data: EstimatePayload; error: null }
  | { data: null; error: string };

export function extractEstimatePayload(raw: unknown): ExtractPayloadResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.estimate_id === 'string' || typeof obj.estimate_id === 'number') {
    const parse = estimatePayloadSchema.safeParse(raw);
    if (!parse.success) return { data: null, error: 'Invalid direct estimate shape' };
    return { data: parse.data, error: null };
  }
  if ('code' in obj) {
    if (typeof obj.code !== 'number' || obj.code !== 0) {
      return { data: null, error: `Zoho API error code: ${obj.code}` };
    }
    if (typeof obj.estimate !== 'object' || obj.estimate === null || Array.isArray(obj.estimate)) {
      return { data: null, error: 'Missing or invalid estimate in Zoho wrapper' };
    }
    const parse = estimatePayloadSchema.safeParse(obj.estimate);
    if (!parse.success) return { data: null, error: 'Invalid wrapped estimate shape' };
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
    data: { normalizedAt: errorCode === null ? new Date() : null, normalizationVersion, normalizationErrorCode: errorCode },
  });
}

async function markSnapshotFailed(snapshotId: string, existingVersion: number, errorCode: string): Promise<void> {
  await prisma.integrationSnapshot.update({
    where: { id: snapshotId },
    data: { normalizedAt: null, normalizationVersion: existingVersion, normalizationErrorCode: errorCode },
  });
}

function logFailure(snapshotId: string, externalId: string, errorCode: string) {
  log({ event: 'zoho.quotes.normalization.failed', snapshotId, externalId, normalizerVersion: CURRENT_QUOTE_NORMALIZER_VERSION, errorCode });
}

export interface NormalizeQuoteOptions {
  /** UNIK user who triggered the write (create/edit/status) — null for background sync. */
  actorUserId?: string | null;
  /** 'created_in_unik' | 'edited_in_unik' | 'status_changed' | 'cloned' | null (sync). */
  origin?: string | null;
  /** When true, the local authorship columns are stamped (createdInUnik / createdBy). */
  markCreatedInUnik?: boolean;
  /** Force the upsert even when the local record looks newer (used by the write service). */
  force?: boolean;
}

export async function normalizeQuoteSnapshot(
  snapshot: SnapshotInput,
  options: NormalizeQuoteOptions = {}
): Promise<{ quoteId: string; status: 'normalized' | 'skipped' }> {
  if (snapshot.source !== SOURCE || snapshot.entityType !== ESTIMATES_ENTITY_TYPE) {
    await markSnapshotFailed(snapshot.id, snapshot.normalizationVersion, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID, snapshot.id, 'Snapshot source/entity type does not match Zoho estimates');
  }

  const extraction = extractEstimatePayload(snapshot.payload);
  if (extraction.data === null) {
    await markSnapshotFailed(snapshot.id, snapshot.normalizationVersion, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID, snapshot.id, extraction.error ?? 'Invalid snapshot payload shape');
  }

  const payload = extraction.data;
  const { quote: quoteData, items } = buildQuoteData(snapshot.id, snapshot.remoteModifiedAt, payload);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.quote.findUnique({
      where: { zohoEstimateId: payload.estimate_id },
      select: { id: true, sourceRemoteModifiedAt: true },
    });

    if (!options.force && existing && existing.sourceRemoteModifiedAt.getTime() > snapshot.remoteModifiedAt.getTime()) {
      await markSnapshotProcessed(tx, snapshot.id, CURRENT_QUOTE_NORMALIZER_VERSION, null);
      return { quoteId: existing.id, status: 'skipped' };
    }

    const before = await getQuoteSnapshotByZohoId(tx, payload.estimate_id);

    const authorship: Partial<Prisma.QuoteUpdateInput> = {};
    if (options.actorUserId) {
      authorship.lastEditedByUserId = options.actorUserId;
      authorship.lastEditedInUnikAt = new Date();
    }
    const createAuthorship: Partial<Prisma.QuoteCreateInput> = options.markCreatedInUnik
      ? { createdInUnik: true, createdByUserId: options.actorUserId ?? null }
      : {};

    const quote = await tx.quote.upsert({
      where: { zohoEstimateId: payload.estimate_id },
      create: { ...quoteData, ...createAuthorship, ...(authorship as Prisma.QuoteCreateInput) },
      update: { ...quoteData, ...authorship },
    });

    await tx.quoteItem.deleteMany({ where: { quoteId: quote.id } });
    if (items.length > 0) {
      await tx.quoteItem.createMany({ data: items.map((item) => ({ ...item, quoteId: quote.id })) });
    }

    const after = await getQuoteSnapshot(tx, quote.id);
    if (after.quote) {
      await recordQuoteChange(tx, {
        quoteId: quote.id,
        estimateNumber: quote.estimateNumber,
        sourceSnapshotId: snapshot.id,
        sourceRemoteModifiedAt: snapshot.remoteModifiedAt,
        before,
        after: { quote: after.quote, items: after.items },
        actorUserId: options.actorUserId ?? null,
        origin: options.origin ?? null,
      });
    }

    await markSnapshotProcessed(tx, snapshot.id, CURRENT_QUOTE_NORMALIZER_VERSION, null);

    log({
      event: 'zoho.quotes.normalization.completed',
      snapshotId: snapshot.id, externalId: snapshot.externalId,
      normalizerVersion: CURRENT_QUOTE_NORMALIZER_VERSION,
      quoteId: quote.id, itemCount: items.length, origin: options.origin ?? 'sync',
    });

    return { quoteId: quote.id, status: 'normalized' };
  });
}

export interface NormalizePendingSnapshotsResult {
  seen: number; normalized: number; skipped: number; failed: number; alreadyRunning: boolean;
}

export async function normalizePendingQuoteSnapshots(options: { limit: number }): Promise<NormalizePendingSnapshotsResult> {
  const state = getNormalizerState();
  if (state.batchInProgress) throw new NormalizationAlreadyRunningError();
  state.batchInProgress = true;

  try {
    const pending = await prisma.integrationSnapshot.findMany({
      where: { source: SOURCE, entityType: ESTIMATES_ENTITY_TYPE, normalizationVersion: { lt: CURRENT_QUOTE_NORMALIZER_VERSION } },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(options.limit, 500)),
    });

    let normalized = 0, skipped = 0, failed = 0;
    for (const snapshot of pending) {
      try {
        const result = await normalizeQuoteSnapshot(snapshot as SnapshotInput);
        if (result.status === 'normalized') normalized += 1; else skipped += 1;
      } catch (error) {
        failed += 1;
        const errorCode = error instanceof NormalizationError ? error.errorCode : NORMALIZATION_ERROR_CODE.UNEXPECTED_ERROR;
        const snapshotId = error instanceof NormalizationError ? error.snapshotId : snapshot.id;
        try { await markSnapshotFailed(snapshotId, snapshot.normalizationVersion, errorCode); } catch { /* continue */ }
        logFailure(snapshotId, snapshot.externalId, errorCode);
      }
    }

    log({ event: 'zoho.quotes.normalization.batch_completed', seen: pending.length, normalized, skipped, failed, normalizerVersion: CURRENT_QUOTE_NORMALIZER_VERSION });
    return { seen: pending.length, normalized, skipped, failed, alreadyRunning: false };
  } finally {
    state.batchInProgress = false;
  }
}
