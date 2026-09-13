import { z } from 'zod';
import { listEstimates, getEstimate } from './estimates';
import { isZohoBooksMockEnabled } from './config';
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

export const ESTIMATES_ENTITY_TYPE = 'estimate';
export const SOURCE = 'zoho';

/** Normalizer version — bump when quotes-normalizer mapping changes. */
export const ESTIMATES_NORMALIZER_VERSION = 1;

// ---------------------------------------------------------------------------
// Zod schemas for extracting summaries from Zoho list/detail payloads
// ---------------------------------------------------------------------------

const estimateSummarySchema = z.object({
  estimate_id: z.union([z.string().min(1), z.number()]).transform(String),
  last_modified_time: z.string().min(1).optional(),
  created_time: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
});

const estimateDetailSchema = z.object({
  estimate: z.object({
    last_modified_time: z.string().min(1),
  }),
});

function toDate(ts: string | null | undefined): Date {
  if (!ts) return new Date(0);
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

// ---------------------------------------------------------------------------
// Adapter
// - Zoho Books estimates LIST does NOT support sort_column=last_modified_time
//   → supportsModifiedTimeSort = false (full SCAN + selective HYDRATE).
// - LIST records do NOT include line_items → useListAsSnapshot = false, the
//   engine fetches /estimates/{id} for every changed record.
// ---------------------------------------------------------------------------

export const estimatesAdapter: ZohoEntityAdapter = {
  entityType: ESTIMATES_ENTITY_TYPE,

  supportsModifiedTimeSort: false,
  useListAsSnapshot: false,

  async listPage({ page, perPage }) {
    if (isZohoBooksMockEnabled()) {
      // Mock mode: nothing to pull from Zoho; local records are created by the write service.
      return { code: 0, estimates: [], page_context: { page, per_page: perPage, has_more_page: false } };
    }
    return listEstimates({ page, perPage, sortColumn: 'created_time', sortOrder: 'D' });
  },

  async getDetail(externalId: string) {
    return getEstimate(externalId);
  },

  extractSummary(rawRecord: unknown): EntitySummary {
    const parsed = estimateSummarySchema.parse(rawRecord);
    const ts = parsed.last_modified_time ?? parsed.created_time ?? parsed.date ?? null;
    return { id: parsed.estimate_id, modifiedAt: toDate(ts) };
  },

  extractDetailModifiedAt(rawDetail: unknown): Date | null {
    const parsed = estimateDetailSchema.safeParse(rawDetail);
    if (!parsed.success) return null;
    const d = new Date(parsed.data.estimate.last_modified_time);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  async normalizePendingSnapshots({ limit }) {
    const { normalizePendingQuoteSnapshots } = await import('@/modules/quotes/quotes-normalizer');
    await normalizePendingQuoteSnapshots({ limit });
  },

  currentNormalizerVersion: ESTIMATES_NORMALIZER_VERSION,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function syncEstimates(options?: SyncOptions): Promise<SyncResult> {
  return runSync(estimatesAdapter, options);
}

export async function startSyncEstimates(options?: SyncOptions): Promise<StartSyncResult> {
  return startSync(estimatesAdapter, options);
}

export async function getLatestEstimatesSyncRun(): Promise<SyncRunStatus | null> {
  return getLatestSyncRun(ESTIMATES_ENTITY_TYPE);
}

export async function getActiveEstimatesSyncRun(): Promise<SyncRunStatus | null> {
  return getActiveSyncRun(ESTIMATES_ENTITY_TYPE);
}

export async function baselineEstimates(): Promise<BaselineResult> {
  return baselineEntity(estimatesAdapter);
}

export {
  type SyncRunStatus,
  type BaselineResult,
  SyncAlreadyRunningError,
  SyncFailedError,
  BaselineAlreadyCompletedError,
} from './zoho-sync-engine';
