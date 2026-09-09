import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  startSyncInvoices, getActiveInvoicesSyncRun, getLatestInvoicesSyncRun,
  SyncAlreadyRunningError, type SyncRunStatus,
} from '@/modules/integrations/zoho/invoices-sync';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('integrations.manage'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const mode = body?.mode === 'baseline' ? 'baseline' : 'sync';
  try {
    if (mode === 'baseline') {
      const { baselineInvoices } = await import('@/modules/integrations/zoho/invoices-sync');
      const result = await baselineInvoices();
      return NextResponse.json({ result });
    }
    const activeRun = await getActiveInvoicesSyncRun();
    if (activeRun) return NextResponse.json({ already_running: true, run_id: activeRun.runId }, { status: 409 });
    const result = await startSyncInvoices({ mode: 'sync' });
    return NextResponse.json({ result: { run_id: result.runId, already_running: result.alreadyRunning } });
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) return NextResponse.json({ already_running: true }, { status: 409 });
    console.error('internal invoices sync error', error);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('integrations.view'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const [latestRun, activeRun] = await Promise.all([getLatestInvoicesSyncRun(), getActiveInvoicesSyncRun()]);
  return NextResponse.json({ active_run: formatRun(activeRun), latest_run: formatRun(latestRun) });
}

function formatRun(run: SyncRunStatus | null) {
  if (!run) return null;
  return {
    run_id: run.runId, mode: run.mode, status: run.status,
    started_at: run.startedAt.toISOString(), completed_at: run.completedAt?.toISOString() ?? null,
    pages_scanned: run.pagesScanned, records_seen: run.recordsSeen, records_pending: run.recordsPending,
    details_fetched: run.detailsFetched, details_failed: run.detailsFailed, error_code: run.errorCode,
  };
}
