import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { openaiProvider } from '@/modules/ai/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /app/assistant/api/voice/transcribe
 *
 * Receives a multipart/form-data with an audio file (webm/wav/mp3).
 * Sends it to OpenAI Whisper for transcription.
 * Returns { text: string }.
 *
 * Requires `assistant.voice` permission.
 */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!hasPermission(session.user, 'assistant.voice')) {
    return NextResponse.json({ error: 'Sin permiso de voz' }, { status: 403 });
  }

  const settings = await getAiSettings();
  if (!settings.voiceEnabled) {
    return NextResponse.json({ error: 'La voz está desactivada' }, { status: 403 });
  }

  const formData = await request.formData();
  const audioFile = formData.get('audio');
  if (!audioFile || !(audioFile instanceof File)) {
    return NextResponse.json({ error: 'No se envió audio' }, { status: 400 });
  }

  // Limit file size (10 MB)
  if (audioFile.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'Audio demasiado grande (máx 10 MB)' }, { status: 413 });
  }

  try {
    const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
    const mimeType = audioFile.type || 'audio/webm';
    const text = await openaiProvider.transcribe!(audioBuffer, mimeType, settings.sttModel);
    return NextResponse.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    console.error('[voice/transcribe] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
