import { describe, expect, it } from 'vitest';
import { modelForTask, type ModelPolicySettings } from './model-policy';

const base: ModelPolicySettings = {
  deployment: 'gpt-4o',
  fallbackDeployment: 'gpt-4o-mini',
  routingSimpleModel: '',
  routingStandardModel: '',
  routingComplexModel: '',
  utilityModel: '',
  qualityJudgeModel: '',
  computerUseModel: '',
  providerConfigs: {},
};

describe('modelForTask', () => {
  it('unconfigured install behaves like before: everything on the primary, simple on the fallback', () => {
    expect(modelForTask(base, 'routine')).toBe('gpt-4o');
    expect(modelForTask(base, 'complex')).toBe('gpt-4o');
    expect(modelForTask(base, 'vision')).toBe('gpt-4o');
    expect(modelForTask(base, 'simple')).toBe('gpt-4o-mini');
    expect(modelForTask(base, 'utility')).toBe('gpt-4o');
    expect(modelForTask(base, 'judge')).toBe('gpt-4o');
  });

  it('cost split: routine + background on Canopy, complex on OpenAI', () => {
    const s: ModelPolicySettings = {
      ...base,
      routingSimpleModel: 'minimax/minimax-m3',
      routingStandardModel: 'moonshotai/kimi-k2.6',
      routingComplexModel: 'gpt-4o',
      utilityModel: 'minimax/minimax-m3',
    };
    expect(modelForTask(s, 'simple')).toBe('minimax/minimax-m3');
    expect(modelForTask(s, 'routine')).toBe('moonshotai/kimi-k2.6');
    expect(modelForTask(s, 'complex')).toBe('gpt-4o');
    expect(modelForTask(s, 'utility')).toBe('minimax/minimax-m3');
    expect(modelForTask(s, 'judge')).toBe('minimax/minimax-m3');
  });

  it('utility inherits the simple model, judge inherits utility', () => {
    const s = { ...base, routingSimpleModel: 'gpt-4.1-mini' };
    expect(modelForTask(s, 'utility')).toBe('gpt-4.1-mini');
    expect(modelForTask(s, 'judge')).toBe('gpt-4.1-mini');
    expect(modelForTask({ ...s, qualityJudgeModel: 'o3-mini' }, 'judge')).toBe('o3-mini');
  });

  it('vision never lands on a model without vision', () => {
    const s = { ...base, routingComplexModel: 'o3-mini' };
    expect(modelForTask(s, 'complex')).toBe('o3-mini');
    expect(modelForTask(s, 'vision')).toBe('gpt-4o');
  });
});
