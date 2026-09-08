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
 * Anthropic Claude provider (STUB for future Phase).
 *
 * When activated, this will use the `@anthropic-ai/sdk` package and adapt
 * the OpenAI-style messages/tools to Claude's format:
 *   - tool_calls → tool_use content blocks
 *   - role: "tool" → user message with tool_result block
 *   - tools wrapper: { type: "function", function: {...} } → { name, description, input_schema }
 *
 * Data privacy: Anthropic does NOT train on commercial API data by default.
 * Zero Data Retention (ZDR) available on request.
 * See https://privacy.claude.com/en/articles/7996868
 *
 * To activate: install `@anthropic-ai/sdk`, implement the conversion logic,
 * and set provider='anthropic' in the admin panel.
 */

export const anthropicProvider: AiProvider = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',

  async getStatus(): Promise<ProviderStatus> {
    const config = await getProviderConfig('anthropic');
    const missingVars: string[] = [];
    if (!config.apiKey) missingVars.push('ANTHROPIC_API_KEY');
    if (!config.model) missingVars.push('ANTHROPIC_MODEL');
    return {
      provider: 'anthropic',
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
      'Anthropic provider no está implementado aún. Usa provider=openai por ahora.',
      'unknown'
    );
  },

  async *chatCompletionStream(_opts: ChatCompletionOptions): AsyncGenerator<StreamChunk> {
    throw new AiApiError(
      'Anthropic provider no está implementado aún. Usa provider=openai por ahora.',
      'unknown'
    );
    yield {}; // unreachable, satisfies generator type
  },

  async testConnection(): Promise<ConnectionTestResult> {
    const config = await getProviderConfig('anthropic');
    return {
      success: false,
      model: config.model ?? 'claude-sonnet-4-5',
      latencyMs: 0,
      tokensUsed: 0,
      error: 'Anthropic provider no está implementado aún.',
      errorCode: 'unknown',
    };
  },
};
