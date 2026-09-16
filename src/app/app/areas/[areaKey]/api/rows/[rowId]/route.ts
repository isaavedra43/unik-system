import { NextResponse } from 'next/server';
import { getWorkRowDetail } from '@/modules/areas/work-rows-service';
import { areaErrorResponse, resolveAreaRoute } from '../../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Detail of one work row (`<rowKind>:<sourceId>`): facts, case summary and
 * timeline when the case rule allows it, evidence and where new evidence goes.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; rowId: string }> }
) {
  const { areaKey, rowId } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    const detail = await getWorkRowDetail(context.user, context.area, decodeURIComponent(rowId));
    if (!detail) {
      return NextResponse.json({ error: 'No encontramos esta fila' }, { status: 404 });
    }
    return NextResponse.json({ detail });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
