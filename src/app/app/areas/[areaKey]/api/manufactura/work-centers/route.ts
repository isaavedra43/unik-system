import { NextResponse } from 'next/server';
import { listWorkCenters } from '@/modules/manufacturing/manufacturing-queries';
import { manufacturaErrorResponse, resolveManufacturaRoute } from '../_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Work centres of the plant, for the "Mover a…" dialog of the board and the
 * pickers of the order forms. `?status=inactive` also lists the retired ones
 * (the manager page uses it); by default only the active ones answer.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveManufacturaRoute(areaKey);
  if (!context.ok) return context.response;

  const status = new URL(request.url).searchParams.get('status');

  try {
    const centers = await listWorkCenters(
      context.user,
      status === 'inactive' || status === 'active' ? { status } : {}
    );
    return NextResponse.json({
      data: centers.map((center) => ({
        id: center.id,
        key: center.key,
        name: center.name,
        status: center.status,
        statusLabel: center.statusLabel,
        capacityUnit: center.capacityUnit,
        capacityUnitLabel: center.capacityUnitLabel,
        capacityPerShift: center.capacityPerShift,
        warehouseId: center.warehouseId,
        warehouseName: center.warehouseName,
        shifts: center.shifts,
      })),
    });
  } catch (error) {
    return manufacturaErrorResponse(error);
  }
}
