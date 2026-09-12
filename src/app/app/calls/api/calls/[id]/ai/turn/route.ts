import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCallsSession, voiceErrorResponse } from '../../../../_shared';
import { getCall } from '@/modules/voice/voice-service';
import { runAnswerTurn } from '@/modules/voice/voice-ai-service';
// Ensures every built-in tool is registered before the allowlist is applied.
import '@/modules/ai/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_MIMES = new Set([
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
]);

const textSchema = z.object({
  text: z.string().min(1).max(4000),
  startMs: z.number().int().min(0).optional(),
  endMs: z.number().int().min(0).optional(),
});

/**
 * POST /app/calls/api/calls/[id]/ai/turn — one STT → LLM → TTS cycle.
 * Accepts JSON `{ text }` or multipart with an `audio` file. Returns the
 * reply text and audio (base64 mp3) for the client to publish in the room.
 * The caller must be on the call (or supervising it); the AI itself runs
 * with the limited voice service identity.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCallsSession();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    await getCall(auth.user, id); // authorization: 404 outside the caller's scope
    const contentType = request.headers.get('content-type') ?? '';
    let input: {
      text?: string;
      audio?: { buffer: Buffer; mimeType: string };
      startMs?: number;
      endMs?: number;
    };
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('audio');
      if (!(file instanceof File))
        return NextResponse.json({ error: 'Falta el audio' }, { status: 400 });
      if (file.size > MAX_AUDIO_BYTES)
        return NextResponse.json({ error: 'Audio demasiado grande' }, { status: 413 });
      const mimeType = (file.type || 'audio/webm').split(';')[0].trim();
      if (!AUDIO_MIMES.has(mimeType))
        return NextResponse.json({ error: 'Formato de audio no soportado' }, { status: 415 });
      const startMs = Number(form.get('startMs') ?? 0);
      const endMs = Number(form.get('endMs') ?? 0);
      input = {
        audio: { buffer: Buffer.from(await file.arrayBuffer()), mimeType },
        startMs: Number.isFinite(startMs) ? startMs : 0,
        endMs: Number.isFinite(endMs) ? endMs : 0,
      };
    } else {
      const parsed = textSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
      input = parsed.data;
    }
    const result = await runAnswerTurn(id, input);
    return NextResponse.json(result, { status: result.discarded ? 202 : 200 });
  } catch (err) {
    return voiceErrorResponse(err);
  }
}
