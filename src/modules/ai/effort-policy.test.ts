import { describe, expect, it } from 'vitest';
import { planEffort, parseEffort, estimateCostUsd, type EffortPlanInput } from './effort-policy';
import type { TaskClassification } from './model-router';
import type { ProviderId } from './providers/types';
import { getModelById } from './model-catalog';

const settings: EffortPlanInput['settings'] = {
  deployment: 'gpt-5',
  fallbackDeployment: 'gpt-4o-mini',
  routingEnabled: true,
  routingSimpleModel: 'gpt-4o-mini',
  routingStandardModel: 'gpt-5-mini',
  routingComplexModel: 'gpt-5',
  computerUseModel: '',
  providerConfigs: {} as EffortPlanInput['settings']['providerConfigs'],
  maxToolIterations: 10,
  maxToolsPerTurn: 96,
  reasoningEffort: 'medium',
  answerReviewEnabled: true,
};

const standard: TaskClassification = {
  tier: 'standard',
  reason: 'consulta de ventas',
  needsVision: false,
  computer: false,
};

function plan(over: Partial<EffortPlanInput> = {}) {
  return planEffort({
    level: 'medium',
    classification: standard,
    settings,
    configured: ['openai'],
    providerOf: (id) => getModelById(id)?.provider ?? (id.includes('/') ? 'canopywave' : 'openai'),
    ...over,
  });
}

describe('parseEffort', () => {
  it('maps the legacy "auto" to the balanced level and rejects unknown values', () => {
    expect(parseEffort('auto')).toBe('medium');
    expect(parseEffort('ULTRA')).toBe('ultra');
    expect(parseEffort('turbo')).toBeNull();
    expect(parseEffort(undefined)).toBeNull();
  });
});

describe('planEffort', () => {
  it('makes each level perceptibly different', () => {
    const instant = plan({ level: 'instant' });
    const light = plan({ level: 'light' });
    const medium = plan({ level: 'medium' });
    const high = plan({ level: 'high' });
    const ultra = plan({ level: 'ultra' });

    expect(instant.model).toBe('gpt-4o-mini');
    expect(instant.reasoningEffort).toBe('minimal');
    expect(instant.maxIterations).toBeLessThanOrEqual(4);
    expect(instant.checks).toBe(0);
    expect(instant.review).toBe('never');

    expect(light.model).toBe('gpt-5-mini');
    expect(light.checks).toBe(1);

    expect(medium.model).toBe('gpt-5-mini'); // standard turn → everyday model
    expect(medium.confidenceEscalation).toBe(true);

    expect(high.model).toBe('gpt-5');
    expect(high.reasoningEffort).toBe('high');
    expect(high.maxIterations).toBeGreaterThanOrEqual(16);

    expect(ultra.reasoningEffort).toBe('high');
    expect(ultra.review).toBe('always');
    expect(ultra.maxIterations).toBeGreaterThanOrEqual(24);
    // The strongest servable model (power 10) — never a weaker one.
    expect(getModelById(ultra.model)?.power).toBe(10);
  });

  it('medium follows the tier (Jev or heuristic)', () => {
    expect(plan({ classification: { ...standard, tier: 'simple' } }).model).toBe('gpt-4o-mini');
    expect(plan({ classification: { ...standard, tier: 'complex' } }).model).toBe('gpt-5');
  });

  it('never routes to a provider without credentials', () => {
    const p = plan({
      level: 'instant',
      settings: { ...settings, routingSimpleModel: 'moonshotai/kimi-k2.6' },
      configured: ['openai'],
    });
    expect(p.candidates).not.toContain('moonshotai/kimi-k2.6');
    expect(p.model).not.toBe('moonshotai/kimi-k2.6');
  });

  it('keeps a fallback chain and puts failing models last', () => {
    const p = plan({ level: 'high', healthy: (m) => m !== 'gpt-5' });
    expect(p.model).not.toBe('gpt-5');
    expect(p.candidates.length).toBeGreaterThan(1);
    expect(p.candidates[p.candidates.length - 1]).toBe('gpt-5');
  });

  it('respects an explicit pick and says so when it cannot be served', () => {
    const own = plan({ explicitModel: 'gpt-4.1' });
    expect(own.model).toBe('gpt-4.1');
    expect(own.routed).toBe(false);
    expect(own.reason).toBe('Modelo elegido por ti');

    const unavailable = plan({ explicitModel: 'claude-sonnet-4-5' });
    expect(unavailable.model).not.toBe('claude-sonnet-4-5');
    expect(unavailable.reason).toMatch(/no está disponible/);
  });

  it('requires vision when the turn carries images or documents', () => {
    const configured: ProviderId[] = ['openai', 'canopywave'];
    const p = plan({
      level: 'light',
      configured,
      settings: { ...settings, routingStandardModel: 'moonshotai/kimi-k2.6' },
      classification: { ...standard, needsVision: true },
    });
    expect(getModelById(p.model)?.capabilities).toContain('vision');
  });
});

describe('estimateCostUsd', () => {
  it('prices known models and returns null for unknown ones', () => {
    expect(estimateCostUsd('gpt-5', 1_000_000, 0)).toBeCloseTo(1.25);
    expect(estimateCostUsd('custom-model', 100, 100)).toBeNull();
  });
});
