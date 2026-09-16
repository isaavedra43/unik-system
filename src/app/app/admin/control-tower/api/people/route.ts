import { NextResponse } from 'next/server';
import { listPeopleNow } from '@/modules/control-tower/people-service';
import { controlTowerErrorResponse, intParam, resolveControlTowerRoute } from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Quién está haciendo qué ahora mismo (plan 7.7 `personas`): carga por persona,
 * último evento y presencia. `?areaKey=` acota a un área; `?idle=0` deja fuera a
 * quien no tiene trabajo abierto.
 */
export async function GET(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const params = new URL(request.url).searchParams;
  try {
    const result = await listPeopleNow(context.user, {
      now: new Date(),
      areaKey: params.get('areaKey'),
      includeIdle: params.get('idle') !== '0',
      limit: intParam(params, 'limit', { min: 1, max: 200 }) ?? 100,
    });
    return NextResponse.json(result);
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
