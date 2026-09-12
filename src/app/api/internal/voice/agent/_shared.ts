import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
import { LiveKitError } from '@/modules/voice/livekit-service';
import { VoiceError } from '@/modules/voice/voice-service';
import { touchVoiceAgent } from '@/modules/voice/voice-agent-service';

/**
 * Internal API used only by the voice agent worker (services/voice-agent).
 * Authenticated with X-UNIK-API-Key; never reachable with a browser session.
 */
export function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export function guard(request: Request): NextResponse | null {
  if (!isInternalApiKeyValid(request)) return unauthorized();
  touchVoiceAgent();
  return null;
}

export function agentErrorResponse(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return NextResponse.json({ error: 'Solicitud inválida' }, { status: 400 });
  }
  if (err instanceof VoiceError || err instanceof LiveKitError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error('[voice-agent-api]', err instanceof Error ? err.message : err);
  return NextResponse.json({ error: 'Error interno' }, { status: 500 });
}

export function callIdFrom(request: Request): string | null {
  const id = new URL(request.url).searchParams.get('callId');
  return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}
