import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getConfiguredProviders, getActiveProviderId } from '@/modules/ai/ai-config';
import { MODEL_CATALOG, getModelsByProvider, getDefaultModel, getModelById } from '@/modules/ai/model-catalog';
import { PROVIDER_LABELS } from '@/modules/ai/providers';
import type { ProviderId } from '@/modules/ai/providers/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/models
 *
 * Returns the list of models available to the user, based on which
 * providers are configured (have API keys). Only models from configured
 * providers are returned, so the user can only select models that will
 * actually work.
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

  const configuredProviders = await getConfiguredProviders();
  const defaultProvider = await getActiveProviderId();

  // If no providers are configured, return all available models (env var fallback)
  const providersToList = configuredProviders.length > 0 ? configuredProviders : [defaultProvider];

  // Collect models from all configured providers
  const models = providersToList.flatMap((provider) =>
    getModelsByProvider(provider).filter((m) => m.available)
  );

  // If no models found (shouldn't happen), fall back to all available
  const finalModels = models.length > 0 ? models : MODEL_CATALOG.filter((m) => m.available);

  const defaultModel = getDefaultModel(defaultProvider);

  const providers = (['openai', 'anthropic', 'gemini', 'local'] as ProviderId[]).map((id) => ({
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
    defaultModel: defaultModel.id,
    providers,
  });
}
