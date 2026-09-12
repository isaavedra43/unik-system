import { NextResponse } from 'next/server';
import { requireCallsSession, voiceErrorResponse } from '../../../../_shared';
import { endSupervision } from '@/modules/voice/voice-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /app/calls/api/calls/[id]/supervise/end — leaves the supervision session. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCallsSession(['calls.supervise']);
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ call: await endSupervision(auth.user, id) });
  } catch (err) {
    return voiceErrorResponse(err);
  }
}
