import { NextRequest, NextResponse } from 'next/server';
import { requireRequestsUser, commsErrorResponse, readJson } from '../../../inbox/api/_shared';
import { getRequest, updateRequest, updateRequestSchema } from '@/modules/comms/requests-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRequestsUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ request: await getRequest(auth.user, id) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRequestsUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const patch = updateRequestSchema.parse(await readJson(request));
    return NextResponse.json({ request: await updateRequest(auth.user, id, patch) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
