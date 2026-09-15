import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { AGENT_LLM_TRIGGERS, DEFAULT_AGENT_SETTINGS, normalizeAgentSettings } from './agent-settings';
import { DEFAULT_AI_SETTINGS, mergeWithDefaults } from './ai-admin-config-service';

describe('agents settings', () => {
  it('defaults: on from minute one with quiet hours, caps and every LLM trigger enabled', () => {
    expect(DEFAULT_AI_SETTINGS.agents).toEqual({
      enabled: true,
      quietHours: { start: '20:00', end: '07:00', tz: 'America/Mexico_City' },
      maxTurnsPerCasePerDay: 4,
      maxIterationsPerAutoTurn: 4,
      degradeAtPct: 80,
      alertAdminAtPct: 80,
      llmTriggers: Object.fromEntries(AGENT_LLM_TRIGGERS.map((t) => [t, true])),
    });
    expect(normalizeAgentSettings(undefined)).toEqual(DEFAULT_AGENT_SETTINGS);
  });

  it('keeps valid partial values and replaces invalid ones field by field', () => {
    const normalized = normalizeAgentSettings({
      enabled: false,
      quietHours: { start: '22:30', end: '25:00', tz: 'Mars/Olympus' },
      maxTurnsPerCasePerDay: 99,
      maxIterationsPerAutoTurn: 0,
      degradeAtPct: 70.4,
      alertAdminAtPct: 'mucho',
      llmTriggers: { digest: false, unknown_trigger: false, mention: 'no' },
    });
    expect(normalized).toMatchObject({
      enabled: false,
      quietHours: { start: '22:30', end: '07:00', tz: 'America/Mexico_City' },
      maxTurnsPerCasePerDay: 50,
      maxIterationsPerAutoTurn: 1,
      degradeAtPct: 70,
      alertAdminAtPct: 80,
    });
    expect(normalized.llmTriggers.digest).toBe(false);
    expect(normalized.llmTriggers.mention).toBe(true);
    expect(Object.keys(normalized.llmTriggers)).toEqual([...AGENT_LLM_TRIGGERS]);
  });

  it('reads rows saved with the legacy autonomous* placeholders without inheriting them', () => {
    const merged = mergeWithDefaults({
      autonomousModeEnabled: false,
      autonomousTasks: ['daily_report'],
      maxToolIterations: 7,
    }) as unknown as Record<string, unknown>;
    expect(merged.autonomousModeEnabled).toBeUndefined();
    expect(merged.autonomousTasks).toBeUndefined();
    expect(merged.maxToolIterations).toBe(7);
    expect((merged.agents as { enabled: boolean }).enabled).toBe(true);
  });

  it('merges a partial stored agents bag over the defaults', () => {
    const merged = mergeWithDefaults({ agents: { maxTurnsPerCasePerDay: 2, quietHours: { end: '06:00' } } });
    expect(merged.agents).toEqual({
      ...DEFAULT_AGENT_SETTINGS,
      maxTurnsPerCasePerDay: 2,
      quietHours: { ...DEFAULT_AGENT_SETTINGS.quietHours, end: '06:00' },
    });
  });

  it('keeps a positive flat monthly fee of a provider and drops invalid ones', () => {
    const merged = mergeWithDefaults({
      providerConfigs: {
        canopywave: { apiKey: 'k', endpoint: '', enabled: true, monthlyFeeUsd: 250 },
        openai: { apiKey: 'k', endpoint: '', enabled: true, monthlyFeeUsd: -3 },
      },
    });
    expect(merged.providerConfigs.canopywave.monthlyFeeUsd).toBe(250);
    expect('monthlyFeeUsd' in merged.providerConfigs.openai).toBe(false);
  });
});
