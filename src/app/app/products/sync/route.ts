import { NextResponse, after } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  syncProducts,
  getActiveProductsSyncRun,
  SyncRunStatus,
  SyncFailedError,
  SyncAlreadyRunningError,
} from '@/modules/integrations/zoho/products-sync';

export const runtime = 'nodejs';

const SYNC_ROUTE_TIMEOUT_MS = 120_000;

export async function POST() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('products.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  try {
    const activeRun = await getActiveProductsSyncRun();
    if (activeRun) {
      return NextResponse.json({ already_running: true, run_id: activeRun.runId }, { status: 409 });
    }

    const syncPromise = syncProducts({ mode: 'sync' });

    after(async () => {
      try {
        await syncPromise;
      } catch {
        // Errors are already logged inside syncProducts.
      }
    });

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
      const activeRun = await getActiveProductsSyncRun();
      return NextResponse.json(
        {
          already_running: true,
          run_id: activeRun?.runId ?? null,
          status: activeRun ? formatRunStatus(activeRun) : null,
        },
        { status: 409 }
      );
    }

    if (error instanceof Error && error.message === 'SYNC_ROUTE_TIMEOUT') {
      const activeRun = await getActiveProductsSyncRun();
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

    console.error('products sync trigger error', error);
    return NextResponse.json({ error: 'No se pudo iniciar la sincronización' }, { status: 500 });
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
