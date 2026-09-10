import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { SOURCE, VENDOR_CREDITS_ENTITY_TYPE } from '@/modules/integrations/zoho/vendor-credits-sync';

const CURRENT_VENDOR_CREDIT_NORMALIZER_VERSION = 1;

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
    super('A vendor credits normalization batch is already running in this instance');
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

const NORMALIZER_STATE_KEY = '__unikZohoVendorCreditsNormalizerState' as const;

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

const vendorCreditPayloadSchema = z
  .object({
    vendor_credit_id: z.union([z.string(), z.number()]).transform(String),
    vendor_credit_number: z.string().nullish(),
    status: z.string().nullish(),
    date: z.string().nullish(),
    vendor_id: z.string().nullish(),
    vendor_name: z.string().nullish(),
    currency_code: z.string().nullish(),
    total: z.union([z.string(), z.number()]).nullish(),
    balance: z.union([z.string(), z.number()]).nullish(),
    notes: z.string().nullish(),
    last_modified_time: z.string().nullish(),
    created_time: z.string().nullish(),
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

function buildVendorCreditData(
  snapshotId: string,
  remoteModifiedAt: Date,
  payload: z.infer<typeof vendorCreditPayloadSchema>
): Prisma.VendorCreditCreateInput {
  return {
    zohoVendorCreditId: payload.vendor_credit_id,
    vendorCreditNumber: payload.vendor_credit_number ?? null,
    status: payload.status ?? null,
    date: payload.date ? safeDate(payload.date) : null,
    zohoVendorId: payload.vendor_id ?? null,
    vendorName: payload.vendor_name ?? null,
    currencyCode: payload.currency_code ?? null,
    total: toDecimal(payload.total),
    balance: toDecimal(payload.balance),
    notes: payload.notes ?? null,
    sourceRemoteModifiedAt: remoteModifiedAt,
    sourceSnapshotId: snapshotId,
    normalizedAt: new Date(),
  };
}

type ExtractPayloadResult =
  | { data: z.infer<typeof vendorCreditPayloadSchema>; error: null }
  | { data: null; error: string };

function extractVendorCreditPayload(raw: unknown): ExtractPayloadResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.vendor_credit_id === 'string' || typeof obj.vendor_credit_id === 'number') {
    const parse = vendorCreditPayloadSchema.safeParse(raw);
    if (!parse.success) return { data: null, error: 'Invalid direct vendor credit shape' };
    return { data: parse.data, error: null };
  }
  if ('code' in obj) {
    if (typeof obj.code !== 'number' || obj.code !== 0) {
      return { data: null, error: `Zoho API error code: ${obj.code}` };
    }
    if (typeof obj.vendor_credit !== 'object' || obj.vendor_credit === null || Array.isArray(obj.vendor_credit)) {
      return { data: null, error: 'Missing or invalid vendor_credit in Zoho wrapper' };
    }
    const parse = vendorCreditPayloadSchema.safeParse(obj.vendor_credit);
    if (!parse.success) return { data: null, error: 'Invalid wrapped vendor credit shape' };
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
  log({ event: 'zoho.vendorcredits.normalization.failed', snapshotId, externalId, normalizerVersion: CURRENT_VENDOR_CREDIT_NORMALIZER_VERSION, errorCode });
}

export async function normalizeVendorCreditSnapshot(
  snapshot: SnapshotInput
): Promise<{ vendorCreditId: string; status: 'normalized' | 'skipped' }> {
  if (snapshot.source !== SOURCE || snapshot.entityType !== VENDOR_CREDITS_ENTITY_TYPE) {
    await markSnapshotFailed(snapshot.id, snapshot.normalizationVersion, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID, snapshot.id, 'Snapshot source/entity type does not match Zoho vendor credits');
  }

  const extraction = extractVendorCreditPayload(snapshot.payload);
  if (extraction.data === null) {
    await markSnapshotFailed(snapshot.id, snapshot.normalizationVersion, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID, snapshot.id, extraction.error ?? 'Invalid snapshot payload shape');
  }

  const payload = extraction.data;
  const vendorCreditData = buildVendorCreditData(snapshot.id, snapshot.remoteModifiedAt, payload);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.vendorCredit.findUnique({
      where: { zohoVendorCreditId: payload.vendor_credit_id },
      select: { id: true, sourceRemoteModifiedAt: true },
    });

    if (existing && existing.sourceRemoteModifiedAt.getTime() > snapshot.remoteModifiedAt.getTime()) {
      await markSnapshotProcessed(tx, snapshot.id, CURRENT_VENDOR_CREDIT_NORMALIZER_VERSION, null);
      return { vendorCreditId: existing.id, status: 'skipped' };
    }

    const vendorCredit = await tx.vendorCredit.upsert({
      where: { zohoVendorCreditId: payload.vendor_credit_id },
      create: vendorCreditData,
      update: vendorCreditData,
    });

    await markSnapshotProcessed(tx, snapshot.id, CURRENT_VENDOR_CREDIT_NORMALIZER_VERSION, null);

    log({
      event: 'zoho.vendorcredits.normalization.completed',
      snapshotId: snapshot.id, externalId: snapshot.externalId,
      normalizerVersion: CURRENT_VENDOR_CREDIT_NORMALIZER_VERSION,
      vendorCreditId: vendorCredit.id,
    });

    return { vendorCreditId: vendorCredit.id, status: 'normalized' };
  });
}

export interface NormalizePendingSnapshotsResult {
  seen: number; normalized: number; skipped: number; failed: number; alreadyRunning: boolean;
}

export async function normalizePendingVendorCreditSnapshots(options: { limit: number }): Promise<NormalizePendingSnapshotsResult> {
  const state = getNormalizerState();
  if (state.batchInProgress) throw new NormalizationAlreadyRunningError();
  state.batchInProgress = true;

  try {
    const pending = await prisma.integrationSnapshot.findMany({
      where: { source: SOURCE, entityType: VENDOR_CREDITS_ENTITY_TYPE, normalizationVersion: { lt: CURRENT_VENDOR_CREDIT_NORMALIZER_VERSION } },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(options.limit, 500)),
    });

    let normalized = 0, skipped = 0, failed = 0;

    for (const snapshot of pending) {
      try {
        const result = await normalizeVendorCreditSnapshot(snapshot as SnapshotInput);
        if (result.status === 'normalized') normalized += 1; else skipped += 1;
      } catch (error) {
        failed += 1;
        const errorCode = error instanceof NormalizationError ? error.errorCode : NORMALIZATION_ERROR_CODE.UNEXPECTED_ERROR;
        const snapshotId = error instanceof NormalizationError ? error.snapshotId : snapshot.id;
        try { await markSnapshotFailed(snapshotId, 'normalizationVersion' in snapshot ? snapshot.normalizationVersion : 0, errorCode); } catch { /* continue */ }
        logFailure(snapshotId, snapshot.externalId, errorCode);
      }
    }

    log({ event: 'zoho.vendorcredits.normalization.batch_completed', seen: pending.length, normalized, skipped, failed, normalizerVersion: CURRENT_VENDOR_CREDIT_NORMALIZER_VERSION });
    return { seen: pending.length, normalized, skipped, failed, alreadyRunning: false };
  } finally {
    state.batchInProgress = false;
  }
}
