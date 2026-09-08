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
 */

import { getActiveProvider } from './providers';
import type {
  ChatMessage,
  ToolSpec,
  ChatCompletionOptions,
  ChatCompletionResult,
  StreamChunk,
  ConnectionTestResult,
} from './providers/types';
export { AiApiError } from './providers/types';
export type { ChatMessage, ToolSpec, ChatCompletionOptions, ChatCompletionResult, StreamChunk };

/**
 * One-shot chat completion. Delegates to the active provider.
 */
export async function chatCompletion(
  opts: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const provider = getActiveProvider();
  return provider.chatCompletion(opts);
}

/**
 * Streaming chat completion. Delegates to the active provider.
 */
export async function* chatCompletionStream(
  opts: ChatCompletionOptions
): AsyncGenerator<StreamChunk> {
  const provider = getActiveProvider();
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
  const provider = getActiveProvider();
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
