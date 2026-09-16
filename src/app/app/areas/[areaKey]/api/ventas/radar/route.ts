import { NextResponse } from 'next/server';
import { getRadarBoard } from '@/modules/areas/ventas/ventas-queries';
import { isRadarKind, RADAR_STATUSES, type RadarKind, type RadarStatus } from '@/modules/crm/types';
import { resolveVentasRoute, ventasErrorResponse } from '../_ventas-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Señales del Radar de cierre visibles para la persona (`crm.radar`), con el
 * resumen por tipo y por vendedor. Filtros: `?vendedor=me|unassigned|<id>`,
 * `?tipo=` (repetible), `?estado=`, `?minScore=`, `?limit=`, `?cursor=`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveVentasRoute(areaKey);
  if (!context.ok) return context.response;

  const search = new URL(request.url).searchParams;
  const kinds = search.getAll('tipo').filter((value): value is RadarKind => isRadarKind(value));
  const statusParam = search.get('estado');
  const status = (RADAR_STATUSES as readonly string[]).includes(statusParam ?? '')
    ? (statusParam as RadarStatus)
    : undefined;
  const limitParam = Number.parseInt(search.get('limit') ?? '50', 10);
  const minScoreParam = Number.parseInt(search.get('minScore') ?? '', 10);
  const salesperson = search.get('vendedor')?.trim();

  try {
    const board = await getRadarBoard(context.user, {
      ...(salesperson && salesperson !== 'all' ? { salesperson } : {}),
      ...(kinds.length > 0 ? { kinds } : {}),
      ...(status ? { status } : {}),
      ...(Number.isFinite(minScoreParam)
        ? { minScore: Math.min(Math.max(minScoreParam, 0), 100) }
        : {}),
      ...(search.get('cursor') ? { cursor: search.get('cursor') as string } : {}),
      limit: Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 50,
    });
    return NextResponse.json(board);
  } catch (error) {
    return ventasErrorResponse(error);
  }
}
