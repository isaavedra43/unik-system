import { prisma } from '@/lib/prisma';
import {
  ENTITY_TYPE,
  SOURCE,
  SYNC_STATUS,
  SyncAlreadyRunningError,
  SyncFailedError,
  syncSalesOrders,
} from './sales-orders-sync';

/**
 * Internal scheduler for Zoho Sales Orders.
 *
 * It runs inside the persistent web service (no external cron service). The
 * frequent tick only reads PostgreSQL; Zoho is contacted at most once per
 * SYNC_INTERVAL_MS. IntegrationSyncRun is the durable source of truth, so a
 * restart never resets the schedule.
 *
 * API budget with the current volume (~115 pages per scan):
 *   115 calls x 24 runs/day  ~= 2,760 calls/day
 *   + up to 50 detail fetches x 24 ~= 1,200 calls/day
 *   ~= 3,960 calls/day against a 5,000/day quota.
 * If pagesScanned grows significantly, SYNC_INTERVAL_MS must be recalculated.
 */

/** Zoho is polled at most once per hour. */
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

/** Local PostgreSQL check cadence. Does NOT consume Zoho API calls. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Grace period so Next.js and Railway finish booting before the first check. */
const STARTUP_DELAY_MS = 30 * 1000;

/** Detail downloads per scheduled run. Deliberately lower than the API maximum. */
const SCHEDULER_MAX_DETAIL_FETCHES = 50;

const SCHEDULER_STATE_KEY = '__unikZohoSalesOrdersSchedulerState' as const;

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

/** Opt-in only. Never enabled implicitly by NODE_ENV. */
export function isSchedulerEnabled(): boolean {
  return process.env.ZOHO_SALES_ORDERS_SCHEDULER_ENABLED === 'true';
}

/** `next build` must never contact Zoho or start timers. */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

/**
 * A sync is due when there is no successful sync yet, or when the most recent
 * one is older than SYNC_INTERVAL_MS. Only `mode = 'sync'` runs count: baseline
 * and scan runs do not download details and must not postpone a real sync.
 */
export async function isSyncDue(now: Date = new Date()): Promise<boolean> {
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

  return now.getTime() - lastCompletedSync.completedAt.getTime() >= SYNC_INTERVAL_MS;
}

/**
 * One scheduler tick. Never throws: a failing sync must not take down the
 * server, and the next tick will re-evaluate from PostgreSQL.
 */
export async function runSchedulerCheck(): Promise<void> {
  const state = getSchedulerState();

  if (!isSchedulerEnabled() || state.tickInProgress) {
    return;
  }

  state.tickInProgress = true;

  try {
    if (!(await isSyncDue())) {
      return;
    }

    log({ event: 'zoho.sales_orders.scheduler.due' });
    const startedAt = Date.now();

    log({ event: 'zoho.sales_orders.scheduler.sync_started' });

    const result = await syncSalesOrders({
      mode: 'sync',
      maxDetailFetches: SCHEDULER_MAX_DETAIL_FETCHES,
    });

    log({
      event: 'zoho.sales_orders.scheduler.sync_completed',
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
        event: 'zoho.sales_orders.scheduler.sync_skipped',
        reason: 'sync_already_running',
      });
      return;
    }

    log({
      event: 'zoho.sales_orders.scheduler.sync_failed',
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
 */
export function startSalesOrdersScheduler(): void {
  const state = getSchedulerState();

  if (state.started) {
    return;
  }

  if (isBuildPhase()) {
    return;
  }

  if (!isSchedulerEnabled()) {
    log({ event: 'zoho.sales_orders.scheduler.disabled' });
    return;
  }

  state.started = true;

  const tick = () => {
    void runSchedulerCheck();
  };

  setTimeout(() => {
    tick();
    setInterval(tick, CHECK_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  log({
    event: 'zoho.sales_orders.scheduler.started',
    startupDelayMs: STARTUP_DELAY_MS,
    checkIntervalMs: CHECK_INTERVAL_MS,
    syncIntervalMs: SYNC_INTERVAL_MS,
    maxDetailFetches: SCHEDULER_MAX_DETAIL_FETCHES,
  });
}
