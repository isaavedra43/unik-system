import { z } from 'zod';
import { listPurchaseOrders, getPurchaseOrder } from './purchase-orders';
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

export const PURCHASE_ORDERS_ENTITY_TYPE = 'purchaseorder';
export const SOURCE = 'zoho';

// ---------------------------------------------------------------------------
// Zod schemas for extracting summaries from Zoho list/detail payloads
// ---------------------------------------------------------------------------

const purchaseOrderSummarySchema = z.object({
  purchaseorder_id: z.union([z.string().min(1), z.number()]).transform(String),
  last_modified_time: z.string().min(1).optional(),
  created_time: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
});

const purchaseOrderDetailSchema = z.object({
  purchaseorder: z.object({
    last_modified_time: z.string().min(1),
  }),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const purchaseOrdersAdapter: ZohoEntityAdapter = {
  entityType: PURCHASE_ORDERS_ENTITY_TYPE,

  supportsModifiedTimeSort: false,

  /** Purchase Orders LIST response already contains all fields needed for normalization. */
  useListAsSnapshot: true,

  async listPage({ page, perPage }) {
    return listPurchaseOrders({ page, perPage });
  },

  async getDetail(externalId: string) {
    return getPurchaseOrder(externalId);
  },

  extractSummary(rawRecord: unknown): EntitySummary {
    const parsed = purchaseOrderSummarySchema.parse(rawRecord);
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
    return { id: parsed.purchaseorder_id, modifiedAt };
  },

  extractDetailModifiedAt(rawDetail: unknown): Date | null {
    const parsed = purchaseOrderDetailSchema.safeParse(rawDetail);
    if (!parsed.success) return null;
    const d = new Date(parsed.data.purchaseorder.last_modified_time);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  async normalizePendingSnapshots({ limit }) {
    const { normalizePendingPurchaseOrderSnapshots } = await import(
      '@/modules/purchase-orders/purchase-orders-normalizer'
    );
    await normalizePendingPurchaseOrderSnapshots({ limit });
  },

  currentNormalizerVersion: 1,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function syncPurchaseOrders(options?: SyncOptions): Promise<SyncResult> {
  return runSync(purchaseOrdersAdapter, options);
}

export async function startSyncPurchaseOrders(options?: SyncOptions): Promise<StartSyncResult> {
  return startSync(purchaseOrdersAdapter, options);
}

export async function getLatestPurchaseOrdersSyncRun(): Promise<SyncRunStatus | null> {
  return getLatestSyncRun(PURCHASE_ORDERS_ENTITY_TYPE);
}

export async function getActivePurchaseOrdersSyncRun(): Promise<SyncRunStatus | null> {
  return getActiveSyncRun(PURCHASE_ORDERS_ENTITY_TYPE);
}

export async function baselinePurchaseOrders(): Promise<BaselineResult> {
  return baselineEntity(purchaseOrdersAdapter);
}

export {
  type SyncRunStatus,
  type BaselineResult,
  SyncAlreadyRunningError,
  SyncFailedError,
  BaselineAlreadyCompletedError,
} from './zoho-sync-engine';
