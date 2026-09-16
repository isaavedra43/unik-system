import { NextResponse } from 'next/server';
import { getWarehouseMap } from '@/modules/areas/inventario/inventory-area-queries';
import { areaErrorResponse, resolveAreaRoute } from '../../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Map of a warehouse (plan 7.6): its locations coloured by confidence and the
 * counts still open. The area guard checks the person may open Inventario and
 * the query checks `inventory.view` again before reading anything.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  if (context.area.key !== 'inventario') {
    return NextResponse.json({ error: 'Esta consulta es de Inventario' }, { status: 404 });
  }

  const requested = new URL(request.url).searchParams.get('warehouseId');
  const warehouseId = requested && ID.test(requested) ? requested : null;

  try {
    return NextResponse.json(await getWarehouseMap(context.user, { warehouseId }));
  } catch (error) {
    return areaErrorResponse(error);
  }
}
