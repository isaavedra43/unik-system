import OpenAI from 'openai';
import type {
  ChatCompletionOptions,
  ChatCompletionResult,
  StreamChunk,
  ConnectionTestResult,
  ProviderStatus,
  AiProvider,
  ChatMessage,
  ToolSpec,
} from './types';
import { AiApiError } from './types';
import { recordAiApiCall } from '../ai-audit';
import { getProviderConfig } from '../ai-config';

/**
 * OpenAI direct API provider.
 *
 * Uses the official `openai` npm package against https://api.openai.com.
 * Supports GPT-4o, GPT-4o-mini, GPT-4.1, o1, o3-mini, etc.
 *
 * Config is read from DB (admin panel) with env var fallback.
 * The client is cached but recreated if the API key or endpoint changes.
 *
 * Data privacy: OpenAI does NOT train on API data by default since March 2023.
 * See https://openai.com/business-data/
 */

let client: OpenAI | null = null;
let cachedKey: string | null = null;
let cachedEndpoint: string | null = null;

async function getClient(): Promise<OpenAI> {
  const config = await getProviderConfig('openai');
  if (!config.apiKey) {
    throw new AiApiError('OPENAI_API_KEY no está configurada. Configúrala en el panel admin o en variables de entorno.', 'auth');
  }
  // Recreate client if key or endpoint changed (e.g. admin updated config)
  if (client && cachedKey === config.apiKey && cachedEndpoint === config.endpoint) {
    return client;
  }
  client = new OpenAI({
    apiKey: config.apiKey,
    ...(config.endpoint ? { baseURL: config.endpoint } : {}),
  });
  cachedKey = config.apiKey;
  cachedEndpoint = config.endpoint;
  return client;
}

function classifyError(err: unknown): AiApiError {
  if (err instanceof AiApiError) return err;
  const message = err instanceof Error ? err.message : 'Unknown error';
  const status = (err as { status?: number })?.status;
  if (status === 429) return new AiApiError(message, 'rate_limit', 429);
  if (status === 401 || status === 403) return new AiApiError(message, 'auth', status);
  if (status && status >= 500) return new AiApiError(message, 'server', status);
  if (message.toLowerCase().includes('timeout')) return new AiApiError(message, 'timeout');
  return new AiApiError(message, 'unknown');
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
}

function toOpenAITools(tools?: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[];
}

export const openaiProvider: AiProvider = {
  id: 'openai',
  label: 'OpenAI (ChatGPT API)',

  async getStatus(): Promise<ProviderStatus> {
    const config = await getProviderConfig('openai');
    const missingVars: string[] = [];
    if (!config.apiKey) missingVars.push('OPENAI_API_KEY');
    if (!config.model) missingVars.push('OPENAI_MODEL');
    return {
      provider: 'openai',
      configured: missingVars.length === 0,
      hasApiKey: Boolean(config.apiKey),
      hasEndpoint: Boolean(config.endpoint),
      hasModel: Boolean(config.model),
      model: config.model ?? null,
      endpoint: config.endpoint ?? null,
      missingVars,
    };
  },

  async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
    const config = await getProviderConfig('openai');
    const model = opts.model ?? config.model ?? 'gpt-4o';
    const c = await getClient();
    const start = Date.now();

    try {
      const response = await c.chat.completions.create({
        model,
        messages: toOpenAIMessages(opts.messages),
        tools: toOpenAITools(opts.tools),
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 2000,
      });

      const choice = response.choices[0];
      const usage = response.usage;
      const durationMs = Date.now() - start;
      const promptTokens = usage?.prompt_tokens ?? 0;
      const completionTokens = usage?.completion_tokens ?? 0;
      const totalTokens = usage?.total_tokens ?? 0;

      await recordAiApiCall({
        userId: opts.userId,
        conversationId: opts.conversationId,
        deployment: model,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
        success: true,
        finishReason: choice?.finish_reason ?? null,
      });

      const toolCalls = choice?.message?.tool_calls?.map((tc) => {
        const fn = (tc as { function: { name: string; arguments: string } }).function;
        return { id: tc.id, name: fn.name, arguments: fn.arguments };
      });

      return {
        content: choice?.message?.content ?? null,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: choice?.finish_reason ?? 'stop',
        promptTokens,
        completionTokens,
        totalTokens,
        model,
        durationMs,
      };
    } catch (err) {
      const apiErr = classifyError(err);
      const durationMs = Date.now() - start;
      await recordAiApiCall({
        userId: opts.userId,
        conversationId: opts.conversationId,
        deployment: model,
        durationMs,
        success: false,
        errorCode: apiErr.code,
      });
      throw apiErr;
    }
  },

  async *chatCompletionStream(opts: ChatCompletionOptions): AsyncGenerator<StreamChunk> {
    const config = await getProviderConfig('openai');
    const model = opts.model ?? config.model ?? 'gpt-4o';
    const c = await getClient();
    const start = Date.now();

    try {
      const stream = await c.chat.completions.create({
        model,
        messages: toOpenAIMessages(opts.messages),
        tools: toOpenAITools(opts.tools),
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 2000,
        stream: true,
        stream_options: { include_usage: true },
      });

      const accumulatedToolCalls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let finishReason: string | undefined;
      let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          yield { delta: choice.delta.content };
        }
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing = accumulatedToolCalls.get(idx);
            const id = tc.id ?? existing?.id ?? '';
            const name = tc.function?.name ?? existing?.name ?? '';
            const args = (tc.function?.arguments ?? '') + (existing?.arguments ?? '');
            accumulatedToolCalls.set(idx, { id, name, arguments: args });
          }
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
        }
      }

      if (accumulatedToolCalls.size > 0) {
        yield { toolCalls: [...accumulatedToolCalls.values()], finishReason, usage };
      } else {
        yield { finishReason, usage };
      }

      const durationMs = Date.now() - start;
      await recordAiApiCall({
        userId: opts.userId,
        conversationId: opts.conversationId,
        deployment: model,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        durationMs,
        success: true,
        finishReason: finishReason ?? null,
      });
    } catch (err) {
      const apiErr = classifyError(err);
      const durationMs = Date.now() - start;
      await recordAiApiCall({
        userId: opts.userId,
        conversationId: opts.conversationId,
        deployment: model,
        durationMs,
        success: false,
        errorCode: apiErr.code,
      });
      throw apiErr;
    }
  },

  async testConnection(): Promise<ConnectionTestResult> {
    const config = await getProviderConfig('openai');
    const model = config.model ?? 'gpt-4o';
    const start = Date.now();
    try {
      const result = await this.chatCompletion({
        messages: [{ role: 'user', content: 'Responde solo con la palabra: OK' }],
        maxTokens: 10,
        model,
      });
      return {
        success: true,
        model,
        latencyMs: Date.now() - start,
        tokensUsed: result.totalTokens,
      };
    } catch (err) {
      const apiErr = classifyError(err);
      return {
        success: false,
        model,
        latencyMs: Date.now() - start,
        tokensUsed: 0,
        error: apiErr.message,
        errorCode: apiErr.code,
      };
    }
  },

  /**
   * Speech-to-Text: transcribe audio using Whisper.
   * Accepts an audio buffer (webm/wav/mp3) and returns text.
   */
  async transcribe(audio: Buffer, mimeType: string, model?: string): Promise<string> {
    const client = await getClient();
    const sttModel = model ?? 'whisper-1';
    const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp3') ? 'mp3' : 'wav';
    try {
      const result = await client.audio.transcriptions.create({
        file: new File([new Uint8Array(audio)], `audio.${ext}`, { type: mimeType }),
        model: sttModel,
        language: 'es',
      });
      return result.text;
    } catch (err) {
      throw classifyError(err);
    }
  },

  /**
   * Text-to-Speech: generate audio from text using OpenAI TTS.
   * Returns an audio buffer (mp3).
   */
  async speak(text: string, voice?: string): Promise<Buffer> {
    const client = await getClient();
    const VALID_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral', 'verse', 'ballad', 'ash', 'sage', 'marin', 'cedar'];
    let ttsVoice = voice ?? 'coral';
    if (!VALID_VOICES.includes(ttsVoice)) {
      ttsVoice = 'coral';
    }
    try {
      const mp3 = await client.audio.speech.create({
        model: 'gpt-4o-mini-tts',
        voice: ttsVoice,
        input: text,
        response_format: 'mp3',
      });
      const arrayBuffer = await mp3.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      throw classifyError(err);
    }
  },
};
