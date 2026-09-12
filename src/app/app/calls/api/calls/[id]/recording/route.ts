import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { readJson, requireCallsSession, voiceErrorResponse } from '../../../_shared';
import { setRecording } from '@/modules/voice/voice-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ on: z.boolean() });

/** POST /app/calls/api/calls/[id]/recording { on } — independent, visible recording control. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCallsSession();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  try {
    return NextResponse.json({ call: await setRecording(auth.user, id, parsed.data.on) });
  } catch (err) {
    return voiceErrorResponse(err);
  }
}
