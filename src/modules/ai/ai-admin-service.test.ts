import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { estimateCost, isFlatRateModel, providerForCost } from './ai-admin-service';

/** Cost estimation, including flat-rate plans (Canopy Wave) with and without an amortized fee. */

const canopyConfigs = (extra: Record<string, unknown> = {}) => ({
  openai: { apiKey: 'k', endpoint: '', enabled: true },
  canopywave: { apiKey: 'k', endpoint: '', enabled: true, models: ['glm-5-custom'], ...extra },
});

describe('estimateCost', () => {
  it('prices OpenAI models from the pricing table', () => {
    expect(estimateCost(1_000_000, 0, 'gpt-4o')).toBeCloseTo(2.5);
    expect(estimateCost(1_000_000, 1_000_000, 'gpt-4o-mini')).toBeCloseTo(0.75);
  });

  it('falls back to the catalog price, then to gpt-4o prices', () => {
    expect(estimateCost(1_000_000, 1_000_000, 'gpt-5')).toBeCloseTo(11.25);
    expect(estimateCost(1_000_000, 0, 'my-custom-deployment')).toBeCloseTo(2.5);
  });

  it('flat-rate models cost 0 without a monthly fee (with or without settings)', () => {
    expect(estimateCost(80_000, 20_000, 'moonshotai/kimi-k2.6')).toBe(0);
    expect(estimateCost(80_000, 20_000, 'minimax/minimax-m3', { providerConfigs: canopyConfigs() })).toBe(0);
    expect(isFlatRateModel('moonshotai/kimi-k2.6')).toBe(true);
    expect(isFlatRateModel('gpt-4o')).toBe(false);
  });

  it('amortizes the monthly fee per token of the month when monthlyFeeUsd is configured', () => {
    const ctx = { providerConfigs: canopyConfigs({ monthlyFeeUsd: 300 }), flatRateMonthTokens: 3_000_000 };
    // 30k of 3M tokens of the month → 1 % of $300.
    expect(estimateCost(20_000, 10_000, 'moonshotai/kimi-k2.6', ctx)).toBeCloseTo(3);
    // Unknown month volume: the call is the only known usage, so it carries the whole fee.
    expect(
      estimateCost(20_000, 10_000, 'moonshotai/kimi-k2.6', { providerConfigs: canopyConfigs({ monthlyFeeUsd: 300 }) })
    ).toBeCloseTo(300);
    // The month total never goes below the call itself.
    expect(
      estimateCost(20_000, 10_000, 'moonshotai/kimi-k2.6', { ...ctx, flatRateMonthTokens: 1_000 })
    ).toBeCloseTo(300);
    expect(estimateCost(0, 0, 'moonshotai/kimi-k2.6', ctx)).toBe(0);
  });

  it('ignores a non-positive fee and does not amortize priced models', () => {
    expect(
      estimateCost(20_000, 10_000, 'moonshotai/kimi-k2.6', { providerConfigs: canopyConfigs({ monthlyFeeUsd: 0 }) })
    ).toBe(0);
    expect(
      estimateCost(1_000_000, 0, 'gpt-4o', {
        providerConfigs: canopyConfigs({ monthlyFeeUsd: 300 }),
        flatRateMonthTokens: 10,
      })
    ).toBeCloseTo(2.5);
  });

  it('recognizes Canopy Wave models the key reported and namespaced open-model ids', () => {
    const providerConfigs = canopyConfigs();
    expect(providerForCost('glm-5-custom', { providerConfigs })).toBe('canopywave');
    expect(providerForCost('zai/glm-5', { providerConfigs })).toBe('canopywave');
    expect(providerForCost('zai/glm-5')).toBe('canopywave');
    // Canopy Wave not enabled: a namespaced id is not assumed to be flat rate.
    expect(
      providerForCost('zai/glm-5', {
        providerConfigs: { openai: { enabled: true }, canopywave: { enabled: false } },
      })
    ).toBe('openai');
  });
});
