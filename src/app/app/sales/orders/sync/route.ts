import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  startSyncSalesOrders,
  getActiveSyncRun,
  SyncRunStatus,
} from '@/modules/integrations/zoho/sales-orders-sync';

export const runtime = 'nodejs';

/**
 * User-facing sync trigger. Starts a quick (incremental) sync in the
 * background and returns immediately with the run ID. The UI polls
 * /app/sales/orders/sync/status to track progress.
 *
 * Returns:
 *   200 — sync started (or already running, with the existing run ID)
 *   401 — not authenticated
 *   403 — no permission
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
    const result = await startSyncSalesOrders({
      mode: 'quick',
      maxDetailFetches: 100,
    });

    const activeRun = await getActiveSyncRun();

    return NextResponse.json({
      run_id: result.runId,
      already_running: result.alreadyRunning,
      status: activeRun ? formatRunStatus(activeRun) : null,
    });
  } catch (error) {
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
