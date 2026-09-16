import { NextResponse } from 'next/server';
import { getTripDetail } from '@/modules/areas/logistica/queries';
import { areaErrorResponse, resolveAreaRoute } from '../../../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One trip with its stops, the deliveries it carries and their evidence. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; tripId: string }> }
) {
  const { areaKey, tripId } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  if (context.area.key !== 'logistica') {
    return NextResponse.json({ error: 'Esta ruta es del área de Logística' }, { status: 404 });
  }
  try {
    const detail = await getTripDetail(context.user, decodeURIComponent(tripId));
    if (!detail) return NextResponse.json({ error: 'No encontramos el viaje' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (error) {
    return areaErrorResponse(error);
  }
}
