import type { ProviderId } from './providers/types';

/**
 * Which provider serves a model id. Pure.
 *
 * Order: curated catalog → ids a provider's key reported (GET /models, saved by the admin test) →
 * namespaced open-model ids ("vendor/model") go to Canopy Wave when it is configured (OpenAI,
 * Anthropic and Gemini ids never contain "/") → the default provider.
 * Without this, a Canopy model that is not in the catalog was sent to OpenAI and failed.
 */
export function resolveProviderForModel(
  modelId: string,
  input: {
    catalogProvider?: ProviderId;
    discovered: Partial<Record<ProviderId, string[]>>;
    configured: ProviderId[];
    defaultProvider: ProviderId;
  }
): ProviderId {
  if (input.catalogProvider) return input.catalogProvider;
  for (const [provider, ids] of Object.entries(input.discovered) as Array<[ProviderId, string[] | undefined]>) {
    if (ids?.includes(modelId)) return provider;
  }
  if (modelId.includes('/') && input.configured.includes('canopywave')) return 'canopywave';
  return input.defaultProvider;
}
