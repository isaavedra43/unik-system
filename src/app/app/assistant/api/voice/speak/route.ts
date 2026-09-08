import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { openaiProvider } from '@/modules/ai/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /app/assistant/api/voice/speak
 *
 * Receives { text: string } and returns an MP3 audio buffer.
 * Uses OpenAI TTS (gpt-4o-mini-tts) with the configured voice.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const text = (body as { text?: string })?.text;
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return NextResponse.json({ error: 'Texto vacío' }, { status: 400 });
  }

  // Limit text length (4000 chars — TTS models have limits)
  if (text.length > 4000) {
    return NextResponse.json({ error: 'Texto demasiado largo (máx 4000 caracteres)' }, { status: 413 });
  }

  try {
    const audioBuffer = await openaiProvider.speak!(text, settings.ttsVoice);
    return new NextResponse(new Uint8Array(audioBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audioBuffer.length),
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    console.error('[voice/speak] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
