import { NextResponse } from 'next/server';
import { getLocationDetail } from '@/modules/areas/inventario/inventory-area-queries';
import { areaErrorResponse, resolveAreaRoute } from '../../../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What one location holds right now, for the drawer of the map. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; locationId: string }> }
) {
  const { areaKey, locationId } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  if (context.area.key !== 'inventario') {
    return NextResponse.json({ error: 'Esta consulta es de Inventario' }, { status: 404 });
  }

  try {
    return NextResponse.json(await getLocationDetail(context.user, decodeURIComponent(locationId)));
  } catch (error) {
    return areaErrorResponse(error);
  }
}
