import { NextResponse } from 'next/server';
import { getRfq } from '@/modules/purchases/purchases-queries';
import { areaErrorResponse } from '../../../../_area-http';
import { resolveComprasRoute } from '../../_compras-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One RFQ with its invitations, the interpreted responses and the comparison
 * with scores (`rfq-scoring.ts`), which is what the review panel needs to show
 * why one supplier ranks over another.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; rfqId: string }> }
) {
  const { areaKey, rfqId } = await params;
  const context = await resolveComprasRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    const rfq = await getRfq(context.user, decodeURIComponent(rfqId), new Date());
    return NextResponse.json({ rfq });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
