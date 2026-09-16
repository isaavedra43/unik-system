import { NextResponse } from 'next/server';
import { getSourcingCandidate } from '@/modules/purchases/purchases-queries';
import { areaErrorResponse } from '../../../../../_area-http';
import { resolveComprasRoute } from '../../../_compras-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One candidate of the Sourcing Lab with everything a person needs before
 * contacting it: its evidence, whether UNIK already knows it as a Zoho vendor
 * and the quotation requests it has received.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; candidateId: string }> }
) {
  const { areaKey, candidateId } = await params;
  const context = await resolveComprasRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    const candidate = await getSourcingCandidate(context.user, decodeURIComponent(candidateId));
    return NextResponse.json({ candidate });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
