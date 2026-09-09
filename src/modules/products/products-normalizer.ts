import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { SOURCE, PRODUCTS_ENTITY_TYPE } from '@/modules/integrations/zoho/products-sync';

export const CURRENT_PRODUCT_NORMALIZER_VERSION = 1;

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
    super('A products normalization batch is already running in this instance');
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

const NORMALIZER_STATE_KEY = '__unikZohoProductsNormalizerState' as const;

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

function log(payload: Record<string, unknown>) {
  console.info(JSON.stringify(payload));
}

const productPayloadSchema = z
  .object({
    item_id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().nullish(),
    sku: z.string().nullish(),
    status: z.string().nullish(),
    product_type: z.string().nullish(),
    description: z.string().nullish(),
    rate: z.number().nullish(),
    unit: z.string().nullish(),
    currency_code: z.string().nullish(),
    tax_name: z.string().nullish(),
    tax_percentage: z.union([z.string(), z.number()]).nullish(),
    is_taxable: z.boolean().nullish(),
    stock_on_hand: z.union([z.string(), z.number()]).nullish(),
    available_stock: z.union([z.string(), z.number()]).nullish(),
    reorder_level: z.union([z.string(), z.number()]).nullish(),
    purchase_rate: z.number().nullish(),
    category_name: z.string().nullish(),
    category_id: z.string().nullish(),
    manufacturer: z.string().nullish(),
    brand: z.string().nullish(),
    vendor_id: z.string().nullish(),
    vendor_name: z.string().nullish(),
    last_modified_time: z.string().nullish(),
    // Mexico SAT fields (custom fields)
    cf_sat_product_code: z.string().nullish(),
    cf_clave_de_producto_sat: z.string().nullish(),
    cf_sat_unit_code: z.string().nullish(),
    cf_clave_de_unidad_sat: z.string().nullish(),
  })
  .passthrough();

function toDecimal(value: unknown): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Prisma.Decimal) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? new Prisma.Decimal(value) : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/,/g, '');
  if (cleaned.length === 0) return null;
  try {
    return new Prisma.Decimal(cleaned);
  } catch {
    return null;
  }
}

function buildProductData(
  snapshotId: string,
  remoteModifiedAt: Date,
  payload: z.infer<typeof productPayloadSchema>
): Prisma.ProductCreateInput {
  return {
    zohoItemId: payload.item_id,
    name: payload.name ?? null,
    sku: payload.sku ?? null,
    status: payload.status ?? null,
    productType: payload.product_type ?? null,
    description: payload.description ?? null,
    rate: toDecimal(payload.rate),
    unit: payload.unit ?? null,
    currencyCode: payload.currency_code ?? null,
    taxName: payload.tax_name ?? null,
    taxPercentage: toDecimal(payload.tax_percentage),
    isTaxable: payload.is_taxable ?? null,
    stockOnHand: toDecimal(payload.stock_on_hand),
    availableStock: toDecimal(payload.available_stock),
    reorderLevel: toDecimal(payload.reorder_level),
    purchaseRate: toDecimal(payload.purchase_rate),
    categoryName: payload.category_name ?? null,
    categoryId: payload.category_id ?? null,
    manufacturer: payload.manufacturer ?? null,
    brand: payload.brand ?? null,
    zohoVendorId: payload.vendor_id ?? null,
    vendorName: payload.vendor_name ?? null,
    // Mexico SAT fields
    satProductCode: payload.cf_sat_product_code ?? payload.cf_clave_de_producto_sat ?? null,
    satUnitCode: payload.cf_sat_unit_code ?? payload.cf_clave_de_unidad_sat ?? null,
    sourceRemoteModifiedAt: remoteModifiedAt,
    sourceSnapshotId: snapshotId,
    normalizedAt: new Date(),
  };
}

type ExtractPayloadResult =
  | { data: z.infer<typeof productPayloadSchema>; error: null }
  | { data: null; error: string };

function extractProductPayload(raw: unknown): ExtractPayloadResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }

  const obj = raw as Record<string, unknown>;

  // Direct item shape
  if (typeof obj.item_id === 'string' || typeof obj.item_id === 'number') {
    const parse = productPayloadSchema.safeParse(raw);
    if (!parse.success) return { data: null, error: 'Invalid direct item shape' };
    return { data: parse.data, error: null };
  }

  // Zoho API wrapper shape: { code, message, item: {...} }
  if ('code' in obj) {
    if (typeof obj.code !== 'number' || obj.code !== 0) {
      return { data: null, error: `Zoho API error code: ${obj.code}` };
    }
    if (typeof obj.item !== 'object' || obj.item === null || Array.isArray(obj.item)) {
      return { data: null, error: 'Missing or invalid item in Zoho wrapper' };
    }
    const parse = productPayloadSchema.safeParse(obj.item);
    if (!parse.success) return { data: null, error: 'Invalid wrapped item shape' };
    return { data: parse.data, error: null };
  }

  return { data: null, error: 'Unrecognized snapshot payload shape' };
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
    event: 'zoho.products.normalization.failed',
    snapshotId,
    externalId,
    normalizerVersion: CURRENT_PRODUCT_NORMALIZER_VERSION,
    errorCode,
  });
}

export async function normalizeProductSnapshot(
  snapshot: SnapshotInput
): Promise<{ productId: string; status: 'normalized' | 'skipped' }> {
  if (snapshot.source !== SOURCE || snapshot.entityType !== PRODUCTS_ENTITY_TYPE) {
    await markSnapshotFailed(
      snapshot.id,
      snapshot.normalizationVersion,
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID
    );
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
      snapshot.id,
      'Snapshot source/entity type does not match Zoho products'
    );
  }

  const extraction = extractProductPayload(snapshot.payload);
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
  const productData = buildProductData(snapshot.id, snapshot.remoteModifiedAt, payload);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.product.findUnique({
      where: { zohoItemId: payload.item_id },
      select: { id: true, sourceRemoteModifiedAt: true },
    });

    if (
      existing &&
      existing.sourceRemoteModifiedAt.getTime() > snapshot.remoteModifiedAt.getTime()
    ) {
      await markSnapshotProcessed(tx, snapshot.id, CURRENT_PRODUCT_NORMALIZER_VERSION, null);
      return { productId: existing.id, status: 'skipped' };
    }

    const product = await tx.product.upsert({
      where: { zohoItemId: payload.item_id },
      create: productData,
      update: productData,
    });

    await markSnapshotProcessed(tx, snapshot.id, CURRENT_PRODUCT_NORMALIZER_VERSION, null);

    log({
      event: 'zoho.products.normalization.completed',
      snapshotId: snapshot.id,
      externalId: snapshot.externalId,
      normalizerVersion: CURRENT_PRODUCT_NORMALIZER_VERSION,
      productId: product.id,
    });

    return { productId: product.id, status: 'normalized' };
  });
}

export interface NormalizePendingSnapshotsResult {
  seen: number;
  normalized: number;
  skipped: number;
  failed: number;
  alreadyRunning: boolean;
}

export async function normalizePendingProductSnapshots(options: {
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
        entityType: PRODUCTS_ENTITY_TYPE,
        normalizationVersion: { lt: CURRENT_PRODUCT_NORMALIZER_VERSION },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(options.limit, 500)),
    });

    let normalized = 0;
    let skipped = 0;
    let failed = 0;

    for (const snapshot of pending) {
      try {
        const result = await normalizeProductSnapshot(snapshot as SnapshotInput);
        if (result.status === 'normalized') normalized += 1;
        else skipped += 1;
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
      event: 'zoho.products.normalization.batch_completed',
      seen: pending.length,
      normalized,
      skipped,
      failed,
      normalizerVersion: CURRENT_PRODUCT_NORMALIZER_VERSION,
    });

    return { seen: pending.length, normalized, skipped, failed, alreadyRunning: false };
  } finally {
    state.batchInProgress = false;
  }
}
