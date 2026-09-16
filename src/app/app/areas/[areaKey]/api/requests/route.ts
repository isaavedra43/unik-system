import { NextResponse } from 'next/server';
import { listAreaRequests } from '@/modules/operations/area-requests-service';
import { areaErrorResponse, resolveAreaRoute } from '../../_area-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Requests of an area: `?direction=in|out`, `?scope=open|closed|all`,
 * `?kind=`, `?overdueOnly=1`. The core service applies the area rule and
 * returns the same DTO the chat cards and the work centre use.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveAreaRoute(areaKey);
  if (!context.ok) return context.response;
  const search = new URL(request.url).searchParams;
  const limitParam = Number.parseInt(search.get('limit') ?? '50', 10);

  try {
    const page = await listAreaRequests(context.user, context.area.key, {
      direction: search.get('direction') === 'out' ? 'out' : 'in',
      scope:
        search.get('scope') === 'closed'
          ? 'closed'
          : search.get('scope') === 'all'
            ? 'all'
            : 'open',
      ...(search.getAll('kind').length > 0 ? { kind: search.getAll('kind') as never } : {}),
      overdueOnly: search.get('overdueOnly') === '1',
      limit: Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50,
      ...(search.get('cursor') ? { cursor: search.get('cursor') as string } : {}),
    });
    return NextResponse.json(page);
  } catch (error) {
    return areaErrorResponse(error);
  }
}
