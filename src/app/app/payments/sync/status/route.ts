import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getLatestPaymentsSyncRun, getActivePaymentsSyncRun } from '@/modules/integrations/zoho/payments-sync';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('payments.view'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const [latestRun, activeRun] = await Promise.all([getLatestPaymentsSyncRun(), getActivePaymentsSyncRun()]);
  return NextResponse.json({
    active_run: activeRun ? {
      run_id: activeRun.runId, mode: activeRun.mode, status: activeRun.status,
      started_at: activeRun.startedAt.toISOString(), completed_at: activeRun.completedAt?.toISOString() ?? null,
    } : null,
    latest_run: latestRun ? {
      run_id: latestRun.runId, mode: latestRun.mode, status: latestRun.status,
      started_at: latestRun.startedAt.toISOString(), completed_at: latestRun.completedAt?.toISOString() ?? null,
      pages_scanned: latestRun.pagesScanned, records_seen: latestRun.recordsSeen,
      records_pending: latestRun.recordsPending, details_fetched: latestRun.detailsFetched,
      details_failed: latestRun.detailsFailed, error_code: latestRun.errorCode,
    } : null,
  });
}
