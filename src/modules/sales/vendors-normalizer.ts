import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ENTITY_TYPE, SOURCE } from '@/modules/integrations/zoho/vendors-sync';

export const CURRENT_VENDOR_NORMALIZER_VERSION = 1;

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
    super('A vendor normalization batch is already running in this instance');
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

const NORMALIZER_STATE_KEY = '__unikZohoVendorsNormalizerState' as const;

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

const vendorPayloadSchema = z
  .object({
    contact_id: z.string().min(1),
    contact_name: z.string().nullish(),
    company_name: z.string().nullish(),
    contact_type: z.string().nullish(),
    status: z.string().nullish(),
    payment_terms: z.number().nullish(),
    payment_terms_label: z.string().nullish(),
    currency_code: z.string().nullish(),
    website: z.string().nullish(),
    billing_address: addressSchema,
    shipping_address: addressSchema,
    primary_contact_id: z.string().nullish(),
    primary_contact_email: z.string().nullish(),
    primary_contact_phone: z.string().nullish(),
    primary_contact_mobile: z.string().nullish(),
    last_modified_time: z.string().nullish(),
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

function extractPrimaryContact(
  payload: z.infer<typeof vendorPayloadSchema>
): { email: string | null; phone: string | null; mobile: string | null } {
  if (payload.primary_contact_email || payload.primary_contact_phone || payload.primary_contact_mobile) {
    return {
      email: payload.primary_contact_email ?? null,
      phone: payload.primary_contact_phone ?? null,
      mobile: payload.primary_contact_mobile ?? null,
    };
  }
  return { email: null, phone: null, mobile: null };
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
    event: 'zoho.vendors.normalization.failed',
    snapshotId,
    externalId,
    normalizerVersion: CURRENT_VENDOR_NORMALIZER_VERSION,
    errorCode,
  });
}

type ExtractPayloadResult =
  | { data: z.infer<typeof vendorPayloadSchema>; error: null }
  | { data: null; error: string };

function extractVendorPayload(raw: unknown): ExtractPayloadResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.contact_id === 'string' && obj.contact_id.length > 0) {
    const parse = vendorPayloadSchema.safeParse(raw);
    if (!parse.success) return { data: null, error: 'Invalid direct vendor shape' };
    return { data: parse.data, error: null };
  }

  if ('code' in obj) {
    if (typeof obj.code !== 'number' || obj.code !== 0) {
      return { data: null, error: `Zoho API error code: ${obj.code}` };
    }
    if (typeof obj.contact !== 'object' || obj.contact === null || Array.isArray(obj.contact)) {
      return { data: null, error: 'Missing or invalid contact in Zoho wrapper' };
    }
    const parse = vendorPayloadSchema.safeParse(obj.contact);
    if (!parse.success) return { data: null, error: 'Invalid wrapped vendor shape' };
    return { data: parse.data, error: null };
  }

  return { data: null, error: 'Unrecognized snapshot payload shape' };
}

export async function normalizeVendorSnapshot(
  snapshot: SnapshotInput
): Promise<{ vendorId: string; status: 'normalized' | 'skipped' }> {
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
      'Snapshot source/entity type does not match Zoho vendors'
    );
  }

  const extraction = extractVendorPayload(snapshot.payload);
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
  const primary = extractPrimaryContact(payload);

  const vendorData: Prisma.VendorCreateInput = {
    zohoContactId: payload.contact_id,
    companyName: payload.company_name ?? payload.contact_name ?? null,
    contactType: payload.contact_type ?? null,
    status: payload.status ?? null,
    paymentTerms: payload.payment_terms ?? null,
    paymentTermsLabel: payload.payment_terms_label ?? null,
    currencyCode: payload.currency_code ?? null,
    website: payload.website ?? null,
    phone: primary.phone,
    mobile: primary.mobile,
    email: primary.email,
    primaryContactId: payload.primary_contact_id ?? null,
    billingAddress: payload.billing_address as Prisma.InputJsonValue,
    shippingAddress: payload.shipping_address as Prisma.InputJsonValue,
    sourceRemoteModifiedAt:
      typeof payload.last_modified_time === 'string'
        ? parseZohoDate(payload.last_modified_time) ?? snapshot.remoteModifiedAt
        : snapshot.remoteModifiedAt,
    sourceSnapshotId: snapshot.id,
    normalizedAt: new Date(),
  };

  return prisma.$transaction(async (tx) => {
    const existing = await tx.vendor.findUnique({
      where: { zohoContactId: payload.contact_id },
      select: { id: true, sourceRemoteModifiedAt: true },
    });

    if (existing && existing.sourceRemoteModifiedAt.getTime() > snapshot.remoteModifiedAt.getTime()) {
      await markSnapshotProcessed(tx, snapshot.id, CURRENT_VENDOR_NORMALIZER_VERSION, null);
      return { vendorId: existing.id, status: 'skipped' };
    }

    const vendor = await tx.vendor.upsert({
      where: { zohoContactId: payload.contact_id },
      create: vendorData,
      update: vendorData,
    });

    await markSnapshotProcessed(tx, snapshot.id, CURRENT_VENDOR_NORMALIZER_VERSION, null);

    log({
      event: 'zoho.vendors.normalization.completed',
      snapshotId: snapshot.id,
      externalId: snapshot.externalId,
      normalizerVersion: CURRENT_VENDOR_NORMALIZER_VERSION,
      vendorId: vendor.id,
    });

    return { vendorId: vendor.id, status: 'normalized' };
  });
}

export interface NormalizePendingSnapshotsResult {
  seen: number;
  normalized: number;
  skipped: number;
  failed: number;
  alreadyRunning: boolean;
}

export async function normalizePendingVendorSnapshots(options: {
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
        normalizationVersion: { lt: CURRENT_VENDOR_NORMALIZER_VERSION },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(options.limit, 500)),
    });

    let normalized = 0;
    let skipped = 0;
    let failed = 0;

    for (const snapshot of pending) {
      try {
        const result = await normalizeVendorSnapshot(snapshot as SnapshotInput);
        if (result.status === 'normalized') normalized += 1;
        else skipped += 1;
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
      event: 'zoho.vendors.normalization.batch_completed',
      seen: pending.length,
      normalized,
      skipped,
      failed,
      normalizerVersion: CURRENT_VENDOR_NORMALIZER_VERSION,
    });

    return { seen: pending.length, normalized, skipped, failed, alreadyRunning: false };
  } finally {
    state.batchInProgress = false;
  }
}
