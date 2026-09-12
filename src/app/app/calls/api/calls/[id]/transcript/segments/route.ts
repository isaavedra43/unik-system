import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { readJson, requireCallsSession, voiceErrorResponse } from '../../../../_shared';
import { getCall, ingestTranscriptSegment } from '@/modules/voice/voice-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  generation: z.number().int().min(0),
  speakerIdentity: z.string().min(1).max(120).optional(),
  text: z.string().min(1).max(4000),
  startMs: z.number().int().min(0).default(0),
  endMs: z.number().int().min(0).default(0),
});

/**
 * POST /app/calls/api/calls/[id]/transcript/segments — live STT ingestion
 * from the client. Segments with a stale `generation` (produced before a
 * pause) or arriving while the AI is paused are discarded (202).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCallsSession();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  try {
    await getCall(auth.user, id); // scope check
    const result = await ingestTranscriptSegment(
      id,
      {
        speakerIdentity: parsed.data.speakerIdentity ?? `user-${auth.user.id}`,
        text: parsed.data.text,
        startMs: parsed.data.startMs,
        endMs: parsed.data.endMs,
      },
      parsed.data.generation
    );
    return NextResponse.json(result, { status: result.accepted ? 201 : 202 });
  } catch (err) {
    return voiceErrorResponse(err);
  }
}
