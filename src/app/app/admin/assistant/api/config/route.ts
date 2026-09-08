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

const PROVIDER_IDS = ['openai', 'anthropic', 'gemini', 'local'];

/**
 * Sanitizes settings for the GET response:
 * - Removes all apiKey fields (top-level and inside providerConfigs)
 * - Adds hasApiKey booleans (top-level and per-provider)
 */
function sanitizeSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...settings };

  // Top-level API key
  const hasApiKey = Boolean(safe.apiKey);
  delete safe.apiKey;
  safe.hasApiKey = hasApiKey;

  // Per-provider API keys inside providerConfigs
  const providerConfigs = (safe.providerConfigs as Record<string, Record<string, unknown>>) ?? {};
  const safeProviderConfigs: Record<string, unknown> = {};
  for (const provider of PROVIDER_IDS) {
    const entry = providerConfigs[provider] ?? {};
    const providerHasKey = Boolean(entry.apiKey);
    safeProviderConfigs[provider] = {
      endpoint: entry.endpoint ?? '',
      enabled: Boolean(entry.enabled),
      hasApiKey: providerHasKey,
    };
  }
  safe.providerConfigs = safeProviderConfigs;

  return safe;
}

/**
 * Merges incoming providerConfigs with existing ones, preserving API keys
 * when the client sends an empty string.
 */
function mergeProviderConfigs(
  incoming: Record<string, Record<string, unknown>>,
  existing: Record<string, Record<string, unknown>>
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const provider of PROVIDER_IDS) {
    const inc = incoming[provider] ?? {};
    const ex = existing[provider] ?? {};
    // If client sends empty apiKey, preserve existing
    const apiKey = inc.apiKey === '' || inc.apiKey === undefined
      ? (ex.apiKey ?? '')
      : inc.apiKey;
    merged[provider] = {
      apiKey,
      endpoint: inc.endpoint ?? ex.endpoint ?? '',
      enabled: Boolean(inc.enabled ?? ex.enabled ?? false),
    };
  }
  return merged;
}

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
  const safeSettings = sanitizeSettings(settings);

  return NextResponse.json({
    id: config.id,
    key: config.key,
    isEnabled: config.isEnabled,
    settings: safeSettings,
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

  const settings = parsed.data.settings ?? {};

  // Strip read-only computed fields
  delete settings.hasApiKey;

  // Get current config to merge providerConfigs
  const current = await listAiConfig();
  const currentSettings = (current.settings as Record<string, unknown>) ?? {};

  // Handle top-level apiKey: empty = preserve existing
  if (settings.apiKey === '' || settings.apiKey === undefined) {
    settings.apiKey = (currentSettings.apiKey as string) ?? '';
  }

  // Handle providerConfigs: merge with existing to preserve API keys
  if (settings.providerConfigs) {
    const incoming = settings.providerConfigs as Record<string, Record<string, unknown>>;
    const existing = (currentSettings.providerConfigs as Record<string, Record<string, unknown>>) ?? {};
    settings.providerConfigs = mergeProviderConfigs(incoming, existing) as unknown as Record<string, unknown>;
    // Strip hasApiKey from each provider config (read-only computed field)
    for (const provider of PROVIDER_IDS) {
      const entry = (settings.providerConfigs as Record<string, Record<string, unknown>>)[provider];
      if (entry) delete entry.hasApiKey;
    }
  }

  try {
    await updateAiConfig({ isEnabled: parsed.data.isEnabled, settings });
    await recordAiAuditEvent({
      actorUserId: session.user.id,
      action: 'assistant.config_changed',
      targetType: 'ai_config',
      targetId: 'global',
      metadata: {
        isEnabled: parsed.data.isEnabled,
        changedKeys: Object.keys(settings),
        // Record which providers were toggled, but NOT the API keys
        providersToggled: PROVIDER_IDS.map((p) => ({
          provider: p,
          enabled: Boolean((settings.providerConfigs as Record<string, Record<string, unknown>>)?.[p]?.enabled),
          hasApiKey: Boolean(
            (settings.providerConfigs as Record<string, Record<string, unknown>>)?.[p]?.apiKey
          ),
        })),
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
