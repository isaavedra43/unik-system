import { prisma } from '@/lib/prisma';
import {
  type ZohoEntityAdapter,
  type SyncMode,
  SYNC_STATUS,
  SyncAlreadyRunningError,
  SyncFailedError,
  runSync,
} from './zoho-sync-engine';
import {
  INTEGRATION_SOURCE_ZOHO,
  getIntegrationSettings,
  isIntegrationEnabled,
} from '../integration-config-service';

/**
 * Scheduler factory for Zoho entity syncs.
 *
 * Creates a self-contained scheduler loop for any entity adapter, mirroring
 * the pattern from sales-orders-scheduler.ts but generalized. The scheduler
 * is NOT registered automatically — it must be explicitly started from
 * instrumentation.ts (Phase 7: Sync Orchestration).
 */

interface SchedulerState {
  started: boolean;
  tickInProgress: boolean;
}

type GlobalWithSchedulerStates = typeof globalThis & {
  [key: string]: SchedulerState | undefined;
};

function getSchedulerStateKey(entityType: string): string {
  return `__unikZohoScheduler_${entityType}`;
}

function getSchedulerState(entityType: string): SchedulerState {
  const scope = globalThis as GlobalWithSchedulerStates;
  const key = getSchedulerStateKey(entityType);
  scope[key] ??= { started: false, tickInProgress: false };
  return scope[key]!;
}

function log(payload: Record<string, unknown>): void {
  console.info(JSON.stringify(payload));
}

function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

/**
 * A sync is due when there is no successful sync yet, or when the most recent
 * completed sync is older than syncIntervalMs. Only 'sync' and 'quick' mode
 * runs count — 'scan' and 'baseline' do not download details.
 */
async function isSyncDue(entityType: string, now: Date = new Date()): Promise<boolean> {
  const settings = await getIntegrationSettings(INTEGRATION_SOURCE_ZOHO);

  const lastCompleted = await prisma.integrationSyncRun.findFirst({
    where: {
      source: 'zoho',
      entityType,
      mode: { in: ['sync', 'quick'] },
      status: SYNC_STATUS.COMPLETED,
    },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true },
  });

  if (!lastCompleted?.completedAt) {
    return true;
  }

  return now.getTime() - lastCompleted.completedAt.getTime() >= settings.syncIntervalMs;
}

async function isSyncCoolingDown(entityType: string, now: Date = new Date()): Promise<boolean> {
  const settings = await getIntegrationSettings(INTEGRATION_SOURCE_ZOHO);

  const lastFailed = await prisma.integrationSyncRun.findFirst({
    where: {
      source: 'zoho',
      entityType,
      mode: { in: ['sync', 'quick'] },
      status: SYNC_STATUS.FAILED,
    },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });

  if (!lastFailed?.startedAt) {
    return false;
  }

  return now.getTime() - lastFailed.startedAt.getTime() < settings.failedRetryCooldownMs;
}

async function runSchedulerCheck(adapter: ZohoEntityAdapter): Promise<void> {
  const state = getSchedulerState(adapter.entityType);

  if (state.tickInProgress) {
    return;
  }

  try {
    const enabled = await isIntegrationEnabled(INTEGRATION_SOURCE_ZOHO);
    if (!enabled) return;
  } catch (error) {
    log({
      event: 'zoho.scheduler.tick_skipped',
      entityType: adapter.entityType,
      reason: error instanceof Error ? error.message : 'db_unreachable',
    });
    return;
  }

  state.tickInProgress = true;

  try {
    if (!(await isSyncDue(adapter.entityType))) {
      return;
    }

    if (await isSyncCoolingDown(adapter.entityType)) {
      log({
        event: 'zoho.scheduler.sync_skipped',
        entityType: adapter.entityType,
        reason: 'failed_retry_cooldown',
      });
      return;
    }

    log({ event: 'zoho.scheduler.due', entityType: adapter.entityType });
    const startedAt = Date.now();
    const settings = await getIntegrationSettings(INTEGRATION_SOURCE_ZOHO);

    log({ event: 'zoho.scheduler.sync_started', entityType: adapter.entityType });

    const result = await runSync(adapter, {
      mode: 'sync' as SyncMode,
      maxDetailFetches: settings.schedulerMaxDetailFetches,
    });

    log({
      event: 'zoho.scheduler.sync_completed',
      entityType: adapter.entityType,
      runId: result.runId,
      pagesScanned: result.pagesScanned,
      recordsSeen: result.recordsSeen,
      recordsPending: result.recordsPending,
      detailsFetched: result.detailsFetched,
      detailsFailed: result.detailsFailed,
      apiCalls: result.apiCalls,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      log({
        event: 'zoho.scheduler.sync_skipped',
        entityType: adapter.entityType,
        reason: 'sync_already_running',
      });
      return;
    }

    log({
      event: 'zoho.scheduler.sync_failed',
      entityType: adapter.entityType,
      reason: error instanceof SyncFailedError ? error.errorCode : 'UNEXPECTED_ERROR',
      runId: error instanceof SyncFailedError ? error.runId : null,
    });
  } finally {
    state.tickInProgress = false;
  }
}

export interface ZohoScheduler {
  start: () => Promise<void>;
  stop: () => void;
  runCheck: () => Promise<void>;
}

/**
 * Creates a scheduler for the given entity adapter.
 *
 * The scheduler is NOT started automatically. Call `start()` explicitly
 * from instrumentation.ts (Phase 7: Sync Orchestration).
 */
export function createZohoScheduler(adapter: ZohoEntityAdapter): ZohoScheduler {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let startupTimeoutId: ReturnType<typeof setTimeout> | null = null;

  return {
    async start(): Promise<void> {
      const state = getSchedulerState(adapter.entityType);

      if (state.started) {
        return;
      }

      if (isBuildPhase()) {
        return;
      }

      let enabled: boolean;
      let settings;
      try {
        enabled = await isIntegrationEnabled(INTEGRATION_SOURCE_ZOHO);
        settings = await getIntegrationSettings(INTEGRATION_SOURCE_ZOHO);
      } catch (error) {
        log({
          event: 'zoho.scheduler.start_failed',
          entityType: adapter.entityType,
          reason: error instanceof Error ? error.message : 'db_unreachable',
        });
        return;
      }

      if (!enabled) {
        log({ event: 'zoho.scheduler.disabled', entityType: adapter.entityType });
        return;
      }

      state.started = true;

      const tick = () => {
        void runSchedulerCheck(adapter);
      };

      startupTimeoutId = setTimeout(() => {
        tick();
        intervalId = setInterval(tick, settings.checkIntervalMs);
      }, settings.startupDelayMs);

      log({
        event: 'zoho.scheduler.started',
        entityType: adapter.entityType,
        startupDelayMs: settings.startupDelayMs,
        checkIntervalMs: settings.checkIntervalMs,
        syncIntervalMs: settings.syncIntervalMs,
        maxDetailFetches: settings.schedulerMaxDetailFetches,
      });
    },

    stop(): void {
      const state = getSchedulerState(adapter.entityType);
      state.started = false;
      state.tickInProgress = false;
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      if (startupTimeoutId) {
        clearTimeout(startupTimeoutId);
        startupTimeoutId = null;
      }
    },

    async runCheck(): Promise<void> {
      await runSchedulerCheck(adapter);
    },
  };
}
