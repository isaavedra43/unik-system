/**
 * ai-client.ts — thin backwards-compatible shim.
 *
 * All real work is delegated to the active AI provider (see ./providers).
 * This file preserves the exports the orchestrator and admin tooling already
 * import (ChatMessage, ToolSpec, chatCompletion, chatCompletionStream,
 * testAiConnection, AiApiError) so changing providers does not require
 * touching the orchestrator.
 *
 * The canonical types live in ./providers/types and are re-exported here.
 *
 * When a model override is provided (user selects a model in the chat UI),
 * the correct provider for that model is resolved automatically.
 */

import { getActiveProvider, getProvider } from './providers';
import { getProviderForModelId } from './ai-config';
import type { ProviderId } from './providers/types';
import type {
  ChatMessage,
  ToolSpec,
  ChatCompletionOptions,
  ChatCompletionResult,
  StreamChunk,
  ConnectionTestResult,
  ContentPart,
} from './providers/types';
export { AiApiError } from './providers/types';
export type { ChatMessage, ToolSpec, ChatCompletionOptions, ChatCompletionResult, StreamChunk, ContentPart };

/**
 * Resolves the provider to use based on the optional model override.
 * If no model is specified, uses the default (active) provider.
 * If a model is specified, looks up which provider owns that model.
 */
async function resolveProvider(model?: string) {
  if (!model) {
    return getActiveProvider();
  }
  const providerId = await getProviderForModelId(model);
  return getProvider(providerId as ProviderId);
}

/**
 * One-shot chat completion. Delegates to the active provider,
 * or the provider that owns the specified model.
 */
export async function chatCompletion(
  opts: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const provider = await resolveProvider(opts.model);
  return provider.chatCompletion(opts);
}

/**
 * Streaming chat completion. Delegates to the active provider,
 * or the provider that owns the specified model.
 */
export async function* chatCompletionStream(
  opts: ChatCompletionOptions
): AsyncGenerator<StreamChunk> {
  const provider = await resolveProvider(opts.model);
  yield* provider.chatCompletionStream(opts);
}

/**
 * Connection test for the admin panel. Delegates to the active provider.
 * Returns a shape compatible with the previous contract
 * (uses `deployment` as the model identifier for backwards compatibility).
 */
export async function testAiConnection(): Promise<{
  success: boolean;
  deployment: string;
  latencyMs: number;
  tokensUsed: number;
  error?: string;
  errorCode?: string;
}> {
  const provider = await getActiveProvider();
  const result: ConnectionTestResult = await provider.testConnection();
  return {
    success: result.success,
    deployment: result.model,
    latencyMs: result.latencyMs,
    tokensUsed: result.tokensUsed,
    error: result.error,
    errorCode: result.errorCode,
  };
}
