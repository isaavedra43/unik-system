import { NextResponse } from 'next/server';
import { hasAnyPermission } from '@/modules/auth/authorization';
import { getItemStockForCapture } from '@/modules/areas/inventario/inventory-area-queries';
import { areaErrorResponse, resolveAreaRoute } from '../../../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stock of ONE article for the capture panel of a movement (plan §3.3): its
 * rows with warehouse, location, variant and container, the warehouses it can
 * be moved to, and what THIS person may do with it.
 *
 * The flags are a courtesy for the panel; the commands check the same keys
 * again inside their transaction (`inventory.manage`, `inventory.adjust`,
 * `inventory.reserve`), so hiding a button never grants anything.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; zohoItemId: string }> }
) {
  const { areaKey, zohoItemId } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  if (context.area.key !== 'inventario') {
    return NextResponse.json({ error: 'Esta consulta es de Inventario' }, { status: 404 });
  }

  try {
    const stock = await getItemStockForCapture(context.user, decodeURIComponent(zohoItemId));
    return NextResponse.json({
      stock,
      can: {
        move: hasAnyPermission(context.user, ['inventory.manage']),
        adjust: hasAnyPermission(context.user, ['inventory.adjust']),
        claim: hasAnyPermission(context.user, ['inventory.reserve']),
      },
    });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
