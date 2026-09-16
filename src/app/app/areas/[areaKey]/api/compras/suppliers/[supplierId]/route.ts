import { NextResponse } from 'next/server';
import { getSupplier } from '@/modules/purchases/purchases-queries';
import { areaErrorResponse } from '../../../../_area-http';
import { resolveComprasRoute } from '../../_compras-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One supplier with what Compras judges it by: the products it quotes, its
 * recent orders and its evaluations (the rating comes from `supplier-rating.ts`).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; supplierId: string }> }
) {
  const { areaKey, supplierId } = await params;
  const context = await resolveComprasRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    const supplier = await getSupplier(context.user, decodeURIComponent(supplierId));
    return NextResponse.json({ supplier });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
