import { prisma } from '@/lib/prisma';
import {
  ENTITY_TYPE,
  SOURCE,
  SYNC_STATUS,
  SyncAlreadyRunningError,
  SyncFailedError,
  syncVendors,
} from './vendors-sync';
import {
  INTEGRATION_SOURCE_ZOHO,
  getIntegrationSettings,
  isIntegrationEnabled,
} from '../integration-config-service';

/**
 * Internal scheduler for Zoho Sales Orders.
 *
 * It runs inside the persistent web service (no external cron service). The
 * frequent tick only reads PostgreSQL; Zoho is contacted at most once per
 * vendorsSyncIntervalMs. IntegrationSyncRun is the durable source of truth, so a
 * restart never resets the schedule.
 *
 * All tuning parameters (intervals, timeouts, max detail fetches) are read
 * from the IntegrationConfig table and can be changed live from the admin UI
 * without restarting the service.
 */

const SCHEDULER_STATE_KEY = '__unikZohoVendorsSchedulerState' as const;

interface SchedulerState {
  started: boolean;
  tickInProgress: boolean;
}

type GlobalWithSchedulerState = typeof globalThis & {
  [SCHEDULER_STATE_KEY]?: SchedulerState;
};

/**
 * Stored on globalThis so that a duplicated module instance (Next.js bundles
 * instrumentation separately from route handlers) can never start a second loop
 * inside the same process.
 */
function getSchedulerState(): SchedulerState {
  const scope = globalThis as GlobalWithSchedulerState;
  scope[SCHEDULER_STATE_KEY] ??= { started: false, tickInProgress: false };
  return scope[SCHEDULER_STATE_KEY];
}

function log(payload: Record<string, unknown>) {
  console.info(JSON.stringify(payload));
}

/** `next build` must never contact Zoho or start timers. */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

/**
 * A sync is due when there is no successful sync yet, or when the most recent
 * one is older than vendorsSyncIntervalMs. Only `mode = 'sync'` runs count: baseline
 * and scan runs do not download details and must not postpone a real sync.
 */
export async function isSyncDue(now: Date = new Date()): Promise<boolean> {
  const settings = await getIntegrationSettings(INTEGRATION_SOURCE_ZOHO);

  const lastCompletedSync = await prisma.integrationSyncRun.findFirst({
    where: {
      source: SOURCE,
      entityType: ENTITY_TYPE,
      mode: 'sync',
      status: SYNC_STATUS.COMPLETED,
    },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true },
  });

  if (!lastCompletedSync?.completedAt) {
    return true;
  }

  return now.getTime() - lastCompletedSync.completedAt.getTime() >= settings.vendorsSyncIntervalMs;
}

/**
 * Prevents retry storms. A recent FAILED sync (within failedRetryCooldownMs)
 * blocks a new attempt even when the normal interval has passed.
 * The lock in memory already prevents RUNNING overlap, so this is purely a
 * post-failure cooldown.
 */
export async function isSyncCoolingDown(now: Date = new Date()): Promise<boolean> {
  const settings = await getIntegrationSettings(INTEGRATION_SOURCE_ZOHO);

  const lastFailedSync = await prisma.integrationSyncRun.findFirst({
    where: {
      source: SOURCE,
      entityType: ENTITY_TYPE,
      mode: 'sync',
      status: SYNC_STATUS.FAILED,
    },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });

  if (!lastFailedSync?.startedAt) {
    return false;
  }

  return now.getTime() - lastFailedSync.startedAt.getTime() < settings.failedRetryCooldownMs;
}

/**
 * One scheduler tick. Never throws: a failing sync must not take down the
 * server, and the next tick will re-evaluate from PostgreSQL.
 */
export async function runSchedulerCheck(): Promise<void> {
  const state = getSchedulerState();

  if (state.tickInProgress) {
    return;
  }

  try {
    const enabled = await isIntegrationEnabled(INTEGRATION_SOURCE_ZOHO);
    if (!enabled) return;
  } catch (error) {
    log({
      event: 'zoho.vendors.scheduler.tick_skipped',
      reason: error instanceof Error ? error.message : 'db_unreachable',
    });
    return;
  }

  state.tickInProgress = true;

  try {
    if (!(await isSyncDue())) {
      return;
    }

    if (await isSyncCoolingDown()) {
      log({
        event: 'zoho.vendors.scheduler.sync_skipped',
        reason: 'failed_retry_cooldown',
      });
      return;
    }

    log({ event: 'zoho.vendors.scheduler.due' });
    const startedAt = Date.now();
    const settings = await getIntegrationSettings(INTEGRATION_SOURCE_ZOHO);

    if (!settings.vendorsSyncEnabled) {
      return;
    }

    log({ event: 'zoho.vendors.scheduler.sync_started' });

    const result = await syncVendors({
      mode: 'sync',
      maxDetailFetches: settings.vendorsMaxDetailFetches,
    });

    log({
      event: 'zoho.vendors.scheduler.sync_completed',
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
        event: 'zoho.vendors.scheduler.sync_skipped',
        reason: 'sync_already_running',
      });
      return;
    }

    log({
      event: 'zoho.vendors.scheduler.sync_failed',
      reason: error instanceof SyncFailedError ? error.errorCode : 'UNEXPECTED_ERROR',
      runId: error instanceof SyncFailedError ? error.runId : null,
    });
  } finally {
    state.tickInProgress = false;
  }
}

/**
 * Starts the scheduler loop once per process. Safe to call multiple times and
 * never throws, so a scheduler problem can never break server startup.
 *
 * The check interval is read from IntegrationConfig once at startup. To change
 * it live, restart the process after updating the config from the admin UI.
 */
export async function startVendorsScheduler(): Promise<void> {
  const state = getSchedulerState();

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
    // DB not reachable — don't crash the server. The next request that
    // touches the config will retry. Log and bail out.
    log({
      event: 'zoho.vendors.scheduler.start_failed',
      reason: error instanceof Error ? error.message : 'db_unreachable',
    });
    return;
  }

  if (!enabled || !settings.vendorsSyncEnabled) {
    log({ event: 'zoho.vendors.scheduler.disabled' });
    return;
  }

  state.started = true;

  const tick = () => {
    void runSchedulerCheck();
  };

  setTimeout(() => {
    tick();
    setInterval(tick, settings.checkIntervalMs);
  }, settings.startupDelayMs);

  log({
    event: 'zoho.vendors.scheduler.started',
    startupDelayMs: settings.startupDelayMs,
    checkIntervalMs: settings.checkIntervalMs,
    vendorsSyncIntervalMs: settings.vendorsSyncIntervalMs,
    maxDetailFetches: settings.vendorsMaxDetailFetches,
  });
}
