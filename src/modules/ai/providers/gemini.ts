import type {
  ChatCompletionOptions,
  ChatCompletionResult,
  StreamChunk,
  ConnectionTestResult,
  ProviderStatus,
  AiProvider,
} from './types';
import { AiApiError } from './types';
import { getProviderConfig } from '../ai-config';

/**
 * Google Gemini provider (STUB for future Phase).
 *
 * When activated, this will use the `@google/generative-ai` package and adapt
 * the OpenAI-style messages/tools to Gemini's format.
 *
 * Data privacy: Google does NOT train on Gemini API data by default.
 * See https://ai.google.dev/gemini-api/data
 *
 * To activate: install `@google/generative-ai`, implement the conversion logic,
 * and set provider='gemini' in the admin panel.
 */

export const geminiProvider: AiProvider = {
  id: 'gemini',
  label: 'Google (Gemini)',

  async getStatus(): Promise<ProviderStatus> {
    const config = await getProviderConfig('gemini');
    const missingVars: string[] = [];
    if (!config.apiKey) missingVars.push('GEMINI_API_KEY');
    if (!config.model) missingVars.push('GEMINI_MODEL');
    return {
      provider: 'gemini',
      configured: missingVars.length === 0,
      hasApiKey: Boolean(config.apiKey),
      hasEndpoint: Boolean(config.endpoint),
      hasModel: Boolean(config.model),
      model: config.model ?? null,
      endpoint: config.endpoint ?? null,
      missingVars,
    };
  },

  async chatCompletion(_opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
    throw new AiApiError(
      'Gemini provider no está implementado aún. Usa provider=openai por ahora.',
      'unknown'
    );
  },

  async *chatCompletionStream(_opts: ChatCompletionOptions): AsyncGenerator<StreamChunk> {
    throw new AiApiError(
      'Gemini provider no está implementado aún. Usa provider=openai por ahora.',
      'unknown'
    );
    yield {}; // unreachable, satisfies generator type
  },

  async testConnection(): Promise<ConnectionTestResult> {
    const config = await getProviderConfig('gemini');
    return {
      success: false,
      model: config.model ?? 'gemini-2.0-flash',
      latencyMs: 0,
      tokensUsed: 0,
      error: 'Gemini provider no está implementado aún.',
      errorCode: 'unknown',
    };
  },
};
