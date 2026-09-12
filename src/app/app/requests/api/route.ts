import { NextRequest, NextResponse } from 'next/server';
import { requireRequestsUser, commsErrorResponse, readJson } from '../../inbox/api/_shared';
import { createRequest, createRequestSchema, listRequests } from '@/modules/comms/requests-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/requests/api?scope=mine|assigned|all&status&type&page */
export async function GET(request: NextRequest) {
  const auth = await requireRequestsUser();
  if ('response' in auth) return auth.response;
  try {
    const q = request.nextUrl.searchParams;
    const scope = q.get('scope');
    return NextResponse.json(
      await listRequests(auth.user, {
        scope: scope === 'mine' || scope === 'assigned' || scope === 'all' ? scope : undefined,
        status: q.get('status') ?? undefined,
        type: q.get('type') ?? undefined,
        page: q.get('page') ? Number(q.get('page')) : undefined,
        pageSize: q.get('pageSize') ? Number(q.get('pageSize')) : undefined,
      })
    );
  } catch (err) {
    return commsErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireRequestsUser();
  if ('response' in auth) return auth.response;
  try {
    const input = createRequestSchema.parse(await readJson(request));
    return NextResponse.json({ request: await createRequest(auth.user, input) }, { status: 201 });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
