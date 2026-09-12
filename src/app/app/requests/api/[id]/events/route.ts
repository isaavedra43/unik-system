import { NextRequest, NextResponse } from 'next/server';
import { requireRequestsUser, commsErrorResponse, readJson } from '../../../../inbox/api/_shared';
import { addRequestEvent, requestEventSchema } from '@/modules/comms/requests-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRequestsUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const input = requestEventSchema.parse(await readJson(request));
    return NextResponse.json(
      { event: await addRequestEvent(auth.user, id, input) },
      { status: 201 }
    );
  } catch (err) {
    return commsErrorResponse(err);
  }
}
