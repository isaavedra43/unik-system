import { NextResponse } from 'next/server';
import { AuthorizationError, getCurrentSession } from '@/modules/auth/authorization';
import { lookupScan, normalizeScanCode } from '@/modules/operations/scan-resolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WAREHOUSE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `GET /app/operations/api/scan?code=...` — what a scanned QR, container
 * label, location code or SKU is (plan 7.10). Read-only: it resolves the code
 * with the inventory module, which checks `inventory.view | inventory.count |
 * inventory.manage` before reading anything, and answers the small shape the
 * mobile bar renders.
 */
export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const code = normalizeScanCode(params.get('code'));
  if (!code) {
    return NextResponse.json(
      { error: 'Escanea una etiqueta o escribe el código' },
      { status: 400 }
    );
  }
  const warehouseParam = params.get('warehouseId');
  const warehouseId = warehouseParam && WAREHOUSE_ID.test(warehouseParam) ? warehouseParam : null;

  try {
    const result = await lookupScan(session.user, code, { warehouseId });
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json(
        { error: 'No tienes permiso para consultar el inventario' },
        { status: 403 }
      );
    }
    console.error(
      JSON.stringify({
        component: 'operations-scan-api',
        event: 'lookup_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return NextResponse.json({ error: 'No pudimos leer el código' }, { status: 500 });
  }
}
