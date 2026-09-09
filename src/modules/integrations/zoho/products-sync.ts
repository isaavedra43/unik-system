import { z } from 'zod';
import { listItems, getItem, listItemDetails } from './items';
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

export const PRODUCTS_ENTITY_TYPE = 'item';
export const SOURCE = 'zoho';

/**
 * Default batch size for /itemdetails bulk fetch.
 * Configurable via IntegrationConfig settings.itemDetailsBatchSize.
 */
export const DEFAULT_ITEM_DETAILS_BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Zod schemas for extracting summaries from Zoho list/detail payloads
// ---------------------------------------------------------------------------

const itemSummarySchema = z.object({
  item_id: z.union([z.string().min(1), z.number()]).transform(String),
  last_modified_time: z.string().min(1).optional(),
  created_time: z.string().min(1).optional(),
});

const itemsListSchema = z.object({
  items: z.array(itemSummarySchema),
  page_context: z
    .object({ has_more_page: z.boolean().optional() })
    .optional(),
});

const itemDetailSchema = z.object({
  item: z.object({
    last_modified_time: z.string().min(1),
  }),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const productsAdapter: ZohoEntityAdapter = {
  entityType: PRODUCTS_ENTITY_TYPE,

  supportsModifiedTimeSort: true,

  /** Items LIST response already contains all fields needed for normalization.
   *  No need to call /items/{id} per record — saves thousands of API calls. */
  useListAsSnapshot: true,

  async listPage({ page, perPage, sorted }) {
    const opts: Parameters<typeof listItems>[0] = { page, perPage };
    if (sorted) {
      opts.sortColumn = 'last_modified_time';
      opts.sortOrder = 'D';
    }
    return listItems(opts);
  },

  async getDetail(externalId: string) {
    return getItem(externalId);
  },

  /**
   * Bulk-fetch item details using /itemdetails endpoint.
   * Returns a map of externalId → raw detail payload.
   */
  async getDetailsBulk(externalIds: string[]): Promise<Map<string, unknown>> {
    const result = new Map<string, unknown>();
    if (externalIds.length === 0) return result;

    const raw = await listItemDetails(externalIds);
    const parsed = itemsListSchema.safeParse(raw);
    if (!parsed.success) {
      // Fallback: if /itemdetails returns a different shape, try itemdetails array
      const envelope = raw as Record<string, unknown>;
      if (Array.isArray(envelope.itemdetails)) {
        for (const item of envelope.itemdetails as Record<string, unknown>[]) {
          const id = String(item.item_id);
          if (id) result.set(id, item);
        }
      }
      return result;
    }

    for (const item of parsed.data.items) {
      result.set(item.item_id, { item });
    }
    return result;
  },

  bulkBatchSize: DEFAULT_ITEM_DETAILS_BATCH_SIZE,

  extractSummary(rawRecord: unknown): EntitySummary {
    const parsed = itemSummarySchema.parse(rawRecord);
    const ts = parsed.last_modified_time ?? parsed.created_time ?? null;
    let modifiedAt: Date;
    if (ts) {
      modifiedAt = new Date(ts);
      if (Number.isNaN(modifiedAt.getTime())) {
        modifiedAt = new Date(0);
      }
    } else {
      modifiedAt = new Date(0);
    }
    return { id: parsed.item_id, modifiedAt };
  },

  extractDetailModifiedAt(rawDetail: unknown): Date | null {
    const parsed = itemDetailSchema.safeParse(rawDetail);
    if (!parsed.success) return null;
    const d = new Date(parsed.data.item.last_modified_time);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  async normalizePendingSnapshots({ limit }) {
    const { normalizePendingProductSnapshots } = await import(
      '@/modules/products/products-normalizer'
    );
    await normalizePendingProductSnapshots({ limit });
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function syncProducts(options?: SyncOptions): Promise<SyncResult> {
  return runSync(productsAdapter, options);
}

export async function startSyncProducts(options?: SyncOptions): Promise<StartSyncResult> {
  return startSync(productsAdapter, options);
}

export async function getLatestProductsSyncRun(): Promise<SyncRunStatus | null> {
  return getLatestSyncRun(PRODUCTS_ENTITY_TYPE);
}

export async function getActiveProductsSyncRun(): Promise<SyncRunStatus | null> {
  return getActiveSyncRun(PRODUCTS_ENTITY_TYPE);
}

export async function baselineProducts(): Promise<BaselineResult> {
  return baselineEntity(productsAdapter);
}

export {
  type SyncRunStatus,
  type BaselineResult,
  SyncAlreadyRunningError,
  SyncFailedError,
  BaselineAlreadyCompletedError,
} from './zoho-sync-engine';
