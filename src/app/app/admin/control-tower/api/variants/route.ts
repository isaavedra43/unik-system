import { NextResponse } from 'next/server';
import { listVariants } from '@/modules/control-tower/projections-service';
import { controlTowerErrorResponse, dateParam, resolveControlTowerRoute } from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Variantes observadas del proceso (plan 7.8b): cada camino distinto que
 * recorrieron los expedientes del rango, con su frecuencia, su duración p50/p90,
 * su conformidad y los expedientes que se desviaron o tuvieron retrabajo.
 *
 * Lee la proyección `CtCaseVariant` (la calcula `ct.projections_refresh`), no la
 * bitácora: por eso responde en frío aunque haya millones de eventos.
 */
export async function GET(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const params = new URL(request.url).searchParams;
  try {
    const view = await listVariants(
      context.user,
      {
        processKey: params.get('processKey'),
        from: dateParam(params, 'from'),
        to: dateParam(params, 'to'),
      },
      { now: new Date() }
    );
    return NextResponse.json(view);
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
