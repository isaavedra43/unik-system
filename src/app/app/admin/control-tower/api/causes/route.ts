import { NextResponse } from 'next/server';
import { CAUSE_TYPE_LABELS, listCauses } from '@/modules/control-tower/projections-service';
import {
  controlTowerErrorResponse,
  dateParam,
  intParam,
  resolveControlTowerRoute,
} from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Causas de bloqueo (plan 7.8b `CauseTable`): qué proveedor, producto, ruta,
 * cliente o motivo de espera acumula más minutos detenidos en el rango. Lee la
 * proyección `CtBlockCauseDaily`.
 */
export async function GET(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const params = new URL(request.url).searchParams;
  const rawType = params.get('causeType');
  const causeType = rawType && rawType in CAUSE_TYPE_LABELS ? rawType : null;
  try {
    const view = await listCauses(
      context.user,
      {
        causeType,
        from: dateParam(params, 'from'),
        to: dateParam(params, 'to'),
        limit: intParam(params, 'limit', { min: 1, max: 200 }),
      },
      { now: new Date() }
    );
    return NextResponse.json({ ...view, causeTypes: CAUSE_TYPE_LABELS });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
