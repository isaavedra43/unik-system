import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { SOURCE, PACKAGES_ENTITY_TYPE } from '@/modules/integrations/zoho/packages-sync';
import { recordPackageChange, PACKAGE_CHANGE_SELECT } from './packages-change-events';
import {
  CURRENT_PACKAGE_NORMALIZER_VERSION,
  extractZohoPackage,
  mapZohoPackage,
  type MappedPackage,
} from './packages-payload';

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

function toDecimal(value: string | null): Prisma.Decimal | null {
  if (value === null) return null;
  try {
    return new Prisma.Decimal(value);
  } catch {
    return null;
  }
}

function buildPackageData(
  snapshotId: string,
  remoteModifiedAt: Date,
  mapped: MappedPackage
): {
  package: Prisma.PackageCreateInput;
  items: Omit<Prisma.PackageItemCreateManyInput, 'packageId'>[];
} {
  const { items, ...fields } = mapped;
  const packageData: Prisma.PackageCreateInput = {
    ...fields,
    shippingCharge: toDecimal(fields.shippingCharge),
    quantity: toDecimal(fields.quantity),
    sourceRemoteModifiedAt: remoteModifiedAt,
    sourceSnapshotId: snapshotId,
    normalizedAt: new Date(),
  };
  return {
    package: packageData,
    items: items.map((item) => ({ ...item, quantity: toDecimal(item.quantity) })),
  };
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

  const extraction = extractZohoPackage(snapshot.payload);
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
  const { package: packageData, items } = buildPackageData(
    snapshot.id,
    snapshot.remoteModifiedAt,
    mapZohoPackage(payload)
  );

  return prisma.$transaction(async (tx) => {
    const existing = await tx.package.findUnique({
      where: { zohoPackageId: payload.package_id },
      select: { ...PACKAGE_CHANGE_SELECT, sourceRemoteModifiedAt: true },
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

    if (existing) {
      await recordPackageChange(tx, {
        before: existing,
        after: pkg,
        sourceSnapshotId: snapshot.id,
        sourceRemoteModifiedAt: snapshot.remoteModifiedAt,
      });
    }

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
