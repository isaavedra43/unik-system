import { NextResponse } from 'next/server';
import { requireCallsSession, voiceErrorResponse } from '../../../_shared';
import { getTranscript } from '@/modules/voice/voice-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/calls/api/calls/[id]/transcript — segments + summary (scoped). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCallsSession();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json(await getTranscript(auth.user, id));
  } catch (err) {
    return voiceErrorResponse(err);
  }
}
