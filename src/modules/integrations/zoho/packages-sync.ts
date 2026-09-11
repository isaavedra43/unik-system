import { z } from 'zod';
import { listPackages, getPackage } from './packages';
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

export const PACKAGES_ENTITY_TYPE = 'package';
export const SOURCE = 'zoho';

// ---------------------------------------------------------------------------
// Zod schemas for extracting summaries from Zoho list/detail payloads
// ---------------------------------------------------------------------------

const packageSummarySchema = z.object({
  package_id: z.union([z.string().min(1), z.number()]).transform(String),
  last_modified_time: z.string().min(1).optional(),
  created_time: z.string().min(1).optional(),
});

const packageDetailSchema = z.object({
  package: z.object({
    last_modified_time: z.string().min(1),
  }),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const packagesAdapter: ZohoEntityAdapter = {
  entityType: PACKAGES_ENTITY_TYPE,

  supportsModifiedTimeSort: true,

  /** Packages LIST response does NOT include package_items or shipping_address.
   *  We MUST call /packages/{id} per record to get the full detail with items
   *  and shipping address. This is required for the package detail page. */
  useListAsSnapshot: false,

  async listPage({ page, perPage, sorted }) {
    const opts: Parameters<typeof listPackages>[0] = { page, perPage };
    if (sorted) {
      opts.sortColumn = 'last_modified_time';
      opts.sortOrder = 'D';
    }
    return listPackages(opts);
  },

  async getDetail(externalId: string) {
    return getPackage(externalId);
  },

  extractSummary(rawRecord: unknown): EntitySummary {
    const parsed = packageSummarySchema.parse(rawRecord);
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
    return { id: parsed.package_id, modifiedAt };
  },

  extractDetailModifiedAt(rawDetail: unknown): Date | null {
    const parsed = packageDetailSchema.safeParse(rawDetail);
    if (!parsed.success) return null;
    const d = new Date(parsed.data.package.last_modified_time);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  async normalizePendingSnapshots({ limit }) {
    const { normalizePendingPackageSnapshots } = await import(
      '@/modules/packages/packages-normalizer'
    );
    await normalizePendingPackageSnapshots({ limit });
  },

  currentNormalizerVersion: 3,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function syncPackages(options?: SyncOptions): Promise<SyncResult> {
  return runSync(packagesAdapter, options);
}

export async function startSyncPackages(options?: SyncOptions): Promise<StartSyncResult> {
  return startSync(packagesAdapter, options);
}

export async function getLatestPackagesSyncRun(): Promise<SyncRunStatus | null> {
  return getLatestSyncRun(PACKAGES_ENTITY_TYPE);
}

export async function getActivePackagesSyncRun(): Promise<SyncRunStatus | null> {
  return getActiveSyncRun(PACKAGES_ENTITY_TYPE);
}

export async function baselinePackages(): Promise<BaselineResult> {
  return baselineEntity(packagesAdapter);
}

export {
  type SyncRunStatus,
  type BaselineResult,
  SyncAlreadyRunningError,
  SyncFailedError,
  BaselineAlreadyCompletedError,
} from './zoho-sync-engine';
