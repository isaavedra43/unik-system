import { NextResponse } from 'next/server';
import { getProcurementOrder } from '@/modules/purchases/purchases-queries';
import { areaErrorResponse } from '../../../../_area-http';
import { resolveComprasRoute } from '../../_compras-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One procurement order with everything its management page shows: lines with
 * their allocations to sales cases, receipts, the business approval, the
 * payable and the open differences.
 *
 * Read only: every change travels as a command to
 * `POST /app/operations/api/commands`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; orderId: string }> }
) {
  const { areaKey, orderId } = await params;
  const context = await resolveComprasRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    const order = await getProcurementOrder(context.user, decodeURIComponent(orderId));
    return NextResponse.json({ order });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
