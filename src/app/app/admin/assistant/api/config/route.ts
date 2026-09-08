import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import {
  listAiConfig,
  updateAiConfig,
} from '@/modules/ai/ai-admin-config-service';
import { recordAiAuditEvent } from '@/modules/ai/ai-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET returns the AI config for the admin UI.
 * The API key is NEVER returned to the client — only a `hasApiKey` boolean.
 * If the client sends an empty apiKey in PATCH, the existing key is preserved.
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'assistant.admin')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const config = await listAiConfig();
  const settings = (config.settings as Record<string, unknown>) ?? {};

  // Strip the API key — never send it to the client
  const safeSettings = { ...settings };
  const hasApiKey = Boolean(safeSettings.apiKey);
  delete safeSettings.apiKey;

  return NextResponse.json({
    id: config.id,
    key: config.key,
    isEnabled: config.isEnabled,
    settings: { ...safeSettings, hasApiKey },
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  });
}

const patchSchema = z.object({
  isEnabled: z.boolean().optional(),
  settings: z.record(z.unknown()).optional(),
});

export async function PATCH(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'assistant.admin')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  }

  // If the client sends an empty apiKey, preserve the existing one
  if (parsed.data.settings && parsed.data.settings.apiKey === '') {
    const current = await listAiConfig();
    const currentSettings = (current.settings as Record<string, unknown>) ?? {};
    parsed.data.settings.apiKey = currentSettings.apiKey ?? '';
  }

  // Strip hasApiKey — it's a read-only computed field, not stored
  if (parsed.data.settings) {
    delete parsed.data.settings.hasApiKey;
  }

  try {
    await updateAiConfig(parsed.data);
    await recordAiAuditEvent({
      actorUserId: session.user.id,
      action: 'assistant.config_changed',
      targetType: 'ai_config',
      targetId: 'global',
      metadata: {
        isEnabled: parsed.data.isEnabled,
        changedKeys: parsed.data.settings ? Object.keys(parsed.data.settings) : [],
      },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Error al actualizar' },
      { status: 500 }
    );
  }
}
