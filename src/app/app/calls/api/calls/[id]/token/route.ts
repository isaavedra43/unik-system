import { NextResponse } from 'next/server';
import { requireCallsSession, voiceErrorResponse } from '../../../_shared';
import { issueParticipantToken } from '@/modules/voice/voice-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /app/calls/api/calls/[id]/token — room token for a participant (calls.use). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCallsSession(['calls.use']);
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const token = await issueParticipantToken(auth.user, id);
    return NextResponse.json({ token });
  } catch (err) {
    return voiceErrorResponse(err);
  }
}
