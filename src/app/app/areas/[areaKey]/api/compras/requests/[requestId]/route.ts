import { NextResponse } from 'next/server';
import { getPurchaseRequest } from '@/modules/purchases/purchases-queries';
import { areaErrorResponse } from '../../../../_area-http';
import { resolveComprasRoute } from '../../_compras-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One purchase request and its orderable lines for the consolidation panel. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; requestId: string }> }
) {
  const { areaKey, requestId } = await params;
  const context = await resolveComprasRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    return NextResponse.json({
      request: await getPurchaseRequest(context.user, decodeURIComponent(requestId)),
    });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
