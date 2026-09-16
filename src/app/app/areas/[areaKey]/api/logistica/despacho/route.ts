import { NextResponse } from 'next/server';
import { getDispatchBoard } from '@/modules/areas/logistica/queries';
import { parseBoardDate } from '@/modules/areas/logistica/logistics-view-model';
import { areaErrorResponse, resolveAreaRoute } from '../../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dispatch board of a day (plan 7.6): the deliveries of that day, the trips of
 * each unit, the fleet with its availability and the counters.
 *
 * `?fecha=YYYY-MM-DD`; anything else falls back to today in the operation's
 * time zone. The area gate already ran; the service checks the logistics
 * permissions again.
 */
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
    return NextResponse.json(await getDispatchBoard(context.user, { date, now }));
  } catch (error) {
    return areaErrorResponse(error);
  }
}
