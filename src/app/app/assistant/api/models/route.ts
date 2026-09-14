import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getConfiguredProviders, getActiveProviderId, getDiscoveredModels } from '@/modules/ai/ai-config';
import {
  MODEL_CATALOG,
  buildDiscoveredModel,
  getDefaultModel,
  getModelById,
  getModelsByProvider,
} from '@/modules/ai/model-catalog';
import { PROVIDER_IDS, PROVIDER_LABELS } from '@/modules/ai/providers';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import type { ProviderId } from '@/modules/ai/providers/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/models
 *
 * Returns the list of models available to the user, based on which
 * providers are configured (have API keys). Only models from configured
 * providers are returned, so the user can only select models that will
 * actually work. Models a provider's key reported (e.g. extra Canopy Wave
 * models) are included after the curated ones.
 *
 * Response shape:
 *   {
 *     models: ModelInfo[],
 *     defaultModel: string,
 *     providers: { id, label, configured }[]
 *   }
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const [configuredProviders, defaultProvider, settings, discovered] = await Promise.all([
    getConfiguredProviders(),
    getActiveProviderId(),
    getAiSettings(),
    getDiscoveredModels(),
  ]);

  // If no providers are configured, return all available models (env var fallback)
  const providersToList = configuredProviders.length > 0 ? configuredProviders : [defaultProvider];

  // Curated models first, then models the provider's key reported that the catalog doesn't know.
  const models = providersToList.flatMap((provider) => {
    const curated = getModelsByProvider(provider).filter((m) => m.available);
    const extra = (discovered[provider] ?? [])
      .filter((id) => !getModelById(id))
      .map((id) => buildDiscoveredModel(id, provider));
    return [...curated, ...extra];
  });

  // If no models found (shouldn't happen), fall back to all available
  const finalModels = models.length > 0 ? models : MODEL_CATALOG.filter((m) => m.available);

  const configuredDefault = settings.deployment?.trim();
  const defaultModelId =
    configuredDefault && finalModels.some((m) => m.id === configuredDefault)
      ? configuredDefault
      : getDefaultModel(defaultProvider).id;

  const providers = PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDER_LABELS[id],
    configured: configuredProviders.includes(id),
  }));

  return NextResponse.json({
    models: finalModels.map((m) => ({
      id: m.id,
      provider: m.provider,
      providerLabel: PROVIDER_LABELS[m.provider as ProviderId] ?? m.provider,
      label: m.label,
      power: m.power,
      bestFor: m.bestFor,
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
      speed: m.speed,
      costPer1M: m.costPer1M,
      capabilities: m.capabilities,
      description: m.description,
      available: m.available,
    })),
    defaultModel: defaultModelId,
    routingEnabled: settings.routingEnabled,
    providers,
  });
}
