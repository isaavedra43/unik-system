import { NextResponse } from 'next/server';
import { parseAreaWorkQuery } from '@/modules/areas/work-filters';
import { listAreaWorkRows } from '@/modules/areas/work-rows-service';
import { areaErrorResponse, readJson, resolveAreaRoute } from '../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Work rows of an area (plan 7.2 API). `GET` takes the filters as search
 * params (`?scope=open&kind=work_item&search=...`) and `POST` takes the same
 * query state as a JSON body. Both answer `{data, pagination}`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  const search = new URL(request.url).searchParams;

  const parseJson = (value: string | null): unknown => {
    if (!value) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };

  try {
    const query = parseAreaWorkQuery(
      {
        search: search.get('search') ?? '',
        filters: parseJson(search.get('filters')) ?? { logic: 'AND', rules: [] },
        sort: parseJson(search.get('sort')) ?? [{ field: 'dueAt', direction: 'asc' }],
        page: search.get('page') ?? 1,
        page_size: search.get('page_size') ?? 50,
        kind: search.getAll('kind').filter((value) => value.length > 0),
        scope: search.get('scope') ?? 'open',
        caseId: search.get('caseId') ?? undefined,
        ownerUserId: search.get('ownerUserId') ?? undefined,
        overdueOnly: search.get('overdueOnly') === '1',
      },
      context.area
    );
    return NextResponse.json(await listAreaWorkRows(context.user, context.area, query));
  } catch (error) {
    return areaErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  try {
    const query = parseAreaWorkQuery(body.value ?? {}, context.area);
    return NextResponse.json(await listAreaWorkRows(context.user, context.area, query));
  } catch (error) {
    return areaErrorResponse(error);
  }
}
