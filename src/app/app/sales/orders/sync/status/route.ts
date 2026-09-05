import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  getLatestSyncRun,
  getActiveSyncRun,
  SyncRunStatus,
} from '@/modules/integrations/zoho/sales-orders-sync';

export const runtime = 'nodejs';

/**
 * Returns the current sync status for the UI to poll.
 *
 * - `active_run`: the currently RUNNING sync (or null if none).
 * - `latest_run`: the most recent sync of any status (for "last synced" display).
 *
 * Returns:
 *   200 — status payload
 *   401 — not authenticated
 *   403 — no permission
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('sales_orders.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  try {
    const [activeRun, latestRun] = await Promise.all([getActiveSyncRun(), getLatestSyncRun()]);

    return NextResponse.json({
      active_run: activeRun ? formatRunStatus(activeRun) : null,
      latest_run: latestRun ? formatRunStatus(latestRun) : null,
    });
  } catch (error) {
    console.error('sync status error', error);
    return NextResponse.json({ error: 'Error al obtener estado' }, { status: 500 });
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
