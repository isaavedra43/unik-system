import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { SOURCE, PACKAGES_ENTITY_TYPE } from '@/modules/integrations/zoho/packages-sync';

const CURRENT_PACKAGE_NORMALIZER_VERSION = 2;

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
    super('A packages normalization batch is already running in this instance');
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

function log(payload: Record<string, unknown>) {
  console.info(JSON.stringify(payload));
}

const packagePayloadSchema = z
  .object({
    package_id: z.union([z.string(), z.number()]).transform(String),
    package_number: z.string().nullish(),
    status: z.string().nullish(),
    date: z.string().nullish(),
    shipment_type: z.string().nullish(),
    carrier: z.string().nullish(),
    tracking_number: z.string().nullish(),
    delivery_method: z.string().nullish(),
    shipping_charge: z.union([z.string(), z.number()]).nullish(),
    salesorder_id: z.string().nullish(),
    customer_id: z.string().nullish(),
    customer_name: z.string().nullish(),
    last_modified_time: z.string().nullish(),
    // Additional fields
    shipment_date: z.string().nullish(),
    shipment_status: z.string().nullish(),
    is_carrier_shipment: z.boolean().nullish(),
    is_tracking_enabled: z.boolean().nullish(),
    label_format: z.string().nullish(),
    sales_channel: z.string().nullish(),
    salesorder_number: z.string().nullish(),
    quantity: z.union([z.string(), z.number()]).nullish(),
    // Shipping address
    shipping_attention: z.string().nullish(),
    shipping_address: z.string().nullish(),
    shipping_city: z.string().nullish(),
    shipping_state: z.string().nullish(),
    shipping_zip: z.string().nullish(),
    shipping_country: z.string().nullish(),
    shipping_phone: z.string().nullish(),
    package_items: z
      .array(
        z.object({
          item_id: z.string().nullish(),
          name: z.string().nullish(),
          sku: z.string().nullish(),
          description: z.string().nullish(),
          quantity: z.union([z.string(), z.number()]).nullish(),
          unit: z.string().nullish(),
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
  try {
    return new Prisma.Decimal(cleaned);
  } catch {
    return null;
  }
}

function safeDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildPackageData(
  snapshotId: string,
  remoteModifiedAt: Date,
  payload: z.infer<typeof packagePayloadSchema>
): { package: Prisma.PackageCreateInput; items: Omit<Prisma.PackageItemCreateManyInput, 'packageId'>[] } {
  const packageData: Prisma.PackageCreateInput = {
    zohoPackageId: payload.package_id,
    packageNumber: payload.package_number ?? null,
    status: payload.status ?? null,
    date: payload.date ? new Date(payload.date) : null,
    shipmentType: payload.shipment_type ?? null,
    carrier: payload.carrier ?? null,
    trackingNumber: payload.tracking_number ?? null,
    deliveryMethod: payload.delivery_method ?? null,
    shippingCharge: toDecimal(payload.shipping_charge),
    zohoSalesOrderId: payload.salesorder_id ?? null,
    zohoCustomerId: payload.customer_id ?? null,
    customerName: payload.customer_name ?? null,
    // Additional fields
    shipmentDate: payload.shipment_date ? safeDate(payload.shipment_date) : null,
    shipmentStatus: payload.shipment_status ?? null,
    isCarrierShipment: payload.is_carrier_shipment ?? null,
    isTrackingEnabled: payload.is_tracking_enabled ?? null,
    labelFormat: payload.label_format ?? null,
    salesChannel: payload.sales_channel ?? null,
    salesorderNumber: payload.salesorder_number ?? null,
    quantity: toDecimal(payload.quantity),
    // Shipping address
    shippingAttention: payload.shipping_attention ?? null,
    shippingAddress: payload.shipping_address ?? null,
    shippingCity: payload.shipping_city ?? null,
    shippingState: payload.shipping_state ?? null,
    shippingZip: payload.shipping_zip ?? null,
    shippingCountry: payload.shipping_country ?? null,
    shippingPhone: payload.shipping_phone ?? null,
    sourceRemoteModifiedAt: remoteModifiedAt,
    sourceSnapshotId: snapshotId,
    normalizedAt: new Date(),
  };

  const items: Omit<Prisma.PackageItemCreateManyInput, 'packageId'>[] = (payload.package_items ?? []).map(
    (item, index) => ({
      zohoItemId: item.item_id ?? null,
      name: item.name ?? null,
      sku: item.sku ?? null,
      description: item.description ?? null,
      quantity: toDecimal(item.quantity),
      unit: item.unit ?? null,
      sortOrder: index,
    })
  );

  return { package: packageData, items };
}

type ExtractPayloadResult =
  | { data: z.infer<typeof packagePayloadSchema>; error: null }
  | { data: null; error: string };

function extractPackagePayload(raw: unknown): ExtractPayloadResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }

  const obj = raw as Record<string, unknown>;

  // Direct package shape
  if (typeof obj.package_id === 'string' || typeof obj.package_id === 'number') {
    const parse = packagePayloadSchema.safeParse(raw);
    if (!parse.success) return { data: null, error: 'Invalid direct package shape' };
    return { data: parse.data, error: null };
  }

  // Zoho API wrapper shape: { code, message, package: {...} }
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

export async function normalizePackageSnapshot(
  snapshot: SnapshotInput
): Promise<{ packageId: string; status: 'normalized' | 'skipped' }> {
  if (snapshot.source !== SOURCE || snapshot.entityType !== PACKAGES_ENTITY_TYPE) {
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
  const { package: packageData, items } = buildPackageData(snapshot.id, snapshot.remoteModifiedAt, payload);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.package.findUnique({
      where: { zohoPackageId: payload.package_id },
      select: { id: true, sourceRemoteModifiedAt: true },
    });

    if (
      existing &&
      existing.sourceRemoteModifiedAt.getTime() > snapshot.remoteModifiedAt.getTime()
    ) {
      await markSnapshotProcessed(tx, snapshot.id, CURRENT_PACKAGE_NORMALIZER_VERSION, null);
      return { packageId: existing.id, status: 'skipped' };
    }

    // Upsert package and replace items
    const pkg = await tx.package.upsert({
      where: { zohoPackageId: payload.package_id },
      create: packageData,
      update: packageData,
    });

    // Delete old items and insert new ones to preserve traceability
    await tx.packageItem.deleteMany({ where: { packageId: pkg.id } });
    if (items.length > 0) {
      await tx.packageItem.createMany({
        data: items.map((item) => ({ ...item, packageId: pkg.id })),
      });
    }

    await markSnapshotProcessed(tx, snapshot.id, CURRENT_PACKAGE_NORMALIZER_VERSION, null);

    log({
      event: 'zoho.packages.normalization.completed',
      snapshotId: snapshot.id,
      externalId: snapshot.externalId,
      normalizerVersion: CURRENT_PACKAGE_NORMALIZER_VERSION,
      packageId: pkg.id,
      itemCount: items.length,
    });

    return { packageId: pkg.id, status: 'normalized' };
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
        entityType: PACKAGES_ENTITY_TYPE,
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
