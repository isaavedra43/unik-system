import { z } from 'zod';
import { listCustomerPayments, getCustomerPayment } from './payments';
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

export const PAYMENTS_ENTITY_TYPE = 'customerpayment';
export const SOURCE = 'zoho';

// ---------------------------------------------------------------------------
// Zod schemas for extracting summaries from Zoho list/detail payloads
// ---------------------------------------------------------------------------

const paymentSummarySchema = z.object({
  payment_id: z.union([z.string().min(1), z.number()]).transform(String),
  last_modified_time: z.string().min(1).optional(),
  created_time: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
});

const paymentDetailSchema = z.object({
  payment: z.object({
    last_modified_time: z.string().min(1),
  }),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const paymentsAdapter: ZohoEntityAdapter = {
  entityType: PAYMENTS_ENTITY_TYPE,

  supportsModifiedTimeSort: false,

  /** Customer Payments LIST response already contains all fields needed for normalization. */
  useListAsSnapshot: true,

  async listPage({ page, perPage }) {
    return listCustomerPayments({ page, perPage });
  },

  async getDetail(externalId: string) {
    return getCustomerPayment(externalId);
  },

  extractSummary(rawRecord: unknown): EntitySummary {
    const parsed = paymentSummarySchema.parse(rawRecord);
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
    return { id: parsed.payment_id, modifiedAt };
  },

  extractDetailModifiedAt(rawDetail: unknown): Date | null {
    const parsed = paymentDetailSchema.safeParse(rawDetail);
    if (!parsed.success) return null;
    const d = new Date(parsed.data.payment.last_modified_time);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  async normalizePendingSnapshots({ limit }) {
    const { normalizePendingPaymentSnapshots } = await import(
      '@/modules/payments/payments-normalizer'
    );
    await normalizePendingPaymentSnapshots({ limit });
  },

  currentNormalizerVersion: 1,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function syncPayments(options?: SyncOptions): Promise<SyncResult> {
  return runSync(paymentsAdapter, options);
}

export async function startSyncPayments(options?: SyncOptions): Promise<StartSyncResult> {
  return startSync(paymentsAdapter, options);
}

export async function getLatestPaymentsSyncRun(): Promise<SyncRunStatus | null> {
  return getLatestSyncRun(PAYMENTS_ENTITY_TYPE);
}

export async function getActivePaymentsSyncRun(): Promise<SyncRunStatus | null> {
  return getActiveSyncRun(PAYMENTS_ENTITY_TYPE);
}

export async function baselinePayments(): Promise<BaselineResult> {
  return baselineEntity(paymentsAdapter);
}

export {
  type SyncRunStatus,
  type BaselineResult,
  SyncAlreadyRunningError,
  SyncFailedError,
  BaselineAlreadyCompletedError,
} from './zoho-sync-engine';
