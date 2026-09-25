import { createOpenAiCompatibleProvider } from './openai-compatible';

/**
 * OpenRouter — one API key, every major model (OpenAI, Anthropic, Google,
 * DeepSeek, Moonshot…). OpenAI-compatible chat completions plus the alpha
 * Decisions API that hosts System One models such as Jev.
 * Docs: https://openrouter.ai/docs
 *
 * Model ids carry the vendor prefix ("google/gemini-2.5-flash"). The routing
 * policy (`modelForTask`) decides which tier each job uses; the admin panel
 * can detect what the key lists via GET /models.
 */
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';

export const openrouterProvider = createOpenAiCompatibleProvider({
  id: 'openrouter',
  label: 'OpenRouter',
  defaultEndpoint: OPENROUTER_ENDPOINT,
  apiKeyEnv: 'OPENROUTER_API_KEY',
  defaultModel: 'google/gemini-2.5-flash',
  defaultHeaders: {
    'HTTP-Referer': 'https://unik.com.mx',
    'X-OpenRouter-Title': 'UNIK',
  },
});
