import { NextResponse } from 'next/server';
import {
  EXCEPTION_KINDS,
  EXCEPTION_KIND_LABELS,
  listControlTowerExceptions,
  type ExceptionQueryInput,
} from '@/modules/control-tower/exceptions-service';
import {
  controlTowerErrorResponse,
  intParam,
  listParam,
  readJsonBody,
  resolveControlTowerRoute,
} from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Excepciones de la operación (plan 7.7 `excepciones`): trabajo escalado o
 * vencido, incidencias abiertas, solicitudes expiradas, entregas en conflicto y
 * expedientes atorados, en una sola lista ordenable.
 *
 * `GET` con parámetros de consulta (enlaces compartibles) y `POST` con el
 * cuerpo que manda `EntityWorkspace`. Ambos terminan en el MISMO servicio, que
 * valida con Zod: un tipo o un orden desconocido responde 422, no se ignora.
 */
function queryFromSearchParams(params: URLSearchParams): ExceptionQueryInput {
  return {
    kind: listParam(params, 'kind', EXCEPTION_KINDS.length) as ExceptionQueryInput['kind'],
    areaKey: listParam(params, 'areaKey', 10),
    severity: listParam(params, 'severity', 4) as ExceptionQueryInput['severity'],
    search: params.get('search') ?? '',
    page: intParam(params, 'page', { min: 1, max: 1000 }) ?? 1,
    page_size: intParam(params, 'page_size', { min: 5, max: 200 }) ?? 50,
    ...(params.get('sort') ? { sort: params.get('sort') as ExceptionQueryInput['sort'] } : {}),
    ...(params.get('direction')
      ? { direction: params.get('direction') as ExceptionQueryInput['direction'] }
      : {}),
  };
}

export async function GET(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  try {
    const params = new URL(request.url).searchParams;
    const page = await listControlTowerExceptions(context.user, queryFromSearchParams(params), {
      now: new Date(),
    });
    return NextResponse.json({
      ...page,
      kinds: EXCEPTION_KINDS.map((kind) => ({ kind, label: EXCEPTION_KIND_LABELS[kind] })),
    });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  try {
    const page = await listControlTowerExceptions(
      context.user,
      (body.value ?? {}) as ExceptionQueryInput,
      { now: new Date() }
    );
    return NextResponse.json({
      ...page,
      kinds: EXCEPTION_KINDS.map((kind) => ({ kind, label: EXCEPTION_KIND_LABELS[kind] })),
    });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
