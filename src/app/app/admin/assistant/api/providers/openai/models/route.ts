import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { openaiProvider } from '@/modules/ai/providers/openai';
import { AiApiError } from '@/modules/ai/providers/types';
import { saveDiscoveredProviderModels } from '@/modules/ai/ai-admin-config-service';
import { recordAiAuditEvent } from '@/modules/ai/ai-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Ids worth surfacing to the admin (chat-capable families), newest families first. */
function chatModelIds(all: string[]): string[] {
  const chat = all.filter((id) => /^(gpt-5|gpt-4\.1|gpt-4o|o[1-9])/i.test(id) && !/(realtime|audio|transcribe|tts|search|embedding|image|moderation)/i.test(id));
  const rank = (id: string) => (id.startsWith('gpt-5') ? 0 : id.startsWith('o') ? 1 : id.startsWith('gpt-4.1') ? 2 : 3);
  return chat.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * POST /app/admin/assistant/api/providers/openai/models
 *
 * Reads GET /models with the SAVED OpenAI key and stores the ids so the model policy can
 * use GPT-5 (or whatever the key lists) without waiting for a catalog update.
 */
export async function POST() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'assistant.admin')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let models: string[];
  try {
    if (!openaiProvider.listRemoteModels) throw new Error('El proveedor no expone la lista de modelos');
    models = await openaiProvider.listRemoteModels();
  } catch (err) {
    const message =
      err instanceof AiApiError && err.code === 'auth'
        ? 'OpenAI rechazó la API key guardada. Revisa la llave en Proveedores.'
        : `No se pudo conectar con OpenAI: ${err instanceof Error ? err.message : 'error desconocido'}`;
    return NextResponse.json({ ok: false, error: message, models: [] });
  }

  const chat = chatModelIds(models);
  await saveDiscoveredProviderModels('openai', chat);
  await recordAiAuditEvent({
    actorUserId: session.user.id,
    action: 'assistant.provider_tested',
    targetType: 'ai_provider',
    targetId: 'openai',
    metadata: { modelsDetected: models.length, chatModels: chat.length },
  });

  return NextResponse.json({
    ok: true,
    models: chat,
    hasGpt5: chat.some((id) => id.startsWith('gpt-5')),
    recommended: chat.find((id) => /^gpt-5(\.\d+)?$/.test(id)) ?? chat.find((id) => id.startsWith('gpt-5')) ?? null,
  });
}
