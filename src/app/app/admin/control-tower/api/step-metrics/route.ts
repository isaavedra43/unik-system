import { NextResponse } from 'next/server';
import { listStepMetrics } from '@/modules/control-tower/projections-service';
import { controlTowerErrorResponse, dateParam, resolveControlTowerRoute } from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Métricas por paso del proceso (plan 7.8a/7.8b): iniciados, cerrados,
 * percentiles de minutos activos y de espera, incumplimientos de SLA y
 * retrabajo, más el ranking de cuellos de botella (`p90 de espera × iniciados`,
 * que es el paso que más tiempo total explica, no el que más tarda una vez).
 */
export async function GET(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const params = new URL(request.url).searchParams;
  try {
    const view = await listStepMetrics(
      context.user,
      {
        processKey: params.get('processKey'),
        areaKey: params.get('areaKey'),
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
