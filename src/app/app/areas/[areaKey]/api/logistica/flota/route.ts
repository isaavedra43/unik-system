import { NextResponse } from 'next/server';
import { getFleetOverview } from '@/modules/areas/logistica/queries';
import { parseBoardDate } from '@/modules/areas/logistica/logistics-view-model';
import { areaErrorResponse, resolveAreaRoute } from '../../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Vehicles and drivers with their availability for a day (`?fecha=YYYY-MM-DD`). */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  if (context.area.key !== 'logistica') {
    return NextResponse.json({ error: 'Esta ruta es del área de Logística' }, { status: 404 });
  }
  const now = new Date();
  const date = parseBoardDate(new URL(request.url).searchParams.get('fecha'), now);
  try {
    return NextResponse.json(await getFleetOverview(context.user, { date, now }));
  } catch (error) {
    return areaErrorResponse(error);
  }
}
