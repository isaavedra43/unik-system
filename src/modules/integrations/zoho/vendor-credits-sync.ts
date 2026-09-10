import { z } from 'zod';
import { listVendorCredits, getVendorCredit } from './vendor-credits';
import {
  type ZohoEntityAdapter,
  type EntitySummary,
  type SyncOptions,
  type SyncResult,
  type StartSyncResult,
  type SyncRunStatus,
  type BaselineResult,
  runSync,
  startSync,
  getLatestSyncRun,
  getActiveSyncRun,
  baselineEntity,
} from './zoho-sync-engine';

export const VENDOR_CREDITS_ENTITY_TYPE = 'vendorcredit';
export const SOURCE = 'zoho';

// ---------------------------------------------------------------------------
// Zod schemas for extracting summaries from Zoho list/detail payloads
// ---------------------------------------------------------------------------

const vendorCreditSummarySchema = z.object({
  vendor_credit_id: z.union([z.string().min(1), z.number()]).transform(String),
  last_modified_time: z.string().min(1).optional(),
  created_time: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
});

const vendorCreditDetailSchema = z.object({
  vendor_credit: z.object({
    last_modified_time: z.string().min(1),
  }),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const vendorCreditsAdapter: ZohoEntityAdapter = {
  entityType: VENDOR_CREDITS_ENTITY_TYPE,

  supportsModifiedTimeSort: false,

  /** Vendor Credits LIST response already contains all fields needed for normalization. */
  useListAsSnapshot: true,

  async listPage({ page, perPage }) {
    return listVendorCredits({ page, perPage });
  },

  async getDetail(externalId: string) {
    return getVendorCredit(externalId);
  },

  extractSummary(rawRecord: unknown): EntitySummary {
    const parsed = vendorCreditSummarySchema.parse(rawRecord);
    const ts = parsed.last_modified_time ?? parsed.created_time ?? parsed.date ?? null;
    let modifiedAt: Date;
    if (ts) {
      modifiedAt = new Date(ts);
      if (Number.isNaN(modifiedAt.getTime())) {
        modifiedAt = new Date(0);
      }
    } else {
      modifiedAt = new Date(0);
    }
    return { id: parsed.vendor_credit_id, modifiedAt };
  },

  extractDetailModifiedAt(rawDetail: unknown): Date | null {
    const parsed = vendorCreditDetailSchema.safeParse(rawDetail);
    if (!parsed.success) return null;
    const d = new Date(parsed.data.vendor_credit.last_modified_time);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  async normalizePendingSnapshots({ limit }) {
    const { normalizePendingVendorCreditSnapshots } = await import(
      '@/modules/vendor-credits/vendor-credits-normalizer'
    );
    await normalizePendingVendorCreditSnapshots({ limit });
  },

  currentNormalizerVersion: 1,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function syncVendorCredits(options?: SyncOptions): Promise<SyncResult> {
  return runSync(vendorCreditsAdapter, options);
}

export async function startSyncVendorCredits(options?: SyncOptions): Promise<StartSyncResult> {
  return startSync(vendorCreditsAdapter, options);
}

export async function getLatestVendorCreditsSyncRun(): Promise<SyncRunStatus | null> {
  return getLatestSyncRun(VENDOR_CREDITS_ENTITY_TYPE);
}

export async function getActiveVendorCreditsSyncRun(): Promise<SyncRunStatus | null> {
  return getActiveSyncRun(VENDOR_CREDITS_ENTITY_TYPE);
}

export async function baselineVendorCredits(): Promise<BaselineResult> {
  return baselineEntity(vendorCreditsAdapter);
}

export {
  type SyncRunStatus,
  type BaselineResult,
  SyncAlreadyRunningError,
  SyncFailedError,
  BaselineAlreadyCompletedError,
} from './zoho-sync-engine';
