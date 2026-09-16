import { NextResponse } from 'next/server';
import { getAreaDashboard, getAreaLiveTiles } from '@/modules/areas/dashboard-service';
import { enqueueAreaDashboardRefresh } from '@/modules/areas/areas-jobs';
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
 * - `POST` enqueues one deduplicated snapshot refresh ("Actualizar").
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

/** Queues one deduplicated refresh instead of recalculating inside the request. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string }> }
) {
  const { areaKey } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    const queued = await enqueueAreaDashboardRefresh({
      areaKey: context.area.key,
      requestedByUserId: context.user.id,
    });
    return NextResponse.json(
      { accepted: true, jobId: queued.id, deduplicated: queued.deduplicated },
      { status: 202 }
    );
  } catch (error) {
    return areaErrorResponse(error);
  }
}
