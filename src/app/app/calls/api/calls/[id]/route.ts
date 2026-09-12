import { NextResponse } from 'next/server';
import { requireCallsSession, voiceErrorResponse } from '../../_shared';
import { getCall } from '@/modules/voice/voice-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/calls/api/calls/[id] — detail (participant, team supervisor or super_admin). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCallsSession();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ call: await getCall(auth.user, id) });
  } catch (err) {
    return voiceErrorResponse(err);
  }
}
