import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ENTITY_TYPE, SOURCE } from '@/modules/integrations/zoho/packages-sync';

export const CURRENT_PACKAGE_NORMALIZER_VERSION = 1;

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
    super('A package normalization batch is already running in this instance');
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

const NORMALIZER_STATE_KEY = '__unikZohoPackagesNormalizerState' as const;

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

const packageItemSchema = z
  .object({
    line_item_id: z.string().nullish(),
    so_line_item_id: z.string().nullish(),
    item_id: z.string().nullish(),
    sku: z.string().nullish(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    quantity: z.number().nullish(),
    unit: z.string().nullish(),
    is_invoiced: z.boolean().nullish(),
    is_combo_product: z.boolean().nullish(),
    combo_type: z.string().nullish(),
    item_order: z.number().nullish(),
  })
  .passthrough();

const packagePayloadSchema = z
  .object({
    package_id: z.string().min(1),
    package_number: z.string().nullish(),
    salesorder_id: z.string().nullish(),
    salesorder_number: z.string().nullish(),
    date: z.string().nullish(),
    shipment_date: z.string().nullish(),
    tracking_number: z.string().nullish(),
    delivery_method: z.string().nullish(),
    status: z.string().nullish(),
    customer_id: z.string().nullish(),
    customer_name: z.string().nullish(),
    total_quantity: z.number().nullish(),
    line_items: z.array(packageItemSchema).nullish(),
  })
  .passthrough();

function log(payload: Record<string, unknown>) {
  console.info(JSON.stringify(payload));
}

function parseZohoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseZohoCommercialDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDecimal(value: unknown): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Prisma.Decimal) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? new Prisma.Decimal(value) : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\,/g, '');
  if (cleaned.length === 0) return null;
  try {
    return new Prisma.Decimal(cleaned);
  } catch {
    return null;
  }
}

async function persistNormalizedPackage(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  zohoPackageId: string,
  packageData: Omit<Prisma.SalesOrderPackageCreateInput, 'items'>,
  items: Omit<Prisma.SalesOrderPackageItemCreateManyInput, 'packageId'>[]
): Promise<{ packageId: string }> {
  const pkg = await tx.salesOrderPackage.upsert({
    where: { zohoPackageId },
    create: packageData,
    update: packageData,
  });

  await tx.salesOrderPackageItem.deleteMany({ where: { packageId: pkg.id } });

  if (items.length > 0) {
    await tx.salesOrderPackageItem.createMany({
      data: items.map((item) => ({ ...item, packageId: pkg.id })),
      skipDuplicates: true,
    });
  }

  return { packageId: pkg.id };
}

function buildPackageData(
  snapshotId: string,
  remoteModifiedAt: Date,
  payload: z.infer<typeof packagePayloadSchema>
): Omit<Prisma.SalesOrderPackageCreateInput, 'items'> {
  return {
    zohoPackageId: payload.package_id,
    zohoSalesOrderId: payload.salesorder_id ?? null,
    salesOrderNumber: payload.salesorder_number ?? null,
    packageNumber: payload.package_number ?? null,
    packageDate: parseZohoCommercialDate(payload.date),
    shipmentDate: parseZohoCommercialDate(payload.shipment_date),
    trackingNumber: payload.tracking_number ?? null,
    deliveryMethod: payload.delivery_method ?? null,
    status: payload.status ?? null,
    zohoCustomerId: payload.customer_id ?? null,
    customerName: payload.customer_name ?? null,
    totalQuantity: toDecimal(payload.total_quantity),
    sourceRemoteModifiedAt: remoteModifiedAt,
    sourceSnapshotId: snapshotId,
    normalizedAt: new Date(),
  };
}

function buildItems(
  lineItems: z.infer<typeof packageItemSchema>[]
): Omit<Prisma.SalesOrderPackageItemCreateManyInput, 'packageId'>[] {
  return lineItems.map((item, index) => ({
    zohoLineItemId: item.line_item_id ?? null,
    soLineItemId: item.so_line_item_id ?? null,
    zohoItemId: item.item_id ?? null,
    sku: item.sku ?? null,
    name: item.name ?? null,
    description: item.description ?? null,
    quantity: toDecimal(item.quantity),
    unit: item.unit ?? null,
    isInvoiced: item.is_invoiced ?? null,
    isComboProduct: item.is_combo_product ?? null,
    comboType: item.combo_type ?? null,
    sortOrder: typeof item.item_order === 'number' ? item.item_order : index + 1,
  }));
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
    event: 'zoho.packages.normalization.failed',
    snapshotId,
    externalId,
    normalizerVersion: CURRENT_PACKAGE_NORMALIZER_VERSION,
    errorCode,
  });
}

type ExtractPayloadResult =
  | { data: z.infer<typeof packagePayloadSchema>; error: null }
  | { data: null; error: string };

function extractPackagePayload(raw: unknown): ExtractPayloadResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.package_id === 'string' && obj.package_id.length > 0) {
    const parse = packagePayloadSchema.safeParse(raw);
    if (!parse.success) return { data: null, error: 'Invalid direct package shape' };
    return { data: parse.data, error: null };
  }

  if ('code' in obj) {
    if (typeof obj.code !== 'number' || obj.code !== 0) {
      return { data: null, error: `Zoho API error code: ${obj.code}` };
    }
    if (typeof obj.package !== 'object' || obj.package === null || Array.isArray(obj.package)) {
      return { data: null, error: 'Missing or invalid package in Zoho wrapper' };
    }
    const parse = packagePayloadSchema.safeParse(obj.package);
    if (!parse.success) return { data: null, error: 'Invalid wrapped package shape' };
    return { data: parse.data, error: null };
  }

  return { data: null, error: 'Unrecognized snapshot payload shape' };
}

export async function normalizePackageSnapshot(
  snapshot: SnapshotInput
): Promise<{ packageId: string; status: 'normalized' | 'skipped' }> {
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
      'Snapshot source/entity type does not match Zoho packages'
    );
  }

  const extraction = extractPackagePayload(snapshot.payload);
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
  const packageData = buildPackageData(snapshot.id, snapshot.remoteModifiedAt, payload);
  const items = buildItems(payload.line_items ?? []);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.salesOrderPackage.findUnique({
      where: { zohoPackageId: payload.package_id },
      select: { id: true, sourceRemoteModifiedAt: true },
    });

    if (existing && existing.sourceRemoteModifiedAt.getTime() > snapshot.remoteModifiedAt.getTime()) {
      await markSnapshotProcessed(tx, snapshot.id, CURRENT_PACKAGE_NORMALIZER_VERSION, null);
      return { packageId: existing.id, status: 'skipped' };
    }

    const pkg = await persistNormalizedPackage(tx, payload.package_id, packageData, items);
    await markSnapshotProcessed(tx, snapshot.id, CURRENT_PACKAGE_NORMALIZER_VERSION, null);

    log({
      event: 'zoho.packages.normalization.completed',
      snapshotId: snapshot.id,
      externalId: snapshot.externalId,
      normalizerVersion: CURRENT_PACKAGE_NORMALIZER_VERSION,
      packageId: pkg.packageId,
    });

    return { packageId: pkg.packageId, status: 'normalized' };
  });
}

export interface NormalizePendingSnapshotsResult {
  seen: number;
  normalized: number;
  skipped: number;
  failed: number;
  alreadyRunning: boolean;
}

export async function normalizePendingPackageSnapshots(options: {
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
        normalizationVersion: { lt: CURRENT_PACKAGE_NORMALIZER_VERSION },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(options.limit, 500)),
    });

    let normalized = 0;
    let skipped = 0;
    let failed = 0;

    for (const snapshot of pending) {
      try {
        const result = await normalizePackageSnapshot(snapshot as SnapshotInput);
        if (result.status === 'normalized') {
          normalized += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        const errorCode =
          error instanceof NormalizationError ? error.errorCode : NORMALIZATION_ERROR_CODE.UNEXPECTED_ERROR;
        const snapshotId = error instanceof NormalizationError ? error.snapshotId : snapshot.id;

        try {
          await markSnapshotFailed(
            snapshotId,
            'normalizationVersion' in snapshot ? snapshot.normalizationVersion : 0,
            errorCode
          );
        } catch {
          // ignore
        }

        logFailure(snapshotId, snapshot.externalId, errorCode);
      }
    }

    log({
      event: 'zoho.packages.normalization.batch_completed',
      seen: pending.length,
      normalized,
      skipped,
      failed,
      normalizerVersion: CURRENT_PACKAGE_NORMALIZER_VERSION,
    });

    return { seen: pending.length, normalized, skipped, failed, alreadyRunning: false };
  } finally {
    state.batchInProgress = false;
  }
}
