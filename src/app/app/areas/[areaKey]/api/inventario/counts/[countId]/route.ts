import { NextResponse } from 'next/server';
import { hasAnyPermission } from '@/modules/auth/authorization';
import { getCountForCapture } from '@/modules/areas/inventario/inventory-area-queries';
import { areaErrorResponse, resolveAreaRoute } from '../../../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Count with its captured lines, for the capture screen (`?count=<id>`) and for
 * the panel that decides its differences.
 *
 * `can.decide` says whether THIS person may authorise an adjustment or settle a
 * dispute (`inventory.adjust`); the commands check the same key again.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; countId: string }> }
) {
  const { areaKey, countId } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  if (context.area.key !== 'inventario') {
    return NextResponse.json({ error: 'Esta consulta es de Inventario' }, { status: 404 });
  }

  try {
    const detail = await getCountForCapture(context.user, decodeURIComponent(countId));
    return NextResponse.json({
      ...detail,
      can: { decide: hasAnyPermission(context.user, ['inventory.adjust']) },
    });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
