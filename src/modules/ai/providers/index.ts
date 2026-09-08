import type { AiProvider, ProviderId } from './types';
import { PROVIDER_IDS, PROVIDER_LABELS } from './types';
import { openaiProvider } from './openai';
import { anthropicProvider } from './anthropic';
import { geminiProvider } from './gemini';
import { localProvider } from './local';
import { getActiveProviderId } from '../ai-config';

const REGISTRY: Record<ProviderId, AiProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  local: localProvider,
};

/** Returns the provider implementation for the given id. */
export function getProvider(id: ProviderId): AiProvider {
  return REGISTRY[id];
}

/** Returns the currently active provider based on DB config (or AI_PROVIDER env fallback). */
export async function getActiveProvider(): Promise<AiProvider> {
  const id = await getActiveProviderId();
  return REGISTRY[id];
}

/** Returns all registered providers (for admin UI). */
export function getAllProviders(): AiProvider[] {
  return PROVIDER_IDS.map((id) => REGISTRY[id]);
}

export { PROVIDER_IDS, PROVIDER_LABELS };
export type { AiProvider, ProviderId };
export { openaiProvider };
