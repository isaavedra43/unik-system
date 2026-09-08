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
 * Local AI provider via Ollama / LM Studio (STUB for future Phase).
 *
 * When activated, this will use an OpenAI-compatible local endpoint
 * (Ollama and LM Studio both expose one) by pointing the OpenAI provider
 * at localhost. Many local runtimes already accept the OpenAI Chat
 * Completions format, so the implementation may reuse openaiProvider
 * with a custom baseURL.
 *
 * Data privacy: 100% local — no data ever leaves your machine.
 *
 * To activate: set AI_PROVIDER=local, OLLAMA_ENDPOINT=http://localhost:11434/v1,
 * OLLAMA_MODEL=llama3.1, and OLLAMA_API_KEY=ollama (any non-empty string).
 */

export const localProvider: AiProvider = {
  id: 'local',
  label: 'Local (Ollama / LM Studio)',

  getStatus(): ProviderStatus {
    const config = getProviderConfig('local');
    const missingVars: string[] = [];
    if (!config.endpoint) missingVars.push('OLLAMA_ENDPOINT');
    if (!config.model) missingVars.push('OLLAMA_MODEL');
    return {
      provider: 'local',
      configured: missingVars.length === 0,
      hasApiKey: true, // local doesn't need a real key
      hasEndpoint: Boolean(config.endpoint),
      hasModel: Boolean(config.model),
      model: config.model ?? null,
      endpoint: config.endpoint ?? null,
      missingVars,
    };
  },

  async chatCompletion(_opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
    throw new AiApiError(
      'Local provider no está implementado aún. Usa AI_PROVIDER=openai por ahora.',
      'unknown'
    );
  },

  async *chatCompletionStream(_opts: ChatCompletionOptions): AsyncGenerator<StreamChunk> {
    throw new AiApiError(
      'Local provider no está implementado aún. Usa AI_PROVIDER=openai por ahora.',
      'unknown'
    );
    yield {}; // unreachable, satisfies generator type
  },

  async testConnection(): Promise<ConnectionTestResult> {
    const config = getProviderConfig('local');
    return {
      success: false,
      model: config.model ?? 'llama3.1',
      latencyMs: 0,
      tokensUsed: 0,
      error: 'Local provider no está implementado aún.',
      errorCode: 'unknown',
    };
  },
};
