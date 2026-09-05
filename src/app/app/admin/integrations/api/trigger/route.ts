import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  syncSalesOrders,
  SyncAlreadyRunningError,
  SyncFailedError,
} from '@/modules/integrations/zoho/sales-orders-sync';

export const runtime = 'nodejs';

/**
 * POST /app/admin/integrations/api/trigger
 * Body: { mode?: 'quick' | 'scan' | 'sync', maxDetailFetches?: number }
 * Triggers a sync run synchronously (bounded by the sync's own timeout).
 * Requires integrations.manage.
 */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  if (
    !session.user.isSuperAdmin &&
    !session.user.permissionKeys.includes('integrations.manage')
  ) {
    return NextResponse.json({ error: 'Sin permiso para ejecutar sync' }, { status: 403 });
  }

  let body: { mode?: 'quick' | 'scan' | 'sync'; maxDetailFetches?: number } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine — defaults apply.
  }

  const mode = body.mode ?? 'quick';
  const maxDetailFetches = body.maxDetailFetches ?? 20;

  try {
    const result = await syncSalesOrders({ mode, maxDetailFetches });
    return NextResponse.json({
      ok: true,
      result: {
        runId: result.runId,
        mode: result.mode,
        pagesScanned: result.pagesScanned,
        recordsSeen: result.recordsSeen,
        recordsPending: result.recordsPending,
        detailsFetched: result.detailsFetched,
        detailsFailed: result.detailsFailed,
        apiCalls: result.apiCalls,
      },
    });
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      return NextResponse.json(
        { error: 'Ya hay una sincronización en curso', code: 'ALREADY_RUNNING' },
        { status: 409 }
      );
    }
    if (error instanceof SyncFailedError) {
      return NextResponse.json(
        { error: 'Sync falló', code: error.errorCode, runId: error.runId },
        { status: 502 }
      );
    }
    console.error('integration trigger error', error);
    return NextResponse.json({ error: 'Error inesperado' }, { status: 500 });
  }
}
