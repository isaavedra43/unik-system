import { z } from 'zod';
import { listInvoices, getInvoice } from './invoices';
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

export const INVOICES_ENTITY_TYPE = 'invoice';
export const SOURCE = 'zoho';

// ---------------------------------------------------------------------------
// Zod schemas for extracting summaries from Zoho list/detail payloads
// ---------------------------------------------------------------------------

const invoiceSummarySchema = z.object({
  invoice_id: z.union([z.string().min(1), z.number()]).transform(String),
  last_modified_time: z.string().min(1).optional(),
  created_time: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
});

const invoiceDetailSchema = z.object({
  invoice: z.object({
    last_modified_time: z.string().min(1),
  }),
});

// ---------------------------------------------------------------------------
// Adapter
// IMPORTANT: Invoices do NOT support sort_column=last_modified_time.
// supportsModifiedTimeSort is false → engine uses full SCAN + selective HYDRATE.
// ---------------------------------------------------------------------------

export const invoicesAdapter: ZohoEntityAdapter = {
  entityType: INVOICES_ENTITY_TYPE,

  supportsModifiedTimeSort: false,

  /** Invoices LIST response already contains all fields needed for normalization.
   *  No need to call /invoices/{id} per record — saves thousands of API calls. */
  useListAsSnapshot: true,

  async listPage({ page, perPage }) {
    return listInvoices({ page, perPage });
  },

  async getDetail(externalId: string) {
    return getInvoice(externalId);
  },

  extractSummary(rawRecord: unknown): EntitySummary {
    const parsed = invoiceSummarySchema.parse(rawRecord);
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
    return { id: parsed.invoice_id, modifiedAt };
  },

  extractDetailModifiedAt(rawDetail: unknown): Date | null {
    const parsed = invoiceDetailSchema.safeParse(rawDetail);
    if (!parsed.success) return null;
    const d = new Date(parsed.data.invoice.last_modified_time);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  async normalizePendingSnapshots({ limit }) {
    const { normalizePendingInvoiceSnapshots } = await import(
      '@/modules/invoices/invoices-normalizer'
    );
    await normalizePendingInvoiceSnapshots({ limit });
  },

  currentNormalizerVersion: 2,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function syncInvoices(options?: SyncOptions): Promise<SyncResult> {
  return runSync(invoicesAdapter, options);
}

export async function startSyncInvoices(options?: SyncOptions): Promise<StartSyncResult> {
  return startSync(invoicesAdapter, options);
}

export async function getLatestInvoicesSyncRun(): Promise<SyncRunStatus | null> {
  return getLatestSyncRun(INVOICES_ENTITY_TYPE);
}

export async function getActiveInvoicesSyncRun(): Promise<SyncRunStatus | null> {
  return getActiveSyncRun(INVOICES_ENTITY_TYPE);
}

export async function baselineInvoices(): Promise<BaselineResult> {
  return baselineEntity(invoicesAdapter);
}

export {
  type SyncRunStatus,
  type BaselineResult,
  SyncAlreadyRunningError,
  SyncFailedError,
  BaselineAlreadyCompletedError,
} from './zoho-sync-engine';
