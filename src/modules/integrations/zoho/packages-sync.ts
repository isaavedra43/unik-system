import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ZohoApiError } from './client';
import { getPackage, listPackages } from './packages';
import {
  INTEGRATION_SOURCE_ZOHO,
  getIntegrationSettings,
  DEFAULT_SETTINGS,
  type ZohoSettings,
} from '../integration-config-service';

export const SOURCE = 'zoho';
export const ENTITY_TYPE = 'package';

export const SYNC_STATUS = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export const SYNC_ERROR_CODE = {
  ZOHO_API_ERROR: 'ZOHO_API_ERROR',
  INVALID_LIST_RESPONSE: 'INVALID_LIST_RESPONSE',
  PAGE_LIMIT_EXCEEDED: 'PAGE_LIMIT_EXCEEDED',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
} as const;

export class SyncAlreadyRunningError extends Error {
  constructor() {
    super('A packages sync is already running in this instance');
    this.name = 'SyncAlreadyRunningError';
  }
}

export class SyncFailedError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly runId: string
  ) {
    super(`Packages sync failed with code ${errorCode}`);
    this.name = 'SyncFailedError';
  }
}

export const syncPackagesOptionsSchema = z.object({
  mode: z.enum(['scan', 'sync']).default('scan'),
  maxDetailFetches: z.number().int().min(1).max(200).default(50),
});

export type SyncPackagesOptions = z.input<typeof syncPackagesOptionsSchema>;
export type SyncMode = z.output<typeof syncPackagesOptionsSchema>['mode'];

export interface SyncPackagesResult {
  runId: string;
  mode: SyncMode;
  pagesScanned: number;
  recordsSeen: number;
  recordsPending: number;
  detailsFetched: number;
  detailsFailed: number;
  apiCalls: number;
}

const SYNC_LOCK_KEY = '__unikZohoPackagesSyncLock' as const;

let currentPrismaTimeoutMs = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number = currentPrismaTimeoutMs): Promise<T> {
  const timeout = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms)
  );
  promise.catch(() => {});
  return Promise.race([promise, timeout]);
}

interface SyncLockState {
  inProgress: boolean;
}

type GlobalWithSyncLock = typeof globalThis & {
  [SYNC_LOCK_KEY]?: SyncLockState;
};

function getSyncLock(): SyncLockState {
  const scope = globalThis as GlobalWithSyncLock;
  scope[SYNC_LOCK_KEY] ??= { inProgress: false };
  return scope[SYNC_LOCK_KEY];
}

const remoteTimestampSchema = z.string().min(1).transform(toDateOrIssue);

function toDateOrIssue(value: string, ctx: z.RefinementCtx): Date {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unusable remote timestamp' });
    return z.NEVER;
  }

  return date;
}

const packageSummarySchema = z.object({
  package_id: z.union([z.string().min(1), z.number()]).transform((value) => String(value)),
  last_modified_time: remoteTimestampSchema,
});

const packagesListSchema = z.object({
  packages: z.array(packageSummarySchema),
  page_context: z
    .object({
      has_more_page: z.boolean().optional(),
    })
    .optional(),
});

const packageDetailTimestampSchema = z.object({
  package: z.object({ last_modified_time: remoteTimestampSchema }),
});

function extractDetailModifiedAt(rawDetail: unknown): Date | null {
  const parsed = packageDetailTimestampSchema.safeParse(rawDetail);
  return parsed.success ? parsed.data.package.last_modified_time : null;
}

interface ScanOutcome {
  pagesScanned: number;
  recordsSeen: number;
  apiCalls: number;
}

interface SyncParams {
  perPage: number;
  maxPages: number;
  quickScanPages: number;
  recentThresholdMs: number;
}

async function scanAllPages(params: SyncParams): Promise<ScanOutcome> {
  let pagesScanned = 0;
  let recordsSeen = 0;
  let apiCalls = 0;
  let page = 1;

  for (;;) {
    if (page > params.maxPages) {
      throw new SyncPageLimitError();
    }

    const rawPage = await listPackages({ page, perPage: params.perPage });
    apiCalls += 1;

    const parsed = packagesListSchema.safeParse(rawPage);
    if (!parsed.success) {
      throw new SyncInvalidListError();
    }

    pagesScanned += 1;

    for (const summary of parsed.data.packages) {
      await recordSummary(summary.package_id, summary.last_modified_time);
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

async function recordSummary(externalId: string, remoteModifiedAt: Date): Promise<void> {
  const now = new Date();

  const existing = await withTimeout(
    prisma.integrationEntityState.findUnique({
      where: {
        source_entityType_externalId: {
          source: SOURCE,
          entityType: ENTITY_TYPE,
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
          entityType: ENTITY_TYPE,
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

async function fetchPendingDetails(
  maxDetailFetches: number,
  shouldAbort?: () => boolean
): Promise<{ detailsFetched: number; detailsFailed: number; apiCalls: number }> {
  const pending = await withTimeout(
    prisma.integrationEntityState.findMany({
      where: { source: SOURCE, entityType: ENTITY_TYPE, needsSync: true },
      orderBy: [{ remoteModifiedAt: 'desc' }, { externalId: 'asc' }],
      take: maxDetailFetches,
    })
  );

  let detailsFetched = 0;
  let detailsFailed = 0;
  let apiCalls = 0;

  for (const entity of pending) {
    if (shouldAbort?.()) break;
    try {
      const rawDetail = await getPackage(entity.externalId);
      apiCalls += 1;

      const detailModifiedAt = extractDetailModifiedAt(rawDetail);
      const effectiveModifiedAt =
        detailModifiedAt && detailModifiedAt.getTime() > entity.remoteModifiedAt.getTime()
          ? detailModifiedAt
          : entity.remoteModifiedAt;

      const fetchedAt = new Date();

      await withTimeout(
        prisma.$transaction([
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
        ])
      );

      detailsFetched += 1;
    } catch {
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

function getSyncTimeoutMs(settings: ZohoSettings, mode: SyncMode): number {
  switch (mode) {
    case 'scan':
      return settings.scanSyncTimeoutMs;
    case 'sync':
    default:
      return settings.fullSyncTimeoutMs;
  }
}

/**
 * Runs one controlled Packages synchronization.
 *
 * scan: walks every page and refreshes summarized state only.
 * sync: same scan, then downloads details for pending entities up to maxDetailFetches.
 */
export async function syncPackages(options: SyncPackagesOptions = {}): Promise<SyncPackagesResult> {
  const { mode, maxDetailFetches } = syncPackagesOptionsSchema.parse(options);
  const lock = getSyncLock();

  if (lock.inProgress) {
    throw new SyncAlreadyRunningError();
  }

  let settings: ZohoSettings;
  try {
    settings = await getIntegrationSettings(INTEGRATION_SOURCE_ZOHO);
  } catch {
    settings = DEFAULT_SETTINGS[INTEGRATION_SOURCE_ZOHO];
  }
  currentPrismaTimeoutMs = settings.prismaTimeoutMs;

  const params: SyncParams = {
    perPage: settings.perPage,
    maxPages: settings.maxPages,
    quickScanPages: settings.quickScanPages,
    recentThresholdMs: settings.recentThresholdMs,
  };

  lock.inProgress = true;
  const startedAt = new Date();
  let run: { id: string } | null = null;
  let timedOut = false;

  const timeoutMs = getSyncTimeoutMs(settings, mode);
  const timeoutId = setTimeout(() => {
    timedOut = true;
    console.error(
      JSON.stringify({
        event: 'zoho.packages.sync.timeout',
        runId: run?.id ?? 'unknown',
        mode,
        durationMs: timeoutMs,
      })
    );
    lock.inProgress = false;
    if (run) {
      void (async () => {
        try {
          await withTimeout(
            prisma.integrationSyncRun.update({
              where: { id: run.id },
              data: {
                status: SYNC_STATUS.FAILED,
                completedAt: new Date(),
                errorCode: SYNC_ERROR_CODE.UNEXPECTED_ERROR,
              },
            }),
            settings.prismaTimeoutMs
          );
        } catch {
          // Best-effort
        }
      })();
    }
  }, timeoutMs);

  try {
    run = await withTimeout(
      prisma.integrationSyncRun.create({
        data: {
          source: SOURCE,
          entityType: ENTITY_TYPE,
          mode,
          status: SYNC_STATUS.RUNNING,
          startedAt,
        },
      })
    );

    const scan = await scanAllPages(params);

    const details =
      mode === 'scan'
        ? { detailsFetched: 0, detailsFailed: 0, apiCalls: 0 }
        : await fetchPendingDetails(maxDetailFetches, () => timedOut);

    const recordsPending = await withTimeout(
      prisma.integrationEntityState.count({
        where: { source: SOURCE, entityType: ENTITY_TYPE, needsSync: true },
      })
    );

    if (mode === 'sync') {
      try {
        const { normalizePendingPackageSnapshots } = await import('@/modules/sales/packages-normalizer');
        await withTimeout(normalizePendingPackageSnapshots({ limit: 100 }), 30_000);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'zoho.packages.sync.normalization_failed',
            runId: run.id,
            error: error instanceof Error ? error.message : 'unknown',
          })
        );
      }
    }

    const result: SyncPackagesResult = {
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
        event: 'zoho.packages.sync.completed',
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
      await withTimeout(
        prisma.integrationSyncRun.update({
          where: { id: run.id },
          data: { status: SYNC_STATUS.FAILED, completedAt, errorCode },
        })
      );
    }

    console.error(
      JSON.stringify({
        event: 'zoho.packages.sync.failed',
        runId: run?.id ?? 'unknown',
        mode,
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
