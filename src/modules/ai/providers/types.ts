/**
 * Provider-agnostic AI interfaces.
 *
 * Every AI provider (OpenAI, Anthropic, Google, local) implements these
 * interfaces so the orchestrator and admin tooling can switch providers
 * without changing business logic.
 *
 * The internal message/tool format mirrors the OpenAI Chat Completions
 * schema because it is the most widely supported and is what the
 * orchestrator already uses. Providers that use a different wire format
 * (e.g. Anthropic) are responsible for adapting in their implementation.
 */

export type ProviderId = 'openai' | 'canopywave' | 'anthropic' | 'gemini' | 'local';

export const PROVIDER_IDS: ProviderId[] = ['openai', 'canopywave', 'anthropic', 'gemini', 'local'];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI (ChatGPT API)',
  canopywave: 'Canopy Wave',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google (Gemini)',
  local: 'Local (Ollama / LM Studio)',
};

/** Content part for multimodal messages (OpenAI Vision format). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  /** Whole document (PDF as data URL) for models that read files natively — used as OCR fallback. */
  | { type: 'file'; file: { filename: string; file_data: string } };

/** A single chat message in the canonical (OpenAI-style) format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** A tool/function spec in the canonical (OpenAI-style) format. */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Canonical tool-calling policy (see `ChatCompletionOptions.toolChoice`). */
export type ToolChoice = 'auto' | 'required' | { type: 'function'; function: { name: string } };

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  userId?: string;
  conversationId?: string;
  /** Override the configured model for this call. */
  model?: string;
  /**
   * Tool-calling policy for this call: 'auto' (default) lets the model decide, 'required' makes it
   * call at least one of the offered tools, and `{ type: 'function', function: { name } }` forces
   * that tool. Each provider maps it to its own wire field (providers/tool-choice.ts).
   */
  toolChoice?: ToolChoice;
  /** Thinking budget for reasoning models (GPT-5 / o-series); ignored by the others. */
  reasoningEffort?: ReasoningEffort;
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ChatCompletionResult {
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  durationMs: number;
}

export interface StreamChunk {
  delta?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface ConnectionTestResult {
  success: boolean;
  model: string;
  latencyMs: number;
  tokensUsed: number;
  error?: string;
  errorCode?: string;
}

/** Status of a provider's configuration, without exposing secrets. */
export interface ProviderStatus {
  provider: ProviderId;
  configured: boolean;
  hasApiKey: boolean;
  hasEndpoint: boolean;
  hasModel: boolean;
  model: string | null;
  endpoint: string | null;
  missingVars: string[];
}

/**
 * Every AI provider implements this interface.
 * The orchestrator only depends on this interface, never on a concrete SDK.
 */
export interface AiProvider {
  readonly id: ProviderId;
  readonly label: string;

  /** Non-secret status for the admin health panel. */
  getStatus(): Promise<ProviderStatus>;

  /** One-shot completion (used by the admin connection test). */
  chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult>;

  /** Streaming completion (used by the chat orchestrator). */
  chatCompletionStream(opts: ChatCompletionOptions): AsyncGenerator<StreamChunk>;

  /** Lightweight connection test for the admin panel. */
  testConnection(): Promise<ConnectionTestResult>;

  /** Speech-to-Text: transcribe audio buffer to text. */
  transcribe?(audio: Buffer, mimeType: string, model?: string): Promise<string>;

  /** Text-to-Speech: generate audio buffer from text. */
  speak?(text: string, voice?: string): Promise<Buffer>;

  /** Model ids the configured key can use (GET /models), when the API exposes it. */
  listRemoteModels?(): Promise<string[]>;
}

/** Error thrown by providers, with a stable code for auditing. */
export class AiApiError extends Error {
  constructor(
    message: string,
    public code: 'rate_limit' | 'auth' | 'timeout' | 'server' | 'unknown',
    public httpStatus?: number
  ) {
    super(message);
    this.name = 'AiApiError';
  }
}
