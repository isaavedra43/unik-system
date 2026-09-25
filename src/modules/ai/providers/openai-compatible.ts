import OpenAI from 'openai';
import type {
  AiProvider,
  ChatCompletionOptions,
  ChatCompletionResult,
  ChatMessage,
  ConnectionTestResult,
  ProviderId,
  ProviderStatus,
  StreamChunk,
  ToolSpec,
} from './types';
import { AiApiError } from './types';
import { recordAiApiCall } from '../ai-audit';
import { getProviderConfig } from '../ai-config';
import { getModelById } from '../model-catalog';
import { buildGenerationParams } from './openai';
import { createThinkFilter, stripThink } from './think-filter';

/**
 * Provider for any OpenAI-compatible inference API (Canopy Wave, vLLM/SGLang hosts…).
 *
 * Same wire format as providers/openai.ts, with the differences open-model hosts need:
 * - its own API key and base URL (never the OpenAI ones);
 * - `<think>` reasoning blocks are stripped from the answer (also while streaming);
 * - content parts the model cannot read (PDF `file` parts, images for text-only models) are
 *   replaced by a short notice instead of failing the whole request;
 * - `listRemoteModels()` reads GET /models so the admin can detect what the key gives access to.
 */

export interface OpenAiCompatibleOptions {
  id: ProviderId;
  label: string;
  defaultEndpoint: string;
  apiKeyEnv: string;
  defaultModel: string;
  /** Extra headers on every request (e.g. OpenRouter HTTP-Referer / X-Title). */
  defaultHeaders?: Record<string, string>;
}

export interface OpenAiCompatibleProvider extends AiProvider {
  readonly defaultEndpoint: string;
  readonly defaultModel: string;
  /** Model ids the configured key can use (GET /models). */
  listRemoteModels(): Promise<string[]>;
  /** Runs a tiny completion with a specific model. */
  testModel(model: string): Promise<ConnectionTestResult>;
}

/** Same guard as providers/openai.ts; the orchestrator already offers fewer. */
const MAX_TOOLS = 128;

function classifyError(err: unknown): AiApiError {
  if (err instanceof AiApiError) return err;
  const message = err instanceof Error ? err.message : 'Unknown error';
  const status = (err as { status?: number })?.status;
  if (status === 429) return new AiApiError(message, 'rate_limit', 429);
  if (status === 401 || status === 403) return new AiApiError(message, 'auth', status);
  if (status && status >= 500) return new AiApiError(message, 'server', status);
  if (message.toLowerCase().includes('timeout')) return new AiApiError(message, 'timeout');
  return new AiApiError(message, 'unknown', status);
}

/** Replaces parts the model can't read with a notice the model can relay. Pure. */
export function adaptMessagesForModel(messages: ChatMessage[], supportsVision: boolean): ChatMessage[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const content = m.content.map((part) => {
      if (part.type === 'file') {
        return {
          type: 'text' as const,
          text: `[Adjunto "${part.file.filename}": este modelo no lee PDFs escaneados. Pide al usuario el texto o una foto de la página.]`,
        };
      }
      if (part.type === 'image_url' && !supportsVision) {
        return { type: 'text' as const, text: '[Imagen adjunta: este modelo no puede ver imágenes. Pide al usuario que describa lo que muestra.]' };
      }
      return part;
    });
    return { ...m, content };
  });
}

function toTools(tools?: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return (tools.length > MAX_TOOLS ? tools.slice(0, MAX_TOOLS) : tools) as unknown as OpenAI.Chat.Completions.ChatCompletionTool[];
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): OpenAiCompatibleProvider {
  let client: OpenAI | null = null;
  let cachedKey: string | null = null;
  let cachedEndpoint: string | null = null;

  async function resolveConfig() {
    const config = await getProviderConfig(options.id);
    return {
      apiKey: config.apiKey,
      endpoint: config.endpoint || options.defaultEndpoint,
      model: config.model || options.defaultModel,
    };
  }

  async function getClient(): Promise<OpenAI> {
    const config = await resolveConfig();
    if (!config.apiKey) {
      throw new AiApiError(
        `Falta la API key de ${options.label}. Pégala en Administración → Asistente IA → Proveedores.`,
        'auth'
      );
    }
    if (client && cachedKey === config.apiKey && cachedEndpoint === config.endpoint) return client;
    client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.endpoint,
      timeout: 180_000,
      maxRetries: 2,
      ...(options.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
    });
    cachedKey = config.apiKey;
    cachedEndpoint = config.endpoint;
    return client;
  }

  const supportsVision = (model: string) => getModelById(model)?.capabilities.includes('vision') ?? false;

  // OpenRouter normalizes reasoning params (reasoning_effort, max_completion_tokens)
  // per vendor, so prefixed heavy ids get them there; every other compatible
  // server keeps the classic pair unless the bare id is a known reasoning model.
  const generationParams = (
    model: string,
    opts: Pick<ChatCompletionOptions, 'temperature' | 'maxTokens' | 'reasoningEffort'>
  ): Record<string, unknown> =>
    options.id === 'openrouter'
      ? buildGenerationParams(model, opts)
      : { temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens ?? 2000 };

  const provider: OpenAiCompatibleProvider = {
    id: options.id,
    label: options.label,
    defaultEndpoint: options.defaultEndpoint,
    defaultModel: options.defaultModel,

    async getStatus(): Promise<ProviderStatus> {
      const config = await resolveConfig();
      const missingVars = config.apiKey ? [] : [options.apiKeyEnv];
      return {
        provider: options.id,
        configured: missingVars.length === 0,
        hasApiKey: Boolean(config.apiKey),
        hasEndpoint: true,
        hasModel: Boolean(config.model),
        model: config.model,
        endpoint: config.endpoint,
        missingVars,
      };
    },

    async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
      const config = await resolveConfig();
      const model = opts.model ?? config.model;
      const c = await getClient();
      const start = Date.now();
      try {
        const response = await c.chat.completions.create({
          model,
          messages: adaptMessagesForModel(opts.messages, supportsVision(model)) as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          tools: toTools(opts.tools),
          // Reasoning params go through OpenRouter (it normalizes them per vendor)
          // or bare reasoning ids; other compatible servers keep classic params —
          // some reject max_completion_tokens outright.
          ...generationParams(model, opts),
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
        const content = choice?.message?.content;
        return {
          content: content ? stripThink(content) : null,
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
        await recordAiApiCall({
          userId: opts.userId,
          conversationId: opts.conversationId,
          deployment: model,
          durationMs: Date.now() - start,
          success: false,
          errorCode: apiErr.code,
        });
        throw apiErr;
      }
    },

    async *chatCompletionStream(opts: ChatCompletionOptions): AsyncGenerator<StreamChunk> {
      const config = await resolveConfig();
      const model = opts.model ?? config.model;
      const c = await getClient();
      const start = Date.now();
      try {
        const tools = toTools(opts.tools);
        const choice = opts.toolChoice && opts.toolChoice !== 'auto' ? opts.toolChoice : null;
        const forced = choice && tools?.some((t) => t.type === 'function' && t.function.name === choice.function.name) ? choice : null;
        const stream = await c.chat.completions.create({
          model,
          messages: adaptMessagesForModel(opts.messages, supportsVision(model)) as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          tools,
          ...(forced ? { tool_choice: forced } : {}),
          ...generationParams(model, opts),
          stream: true,
          stream_options: { include_usage: true },
        });

        // Think bodies become reasoning chunks: the user can watch the model work
        // instead of the thinking being silently stripped.
        const reasoningQueue: string[] = [];
        const think = createThinkFilter((t) => reasoningQueue.push(t));
        const accumulated = new Map<number, { id: string; name: string; arguments: string }>();
        let finishReason: string | undefined;
        let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta;
          // OpenRouter/DeepSeek-style reasoning channels (not part of the answer).
          const reasoningDelta =
            (delta as unknown as { reasoning?: unknown; reasoning_content?: unknown })?.reasoning ??
            (delta as unknown as { reasoning_content?: unknown })?.reasoning_content;
          if (typeof reasoningDelta === 'string' && reasoningDelta) {
            yield { reasoning: reasoningDelta };
          }
          if (delta?.content) {
            const visible = think.push(delta.content);
            for (const r of reasoningQueue.splice(0)) yield { reasoning: r };
            if (visible) yield { delta: visible };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = accumulated.get(idx);
              accumulated.set(idx, {
                id: tc.id ?? existing?.id ?? `call_${idx}_${Date.now()}`,
                name: tc.function?.name ?? existing?.name ?? '',
                arguments: (existing?.arguments ?? '') + (tc.function?.arguments ?? ''),
              });
            }
          }
          if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          if (chunk.usage) {
            usage = {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
            };
          }
        }

        const rest = think.flush();
        if (rest) yield { delta: rest };
        const toolCalls = [...accumulated.values()].filter((t) => t.name);
        yield toolCalls.length > 0 ? { toolCalls, finishReason, usage } : { finishReason, usage };

        await recordAiApiCall({
          userId: opts.userId,
          conversationId: opts.conversationId,
          deployment: model,
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
          durationMs: Date.now() - start,
          success: true,
          finishReason: finishReason ?? null,
        });
      } catch (err) {
        const apiErr = classifyError(err);
        await recordAiApiCall({
          userId: opts.userId,
          conversationId: opts.conversationId,
          deployment: model,
          durationMs: Date.now() - start,
          success: false,
          errorCode: apiErr.code,
        });
        throw apiErr;
      }
    },

    async testModel(model: string): Promise<ConnectionTestResult> {
      const start = Date.now();
      try {
        const result = await provider.chatCompletion({
          messages: [{ role: 'user', content: 'Responde solo con la palabra: OK' }],
          maxTokens: 400,
          temperature: 0,
          model,
        });
        return { success: true, model, latencyMs: Date.now() - start, tokensUsed: result.totalTokens };
      } catch (err) {
        const apiErr = classifyError(err);
        return { success: false, model, latencyMs: Date.now() - start, tokensUsed: 0, error: apiErr.message, errorCode: apiErr.code };
      }
    },

    async testConnection(): Promise<ConnectionTestResult> {
      const config = await resolveConfig();
      return provider.testModel(config.model);
    },

    async listRemoteModels(): Promise<string[]> {
      const c = await getClient();
      try {
        const ids: string[] = [];
        for await (const m of c.models.list()) ids.push(m.id);
        return [...new Set(ids)].sort();
      } catch (err) {
        throw classifyError(err);
      }
    },
  };

  return provider;
}
