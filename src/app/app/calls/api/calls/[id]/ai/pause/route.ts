import { NextResponse } from 'next/server';
import { requireCallsSession, voiceErrorResponse } from '../../../../_shared';
import { pauseAi } from '@/modules/voice/voice-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /app/calls/api/calls/[id]/ai/pause — "Pausar IA" (stops listening, transcription, analysis, voice). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCallsSession();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ call: await pauseAi(auth.user, id) });
  } catch (err) {
    return voiceErrorResponse(err);
  }
}
