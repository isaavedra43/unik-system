import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getArea } from '@/modules/areas/area-registry';
import { getDriverToday } from '@/modules/logistics/driver-service';
import { LOGISTICS_AREA_KEY, parseBoardDate } from '@/modules/areas/logistica/logistics-view-model';
import { areaErrorResponse } from '../../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read model of the driver PWA (plan 6.3): the trips of the day of the driver
 * linked to the signed-in user, with stops, lines still owed, contact,
 * coordinates, evidence and the upload targets.
 *
 * Access is the module rule, not the area one: `logistics.drive` sees only its
 * own driver and `logistics.dispatch` may look at another one (`?chofer=<id>`),
 * both enforced inside `getDriverToday`. A driver therefore reads their day even
 * without the area's view permission.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  if (getArea(areaKey)?.key !== LOGISTICS_AREA_KEY) {
    return NextResponse.json({ error: 'Esta ruta es del área de Logística' }, { status: 404 });
  }
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const search = new URL(request.url).searchParams;
  const now = new Date();
  const date = parseBoardDate(search.get('fecha'), now);
  const driverId = search.get('chofer')?.trim();

  try {
    return NextResponse.json(
      await getDriverToday(session.user, {
        now,
        date,
        ...(driverId ? { driverId } : {}),
      })
    );
  } catch (error) {
    return areaErrorResponse(error);
  }
}
