import { describe, expect, it } from 'vitest';
import { buildGenerationParams, isReasoningModel } from './openai';

describe('OpenAI reasoning-model parameters', () => {
  it('recognizes GPT-5 and o-series ids', () => {
    expect(isReasoningModel('gpt-5')).toBe(true);
    expect(isReasoningModel('gpt-5-mini')).toBe(true);
    expect(isReasoningModel('gpt-5.1')).toBe(true);
    expect(isReasoningModel('o3-mini')).toBe(true);
    expect(isReasoningModel('o1')).toBe(true);
    expect(isReasoningModel('gpt-4o')).toBe(false);
    expect(isReasoningModel('gpt-4.1-mini')).toBe(false);
  });

  it('recognizes vendor-prefixed reasoning ids through the catalog', () => {
    // OpenRouter ids carry the vendor prefix; the catalog declares reasoning.
    expect(isReasoningModel('openai/gpt-5.2')).toBe(true);
    expect(isReasoningModel('anthropic/claude-opus-4.5')).toBe(true);
    expect(isReasoningModel('x-ai/grok-4')).toBe(true);
    expect(isReasoningModel('google/gemini-2.5-flash')).toBe(true);
    // Prefixed catalog ids without the reasoning capability stay classic.
    expect(isReasoningModel('deepseek/deepseek-chat-v3.1')).toBe(false);
    // Unknown prefixed ids fall back to the tail pattern.
    expect(isReasoningModel('vendor/o3-something')).toBe(true);
    expect(isReasoningModel('vendor/llama-4')).toBe(false);
  });

  it('sends max_completion_tokens + reasoning_effort and never temperature to reasoning models', () => {
    expect(buildGenerationParams('gpt-5', { temperature: 0.4, maxTokens: 32_000, reasoningEffort: 'high' })).toEqual({
      max_completion_tokens: 32_000,
      reasoning_effort: 'high',
    });
    expect(buildGenerationParams('o3-mini', { maxTokens: 500 })).toEqual({ max_completion_tokens: 500 });
    expect(buildGenerationParams('o3-mini', { maxTokens: 500, reasoningEffort: 'minimal' })).toEqual({ max_completion_tokens: 500, reasoning_effort: 'low' });
    expect(buildGenerationParams('gpt-5-mini', { maxTokens: 500, reasoningEffort: 'minimal' })).toEqual({ max_completion_tokens: 500, reasoning_effort: 'minimal' });
  });

  it('keeps the classic parameters for GPT-4o', () => {
    expect(buildGenerationParams('gpt-4o', { temperature: 0.4, maxTokens: 6000, reasoningEffort: 'high' })).toEqual({ temperature: 0.4, max_tokens: 6000 });
    expect(buildGenerationParams('gpt-4o-mini', {})).toEqual({ temperature: 0.3, max_tokens: 2000 });
  });
});
