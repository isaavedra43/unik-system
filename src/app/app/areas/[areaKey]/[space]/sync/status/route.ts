import { NextResponse } from 'next/server';
import { resolveAreaRoute } from '../../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sync status of an area table. Area rows come straight from PostgreSQL, so
 * there is never a run in flight: the shared workspace stops polling and shows
 * no stale "last sync" label.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  return NextResponse.json({ active_run: null, latest_run: null });
}
