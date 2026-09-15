import type { ToolChoice } from './types';

/**
 * Canonical `toolChoice` → the wire field each provider expects. Pure, so every provider maps it
 * the same way:
 *
 *   canonical                     OpenAI / OpenAI-compatible / local   Anthropic                Gemini (toolConfig)
 *   undefined | 'auto'            omitted (API default: auto)          omitted                  omitted
 *   'required'                    'required'                           { type: 'any' }          { functionCallingConfig: { mode: 'ANY' } }
 *   { function: { name } }        { type: 'function', function }       { type: 'tool', name }   { mode: 'ANY', allowedFunctionNames: [name] }
 *
 * Nothing is sent when the call offers no tools (the APIs reject a tool choice without tools), and a
 * forced function that is not among the offered tools is dropped so the model decides — the same
 * guard providers/openai.ts applied before this helper existed.
 */

export type OpenAiToolChoice = 'required' | { type: 'function'; function: { name: string } };

export type AnthropicToolChoice = { type: 'any' } | { type: 'tool'; name: string };

export interface GeminiToolConfig {
  functionCallingConfig: { mode: 'ANY'; allowedFunctionNames?: string[] };
}

type ResolvedChoice = { kind: 'required' } | { kind: 'function'; name: string } | null;

function resolveToolChoice(
  choice: ToolChoice | undefined,
  toolNames: readonly string[]
): ResolvedChoice {
  if (!choice || choice === 'auto' || toolNames.length === 0) return null;
  if (choice === 'required') return { kind: 'required' };
  return toolNames.includes(choice.function.name)
    ? { kind: 'function', name: choice.function.name }
    : null;
}

/** Names of the function tools actually sent on the request (after any truncation). */
export function toolNamesOf(tools: ReadonlyArray<unknown> | undefined): string[] {
  const names: string[] = [];
  for (const tool of tools ?? []) {
    const t = tool as { type?: unknown; function?: { name?: unknown } } | null;
    if (t?.type === 'function' && typeof t.function?.name === 'string') names.push(t.function.name);
  }
  return names;
}

/** OpenAI Chat Completions `tool_choice` (also OpenAI-compatible hosts and local runtimes). `undefined` = omit the field. */
export function toOpenAiToolChoice(
  choice: ToolChoice | undefined,
  toolNames: readonly string[]
): OpenAiToolChoice | undefined {
  const resolved = resolveToolChoice(choice, toolNames);
  if (!resolved) return undefined;
  return resolved.kind === 'required'
    ? 'required'
    : { type: 'function', function: { name: resolved.name } };
}

/** Anthropic Messages `tool_choice`. `undefined` = omit the field. */
export function toAnthropicToolChoice(
  choice: ToolChoice | undefined,
  toolNames: readonly string[]
): AnthropicToolChoice | undefined {
  const resolved = resolveToolChoice(choice, toolNames);
  if (!resolved) return undefined;
  return resolved.kind === 'required' ? { type: 'any' } : { type: 'tool', name: resolved.name };
}

/** Gemini `toolConfig`. `undefined` = omit the field. */
export function toGeminiToolConfig(
  choice: ToolChoice | undefined,
  toolNames: readonly string[]
): GeminiToolConfig | undefined {
  const resolved = resolveToolChoice(choice, toolNames);
  if (!resolved) return undefined;
  return resolved.kind === 'required'
    ? { functionCallingConfig: { mode: 'ANY' } }
    : { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [resolved.name] } };
}
