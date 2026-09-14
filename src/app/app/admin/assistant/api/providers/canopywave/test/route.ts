import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { canopywaveProvider } from '@/modules/ai/providers/canopywave';
import { AiApiError } from '@/modules/ai/providers/types';
import { saveDiscoveredProviderModels } from '@/modules/ai/ai-admin-config-service';
import { recordAiAuditEvent } from '@/modules/ai/ai-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const schema = z.object({
  models: z.array(z.string().min(1).max(160)).max(5).default([]),
});

/** Does the model actually call a tool? The assistant is useless without it. */
async function checkToolCalling(model: string): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await canopywaveProvider.chatCompletion({
      model,
      temperature: 0,
      maxTokens: 600,
      messages: [{ role: 'user', content: 'Usa la herramienta get_server_time para saber la hora. No respondas con texto.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_server_time',
            description: 'Devuelve la hora actual del servidor.',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ],
    });
    const called = Boolean(result.toolCalls?.some((t) => t.name === 'get_server_time'));
    return called ? { success: true } : { success: false, error: 'El modelo respondió sin llamar la herramienta.' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error' };
  }
}

/**
 * POST /app/admin/assistant/api/providers/canopywave/test
 *
 * With the SAVED Canopy Wave key: reads GET /models, stores the ids (so the chat can select them),
 * and for each requested model runs a tiny chat completion and a tool-calling check.
 */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'assistant.admin')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });

  let models: string[];
  try {
    models = await canopywaveProvider.listRemoteModels();
  } catch (err) {
    const message =
      err instanceof AiApiError && err.code === 'auth'
        ? err.message.includes('Falta la API key')
          ? err.message
          : 'Canopy Wave rechazó la API key. Copia de nuevo la llave de tu plan (Model API → Model API Key → Monthly Subscription).'
        : `No se pudo conectar con Canopy Wave: ${err instanceof Error ? err.message : 'error desconocido'}`;
    return NextResponse.json({ ok: false, error: message, models: [], checks: [] });
  }

  await saveDiscoveredProviderModels('canopywave', models);

  const toCheck = parsed.data.models.length > 0 ? parsed.data.models : [canopywaveProvider.defaultModel];
  const checks = [];
  for (const model of toCheck) {
    const listed = models.includes(model);
    const chat = await canopywaveProvider.testModel(model);
    const tools = chat.success ? await checkToolCalling(model) : { success: false, error: 'Se omitió: el chat falló.' };
    checks.push({
      model,
      listed,
      chat: { success: chat.success, latencyMs: chat.latencyMs, error: chat.error },
      tools,
    });
  }

  await recordAiAuditEvent({
    actorUserId: session.user.id,
    action: 'assistant.provider_tested',
    targetType: 'ai_provider',
    targetId: 'canopywave',
    metadata: {
      modelsDetected: models.length,
      checks: checks.map((c) => ({ model: c.model, chat: c.chat.success, tools: c.tools.success })),
    },
  });

  return NextResponse.json({ ok: true, models, checks });
}
