import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ZohoApiError } from './client';
import { getSalesOrder, listSalesOrders } from './sales-orders';

const SOURCE = 'zoho';
const ENTITY_TYPE = 'sales_order';
const PER_PAGE = 200;

/** Defensive upper bound so a broken pagination contract can never loop forever. */
const MAX_PAGES = 200;

export const SYNC_STATUS = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

/** Internal, non-sensitive error codes persisted on IntegrationSyncRun. */
export const SYNC_ERROR_CODE = {
  ZOHO_API_ERROR: 'ZOHO_API_ERROR',
  INVALID_LIST_RESPONSE: 'INVALID_LIST_RESPONSE',
  PAGE_LIMIT_EXCEEDED: 'PAGE_LIMIT_EXCEEDED',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
} as const;

export class SyncAlreadyRunningError extends Error {
  constructor() {
    super('A sales orders sync is already running in this instance');
    this.name = 'SyncAlreadyRunningError';
  }
}

export class SyncFailedError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly runId: string
  ) {
    super(`Sales orders sync failed with code ${errorCode}`);
    this.name = 'SyncFailedError';
  }
}

export const syncSalesOrdersOptionsSchema = z.object({
  mode: z.enum(['scan', 'sync']).default('scan'),
  maxDetailFetches: z.number().int().min(1).max(200).default(50),
});

export type SyncSalesOrdersOptions = z.input<typeof syncSalesOrdersOptionsSchema>;
export type SyncMode = z.output<typeof syncSalesOrdersOptionsSchema>['mode'];

export interface SyncSalesOrdersResult {
  runId: string;
  mode: SyncMode;
  pagesScanned: number;
  recordsSeen: number;
  recordsPending: number;
  detailsFetched: number;
  detailsFailed: number;
  apiCalls: number;
}

/**
 * In-memory guard preventing two concurrent syncs inside the SAME instance.
 * This is intentionally NOT a distributed lock: multiple Railway instances or
 * replicas could still run concurrently. A durable strategy will be decided
 * together with the scheduler.
 */
let syncInProgress = false;

const remoteTimestampSchema = z.string().min(1).transform(toDateOrIssue);

function toDateOrIssue(value: string, ctx: z.RefinementCtx): Date {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unusable remote timestamp' });
    return z.NEVER;
  }

  return date;
}

/** Minimal shape needed for change detection. The rest of the payload stays RAW. */
const salesOrderSummarySchema = z.object({
  salesorder_id: z.union([z.string().min(1), z.number()]).transform((value) => String(value)),
  last_modified_time: remoteTimestampSchema,
});

const salesOrdersListSchema = z.object({
  salesorders: z.array(salesOrderSummarySchema),
  page_context: z
    .object({
      has_more_page: z.boolean().optional(),
    })
    .optional(),
});

/** Detail payload is kept RAW; we only read its timestamp when present. */
const salesOrderDetailTimestampSchema = z.object({
  salesorder: z.object({ last_modified_time: remoteTimestampSchema }),
});

function extractDetailModifiedAt(rawDetail: unknown): Date | null {
  const parsed = salesOrderDetailTimestampSchema.safeParse(rawDetail);
  return parsed.success ? parsed.data.salesorder.last_modified_time : null;
}

interface ScanOutcome {
  pagesScanned: number;
  recordsSeen: number;
  apiCalls: number;
}

/**
 * Walks every Sales Orders page and records only the summarized state.
 * Never fetches details and never stores snapshots.
 */
async function scanAllPages(): Promise<ScanOutcome> {
  let pagesScanned = 0;
  let recordsSeen = 0;
  let apiCalls = 0;
  let page = 1;

  for (;;) {
    if (page > MAX_PAGES) {
      throw new SyncPageLimitError();
    }

    const rawPage = await listSalesOrders({ page, perPage: PER_PAGE });
    apiCalls += 1;

    const parsed = salesOrdersListSchema.safeParse(rawPage);
    if (!parsed.success) {
      throw new SyncInvalidListError();
    }

    pagesScanned += 1;

    for (const summary of parsed.data.salesorders) {
      await recordSummary(summary.salesorder_id, summary.last_modified_time);
      recordsSeen += 1;
    }

    if (!parsed.data.page_context?.has_more_page) {
      break;
    }

    page += 1;
  }

  return { pagesScanned, recordsSeen, apiCalls };
}

class SyncPageLimitError extends Error {
  readonly errorCode = SYNC_ERROR_CODE.PAGE_LIMIT_EXCEEDED;
}

class SyncInvalidListError extends Error {
  readonly errorCode = SYNC_ERROR_CODE.INVALID_LIST_RESPONSE;
}

/**
 * Creates or updates the entity state for one summarized Sales Order.
 * needsSync is only ever raised here; it is never cleared just because the
 * record showed up in the listing.
 */
async function recordSummary(externalId: string, remoteModifiedAt: Date): Promise<void> {
  const now = new Date();

  const existing = await prisma.integrationEntityState.findUnique({
    where: {
      source_entityType_externalId: {
        source: SOURCE,
        entityType: ENTITY_TYPE,
        externalId,
      },
    },
  });

  if (!existing) {
    await prisma.integrationEntityState.create({
      data: {
        source: SOURCE,
        entityType: ENTITY_TYPE,
        externalId,
        remoteModifiedAt,
        needsSync: true,
        lastSeenAt: now,
      },
    });
    return;
  }

  const hasChanged = existing.remoteModifiedAt.getTime() !== remoteModifiedAt.getTime();

  await prisma.integrationEntityState.update({
    where: { id: existing.id },
    data: hasChanged ? { remoteModifiedAt, needsSync: true, lastSeenAt: now } : { lastSeenAt: now },
  });
}

/**
 * Downloads and persists details for pending entities, bounded by maxDetailFetches.
 * Each successful detail is stored together with its state update inside one
 * transaction, so a state can never be marked synced without its snapshot.
 */
async function fetchPendingDetails(
  maxDetailFetches: number
): Promise<{ detailsFetched: number; detailsFailed: number; apiCalls: number }> {
  const pending = await prisma.integrationEntityState.findMany({
    where: { source: SOURCE, entityType: ENTITY_TYPE, needsSync: true },
    orderBy: { remoteModifiedAt: 'asc' },
    take: maxDetailFetches,
  });

  let detailsFetched = 0;
  let detailsFailed = 0;
  let apiCalls = 0;

  for (const entity of pending) {
    try {
      const rawDetail = await getSalesOrder(entity.externalId);
      apiCalls += 1;

      const detailModifiedAt = extractDetailModifiedAt(rawDetail);
      const effectiveModifiedAt =
        detailModifiedAt && detailModifiedAt.getTime() > entity.remoteModifiedAt.getTime()
          ? detailModifiedAt
          : entity.remoteModifiedAt;

      const fetchedAt = new Date();

      await prisma.$transaction([
        prisma.integrationSnapshot.upsert({
          where: {
            source_entityType_externalId_remoteModifiedAt: {
              source: SOURCE,
              entityType: ENTITY_TYPE,
              externalId: entity.externalId,
              remoteModifiedAt: effectiveModifiedAt,
            },
          },
          create: {
            source: SOURCE,
            entityType: ENTITY_TYPE,
            externalId: entity.externalId,
            remoteModifiedAt: effectiveModifiedAt,
            payload: rawDetail as Prisma.InputJsonValue,
            fetchedAt,
          },
          update: {},
        }),
        prisma.integrationEntityState.update({
          where: { id: entity.id },
          data: {
            remoteModifiedAt: effectiveModifiedAt,
            lastSyncedRemoteModifiedAt: effectiveModifiedAt,
            needsSync: false,
            lastDetailFetchedAt: fetchedAt,
          },
        }),
      ]);

      detailsFetched += 1;
    } catch {
      // The entity keeps needsSync = true so a later run can retry it.
      // No immediate retries inside the same run.
      detailsFailed += 1;
    }
  }

  return { detailsFetched, detailsFailed, apiCalls };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof SyncPageLimitError || error instanceof SyncInvalidListError) {
    return error.errorCode;
  }

  if (error instanceof ZohoApiError) {
    return SYNC_ERROR_CODE.ZOHO_API_ERROR;
  }

  return SYNC_ERROR_CODE.UNEXPECTED_ERROR;
}

/**
 * Runs one controlled Sales Orders synchronization.
 *
 * scan: walks every page and refreshes summarized state only.
 * sync: same scan, then downloads details for pending entities up to maxDetailFetches.
 */
export async function syncSalesOrders(
  options: SyncSalesOrdersOptions = {}
): Promise<SyncSalesOrdersResult> {
  const { mode, maxDetailFetches } = syncSalesOrdersOptionsSchema.parse(options);

  if (syncInProgress) {
    throw new SyncAlreadyRunningError();
  }

  syncInProgress = true;
  const startedAt = new Date();
  let run: { id: string } | null = null;

  try {
    run = await prisma.integrationSyncRun.create({
      data: {
        source: SOURCE,
        entityType: ENTITY_TYPE,
        mode,
        status: SYNC_STATUS.RUNNING,
        startedAt,
      },
    });

    const scan = await scanAllPages();

    const details =
      mode === 'sync'
        ? await fetchPendingDetails(maxDetailFetches)
        : { detailsFetched: 0, detailsFailed: 0, apiCalls: 0 };

    const recordsPending = await prisma.integrationEntityState.count({
      where: { source: SOURCE, entityType: ENTITY_TYPE, needsSync: true },
    });

    const result: SyncSalesOrdersResult = {
      runId: run.id,
      mode,
      pagesScanned: scan.pagesScanned,
      recordsSeen: scan.recordsSeen,
      recordsPending,
      detailsFetched: details.detailsFetched,
      detailsFailed: details.detailsFailed,
      apiCalls: scan.apiCalls + details.apiCalls,
    };

    const completedAt = new Date();

    await prisma.integrationSyncRun.update({
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
    });

    console.info(
      JSON.stringify({
        event: 'zoho.sales_orders.sync.completed',
        runId: run.id,
        mode,
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
      await prisma.integrationSyncRun.update({
        where: { id: run.id },
        data: { status: SYNC_STATUS.FAILED, completedAt, errorCode },
      });
    }

    console.error(
      JSON.stringify({
        event: 'zoho.sales_orders.sync.failed',
        runId: run?.id ?? 'unknown',
        mode,
        errorCode,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      })
    );

    throw new SyncFailedError(errorCode, run?.id ?? 'sync-run-creation-failed');
  } finally {
    syncInProgress = false;
  }
}

export interface BaselineResult {
  runId: string;
  mode: 'baseline';
  baselined: number;
}

/**
 * Marks historical Sales Orders discovered by a previous scan as the known
 * baseline without downloading any detail or creating snapshots.
 *
 * Only affects records that:
 *   - are from source "zoho" and entityType "sales_order"
 *   - have needsSync = true
 *   - have never been synced (lastSyncedRemoteModifiedAt IS NULL)
 *   - have never been fetched (lastDetailFetchedAt IS NULL)
 *
 * After baseline those records keep needsSync = false, lastSyncedRemoteModifiedAt
 * remains null and no IntegrationSnapshot is created. Future scans will mark an
 * existing order as needsSync = true only when its last_modified_time actually
 * changes, or when the order is new.
 */
export async function baselineSalesOrders(): Promise<BaselineResult> {
  if (syncInProgress) {
    throw new SyncAlreadyRunningError();
  }

  syncInProgress = true;
  const startedAt = new Date();
  let run: { id: string } | null = null;

  try {
    run = await prisma.integrationSyncRun.create({
      data: {
        source: SOURCE,
        entityType: ENTITY_TYPE,
        mode: 'baseline',
        status: SYNC_STATUS.RUNNING,
        startedAt,
      },
    });

    const update = await prisma.integrationEntityState.updateMany({
      where: {
        source: SOURCE,
        entityType: ENTITY_TYPE,
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
        event: 'zoho.sales_orders.baseline.completed',
        runId: run.id,
        baselined: update.count,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      })
    );

    return { runId: run.id, mode: 'baseline', baselined: update.count };
  } catch {
    const errorCode = SYNC_ERROR_CODE.UNEXPECTED_ERROR;
    const completedAt = new Date();

    if (run) {
      await prisma.integrationSyncRun.update({
        where: { id: run.id },
        data: { status: SYNC_STATUS.FAILED, completedAt, errorCode },
      });
    }

    console.error(
      JSON.stringify({
        event: 'zoho.sales_orders.baseline.failed',
        runId: run?.id ?? 'unknown',
        errorCode,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      })
    );

    throw new SyncFailedError(errorCode, run?.id ?? 'unknown');
  } finally {
    syncInProgress = false;
  }
}
