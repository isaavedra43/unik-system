import { NextResponse } from 'next/server';
import { AREA_SPACE_SLUGS, findAreaSpace, rowKindsForSpace } from '@/modules/areas/area-registry';
import { listAreaWorkRows } from '@/modules/areas/work-rows-service';
import { parseAreaWorkQuery } from '@/modules/areas/work-filters';
import { areaErrorResponse, readJson, resolveAreaRoute } from '../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Rows of the space shown by `EntityWorkspace` (it posts its query state to
 * `${basePath}/api`). Only the work centre and the area's own subpages answer;
 * the other spaces are not tables.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ areaKey: string; space: string }> }
) {
  const { areaKey, space } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  const areaSpace = findAreaSpace(context.area, space);
  if (!areaSpace || (areaSpace.kind !== 'work' && areaSpace.kind !== 'subpage')) {
    return NextResponse.json({ error: 'Este espacio no tiene tabla' }, { status: 404 });
  }

  const body = await readJson(request);
  if (!body.ok) return body.response;

  try {
    const raw = (body.value ?? {}) as Record<string, unknown>;
    const declared = rowKindsForSpace(context.area, areaSpace);
    const requested = Array.isArray(raw.kind) ? (raw.kind as string[]) : [];
    // A subpage never widens its scope: its own row kinds bound the query.
    const kind =
      areaSpace.slug === AREA_SPACE_SLUGS.work
        ? requested
        : requested.length > 0
          ? requested.filter((entry) => declared.includes(entry))
          : [...declared];
    const query = parseAreaWorkQuery({ ...raw, kind }, context.area);
    const result = await listAreaWorkRows(context.user, context.area, query);
    return NextResponse.json(result);
  } catch (error) {
    return areaErrorResponse(error);
  }
}
