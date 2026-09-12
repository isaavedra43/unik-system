import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { VoiceError } from '@/modules/voice/voice-service';
import { LiveKitError } from '@/modules/voice/livekit-service';
import { StorageError } from '@/modules/storage/storage-service';
import { AiApiError } from '@/modules/ai/ai-client';
// Recording/transcript access resolvers and job handlers for this process.
import '@/modules/voice/voice-access';
import '@/modules/jobs/register-handlers';

/** Calls endpoints accept `calls.use` or `calls.supervise` (super_admin bypasses). */
export async function requireCallsSession(
  permissions: string[] = ['calls.use', 'calls.supervise']
): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  const ok = permissions.some((p) => {
    try {
      return hasPermission(session.user, p);
    } catch {
      return false;
    }
  });
  if (!ok) return { response: NextResponse.json({ error: 'Sin permiso' }, { status: 403 }) };
  return { user: session.user };
}

export async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Stable JSON errors; never leaks internals or secrets. */
export function voiceErrorResponse(err: unknown): NextResponse {
  if (err instanceof VoiceError || err instanceof LiveKitError || err instanceof StorageError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof AiApiError) {
    return NextResponse.json(
      { error: 'El proveedor de IA no respondió', code: err.code },
      { status: 502 }
    );
  }
  console.error('[calls-api]', err instanceof Error ? err.message : 'error');
  return NextResponse.json({ error: 'Error interno de telefonía' }, { status: 500 });
}
