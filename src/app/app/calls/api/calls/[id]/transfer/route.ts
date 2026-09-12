import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { readJson, requireCallsSession, voiceErrorResponse } from '../../../_shared';
import { transferToHuman } from '@/modules/voice/voice-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ userId: z.string().min(1) });

/** POST /app/calls/api/calls/[id]/transfer { userId } — hands the call to a human agent. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCallsSession();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  try {
    return NextResponse.json({ call: await transferToHuman(auth.user, id, parsed.data.userId) });
  } catch (err) {
    return voiceErrorResponse(err);
  }
}
