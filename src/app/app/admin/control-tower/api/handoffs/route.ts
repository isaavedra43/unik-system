import { NextResponse } from 'next/server';
import { listHandoffs } from '@/modules/control-tower/projections-service';
import { controlTowerErrorResponse, dateParam, resolveControlTowerRoute } from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = ['request', 'workitem', 'all'] as const;

/**
 * Matriz de traspasos área × área (plan 7.8b): cuántas veces un área le pasó
 * trabajo a otra, cuánto tardó la respuesta (p50/p90) y cuántas se vencieron sin
 * contestar. `?kind=request|workitem` separa las solicitudes entre áreas de las
 * reasignaciones de trabajo.
 */
export async function GET(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const params = new URL(request.url).searchParams;
  const rawKind = params.get('kind');
  const kind = (KINDS as readonly string[]).includes(rawKind ?? '')
    ? (rawKind as (typeof KINDS)[number])
    : 'all';
  try {
    const view = await listHandoffs(
      context.user,
      { kind, from: dateParam(params, 'from'), to: dateParam(params, 'to') },
      { now: new Date() }
    );
    return NextResponse.json(view);
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
