import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { readJson, requireCallsSession, voiceErrorResponse } from '../../../_shared';
import { startSupervision } from '@/modules/voice/voice-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ mode: z.enum(['listen', 'whisper', 'barge']) });

/**
 * POST /app/calls/api/calls/[id]/supervise { mode } — calls.supervise only.
 * Without permission (or outside the supervisor's teams) no token is issued.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCallsSession(['calls.supervise']);
  if ('response' in auth) return auth.response;
  const { id } = await params;
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: 'Modo inválido' }, { status: 400 });
  try {
    return NextResponse.json(await startSupervision(auth.user, id, parsed.data.mode));
  } catch (err) {
    return voiceErrorResponse(err);
  }
}
