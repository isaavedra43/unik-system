import { NextResponse } from 'next/server';
import { loadProductionBoard } from '@/modules/areas/manufactura/board-service';
import { intParam, manufacturaErrorResponse, resolveManufacturaRoute } from '../_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Production board (plan 7.6): work centres with the load of their shifts and
 * their orders grouped by lane. `?days=1..14` covers the capacity bars and
 * `?workCenterId=` narrows it to one centre (the phone board and deep links).
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveManufacturaRoute(areaKey);
  if (!context.ok) return context.response;

  const search = new URL(request.url).searchParams;
  const workCenterId = search.get('workCenterId')?.trim();

  try {
    const board = await loadProductionBoard(context.user, {
      days: intParam(search.get('days'), 3, 1, 14),
      ...(workCenterId ? { workCenterId } : {}),
    });
    return NextResponse.json({ board });
  } catch (error) {
    return manufacturaErrorResponse(error);
  }
}
