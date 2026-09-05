import { NextResponse, after } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  syncSalesOrders,
  getActiveSyncRun,
  SyncRunStatus,
  SyncFailedError,
  SyncAlreadyRunningError,
} from '@/modules/integrations/zoho/sales-orders-sync';

export const runtime = 'nodejs';

/** Max time we keep the HTTP request open before responding. The actual
 *  sync work is handed to `after` so it continues even if the client drops. */
const SYNC_ROUTE_TIMEOUT_MS = 25_000;

/**
 * User-facing sync trigger. Starts a quick (incremental) sync and keeps it
 * alive with `after()` so it survives the HTTP response.
 *
 * Returns:
 *   200 — sync completed (result included)
 *   202 — sync started and still running (client should poll)
 *   401 — not authenticated
 *   403 — no permission
 *   409 — a sync is already running
 */
export async function POST() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('sales_orders.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  try {
    // Start the sync immediately.
    const syncPromise = syncSalesOrders({ mode: 'quick', maxDetailFetches: 20 });

    // Keep the sync alive after the response is sent. `after()` is the
    // official Next.js API for post-response work; it prevents the runtime
    // from terminating the promise when the HTTP request completes.
    after(async () => {
      try {
        await syncPromise;
      } catch {
        // Errors are already logged inside syncSalesOrders.
      }
    });

    // Wait up to SYNC_ROUTE_TIMEOUT_MS for a quick completion.
    const result = await Promise.race([
      syncPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SYNC_ROUTE_TIMEOUT')), SYNC_ROUTE_TIMEOUT_MS)
      ),
    ]);

    return NextResponse.json({
      run_id: result.runId,
      already_running: false,
      result: {
        pages_scanned: result.pagesScanned,
        records_seen: result.recordsSeen,
        records_pending: result.recordsPending,
        details_fetched: result.detailsFetched,
        details_failed: result.detailsFailed,
        api_calls: result.apiCalls,
      },
    });
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      const activeRun = await getActiveSyncRun();
      return NextResponse.json(
        {
          already_running: true,
          run_id: activeRun?.runId ?? null,
          status: activeRun ? formatRunStatus(activeRun) : null,
        },
        { status: 409 }
      );
    }

    // The HTTP timeout fired but the sync keeps running inside `after()`.
    // Report it so the UI can keep polling.
    if (error instanceof Error && error.message === 'SYNC_ROUTE_TIMEOUT') {
      const activeRun = await getActiveSyncRun();
      return NextResponse.json(
        {
          still_running: true,
          run_id: activeRun?.runId ?? null,
          status: activeRun ? formatRunStatus(activeRun) : null,
        },
        { status: 202 }
      );
    }

    if (error instanceof SyncFailedError) {
      return NextResponse.json(
        { error: 'La sincronización falló', error_code: error.errorCode },
        { status: 500 }
      );
    }

    console.error('sync trigger error', error);
    return NextResponse.json({ error: 'Error al iniciar sincronización' }, { status: 500 });
  }
}

function formatRunStatus(run: SyncRunStatus) {
  return {
    run_id: run.runId,
    mode: run.mode,
    status: run.status,
    started_at: run.startedAt.toISOString(),
    completed_at: run.completedAt?.toISOString() ?? null,
    pages_scanned: run.pagesScanned,
    records_seen: run.recordsSeen,
    records_pending: run.recordsPending,
    details_fetched: run.detailsFetched,
    details_failed: run.detailsFailed,
    api_calls: run.apiCalls,
    error_code: run.errorCode,
  };
}
