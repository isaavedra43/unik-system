import { NextResponse } from 'next/server';
import { getAreaDashboard, getAreaLiveTiles } from '@/modules/areas/dashboard-service';
import { areaErrorResponse, resolveAreaRoute } from '../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Panel of an area (plan 7.3): what the area registered, or the default
 * dashboard of the core (work, requests and incidents) while it has none.
 *
 * - `GET` answers the cached panel (`DashboardSnapshot`), recomputing and
 *   storing it when the snapshot is missing or older than the refresh cadence,
 *   always with the live tiles recomputed for this request.
 * - `GET ?live=1` answers ONLY the live tiles: that is what the panel polls
 *   once a minute, and it costs three indexed counts instead of a whole panel.
 * - `POST` recomputes the panel now and stores its snapshot ("Actualizar").
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  const now = new Date();
  const liveOnly = new URL(request.url).searchParams.get('live') === '1';
  try {
    if (liveOnly) {
      const tiles = await getAreaLiveTiles(context.user, context.area, { now });
      return NextResponse.json({ tiles, liveAt: now.toISOString() });
    }
    const view = await getAreaDashboard(context.user, context.area, { now });
    return NextResponse.json({ dashboard: view.payload, note: view.note, liveAt: view.liveAt });
  } catch (error) {
    return areaErrorResponse(error);
  }
}

/** Recomputes the panel of the area and refreshes its snapshot. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string }> }
) {
  const { areaKey } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    const view = await getAreaDashboard(context.user, context.area, {
      now: new Date(),
      refresh: true,
    });
    return NextResponse.json({ dashboard: view.payload, note: view.note, liveAt: view.liveAt });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
