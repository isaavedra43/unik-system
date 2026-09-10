import type { ProviderId } from './providers/types';
import { PROVIDER_IDS } from './providers/types';
import { getAiSettings } from './ai-admin-config-service';

/**
 * AI provider configuration (provider-agnostic, multi-provider).
 *
 * Configuration is resolved in this order:
 *   1. Database providerConfigs[provider] (admin panel — multi-provider)
 *   2. Database legacy fields (apiKey, endpoint — single provider fallback)
 *   3. Environment variables — fallback for initial setup / CI
 *
 * Multiple providers can be configured simultaneously. The chat UI lets
 * users pick which model to use per conversation.
 */

const PROVIDER_ENV_MAP: Record<
  ProviderId,
  { apiKey: string; model: string; fallbackModel: string; endpoint: string }
> = {
  openai: {
    apiKey: 'OPENAI_API_KEY',
    model: 'OPENAI_MODEL',
    fallbackModel: 'OPENAI_FALLBACK_MODEL',
    endpoint: 'OPENAI_ENDPOINT',
  },
  anthropic: {
    apiKey: 'ANTHROPIC_API_KEY',
    model: 'ANTHROPIC_MODEL',
    fallbackModel: 'ANTHROPIC_FALLBACK_MODEL',
    endpoint: 'ANTHROPIC_ENDPOINT',
  },
  gemini: {
    apiKey: 'GEMINI_API_KEY',
    model: 'GEMINI_MODEL',
    fallbackModel: 'GEMINI_FALLBACK_MODEL',
    endpoint: 'GEMINI_ENDPOINT',
  },
  local: {
    apiKey: 'OLLAMA_API_KEY',
    model: 'OLLAMA_MODEL',
    fallbackModel: 'OLLAMA_FALLBACK_MODEL',
    endpoint: 'OLLAMA_ENDPOINT',
  },
};

const DEFAULT_MODELS: Record<ProviderId, { model: string; fallbackModel: string }> = {
  openai: { model: 'gpt-4o', fallbackModel: 'gpt-4o-mini' },
  anthropic: { model: 'claude-sonnet-4-5', fallbackModel: 'claude-haiku-4-5' },
  gemini: { model: 'gemini-2.0-flash', fallbackModel: 'gemini-2.0-flash-lite' },
  local: { model: 'llama3.1', fallbackModel: 'llama3.1' },
};

export interface ProviderConfig {
  apiKey: string | null;
  model: string | null;
  fallbackModel: string | null;
  endpoint: string | null;
}

/** Returns the default provider id from env (sync, no DB). */
function getActiveProviderIdFromEnv(): ProviderId {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (raw && (PROVIDER_IDS as string[]).includes(raw)) {
    return raw as ProviderId;
  }
  return 'openai';
}

/** Returns the default provider id, preferring DB settings over env. */
export async function getActiveProviderId(): Promise<ProviderId> {
  try {
    const settings = await getAiSettings();
    const raw = settings.provider?.trim().toLowerCase();
    if (raw && (PROVIDER_IDS as string[]).includes(raw)) {
      return raw as ProviderId;
    }
  } catch {
    // DB not available yet
  }
  return getActiveProviderIdFromEnv();
}

/**
 * Returns the configuration for a specific provider.
 * Resolution order: providerConfigs[provider] → legacy fields → env vars → defaults
 */
export async function getProviderConfig(provider: ProviderId): Promise<ProviderConfig> {
  const env = PROVIDER_ENV_MAP[provider];
  const defaults = DEFAULT_MODELS[provider];

  let dbApiKey = '';
  let dbEndpoint = '';
  let dbModel = '';
  let dbFallbackModel = '';

  try {
    const settings = await getAiSettings();
    // 1. Multi-provider config (preferred)
    const multiConfig = settings.providerConfigs?.[provider];
    if (multiConfig) {
      dbApiKey = multiConfig.apiKey ?? '';
      dbEndpoint = multiConfig.endpoint ?? '';
    }
    // 2. Legacy single-provider fields (fallback if provider matches default)
    if (!dbApiKey && settings.provider === provider) {
      dbApiKey = settings.apiKey ?? '';
      dbEndpoint = settings.endpoint ?? '';
    }
    // Model/fallback always from top-level settings (shared across providers)
    if (settings.provider === provider) {
      dbModel = settings.deployment ?? '';
      dbFallbackModel = settings.fallbackDeployment ?? '';
    }
  } catch {
    // DB not available — use env only
  }

  return {
    apiKey: dbApiKey || process.env[env.apiKey]?.trim() || null,
    model: dbModel || process.env[env.model]?.trim() || defaults.model,
    fallbackModel:
      dbFallbackModel || process.env[env.fallbackModel]?.trim() || defaults.fallbackModel,
    endpoint: dbEndpoint || process.env[env.endpoint]?.trim() || null,
  };
}

/** Returns the configuration for the currently active (default) provider. */
export async function getActiveProviderConfig(): Promise<ProviderConfig> {
  const provider = await getActiveProviderId();
  return getProviderConfig(provider);
}

/**
 * Returns the provider for a given model id, checking the model catalog.
 * Used when the user selects a specific model in the chat UI.
 */
export async function getProviderForModelId(modelId: string): Promise<ProviderId> {
  // Check the model catalog first
  const { getModelById } = await import('./model-catalog');
  const model = getModelById(modelId);
  if (model) return model.provider;
  // Fall back to the default provider
  return getActiveProviderId();
}

/** For the admin panel: status without exposing the key. Async (reads DB). */
export async function getAiConfigStatus(): Promise<{
  provider: ProviderId;
  configured: boolean;
  hasApiKey: boolean;
  hasEndpoint: boolean;
  hasModel: boolean;
  model: string | null;
  fallbackModel: string | null;
  endpoint: string | null;
  missingVars: string[];
}> {
  const provider = await getActiveProviderId();
  const config = await getProviderConfig(provider);
  const env = PROVIDER_ENV_MAP[provider];
  const missingVars: string[] = [];
  if (!config.apiKey && provider !== 'local') missingVars.push(env.apiKey);
  if (!config.model) missingVars.push(env.model);
  if (provider === 'local' && !config.endpoint) missingVars.push(env.endpoint);

  return {
    provider,
    configured: missingVars.length === 0,
    hasApiKey: Boolean(config.apiKey),
    hasEndpoint: Boolean(config.endpoint),
    hasModel: Boolean(config.model),
    model: config.model,
    fallbackModel: config.fallbackModel,
    endpoint: config.endpoint,
    missingVars,
  };
}

/**
 * Returns the list of configured (enabled + has API key) providers.
 * Used by the model selector to show only providers that are actually connected.
 */
export async function getConfiguredProviders(): Promise<ProviderId[]> {
  const result: ProviderId[] = [];
  for (const provider of PROVIDER_IDS) {
    const config = await getProviderConfig(provider);
    if (provider === 'local') {
      if (config.endpoint) result.push(provider);
    } else if (config.apiKey) {
      result.push(provider);
    }
  }
  return result;
}

