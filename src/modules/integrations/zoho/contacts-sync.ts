import { z } from 'zod';
import { listContacts, getContact } from './contacts';
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

export const CONTACTS_ENTITY_TYPE = 'contact';
export const SOURCE = 'zoho';

// ---------------------------------------------------------------------------
// Zod schemas for extracting summaries from Zoho list/detail payloads
// ---------------------------------------------------------------------------

const contactSummarySchema = z.object({
  contact_id: z.union([z.string().min(1), z.number()]).transform(String),
  last_modified_time: z.string().min(1).optional(),
  created_time: z.string().min(1).optional(),
});

const contactDetailSchema = z.object({
  contact: z.object({
    last_modified_time: z.string().min(1),
  }),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const contactsAdapter: ZohoEntityAdapter = {
  entityType: CONTACTS_ENTITY_TYPE,

  supportsModifiedTimeSort: true,

  /** Contacts LIST response already contains all fields needed for normalization.
   *  No need to call /contacts/{id} per record — saves thousands of API calls. */
  useListAsSnapshot: true,

  async listPage({ page, perPage, sorted }) {
    const opts: Parameters<typeof listContacts>[0] = { page, perPage };
    if (sorted) {
      opts.sortColumn = 'last_modified_time';
      opts.sortOrder = 'D';
    }
    return listContacts(opts);
  },

  async getDetail(externalId: string) {
    return getContact(externalId);
  },

  extractSummary(rawRecord: unknown): EntitySummary {
    const parsed = contactSummarySchema.parse(rawRecord);
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
    return { id: parsed.contact_id, modifiedAt };
  },

  extractDetailModifiedAt(rawDetail: unknown): Date | null {
    const parsed = contactDetailSchema.safeParse(rawDetail);
    if (!parsed.success) return null;
    const d = new Date(parsed.data.contact.last_modified_time);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  async normalizePendingSnapshots({ limit }) {
    const { normalizePendingContactSnapshots } = await import(
      '@/modules/contacts/contacts-normalizer'
    );
    await normalizePendingContactSnapshots({ limit });
  },
};

// ---------------------------------------------------------------------------
// Public API — mirrors the sales-orders-sync surface
// ---------------------------------------------------------------------------

export async function syncContacts(options?: SyncOptions): Promise<SyncResult> {
  return runSync(contactsAdapter, options);
}

export async function startSyncContacts(options?: SyncOptions): Promise<StartSyncResult> {
  return startSync(contactsAdapter, options);
}

export async function getLatestContactsSyncRun(): Promise<SyncRunStatus | null> {
  return getLatestSyncRun(CONTACTS_ENTITY_TYPE);
}

export async function getActiveContactsSyncRun(): Promise<SyncRunStatus | null> {
  return getActiveSyncRun(CONTACTS_ENTITY_TYPE);
}

export async function baselineContacts(): Promise<BaselineResult> {
  return baselineEntity(contactsAdapter);
}

export {
  SyncAlreadyRunningError,
  SyncFailedError,
  BaselineAlreadyCompletedError,
  type SyncRunStatus,
  type BaselineResult,
} from './zoho-sync-engine';
