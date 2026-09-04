import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  SyncAlreadyRunningError,
  syncSalesOrders,
} from '@/modules/integrations/zoho/sales-orders-sync';

export const runtime = 'nodejs';

/**
 * Triggers an on-demand Sales Orders sync from Zoho.
 *
 * Reuses the existing `syncSalesOrders` from `@/modules/integrations/zoho`.
 * The endpoint is permission-aware (must hold `sales_orders.view`), so any
 * viewer of the page can refresh the data without exposing the internal API
 * key used by `/api/internal/zoho/sync/sales-orders`.
 *
 * Returns the timestamp returned by Zoho's `last_modified_time` paginator
 * (`lastSyncCursor`) when the run finishes, which the UI uses as the
 * "Última sincronización exitosa" indicator.
 */
export async function POST() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (
    !session.user.isSuperAdmin &&
    !session.user.permissionKeys.includes('sales_orders.view')
  ) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  try {
    const result = await syncSalesOrders();
    return NextResponse.json({
      runId: result.runId,
      mode: result.mode,
      pagesScanned: result.pagesScanned,
      recordsSeen: result.recordsSeen,
      recordsPending: result.recordsPending,
      detailsFetched: result.detailsFetched,
      detailsFailed: result.detailsFailed,
      apiCalls: result.apiCalls,
    });
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      return NextResponse.json(
        { error: 'Ya hay una sincronización en curso' },
        { status: 409 }
      );
    }
    console.error('sales orders sync error', error);
    return NextResponse.json(
      { error: 'No se pudo sincronizar con Zoho' },
      { status: 500 }
    );
  }
}
