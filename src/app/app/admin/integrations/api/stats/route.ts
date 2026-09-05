import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getApiCallStats } from '@/modules/integrations/integration-api-call-logger';
import { getLatestSyncRun, getActiveSyncRun } from '@/modules/integrations/zoho/sales-orders-sync';

export const runtime = 'nodejs';

/**
 * GET /app/admin/integrations/api/stats?source=zoho
 * Returns aggregated API call stats plus current sync status.
 */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  if (
    !session.user.isSuperAdmin &&
    !session.user.permissionKeys.includes('integrations.view')
  ) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const source = searchParams.get('source') ?? 'zoho';

  try {
    const [stats, activeRun, latestRun] = await Promise.all([
      getApiCallStats(source),
      getActiveSyncRun(),
      getLatestSyncRun(),
    ]);

    return NextResponse.json({
      stats,
      active_run: activeRun
        ? {
            runId: activeRun.runId,
            mode: activeRun.mode,
            status: activeRun.status,
            startedAt: activeRun.startedAt.toISOString(),
          }
        : null,
      latest_run: latestRun
        ? {
            runId: latestRun.runId,
            mode: latestRun.mode,
            status: latestRun.status,
            startedAt: latestRun.startedAt.toISOString(),
            completedAt: latestRun.completedAt?.toISOString() ?? null,
            pagesScanned: latestRun.pagesScanned,
            recordsSeen: latestRun.recordsSeen,
            recordsPending: latestRun.recordsPending,
            detailsFetched: latestRun.detailsFetched,
            detailsFailed: latestRun.detailsFailed,
            apiCalls: latestRun.apiCalls,
            errorCode: latestRun.errorCode,
          }
        : null,
    });
  } catch (error) {
    console.error('integration stats GET error', error);
    return NextResponse.json({ error: 'Error al obtener estadísticas' }, { status: 500 });
  }
}
