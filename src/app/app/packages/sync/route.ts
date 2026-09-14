import { NextResponse, after } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  syncPackages,
  getActivePackagesSyncRun,
  SyncRunStatus,
  SyncFailedError,
  SyncAlreadyRunningError,
} from '@/modules/integrations/zoho/packages-sync';
import { sweepPackageShipments } from '@/modules/integrations/zoho/packages-shipment-sweep';

export const runtime = 'nodejs';

/** Max time the HTTP request stays open; the sync itself continues in `after()`. */
const SYNC_ROUTE_TIMEOUT_MS = 25_000;
/** Package details re-read per manual refresh (unshipped or carrier-less first). */
const SWEEP_LIMIT = 40;

const ERROR_MESSAGES: Record<string, string> = {
  ZOHO_API_ERROR: 'Zoho rechazó la consulta de paquetes. Revisa la conexión en Integraciones.',
  INVALID_LIST_RESPONSE: 'Zoho devolvió una respuesta inesperada al listar paquetes.',
  PAGE_LIMIT_EXCEEDED: 'Se alcanzó el límite de páginas configurado para la sincronización.',
  RATE_LIMIT_EXCEEDED:
    'Zoho limitó las llamadas por minuto. Espera un momento e inténtalo de nuevo.',
  DAILY_LIMIT_EXCEEDED: 'Se agotó la cuota diaria de llamadas a Zoho.',
  UNEXPECTED_ERROR: 'La sincronización falló por un error inesperado. Revisa Deploy Logs.',
};

/**
 * User-facing "Actualizar": incremental sync of the most recently modified
 * packages (sorted LIST pages + detail download), same strategy as sales
 * orders. A full scan of every page runs from the scheduler, never from here.
 */
export async function POST() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('packages.view'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  try {
    const activeRun = await getActivePackagesSyncRun();
    if (activeRun)
      return NextResponse.json(
        { already_running: true, run_id: activeRun.runId, status: formatRunStatus(activeRun) },
        { status: 409 }
      );

    const syncPromise = syncPackages({ mode: 'quick', maxDetailFetches: 30 });
    // Carrier / shipment refresh for packages Zoho did not report as modified.
    // Runs alongside the sync (shared rate budget) so it never waits for it.
    const sweepPromise = sweepPackageShipments({ limit: SWEEP_LIMIT }).catch(() => undefined);

    after(async () => {
      try {
        await syncPromise;
      } catch {
        // Errors are already logged inside syncPackages.
      }
      await sweepPromise;
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
      const activeRun = await getActivePackagesSyncRun();
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
      const activeRun = await getActivePackagesSyncRun();
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
        {
          error: ERROR_MESSAGES[error.errorCode] ?? ERROR_MESSAGES.UNEXPECTED_ERROR,
          error_code: error.errorCode,
          run_id: error.runId,
        },
        { status: 500 }
      );
    }

    console.error('packages sync trigger error', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message.startsWith('Invalid or missing Zoho')
            ? 'Faltan credenciales de Zoho en el servidor.'
            : 'No se pudo iniciar la sincronización.',
        error_code: 'UNEXPECTED_ERROR',
      },
      { status: 500 }
    );
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
