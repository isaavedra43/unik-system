import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { SOURCE, CONTACTS_ENTITY_TYPE } from '@/modules/integrations/zoho/contacts-sync';

export const CURRENT_CONTACT_NORMALIZER_VERSION = 2;

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
    super('A contacts normalization batch is already running in this instance');
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

const NORMALIZER_STATE_KEY = '__unikZohoContactsNormalizerState' as const;

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

// ---------------------------------------------------------------------------
// Zod schema for Zoho Contact detail payload
// ---------------------------------------------------------------------------

const contactPayloadSchema = z
  .object({
    contact_id: z.union([z.string(), z.number()]).transform(String),
    contact_name: z.string().nullish(),
    company_name: z.string().nullish(),
    contact_type: z.string().nullish(),
    status: z.string().nullish(),
    payment_terms: z.number().nullish(),
    payment_terms_label: z.string().nullish(),
    currency_code: z.string().nullish(),
    outstanding_receivable_amount: z.number().nullish(),
    outstanding_payable_amount: z.number().nullish(),
    unused_credits_receivable_amount: z.number().nullish(),
    unused_credits_payable_amount: z.number().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    website: z.string().nullish(),
    language_code: z.string().nullish(),
    last_modified_time: z.string().nullish(),
    // Mexico fiscal fields
    tax_reg_no: z.string().nullish(),
    tax_treatment: z.string().nullish(),
    tax_regime: z.string().nullish(),
    legal_name: z.string().nullish(),
    is_tds_registered: z.boolean().nullish(),
    // India-specific fields remain RAW — not normalized
    gst_treatment: z.string().nullish(),
    place_of_supply: z.string().nullish(),
    shipping_legal_name: z.string().nullish(),
    // Address fields
    billing_address: z.string().nullish(),
    billing_city: z.string().nullish(),
    billing_state: z.string().nullish(),
    billing_zip: z.string().nullish(),
    billing_country: z.string().nullish(),
    billing_fax: z.string().nullish(),
    shipping_address: z.string().nullish(),
    shipping_city: z.string().nullish(),
    shipping_state: z.string().nullish(),
    shipping_zip: z.string().nullish(),
    shipping_country: z.string().nullish(),
    shipping_fax: z.string().nullish(),
    // Contact person fields
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    mobile: z.string().nullish(),
    designation: z.string().nullish(),
    department: z.string().nullish(),
    // Additional Zoho fields
    customer_sub_type: z.string().nullish(),
    portal_status: z.string().nullish(),
    owner_name: z.string().nullish(),
    source: z.string().nullish(),
    photo_url: z.string().nullish(),
    primary_contact_id: z.string().nullish(),
    credit_limit_exceeded_amount: z.union([z.string(), z.number()]).nullish(),
    notes: z.string().nullish(),
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

function buildContactData(
  snapshotId: string,
  remoteModifiedAt: Date,
  payload: z.infer<typeof contactPayloadSchema>
): Prisma.ContactCreateInput {
  return {
    zohoContactId: payload.contact_id,
    contactType: payload.contact_type ?? null,
    contactName: payload.contact_name ?? null,
    companyName: payload.company_name ?? null,
    currencyCode: payload.currency_code ?? null,
    paymentTerms: payload.payment_terms ?? null,
    paymentTermsLabel: payload.payment_terms_label ?? null,
    status: payload.status ?? null,
    outstandingReceivable: toDecimal(payload.outstanding_receivable_amount),
    outstandingPayable: toDecimal(payload.outstanding_payable_amount),
    unusedCreditsReceivable: toDecimal(payload.unused_credits_receivable_amount),
    unusedCreditsPayable: toDecimal(payload.unused_credits_payable_amount),
    primaryEmail: payload.email ?? null,
    primaryPhone: payload.phone ?? null,
    website: payload.website ?? null,
    languageCode: payload.language_code ?? null,
    // Mexico fiscal fields
    taxRegNo: payload.tax_reg_no ?? null,
    taxTreatment: payload.tax_treatment ?? null,
    taxRegime: payload.tax_regime ?? null,
    legalName: payload.legal_name ?? null,
    isTdsRegistered: payload.is_tds_registered ?? null,
    // Address fields
    billingAddress: payload.billing_address ?? null,
    billingCity: payload.billing_city ?? null,
    billingState: payload.billing_state ?? null,
    billingZip: payload.billing_zip ?? null,
    billingCountry: payload.billing_country ?? null,
    billingFax: payload.billing_fax ?? null,
    shippingAddress: payload.shipping_address ?? null,
    shippingCity: payload.shipping_city ?? null,
    shippingState: payload.shipping_state ?? null,
    shippingZip: payload.shipping_zip ?? null,
    shippingCountry: payload.shipping_country ?? null,
    shippingFax: payload.shipping_fax ?? null,
    // Contact person fields
    firstName: payload.first_name ?? null,
    lastName: payload.last_name ?? null,
    mobile: payload.mobile ?? null,
    designation: payload.designation ?? null,
    department: payload.department ?? null,
    // Additional Zoho fields
    customerSubType: payload.customer_sub_type ?? null,
    portalStatus: payload.portal_status ?? null,
    ownerName: payload.owner_name ?? null,
    source: payload.source ?? null,
    photoUrl: payload.photo_url ?? null,
    primaryContactId: payload.primary_contact_id ?? null,
    creditLimitExceededAmount: toDecimal(payload.credit_limit_exceeded_amount),
    notes: payload.notes ?? null,
    // Sync tracking
    sourceRemoteModifiedAt: remoteModifiedAt,
    sourceSnapshotId: snapshotId,
    normalizedAt: new Date(),
  };
}

type ExtractPayloadResult =
  | { data: z.infer<typeof contactPayloadSchema>; error: null }
  | { data: null; error: string };

function extractContactPayload(raw: unknown): ExtractPayloadResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }

  const obj = raw as Record<string, unknown>;

  // Direct contact shape
  if (typeof obj.contact_id === 'string' || typeof obj.contact_id === 'number') {
    const parse = contactPayloadSchema.safeParse(raw);
    if (!parse.success) return { data: null, error: 'Invalid direct contact shape' };
    return { data: parse.data, error: null };
  }

  // Zoho API wrapper shape: { code, message, contact: {...} }
  if ('code' in obj) {
    if (typeof obj.code !== 'number' || obj.code !== 0) {
      return { data: null, error: `Zoho API error code: ${obj.code}` };
    }
    if (typeof obj.contact !== 'object' || obj.contact === null || Array.isArray(obj.contact)) {
      return { data: null, error: 'Missing or invalid contact in Zoho wrapper' };
    }
    const parse = contactPayloadSchema.safeParse(obj.contact);
    if (!parse.success) return { data: null, error: 'Invalid wrapped contact shape' };
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
    event: 'zoho.contacts.normalization.failed',
    snapshotId,
    externalId,
    normalizerVersion: CURRENT_CONTACT_NORMALIZER_VERSION,
    errorCode,
  });
}

export async function normalizeContactSnapshot(
  snapshot: SnapshotInput
): Promise<{ contactId: string; status: 'normalized' | 'skipped' }> {
  if (snapshot.source !== SOURCE || snapshot.entityType !== CONTACTS_ENTITY_TYPE) {
    await markSnapshotFailed(
      snapshot.id,
      snapshot.normalizationVersion,
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID
    );
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
      snapshot.id,
      'Snapshot source/entity type does not match Zoho contacts'
    );
  }

  const extraction = extractContactPayload(snapshot.payload);
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
  const contactData = buildContactData(snapshot.id, snapshot.remoteModifiedAt, payload);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.contact.findUnique({
      where: { zohoContactId: payload.contact_id },
      select: { id: true, sourceRemoteModifiedAt: true },
    });

    if (
      existing &&
      existing.sourceRemoteModifiedAt.getTime() > snapshot.remoteModifiedAt.getTime()
    ) {
      await markSnapshotProcessed(tx, snapshot.id, CURRENT_CONTACT_NORMALIZER_VERSION, null);
      return { contactId: existing.id, status: 'skipped' };
    }

    const contact = await tx.contact.upsert({
      where: { zohoContactId: payload.contact_id },
      create: contactData,
      update: contactData,
    });

    await markSnapshotProcessed(tx, snapshot.id, CURRENT_CONTACT_NORMALIZER_VERSION, null);

    log({
      event: 'zoho.contacts.normalization.completed',
      snapshotId: snapshot.id,
      externalId: snapshot.externalId,
      normalizerVersion: CURRENT_CONTACT_NORMALIZER_VERSION,
      contactId: contact.id,
    });

    return { contactId: contact.id, status: 'normalized' };
  });
}

export interface NormalizePendingSnapshotsResult {
  seen: number;
  normalized: number;
  skipped: number;
  failed: number;
  alreadyRunning: boolean;
}

export async function normalizePendingContactSnapshots(options: {
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
        entityType: CONTACTS_ENTITY_TYPE,
        normalizationVersion: { lt: CURRENT_CONTACT_NORMALIZER_VERSION },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(options.limit, 500)),
    });

    let normalized = 0;
    let skipped = 0;
    let failed = 0;

    for (const snapshot of pending) {
      try {
        const result = await normalizeContactSnapshot(snapshot as SnapshotInput);
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
      event: 'zoho.contacts.normalization.batch_completed',
      seen: pending.length,
      normalized,
      skipped,
      failed,
      normalizerVersion: CURRENT_CONTACT_NORMALIZER_VERSION,
    });

    return { seen: pending.length, normalized, skipped, failed, alreadyRunning: false };
  } finally {
    state.batchInProgress = false;
  }
}
