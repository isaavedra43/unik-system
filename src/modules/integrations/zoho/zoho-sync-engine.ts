import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ZohoApiError } from './client';
import {
  INTEGRATION_SOURCE_ZOHO,
  getIntegrationSettings,
  DEFAULT_SETTINGS,
  type ZohoSettings,
} from '../integration-config-service';

// ---------------------------------------------------------------------------
// Constants & error types
// ---------------------------------------------------------------------------

export const SOURCE = 'zoho';

export const SYNC_STATUS = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export const SYNC_ERROR_CODE = {
  ZOHO_API_ERROR: 'ZOHO_API_ERROR',
  INVALID_LIST_RESPONSE: 'INVALID_LIST_RESPONSE',
  PAGE_LIMIT_EXCEEDED: 'PAGE_LIMIT_EXCEEDED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  DAILY_LIMIT_EXCEEDED: 'DAILY_LIMIT_EXCEEDED',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
} as const;

export class SyncAlreadyRunningError extends Error {
  constructor(entityType: string) {
    super(`A ${entityType} sync is already running in this instance`);
    this.name = 'SyncAlreadyRunningError';
  }
}

export class SyncFailedError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly runId: string
  ) {
    super(`Sync failed with code ${errorCode}`);
    this.name = 'SyncFailedError';
  }
}

// ---------------------------------------------------------------------------
// Sync modes
// ---------------------------------------------------------------------------

export const SYNC_MODES = ['scan', 'hydrate', 'sync', 'quick'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const syncOptionsSchema = z.object({
  mode: z.enum(SYNC_MODES).default('sync'),
  maxDetailFetches: z.number().int().min(1).max(500).default(50),
});

export type SyncOptions = z.input<typeof syncOptionsSchema>;

export interface SyncResult {
  runId: string;
  mode: SyncMode;
  entityType: string;
  pagesScanned: number;
  recordsSeen: number;
  recordsPending: number;
  detailsFetched: number;
  detailsFailed: number;
  apiCalls: number;
}

// ---------------------------------------------------------------------------
// Entity adapter interface
// ---------------------------------------------------------------------------

export interface EntitySummary {
  id: string;
  modifiedAt: Date;
}

export interface ListPageResult {
  records: EntitySummary[];
  hasMore: boolean;
}

/**
 * Each entity (contact, item, package, invoice) provides an adapter that
 * encapsulates only the entity-specific concerns. The engine handles
 * pagination, snapshot persistence, sync-run lifecycle, rate limiting,
 * timeouts and error resolution.
 */
export interface ZohoEntityAdapter {
  /** Unique entity type key, e.g. 'contact', 'item', 'package', 'invoice'. */
  entityType: string;

  /**
   * Fetches one page of LIST results from Zoho.
   * The adapter MUST force `sort_column=last_modified_time&sort_order=D`
   * when `sorted` is true and the endpoint supports it.
   */
  listPage(opts: {
    page: number;
    perPage: number;
    sorted: boolean;
  }): Promise<unknown>;

  /**
   * Fetches the DETAIL of a single entity by external ID.
   * Used when bulk fetch is not available or for the last partial batch.
   */
  getDetail(externalId: string): Promise<unknown>;

  /**
   * Whether the Zoho LIST endpoint for this entity supports
   * `sort_column=last_modified_time`. If false, QUICK mode is disabled
   * and the engine falls back to full SCAN + selective HYDRATE.
   */
  supportsModifiedTimeSort: boolean;

  /**
   * If true, the engine saves each LIST record directly as a snapshot
   * during SCAN and skips HYDRATE entirely. This is far more efficient
   * for entities where the LIST response already contains all the
   * fields needed for normalization (contacts, items, packages, invoices).
   * Default: false (backwards-compatible with Sales Orders).
   */
  useListAsSnapshot?: boolean;

  /**
   * Extracts the external ID and last_modified_time from a LIST record.
   * The returned `modifiedAt` is the CANONICAL remoteModifiedAt — it is
   * propagated to the snapshot and never re-extracted from DETAIL.
   */
  extractSummary(rawRecord: unknown): EntitySummary;

  /**
   * Extracts last_modified_time from a DETAIL payload, if present.
   * Used only for logging/diagnostics — the canonical timestamp comes
   * from LIST (see A8 in the plan addendum).
   */
  extractDetailModifiedAt(rawDetail: unknown): Date | null;

  /**
   * Optional: bulk-fetch details for multiple IDs in a single API call.
   * If provided, the engine uses this instead of N individual getDetail calls.
   * Returns a map of externalId → raw detail payload.
   */
  getDetailsBulk?(externalIds: string[]): Promise<Map<string, unknown>>;

  /**
   * Batch size for bulk detail fetch. Default 50. Not a Zoho-imposed limit —
   * the API accepts a comma-separated list of IDs.
   */
  bulkBatchSize?: number;

  /**
   * Optional: normalize pending snapshots into business models.
   * Called after HYDRATE/SYNC/QUICK completes, before marking the run COMPLETED.
   * The engine loops this in batches until ALL pending snapshots are processed.
   */
  normalizePendingSnapshots?(opts: { limit: number }): Promise<void>;

  /**
   * The current normalizer version for this entity. Used by the engine to
   * count pending snapshots. Defaults to 1 if omitted.
   */
  currentNormalizerVersion?: number;

  /**
   * Wall-clock timeout overrides per mode. If omitted, engine defaults are used.
   */
  timeouts?: {
    quick?: number;
    scan?: number;
    sync?: number;
    hydrate?: number;
  };
}

// ---------------------------------------------------------------------------
// Shared rate budget (per organization, NOT per entity)
// ---------------------------------------------------------------------------

interface RateBudgetState {
  /** Timestamps of calls in the current 60-second window. */
  callTimestamps: number[];
  /** Total calls today (resets at midnight UTC). */
  dailyCallCount: number;
  /** Start of the current day (UTC midnight). */
  dayStart: number;
  /** Whether we hit a 429 recently and should back off. */
  backingOffUntil: number;
}

const RATE_BUDGET_KEY = '__unikZohoSharedRateBudget' as const;

type GlobalWithRateBudget = typeof globalThis & {
  [RATE_BUDGET_KEY]?: RateBudgetState;
};

function getRateBudget(): RateBudgetState {
  const scope = globalThis as GlobalWithRateBudget;
  scope[RATE_BUDGET_KEY] ??= {
    callTimestamps: [],
    dailyCallCount: 0,
    dayStart: getUtcMidnight(Date.now()),
    backingOffUntil: 0,
  };
  return scope[RATE_BUDGET_KEY];
}

function getUtcMidnight(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Default conservative per-minute limit. Configurable via ZohoSettings. */
const DEFAULT_MAX_CALLS_PER_MINUTE = 40;

/** Default conservative daily limit. Configurable via ZohoSettings. */
const DEFAULT_MAX_DAILY_CALLS = 2000;

interface RateBudgetConfig {
  maxCallsPerMinute: number;
  maxDailyCalls: number;
}

function resolveRateBudgetConfig(settings: ZohoSettings): RateBudgetConfig {
  return {
    maxCallsPerMinute:
      (settings as unknown as Record<string, unknown>).maxCallsPerMinute as number | undefined ??
      DEFAULT_MAX_CALLS_PER_MINUTE,
    maxDailyCalls:
      (settings as unknown as Record<string, unknown>).maxDailyCalls as number | undefined ??
      DEFAULT_MAX_DAILY_CALLS,
  };
}

/**
 * Records an API call in the shared rate budget and checks whether we can
 * proceed. If the per-minute or daily limit is exceeded, this throws a
 * RateLimitError so the engine can abort or back off.
 */
function recordApiCall(config: RateBudgetConfig): void {
  const budget = getRateBudget();
  const now = Date.now();

  // Reset daily counter at UTC midnight.
  const currentDayStart = getUtcMidnight(now);
  if (currentDayStart !== budget.dayStart) {
    budget.dayStart = currentDayStart;
    budget.dailyCallCount = 0;
  }

  // Prune call timestamps older than 60 seconds.
  budget.callTimestamps = budget.callTimestamps.filter((ts) => now - ts < 60_000);

  if (budget.callTimestamps.length >= config.maxCallsPerMinute) {
    throw new RateLimitError('per_minute');
  }

  if (budget.dailyCallCount >= config.maxDailyCalls) {
    throw new RateLimitError('daily');
  }

  budget.callTimestamps.push(now);
  budget.dailyCallCount += 1;
}

/**
 * Waits until the rate budget allows a new call. Called before each API
 * invocation to proactively throttle.
 */
async function waitForRateBudget(config: RateBudgetConfig): Promise<void> {
  const budget = getRateBudget();
  const now = Date.now();

  // If we're in a back-off period, wait.
  if (budget.backingOffUntil > now) {
    const waitMs = budget.backingOffUntil - now;
    await sleep(waitMs);
  }

  // Prune and check per-minute window.
  budget.callTimestamps = budget.callTimestamps.filter((ts) => now - ts < 60_000);
  if (budget.callTimestamps.length >= config.maxCallsPerMinute) {
    const oldestTs = budget.callTimestamps[0];
    const waitMs = 60_000 - (Date.now() - oldestTs) + 100;
    await sleep(waitMs);
  }
}

class RateLimitError extends Error {
  constructor(public readonly limitType: 'per_minute' | 'daily') {
    super(`Rate limit exceeded: ${limitType}`);
    this.name = 'RateLimitError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Per-entity lock (globalThis)
// ---------------------------------------------------------------------------

interface SyncLockState {
  inProgress: boolean;
}

function getSyncLockKey(entityType: string): string {
  return `__unikZohoSyncLock_${entityType}` as const;
}

type GlobalWithSyncLock = typeof globalThis & {
  [key: string]: SyncLockState | undefined;
};

function getSyncLock(entityType: string): SyncLockState {
  const scope = globalThis as GlobalWithSyncLock;
  const key = getSyncLockKey(entityType);
  scope[key] ??= { inProgress: false };
  return scope[key]!;
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

let currentPrismaTimeoutMs = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number = currentPrismaTimeoutMs): Promise<T> {
  const timeout = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms)
  );
  promise.catch(() => {});
  return Promise.race([promise, timeout]);
}

// ---------------------------------------------------------------------------
// Zod schemas (reusable)
// ---------------------------------------------------------------------------

// Adapters handle their own summary extraction, so the engine does not need
// a shared timestamp schema here. Individual adapters may use z.parse() with
// their own schemas inside extractSummary().

// ---------------------------------------------------------------------------
// Internal errors
// ---------------------------------------------------------------------------

class SyncPageLimitError extends Error {
  readonly errorCode = SYNC_ERROR_CODE.PAGE_LIMIT_EXCEEDED;
}

class SyncInvalidListError extends Error {
  readonly errorCode = SYNC_ERROR_CODE.INVALID_LIST_RESPONSE;
}

// ---------------------------------------------------------------------------
// Engine parameters
// ---------------------------------------------------------------------------

interface EngineParams {
  perPage: number;
  maxPages: number;
  quickScanPages: number;
  recentThresholdMs: number;
  bulkBatchSize: number;
}

function resolveParams(settings: ZohoSettings, adapter: ZohoEntityAdapter): EngineParams {
  return {
    perPage: settings.perPage,
    maxPages: settings.maxPages,
    quickScanPages: settings.quickScanPages,
    recentThresholdMs: settings.recentThresholdMs,
    bulkBatchSize: adapter.bulkBatchSize ?? 50,
  };
}

function resolveTimeoutMs(
  settings: ZohoSettings,
  adapter: ZohoEntityAdapter,
  mode: SyncMode
): number {
  if (adapter.timeouts?.[mode]) return adapter.timeouts[mode]!;
  switch (mode) {
    case 'quick':
      return settings.quickSyncTimeoutMs;
    case 'scan':
      return settings.scanSyncTimeoutMs;
    case 'hydrate':
      return settings.quickSyncTimeoutMs;
    case 'sync':
      return settings.fullSyncTimeoutMs;
  }
}

// ---------------------------------------------------------------------------
// SCAN: walk LIST pages, update IntegrationEntityState
// ---------------------------------------------------------------------------

interface ScanOutcome {
  pagesScanned: number;
  recordsSeen: number;
  apiCalls: number;
}

async function scanAllPages(
  adapter: ZohoEntityAdapter,
  params: EngineParams,
  budgetConfig: RateBudgetConfig
): Promise<ScanOutcome> {
  let pagesScanned = 0;
  let recordsSeen = 0;
  let apiCalls = 0;
  let page = 1;

  for (;;) {
    if (page > params.maxPages) {
      throw new SyncPageLimitError();
    }

    await waitForRateBudget(budgetConfig);
    const rawPage = await adapter.listPage({ page, perPage: params.perPage, sorted: false });
    recordApiCall(budgetConfig);
    apiCalls += 1;

    const { summaries, rawRecords } = extractSummariesWithRaw(adapter, rawPage);
    pagesScanned += 1;

    for (let i = 0; i < summaries.length; i++) {
      const summary = summaries[i];
      if (adapter.useListAsSnapshot && rawRecords[i]) {
        await recordSummaryWithSnapshot(adapter, summary.id, summary.modifiedAt, rawRecords[i]);
      } else {
        await recordSummary(adapter, summary.id, summary.modifiedAt);
      }
      recordsSeen += 1;
    }

    if (!hasMorePages(rawPage)) {
      break;
    }

    page += 1;
  }

  return { pagesScanned, recordsSeen, apiCalls };
}

async function scanRecentPages(
  adapter: ZohoEntityAdapter,
  params: EngineParams,
  budgetConfig: RateBudgetConfig
): Promise<ScanOutcome> {
  let pagesScanned = 0;
  let recordsSeen = 0;
  let apiCalls = 0;
  const now = Date.now();
  let foundRecent = false;

  const tryPage = async (page: number, sorted: boolean): Promise<boolean | null> => {
    try {
      await waitForRateBudget(budgetConfig);
      const rawPage = await adapter.listPage({ page, perPage: params.perPage, sorted });
      recordApiCall(budgetConfig);
      apiCalls += 1;
      pagesScanned += 1;

      const { summaries, rawRecords } = extractSummariesWithRaw(adapter, rawPage);
      let newest: Date | null = null;
      for (let i = 0; i < summaries.length; i++) {
        const summary = summaries[i];
        if (adapter.useListAsSnapshot && rawRecords[i]) {
          await recordSummaryWithSnapshot(adapter, summary.id, summary.modifiedAt, rawRecords[i]);
        } else {
          await recordSummary(adapter, summary.id, summary.modifiedAt);
        }
        recordsSeen += 1;
        if (!newest || summary.modifiedAt.getTime() > newest.getTime()) {
          newest = summary.modifiedAt;
        }
      }

      const hasMore = hasMorePages(rawPage);
      const isRecentRecord =
        newest !== null && now - newest.getTime() < params.recentThresholdMs;

      return isRecentRecord ? true : hasMore ? false : null;
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
      const isAbort = error instanceof DOMException && error.name === 'AbortError';
      if (error instanceof ZohoApiError || isTimeout || isAbort) {
        console.warn(
          JSON.stringify({
            event: 'zoho.sync.quick_scan.page_failed',
            entityType: adapter.entityType,
            page,
            sorted,
            reason: isTimeout ? 'timeout' : isAbort ? 'aborted' : 'zoho_api_error',
          })
        );
        return null;
      }
      throw error;
    }
  };

  // Pass 1: sorted by last_modified_time desc (only if supported)
  if (adapter.supportsModifiedTimeSort) {
    for (let page = 1; page <= params.quickScanPages; page++) {
      const r = await tryPage(page, true);
      if (r === null) break;
      if (r === true) {
        foundRecent = true;
        break;
      }
    }
  }

  if (foundRecent) return { pagesScanned, recordsSeen, apiCalls };

  // Pass 2: unsorted — Zoho default order
  for (let page = 1; page <= params.quickScanPages; page++) {
    const r = await tryPage(page, false);
    if (r === null) break;
    if (r === true) {
      foundRecent = true;
      break;
    }
  }

  if (foundRecent) return { pagesScanned, recordsSeen, apiCalls };

  // Pass 3: last pages — ascending order fallback
  const totalEntities = await withTimeout(
    prisma.integrationEntityState.count({
      where: { source: SOURCE, entityType: adapter.entityType },
    })
  );
  const lastPage = Math.max(1, Math.ceil(totalEntities / params.perPage));
  const startPage = Math.max(1, lastPage - params.quickScanPages + 1);

  for (let page = lastPage; page >= startPage; page--) {
    const r = await tryPage(page, false);
    if (r === null) break;
    if (r === true) break;
  }

  return { pagesScanned, recordsSeen, apiCalls };
}

function extractSummaries(adapter: ZohoEntityAdapter, rawPage: unknown): EntitySummary[] {
  return extractSummariesWithRaw(adapter, rawPage).summaries;
}

function extractSummariesWithRaw(
  adapter: ZohoEntityAdapter,
  rawPage: unknown
): { summaries: EntitySummary[]; rawRecords: unknown[] } {
  const pageObj = rawPage as Record<string, unknown>;
  const arrayKey = findRecordArrayKey(pageObj);
  if (!arrayKey) {
    throw new SyncInvalidListError();
  }
  const records = pageObj[arrayKey];
  if (!Array.isArray(records)) {
    throw new SyncInvalidListError();
  }
  const summaries: EntitySummary[] = [];
  const rawRecords: unknown[] = [];
  for (const record of records) {
    try {
      summaries.push(adapter.extractSummary(record));
      rawRecords.push(record);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'zoho.sync.extract_summary_skipped',
          entityType: adapter.entityType,
          error: error instanceof Error ? error.message : 'unknown',
        })
      );
    }
  }
  return { summaries, rawRecords };
}

/**
 * Finds the key in a Zoho list response that holds the array of records.
 * Zoho responses look like `{ contacts: [...], page_context: {...} }`.
 */
function findRecordArrayKey(page: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(page)) {
    if (Array.isArray(value) && key !== 'page_context' && key !== 'code' && key !== 'message') {
      return key;
    }
  }
  return null;
}

function hasMorePages(rawPage: unknown): boolean {
  const pageObj = rawPage as Record<string, unknown>;
  const ctx = pageObj?.page_context;
  if (ctx && typeof ctx === 'object') {
    return (ctx as Record<string, unknown>).has_more_page === true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Record summary → IntegrationEntityState
// ---------------------------------------------------------------------------

async function recordSummary(
  adapter: ZohoEntityAdapter,
  externalId: string,
  remoteModifiedAt: Date
): Promise<void> {
  const now = new Date();

  const existing = await withTimeout(
    prisma.integrationEntityState.findUnique({
      where: {
        source_entityType_externalId: {
          source: SOURCE,
          entityType: adapter.entityType,
          externalId,
        },
      },
    })
  );

  if (!existing) {
    await withTimeout(
      prisma.integrationEntityState.create({
        data: {
          source: SOURCE,
          entityType: adapter.entityType,
          externalId,
          remoteModifiedAt,
          needsSync: true,
          lastSeenAt: now,
        },
      })
    );
    return;
  }

  const hasChanged = existing.remoteModifiedAt.getTime() !== remoteModifiedAt.getTime();

  await withTimeout(
    prisma.integrationEntityState.update({
      where: { id: existing.id },
      data: hasChanged
        ? { remoteModifiedAt, needsSync: true, lastSeenAt: now }
        : { lastSeenAt: now },
    })
  );
}

/**
 * Records a summary AND saves the LIST record as a snapshot in one step.
 * Used when adapter.useListAsSnapshot is true — eliminates the need for
 * individual HYDRATE calls. The LIST response already contains all the
 * fields needed for normalization.
 */
async function recordSummaryWithSnapshot(
  adapter: ZohoEntityAdapter,
  externalId: string,
  remoteModifiedAt: Date,
  rawRecord: unknown
): Promise<void> {
  const now = new Date();
  const fetchedAt = now;

  const existing = await withTimeout(
    prisma.integrationEntityState.findUnique({
      where: {
        source_entityType_externalId: {
          source: SOURCE,
          entityType: adapter.entityType,
          externalId,
        },
      },
    })
  );

  const hasChanged = !existing || existing.remoteModifiedAt.getTime() !== remoteModifiedAt.getTime();

  await withTimeout(
    prisma.$transaction([
      prisma.integrationSnapshot.upsert({
        where: {
          source_entityType_externalId_remoteModifiedAt: {
            source: SOURCE,
            entityType: adapter.entityType,
            externalId,
            remoteModifiedAt,
          },
        },
        create: {
          source: SOURCE,
          entityType: adapter.entityType,
          externalId,
          remoteModifiedAt,
          payload: rawRecord as Prisma.InputJsonValue,
          fetchedAt,
        },
        update: {},
      }),
      !existing
        ? prisma.integrationEntityState.create({
            data: {
              source: SOURCE,
              entityType: adapter.entityType,
              externalId,
              remoteModifiedAt,
              needsSync: false,
              lastSyncedRemoteModifiedAt: remoteModifiedAt,
              lastSeenAt: now,
              lastDetailFetchedAt: fetchedAt,
            },
          })
        : prisma.integrationEntityState.update({
            where: { id: existing.id },
            data: hasChanged
              ? {
                  remoteModifiedAt,
                  needsSync: false,
                  lastSyncedRemoteModifiedAt: remoteModifiedAt,
                  lastSeenAt: now,
                  lastDetailFetchedAt: fetchedAt,
                }
              : { lastSeenAt: now },
          }),
    ])
  );
}

// ---------------------------------------------------------------------------
// HYDRATE: fetch details for pending entities
// ---------------------------------------------------------------------------

interface HydrateOutcome {
  detailsFetched: number;
  detailsFailed: number;
  apiCalls: number;
}

async function hydratePendingDetails(
  adapter: ZohoEntityAdapter,
  params: EngineParams,
  maxDetailFetches: number,
  budgetConfig: RateBudgetConfig,
  shouldAbort?: () => boolean
): Promise<HydrateOutcome> {
  const pending = await withTimeout(
    prisma.integrationEntityState.findMany({
      where: { source: SOURCE, entityType: adapter.entityType, needsSync: true },
      orderBy: [{ remoteModifiedAt: 'desc' }, { externalId: 'asc' }],
      take: maxDetailFetches,
    })
  );

  let detailsFetched = 0;
  let detailsFailed = 0;
  let apiCalls = 0;

  if (adapter.getDetailsBulk) {
    // Bulk fetch path — group IDs into batches.
    const batchSize = params.bulkBatchSize;
    for (let i = 0; i < pending.length; i += batchSize) {
      if (shouldAbort?.()) break;

      const batch = pending.slice(i, i + batchSize);
      const ids = batch.map((e) => e.externalId);

      try {
        await waitForRateBudget(budgetConfig);
        const detailsMap = await adapter.getDetailsBulk(ids);
        recordApiCall(budgetConfig);
        apiCalls += 1;

        for (const entity of batch) {
          const rawDetail = detailsMap.get(entity.externalId);
          if (!rawDetail) {
            detailsFailed += 1;
            continue;
          }
          await saveSnapshot(adapter, entity, rawDetail);
          detailsFetched += 1;
        }
      } catch (error) {
        apiCalls += 1;
        if (error instanceof RateLimitError) {
          handleRateLimitError(error);
          if (error.limitType === 'daily') throw error;
        }
        detailsFailed += batch.length;
        console.warn(
          JSON.stringify({
            event: 'zoho.sync.hydrate.bulk_batch_failed',
            entityType: adapter.entityType,
            batchSize: batch.length,
            error: error instanceof Error ? error.message : 'unknown',
          })
        );
      }
    }
  } else {
    // Individual fetch path.
    for (const entity of pending) {
      if (shouldAbort?.()) break;

      try {
        await waitForRateBudget(budgetConfig);
        const rawDetail = await adapter.getDetail(entity.externalId);
        recordApiCall(budgetConfig);
        apiCalls += 1;

        await saveSnapshot(adapter, entity, rawDetail);
        detailsFetched += 1;
      } catch (error) {
        apiCalls += 1;
        if (error instanceof RateLimitError) {
          handleRateLimitError(error);
          if (error.limitType === 'daily') throw error;
        }
        detailsFailed += 1;
      }
    }
  }

  return { detailsFetched, detailsFailed, apiCalls };
}

/**
 * Saves a snapshot and updates the entity state in a single transaction.
 * The `remoteModifiedAt` from LIST is canonical — it is NOT re-extracted
 * from the detail payload (A8 in the plan addendum).
 */
async function saveSnapshot(
  adapter: ZohoEntityAdapter,
  entity: { id: string; externalId: string; remoteModifiedAt: Date },
  rawDetail: unknown
): Promise<void> {
  const fetchedAt = new Date();

  await withTimeout(
    prisma.$transaction([
      prisma.integrationSnapshot.upsert({
        where: {
          source_entityType_externalId_remoteModifiedAt: {
            source: SOURCE,
            entityType: adapter.entityType,
            externalId: entity.externalId,
            remoteModifiedAt: entity.remoteModifiedAt,
          },
        },
        create: {
          source: SOURCE,
          entityType: adapter.entityType,
          externalId: entity.externalId,
          remoteModifiedAt: entity.remoteModifiedAt,
          payload: rawDetail as Prisma.InputJsonValue,
          fetchedAt,
        },
        update: {},
      }),
      prisma.integrationEntityState.update({
        where: { id: entity.id },
        data: {
          lastSyncedRemoteModifiedAt: entity.remoteModifiedAt,
          needsSync: false,
          lastDetailFetchedAt: fetchedAt,
        },
      }),
    ])
  );
}

// ---------------------------------------------------------------------------
// Rate limit error handling
// ---------------------------------------------------------------------------

function handleRateLimitError(error: RateLimitError): void {
  const budget = getRateBudget();
  if (error.limitType === 'per_minute') {
    // Back off for 60 seconds + jitter.
    const jitter = Math.floor(Math.random() * 5000);
    budget.backingOffUntil = Date.now() + 60_000 + jitter;
    console.warn(
      JSON.stringify({
        event: 'zoho.sync.rate_limit.per_minute',
        backingOffMs: 60_000 + jitter,
      })
    );
  } else if (error.limitType === 'daily') {
    // Daily limit — abort. No backoff, just stop.
    console.error(
      JSON.stringify({
        event: 'zoho.sync.rate_limit.daily_exceeded',
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Error resolution
// ---------------------------------------------------------------------------

function resolveErrorCode(error: unknown): string {
  if (error instanceof SyncPageLimitError || error instanceof SyncInvalidListError) {
    return error.errorCode;
  }
  if (error instanceof RateLimitError) {
    return error.limitType === 'daily'
      ? SYNC_ERROR_CODE.DAILY_LIMIT_EXCEEDED
      : SYNC_ERROR_CODE.RATE_LIMIT_EXCEEDED;
  }
  if (error instanceof ZohoApiError) {
    // Zoho error code 44 = rate/concurrency, 45 = daily quota, 1070 = concurrency
    if (error.zohoCode === 45) return SYNC_ERROR_CODE.DAILY_LIMIT_EXCEEDED;
    if (error.zohoCode === 44 || error.zohoCode === 1070)
      return SYNC_ERROR_CODE.RATE_LIMIT_EXCEEDED;
    return SYNC_ERROR_CODE.ZOHO_API_ERROR;
  }
  return SYNC_ERROR_CODE.UNEXPECTED_ERROR;
}

// ---------------------------------------------------------------------------
// Public API: runSync
// ---------------------------------------------------------------------------

/**
 * Runs one controlled synchronization for the given entity adapter.
 *
 * Modes:
 *   scan:    walks every LIST page and refreshes summarized state only.
 *   hydrate: takes pending entities from DB (no LIST scan) and downloads details.
 *   sync:    SCAN + HYDRATE.
 *   quick:   scans only recent pages (requires supportsModifiedTimeSort),
 *            then HYDRATE. If the adapter doesn't support modified-time sort,
 *            falls back to full SCAN + HYDRATE (i.e. behaves like 'sync').
 */
export async function runSync(
  adapter: ZohoEntityAdapter,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const { mode, maxDetailFetches } = syncOptionsSchema.parse(options);
  const lock = getSyncLock(adapter.entityType);

  if (lock.inProgress) {
    throw new SyncAlreadyRunningError(adapter.entityType);
  }

  // Load settings.
  let settings: ZohoSettings;
  try {
    settings = await getIntegrationSettings(INTEGRATION_SOURCE_ZOHO);
  } catch {
    settings = DEFAULT_SETTINGS[INTEGRATION_SOURCE_ZOHO];
  }
  currentPrismaTimeoutMs = settings.prismaTimeoutMs;

  const params = resolveParams(settings, adapter);
  const budgetConfig = resolveRateBudgetConfig(settings);

  // QUICK mode requires modified-time sort support.
  const effectiveMode: SyncMode =
    mode === 'quick' && !adapter.supportsModifiedTimeSort ? 'sync' : mode;

  lock.inProgress = true;
  const startedAt = new Date();
  let run: { id: string } | null = null;
  let timedOut = false;

  const timeoutMs = resolveTimeoutMs(settings, adapter, effectiveMode);
  const timeoutId = setTimeout(() => {
    timedOut = true;
    console.error(
      JSON.stringify({
        event: 'zoho.sync.timeout',
        entityType: adapter.entityType,
        runId: run?.id ?? 'unknown',
        mode: effectiveMode,
        durationMs: timeoutMs,
      })
    );
    lock.inProgress = false;
    if (run) {
      void (async () => {
        try {
          await withTimeout(
            prisma.integrationSyncRun.update({
              where: { id: run!.id },
              data: {
                status: SYNC_STATUS.FAILED,
                completedAt: new Date(),
                errorCode: SYNC_ERROR_CODE.UNEXPECTED_ERROR,
              },
            }),
            settings.prismaTimeoutMs
          );
        } catch {
          // Best-effort.
        }
      })();
    }
  }, timeoutMs);

  try {
    run = await withTimeout(
      prisma.integrationSyncRun.create({
        data: {
          source: SOURCE,
          entityType: adapter.entityType,
          mode: effectiveMode,
          status: SYNC_STATUS.RUNNING,
          startedAt,
        },
      })
    );

    // SCAN phase (skip for hydrate-only mode).
    let scan: ScanOutcome = { pagesScanned: 0, recordsSeen: 0, apiCalls: 0 };
    if (effectiveMode === 'scan' || effectiveMode === 'sync' || effectiveMode === 'quick') {
      scan =
        effectiveMode === 'quick'
          ? await scanRecentPages(adapter, params, budgetConfig)
          : await scanAllPages(adapter, params, budgetConfig);
    }

    // HYDRATE phase (skip for scan-only mode, or when LIST already saved snapshots).
    let details: HydrateOutcome = { detailsFetched: 0, detailsFailed: 0, apiCalls: 0 };
    if (
      !adapter.useListAsSnapshot &&
      (effectiveMode === 'hydrate' || effectiveMode === 'sync' || effectiveMode === 'quick')
    ) {
      details = await hydratePendingDetails(
        adapter,
        params,
        maxDetailFetches,
        budgetConfig,
        () => timedOut
      );
    }

    const recordsPending = await withTimeout(
      prisma.integrationEntityState.count({
        where: { source: SOURCE, entityType: adapter.entityType, needsSync: true },
      })
    );

    // Normalize snapshots → business models BEFORE marking COMPLETED.
    // Loop in batches until ALL pending snapshots are processed.
    if (adapter.normalizePendingSnapshots) {
      const BATCH_SIZE = 500;
      const MAX_NORMALIZATION_LOOPS = 200; // safety valve: 200 * 500 = 100k records
      let normalizationLoops = 0;
      let totalNormalized = 0;

      while (normalizationLoops < MAX_NORMALIZATION_LOOPS) {
        normalizationLoops += 1;

        const pendingCount = await withTimeout(
          prisma.integrationSnapshot.count({
            where: {
              source: SOURCE,
              entityType: adapter.entityType,
              normalizationVersion: { lt: adapter.currentNormalizerVersion ?? 1 },
            },
          })
        );

        if (pendingCount === 0) break;

        try {
          await withTimeout(
            Promise.resolve(adapter.normalizePendingSnapshots({ limit: BATCH_SIZE })),
            120_000
          );
          totalNormalized += BATCH_SIZE;
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'zoho.sync.normalization_batch_failed',
              entityType: adapter.entityType,
              runId: run.id,
              loop: normalizationLoops,
              pendingCount,
              error: error instanceof Error ? error.message : 'unknown',
            })
          );
          break;
        }
      }

      console.info(
        JSON.stringify({
          event: 'zoho.sync.normalization_complete',
          entityType: adapter.entityType,
          runId: run.id,
          loops: normalizationLoops,
          totalNormalized,
        })
      );
    }

    const result: SyncResult = {
      runId: run.id,
      mode: effectiveMode,
      entityType: adapter.entityType,
      pagesScanned: scan.pagesScanned,
      recordsSeen: scan.recordsSeen,
      recordsPending,
      detailsFetched: details.detailsFetched,
      detailsFailed: details.detailsFailed,
      apiCalls: scan.apiCalls + details.apiCalls,
    };

    const completedAt = new Date();

    // Guard: only mark COMPLETED if still RUNNING (timeout may have marked FAILED).
    const currentRun = await withTimeout(
      prisma.integrationSyncRun.findUnique({
        where: { id: run.id },
        select: { status: true },
      })
    );
    if (currentRun?.status === SYNC_STATUS.RUNNING) {
      await withTimeout(
        prisma.integrationSyncRun.update({
          where: { id: run.id },
          data: {
            status: SYNC_STATUS.COMPLETED,
            completedAt,
            pagesScanned: result.pagesScanned,
            recordsSeen: result.recordsSeen,
            recordsPending: result.recordsPending,
            detailsFetched: result.detailsFetched,
            detailsFailed: result.detailsFailed,
            apiCalls: result.apiCalls,
          },
        })
      );
    }

    console.info(
      JSON.stringify({
        event: 'zoho.sync.completed',
        entityType: adapter.entityType,
        runId: run.id,
        mode: effectiveMode,
        pagesScanned: result.pagesScanned,
        recordsSeen: result.recordsSeen,
        recordsPending: result.recordsPending,
        detailsFetched: result.detailsFetched,
        detailsFailed: result.detailsFailed,
        apiCalls: result.apiCalls,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      })
    );

    return result;
  } catch (error) {
    const errorCode = resolveErrorCode(error);
    const completedAt = new Date();

    if (run) {
      try {
        await withTimeout(
          prisma.integrationSyncRun.update({
            where: { id: run.id },
            data: { status: SYNC_STATUS.FAILED, completedAt, errorCode },
          })
        );
      } catch {
        // Best-effort.
      }
    }

    console.error(
      JSON.stringify({
        event: 'zoho.sync.failed',
        entityType: adapter.entityType,
        runId: run?.id ?? 'unknown',
        mode: effectiveMode,
        errorCode,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      })
    );

    throw new SyncFailedError(errorCode, run?.id ?? 'sync-run-creation-failed');
  } finally {
    clearTimeout(timeoutId);
    lock.inProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Public API: startSync (background)
// ---------------------------------------------------------------------------

export interface StartSyncResult {
  runId: string;
  alreadyRunning: boolean;
}

/**
 * Starts a sync in the background and returns immediately with the run ID.
 * The actual sync runs on the next event-loop tick.
 */
export async function startSync(
  adapter: ZohoEntityAdapter,
  options: SyncOptions = {}
): Promise<StartSyncResult> {
  const { mode, maxDetailFetches } = syncOptionsSchema.parse(options);
  const lock = getSyncLock(adapter.entityType);

  if (lock.inProgress) {
    const activeRun = await getActiveSyncRun(adapter.entityType);
    if (activeRun) {
      return { runId: activeRun.runId, alreadyRunning: true };
    }
    lock.inProgress = false;
  }

  const activeRun = await getActiveSyncRun(adapter.entityType);
  if (activeRun) {
    return { runId: activeRun.runId, alreadyRunning: true };
  }

  const effectiveMode: SyncMode =
    mode === 'quick' && !adapter.supportsModifiedTimeSort ? 'sync' : mode;

  lock.inProgress = true;
  const startedAt = new Date();
  const run = await withTimeout(
    prisma.integrationSyncRun.create({
      data: {
        source: SOURCE,
        entityType: adapter.entityType,
        mode: effectiveMode,
        status: SYNC_STATUS.RUNNING,
        startedAt,
      },
    })
  );

  setImmediate(() => {
    runSyncInBackground(adapter, run.id, effectiveMode, maxDetailFetches, startedAt).catch(
      () => {}
    );
  });

  return { runId: run.id, alreadyRunning: false };
}

async function runSyncInBackground(
  adapter: ZohoEntityAdapter,
  runId: string,
  mode: SyncMode,
  maxDetailFetches: number,
  startedAt: Date
): Promise<void> {
  const lock = getSyncLock(adapter.entityType);

  let settings: ZohoSettings;
  try {
    settings = await getIntegrationSettings(INTEGRATION_SOURCE_ZOHO);
  } catch {
    settings = DEFAULT_SETTINGS[INTEGRATION_SOURCE_ZOHO];
  }
  currentPrismaTimeoutMs = settings.prismaTimeoutMs;

  const params = resolveParams(settings, adapter);
  const budgetConfig = resolveRateBudgetConfig(settings);

  const timeoutMs = resolveTimeoutMs(settings, adapter, mode);
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    console.error(
      JSON.stringify({
        event: 'zoho.sync.timeout',
        entityType: adapter.entityType,
        runId,
        mode,
        durationMs: timeoutMs,
      })
    );
    lock.inProgress = false;
    void (async () => {
      try {
        await withTimeout(
          prisma.integrationSyncRun.update({
            where: { id: runId },
            data: {
              status: SYNC_STATUS.FAILED,
              completedAt: new Date(),
              errorCode: SYNC_ERROR_CODE.UNEXPECTED_ERROR,
            },
          }),
          settings.prismaTimeoutMs
        );
      } catch {
        // Best-effort.
      }
    })();
  }, timeoutMs);

  try {
    console.info(
      JSON.stringify({
        event: 'zoho.sync.background_started',
        entityType: adapter.entityType,
        runId,
        mode,
      })
    );

    let scan: ScanOutcome = { pagesScanned: 0, recordsSeen: 0, apiCalls: 0 };
    if (mode === 'scan' || mode === 'sync' || mode === 'quick') {
      scan =
        mode === 'quick'
          ? await scanRecentPages(adapter, params, budgetConfig)
          : await scanAllPages(adapter, params, budgetConfig);
    }

    let details: HydrateOutcome = { detailsFetched: 0, detailsFailed: 0, apiCalls: 0 };
    if (mode === 'hydrate' || mode === 'sync' || mode === 'quick') {
      details = await hydratePendingDetails(
        adapter,
        params,
        maxDetailFetches,
        budgetConfig,
        () => timedOut
      );
    }

    const recordsPending = await withTimeout(
      prisma.integrationEntityState.count({
        where: { source: SOURCE, entityType: adapter.entityType, needsSync: true },
      })
    );

    if (adapter.normalizePendingSnapshots) {
      try {
        await adapter.normalizePendingSnapshots({ limit: 100 });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'zoho.sync.background_normalization_failed',
            entityType: adapter.entityType,
            runId,
            error: error instanceof Error ? error.message : 'unknown',
          })
        );
      }
    }

    const completedAt = new Date();

    try {
      const current = await withTimeout(
        prisma.integrationSyncRun.findUnique({
          where: { id: runId },
          select: { status: true },
        })
      );
      if (current?.status === SYNC_STATUS.RUNNING) {
        await withTimeout(
          prisma.integrationSyncRun.update({
            where: { id: runId },
            data: {
              status: SYNC_STATUS.COMPLETED,
              completedAt,
              pagesScanned: scan.pagesScanned,
              recordsSeen: scan.recordsSeen,
              recordsPending,
              detailsFetched: details.detailsFetched,
              detailsFailed: details.detailsFailed,
              apiCalls: scan.apiCalls + details.apiCalls,
            },
          })
        );
      }
    } catch (updateError) {
      console.error(
        JSON.stringify({
          event: 'zoho.sync.completion_update_failed',
          entityType: adapter.entityType,
          runId,
          error: updateError instanceof Error ? updateError.message : 'unknown',
        })
      );
    }

    console.info(
      JSON.stringify({
        event: 'zoho.sync.completed',
        entityType: adapter.entityType,
        runId,
        mode,
        pagesScanned: scan.pagesScanned,
        recordsSeen: scan.recordsSeen,
        recordsPending,
        detailsFetched: details.detailsFetched,
        detailsFailed: details.detailsFailed,
        apiCalls: scan.apiCalls + details.apiCalls,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        background: true,
      })
    );
  } catch (error) {
    const errorCode = resolveErrorCode(error);
    const completedAt = new Date();

    try {
      await withTimeout(
        prisma.integrationSyncRun.update({
          where: { id: runId },
          data: { status: SYNC_STATUS.FAILED, completedAt, errorCode },
        })
      );
    } catch {
      // Best-effort.
    }

    console.error(
      JSON.stringify({
        event: 'zoho.sync.failed',
        entityType: adapter.entityType,
        runId,
        mode,
        errorCode,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        background: true,
      })
    );
  } finally {
    clearTimeout(timeoutId);
    lock.inProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Public API: sync run status queries
// ---------------------------------------------------------------------------

export interface SyncRunStatus {
  runId: string;
  entityType: string;
  mode: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  pagesScanned: number;
  recordsSeen: number;
  recordsPending: number;
  detailsFetched: number;
  detailsFailed: number;
  apiCalls: number;
  errorCode: string | null;
}

export async function getLatestSyncRun(entityType: string): Promise<SyncRunStatus | null> {
  const run = await withTimeout(
    prisma.integrationSyncRun.findFirst({
      where: { source: SOURCE, entityType },
      orderBy: { startedAt: 'desc' },
    })
  );

  if (!run) return null;

  return {
    runId: run.id,
    entityType: run.entityType,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    pagesScanned: run.pagesScanned,
    recordsSeen: run.recordsSeen,
    recordsPending: run.recordsPending,
    detailsFetched: run.detailsFetched,
    detailsFailed: run.detailsFailed,
    apiCalls: run.apiCalls,
    errorCode: run.errorCode,
  };
}

const DEFAULT_STALE_RUN_THRESHOLD_MS = 10 * 60 * 1000;

export async function getActiveSyncRun(
  entityType: string,
  now: Date = new Date()
): Promise<SyncRunStatus | null> {
  let staleThresholdMs = DEFAULT_STALE_RUN_THRESHOLD_MS;
  try {
    const settings = await getIntegrationSettings(INTEGRATION_SOURCE_ZOHO);
    staleThresholdMs = settings.staleRunThresholdMs;
  } catch {
    // Fall back to default.
  }

  const staleCutoff = new Date(now.getTime() - staleThresholdMs);

  await withTimeout(
    prisma.integrationSyncRun.updateMany({
      where: {
        source: SOURCE,
        entityType,
        status: SYNC_STATUS.RUNNING,
        startedAt: { lt: staleCutoff },
      },
      data: {
        status: SYNC_STATUS.FAILED,
        completedAt: now,
        errorCode: SYNC_ERROR_CODE.UNEXPECTED_ERROR,
      },
    })
  );

  const run = await withTimeout(
    prisma.integrationSyncRun.findFirst({
      where: { source: SOURCE, entityType, status: SYNC_STATUS.RUNNING },
      orderBy: { startedAt: 'desc' },
    })
  );

  if (!run) return null;

  return {
    runId: run.id,
    entityType: run.entityType,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    pagesScanned: run.pagesScanned,
    recordsSeen: run.recordsSeen,
    recordsPending: run.recordsPending,
    detailsFetched: run.detailsFetched,
    detailsFailed: run.detailsFailed,
    apiCalls: run.apiCalls,
    errorCode: run.errorCode,
  };
}

// ---------------------------------------------------------------------------
// Public API: baseline
// ---------------------------------------------------------------------------

export interface BaselineResult {
  runId: string;
  mode: 'baseline';
  entityType: string;
  baselined: number;
}

export class BaselineAlreadyCompletedError extends Error {
  constructor(entityType: string) {
    super(`A baseline has already been completed for ${entityType}`);
    this.name = 'BaselineAlreadyCompletedError';
  }
}

export async function baselineEntity(adapter: ZohoEntityAdapter): Promise<BaselineResult> {
  const lock = getSyncLock(adapter.entityType);

  if (lock.inProgress) {
    throw new SyncAlreadyRunningError(adapter.entityType);
  }

  lock.inProgress = true;
  const startedAt = new Date();
  let run: { id: string } | null = null;

  try {
    const existingCompleted = await prisma.integrationSyncRun.findFirst({
      where: {
        source: SOURCE,
        entityType: adapter.entityType,
        mode: 'baseline',
        status: SYNC_STATUS.COMPLETED,
      },
      select: { id: true },
    });

    if (existingCompleted) {
      throw new BaselineAlreadyCompletedError(adapter.entityType);
    }

    run = await prisma.integrationSyncRun.create({
      data: {
        source: SOURCE,
        entityType: adapter.entityType,
        mode: 'baseline',
        status: SYNC_STATUS.RUNNING,
        startedAt,
      },
    });

    const update = await prisma.integrationEntityState.updateMany({
      where: {
        source: SOURCE,
        entityType: adapter.entityType,
        needsSync: true,
        lastSyncedRemoteModifiedAt: null,
        lastDetailFetchedAt: null,
      },
      data: { needsSync: false },
    });

    const completedAt = new Date();

    await prisma.integrationSyncRun.update({
      where: { id: run.id },
      data: {
        status: SYNC_STATUS.COMPLETED,
        completedAt,
        recordsSeen: 0,
        recordsPending: 0,
        detailsFetched: 0,
        detailsFailed: 0,
        apiCalls: 0,
      },
    });

    console.info(
      JSON.stringify({
        event: 'zoho.sync.baseline.completed',
        entityType: adapter.entityType,
        runId: run.id,
        baselined: update.count,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      })
    );

    return {
      runId: run.id,
      mode: 'baseline',
      entityType: adapter.entityType,
      baselined: update.count,
    };
  } catch (error) {
    if (error instanceof BaselineAlreadyCompletedError) {
      throw error;
    }

    const errorCode = SYNC_ERROR_CODE.UNEXPECTED_ERROR;
    const completedAt = new Date();

    if (run) {
      await prisma.integrationSyncRun.update({
        where: { id: run.id },
        data: { status: SYNC_STATUS.FAILED, completedAt, errorCode },
      });
    }

    throw new SyncFailedError(errorCode, run?.id ?? 'unknown');
  } finally {
    lock.inProgress = false;
  }
}
