import { NextResponse } from 'next/server';
import { hasAnyPermission } from '@/modules/auth/authorization';
import { getLegacyClaimDetail } from '@/modules/areas/inventario/inventory-area-queries';
import { areaErrorResponse, resolveAreaRoute } from '../../../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One legacy claim with the demands it can be tied to (plan §3.3 "corte").
 * The panel needs the list because confirming a claim picks ONE demand of one
 * case — something the generic row dialog (a note, a reason) cannot collect.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; claimId: string }> }
) {
  const { areaKey, claimId } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  if (context.area.key !== 'inventario') {
    return NextResponse.json({ error: 'Esta consulta es de Inventario' }, { status: 404 });
  }

  try {
    const detail = await getLegacyClaimDetail(context.user, decodeURIComponent(claimId));
    return NextResponse.json({
      ...detail,
      can: { manage: hasAnyPermission(context.user, ['inventory.reserve']) },
    });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
