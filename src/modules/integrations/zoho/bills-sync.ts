import { z } from 'zod';
import { listBills, getBill } from './bills';
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

export const BILLS_ENTITY_TYPE = 'bill';
export const SOURCE = 'zoho';

// ---------------------------------------------------------------------------
// Zod schemas for extracting summaries from Zoho list/detail payloads
// ---------------------------------------------------------------------------

const billSummarySchema = z.object({
  bill_id: z.union([z.string().min(1), z.number()]).transform(String),
  last_modified_time: z.string().min(1).optional(),
  created_time: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
});

const billDetailSchema = z.object({
  bill: z.object({
    last_modified_time: z.string().min(1),
  }),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const billsAdapter: ZohoEntityAdapter = {
  entityType: BILLS_ENTITY_TYPE,

  supportsModifiedTimeSort: false,

  /** Bills LIST response already contains all fields needed for normalization. */
  useListAsSnapshot: true,

  async listPage({ page, perPage }) {
    return listBills({ page, perPage });
  },

  async getDetail(externalId: string) {
    return getBill(externalId);
  },

  extractSummary(rawRecord: unknown): EntitySummary {
    const parsed = billSummarySchema.parse(rawRecord);
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
    return { id: parsed.bill_id, modifiedAt };
  },

  extractDetailModifiedAt(rawDetail: unknown): Date | null {
    const parsed = billDetailSchema.safeParse(rawDetail);
    if (!parsed.success) return null;
    const d = new Date(parsed.data.bill.last_modified_time);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  async normalizePendingSnapshots({ limit }) {
    const { normalizePendingBillSnapshots } = await import(
      '@/modules/bills/bills-normalizer'
    );
    await normalizePendingBillSnapshots({ limit });
  },

  currentNormalizerVersion: 1,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function syncBills(options?: SyncOptions): Promise<SyncResult> {
  return runSync(billsAdapter, options);
}

export async function startSyncBills(options?: SyncOptions): Promise<StartSyncResult> {
  return startSync(billsAdapter, options);
}

export async function getLatestBillsSyncRun(): Promise<SyncRunStatus | null> {
  return getLatestSyncRun(BILLS_ENTITY_TYPE);
}

export async function getActiveBillsSyncRun(): Promise<SyncRunStatus | null> {
  return getActiveSyncRun(BILLS_ENTITY_TYPE);
}

export async function baselineBills(): Promise<BaselineResult> {
  return baselineEntity(billsAdapter);
}

export {
  type SyncRunStatus,
  type BaselineResult,
  SyncAlreadyRunningError,
  SyncFailedError,
  BaselineAlreadyCompletedError,
} from './zoho-sync-engine';
