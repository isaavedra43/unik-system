import { z } from 'zod';
import type { ProviderId } from './providers/types';
import { PROVIDER_IDS } from './providers/types';

/**
 * AI provider configuration (provider-agnostic).
 *
 * The active provider is selected via AI_PROVIDER (default: openai).
 * Each provider reads its own env vars. Secrets are never exposed to clients.
 *
 * Supported providers:
 *   - openai    → OpenAI direct API (ChatGPT API)
 *   - anthropic → Anthropic Claude (future)
 *   - gemini    → Google Gemini (future)
 *   - local     → Ollama / LM Studio (future)
 */

const PROVIDER_ENV_MAP: Record<ProviderId, { apiKey: string; model: string; fallbackModel: string; endpoint: string }> = {
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

/** Returns the active provider id from env, defaulting to openai. */
export function getActiveProviderId(): ProviderId {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (raw && (PROVIDER_IDS as string[]).includes(raw)) {
    return raw as ProviderId;
  }
  return 'openai';
}

/** Returns the configuration for a specific provider, reading its env vars. */
export function getProviderConfig(provider: ProviderId): ProviderConfig {
  const env = PROVIDER_ENV_MAP[provider];
  const defaults = DEFAULT_MODELS[provider];
  return {
    apiKey: process.env[env.apiKey]?.trim() || null,
    model: process.env[env.model]?.trim() || defaults.model,
    fallbackModel: process.env[env.fallbackModel]?.trim() || defaults.fallbackModel,
    endpoint: process.env[env.endpoint]?.trim() || null,
  };
}

/** Returns the configuration for the currently active provider. */
export function getActiveProviderConfig(): ProviderConfig {
  return getProviderConfig(getActiveProviderId());
}

/** For the admin panel: status without exposing the key. */
export function getAiConfigStatus(): {
  provider: ProviderId;
  configured: boolean;
  hasApiKey: boolean;
  hasEndpoint: boolean;
  hasModel: boolean;
  model: string | null;
  fallbackModel: string | null;
  endpoint: string | null;
  missingVars: string[];
} {
  const provider = getActiveProviderId();
  const config = getProviderConfig(provider);
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

// Keep zod import used for future schema validation extension
export const _aiConfigSchema = z.object({
  AI_PROVIDER: z.enum(['openai', 'anthropic', 'gemini', 'local']).optional(),
});
