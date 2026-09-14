import { describe, expect, it } from 'vitest';
import { resolveProviderForModel } from './provider-resolution';

const base = { discovered: {}, configured: ['openai', 'canopywave'] as const, defaultProvider: 'openai' as const };

describe('resolveProviderForModel', () => {
  it('uses the catalog first', () => {
    expect(resolveProviderForModel('moonshotai/kimi-k2.6', { ...base, configured: [...base.configured], catalogProvider: 'canopywave' })).toBe('canopywave');
    expect(resolveProviderForModel('gpt-4o', { ...base, configured: [...base.configured], catalogProvider: 'openai' })).toBe('openai');
  });

  it('uses models a key reported even if they are not in the catalog', () => {
    expect(
      resolveProviderForModel('zai/glm-5', { ...base, configured: [...base.configured], discovered: { canopywave: ['zai/glm-5'] } })
    ).toBe('canopywave');
  });

  it('sends unknown namespaced ids to Canopy Wave only when it is configured', () => {
    expect(resolveProviderForModel('deepseek/deepseek-chat-v3.2', { ...base, configured: [...base.configured] })).toBe('canopywave');
    expect(resolveProviderForModel('deepseek/deepseek-chat-v3.2', { ...base, configured: ['openai'] })).toBe('openai');
  });

  it('falls back to the default provider', () => {
    expect(resolveProviderForModel('gpt-5-unknown', { ...base, configured: [...base.configured] })).toBe('openai');
  });
});
