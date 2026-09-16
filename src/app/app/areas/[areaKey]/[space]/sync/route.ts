import { NextResponse } from 'next/server';
import { findAreaSpace, rowKindsForSpace } from '@/modules/areas/area-registry';
import { parseAreaWorkQuery } from '@/modules/areas/work-filters';
import { listAreaWorkRows } from '@/modules/areas/work-rows-service';
import { areaErrorResponse, resolveAreaRoute } from '../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Actualizar" of the work centre. Area rows are not synchronized from an
 * external system: they are read live from PostgreSQL, so this endpoint simply
 * recounts the open work and lets the table refetch. It answers with the same
 * shape the shared workspace expects.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; space: string }> }
) {
  const { areaKey, space } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  const areaSpace = findAreaSpace(context.area, space);
  if (!areaSpace || (areaSpace.kind !== 'work' && areaSpace.kind !== 'subpage')) {
    return NextResponse.json({ error: 'Este espacio no tiene tabla' }, { status: 404 });
  }

  try {
    const query = parseAreaWorkQuery(
      {
        scope: 'open',
        page: 1,
        page_size: 1,
        kind: [...rowKindsForSpace(context.area, areaSpace)],
      },
      context.area
    );
    const result = await listAreaWorkRows(context.user, context.area, query);
    return NextResponse.json({
      already_running: false,
      result: { details_fetched: result.pagination.total },
    });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
