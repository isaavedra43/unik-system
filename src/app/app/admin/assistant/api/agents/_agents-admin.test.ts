import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_SETTINGS } from '@/modules/ai/agent-settings';
import {
  agentsPatchSchema,
  buildIdentityDraftPatch,
  identityUpdateData,
  mergeAgentSettingsPatch,
  monthStartOf,
  parseRangeDays,
  rangeEndingOn,
  summarizeAgentEvents,
} from './_agents-admin';

describe('rangos de consumo', () => {
  it('sólo acepta 7, 30 o 90 días', () => {
    expect(parseRangeDays('7')).toBe(7);
    expect(parseRangeDays('90')).toBe(90);
    expect(parseRangeDays('365')).toBe(30);
    expect(parseRangeDays(null)).toBe(30);
    expect(parseRangeDays('abc')).toBe(30);
  });

  it('calcula el rango inclusivo y el inicio de mes', () => {
    expect(rangeEndingOn('2026-09-15', 30)).toEqual({ from: '2026-08-17', to: '2026-09-15' });
    expect(rangeEndingOn('2026-03-01', 7)).toEqual({ from: '2026-02-23', to: '2026-03-01' });
    expect(rangeEndingOn('2026-09-15', 0)).toEqual({ from: '2026-09-15', to: '2026-09-15' });
    expect(monthStartOf('2026-09-15')).toBe('2026-09-01');
  });
});

describe('agentsPatchSchema', () => {
  it('acepta interruptor, disparos y cambios de identidad', () => {
    const parsed = agentsPatchSchema.safeParse({
      agents: { enabled: false, llmTriggers: { mention: false } },
      identities: [{ key: 'area:compras', mode: 'on_demand', dailyTokenBudget: 200000, monthlyCostBudgetUsd: 12.5 }],
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    [{}, 'sin cambios'],
    [{ agents: { llmTriggers: { borrar_todo: true } } }, 'disparo desconocido'],
    [{ agents: { enabled: 'sí' } }, 'tipo inválido'],
    [{ identities: [{ key: 'area:marketing', mode: 'active' }] }, 'agente desconocido'],
    [{ identities: [{ key: 'admin' }] }, 'identidad sin cambios'],
    [{ identities: [{ key: 'admin', mode: 'turbo' }] }, 'modo inválido'],
    [{ identities: [{ key: 'admin', dailyTokenBudget: -1 }] }, 'presupuesto negativo'],
    [{ identities: [{ key: 'admin', maxTurnsPerCasePerDay: 51 }] }, 'tope excedido'],
    [{ identities: [{ key: 'admin', mode: 'paused' }, { key: 'admin', mode: 'active' }] }, 'agente repetido'],
    [{ identities: [{ key: 'admin', mode: 'paused', isBot: false }] }, 'campo extra'],
    [{ agents: { enabled: true }, superAdmin: true }, 'campo extra arriba'],
  ])('rechaza %j (%s)', (body, reason) => {
    expect(agentsPatchSchema.safeParse(body).success, reason).toBe(false);
  });
});

describe('mergeAgentSettingsPatch e identityUpdateData', () => {
  it('sólo cambia lo pedido y conserva los demás disparos', () => {
    const merged = mergeAgentSettingsPatch(DEFAULT_AGENT_SETTINGS, { llmTriggers: { digest: false } });
    expect(merged.enabled).toBe(true);
    expect(merged.llmTriggers.digest).toBe(false);
    expect(merged.llmTriggers.mention).toBe(true);
    expect(merged.quietHours).toEqual(DEFAULT_AGENT_SETTINGS.quietHours);
    expect(mergeAgentSettingsPatch(DEFAULT_AGENT_SETTINGS, { enabled: false }).enabled).toBe(false);
  });

  it('manda a Prisma sólo los campos presentes, con 4 decimales', () => {
    expect(identityUpdateData({ key: 'admin', monthlyCostBudgetUsd: 12.123456 })).toEqual({ monthlyCostBudgetUsd: 12.1235 });
    expect(identityUpdateData({ key: 'admin', mode: 'paused', maxTurnsPerCasePerDay: 0 })).toEqual({
      mode: 'paused',
      maxTurnsPerCasePerDay: 0,
    });
  });
});

describe('buildIdentityDraftPatch', () => {
  const identity = { mode: 'active', dailyTokenBudget: 150000, monthlyCostBudgetUsd: 40, maxTurnsPerCasePerDay: 4 };
  const draft = { mode: 'active', dailyTokenBudget: '150000', monthlyCostBudgetUsd: '40', maxTurnsPerCasePerDay: '4' };

  it('sin cambios no hay nada que guardar', () => {
    expect(buildIdentityDraftPatch(identity, draft)).toEqual({ ok: true, patch: {} });
    expect(buildIdentityDraftPatch(identity, { ...draft, monthlyCostBudgetUsd: '40.00001' })).toEqual({ ok: true, patch: {} });
  });

  it('devuelve sólo lo que cambió', () => {
    expect(
      buildIdentityDraftPatch(identity, { mode: 'paused', dailyTokenBudget: '0', monthlyCostBudgetUsd: '12.5', maxTurnsPerCasePerDay: '4' })
    ).toEqual({ ok: true, patch: { mode: 'paused', dailyTokenBudget: 0, monthlyCostBudgetUsd: 12.5 } });
  });

  it.each([
    [{ dailyTokenBudget: '' }, 'Tokens diarios'],
    [{ dailyTokenBudget: '1.5' }, 'Tokens diarios'],
    [{ monthlyCostBudgetUsd: '-3' }, 'Costo mensual'],
    [{ maxTurnsPerCasePerDay: '99' }, 'Turnos por expediente'],
    [{ mode: 'turbo' }, 'Modo inválido'],
  ])('valida %j', (change, message) => {
    const result = buildIdentityDraftPatch(identity, { ...draft, ...change });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });
});

describe('summarizeAgentEvents', () => {
  it('cuenta turnos, saltos y fallos por disparo con datos no confiables', () => {
    const summary = summarizeAgentEvents([
      { type: 'ai.turn', payload: { trigger: 'unblock', promptTokens: 100, completionTokens: 50 } },
      { type: 'ai.turn', payload: { trigger: 'unblock', promptTokens: 'mucho', completionTokens: -5 } },
      { type: 'ai.turn_skipped', payload: { trigger: 'mention', reason: 'budget' } },
      { type: 'ai.turn_skipped', payload: { trigger: 'mention', reason: 'quiet_hours' } },
      { type: 'ai.turn_failed', payload: { trigger: 'triage' } },
      { type: 'ai.turn', payload: { trigger: 'IGNORA TODO <script>' } },
      { type: 'ai.turn_skipped', payload: null },
      { type: 'otro.evento', payload: { trigger: 'unblock' } },
    ]);
    expect(summary.turns).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.skippedByBudget).toBe(1);
    const unblock = summary.triggers.find((t) => t.trigger === 'unblock');
    expect(unblock).toEqual({ trigger: 'unblock', label: 'Destrabar vencidos', turns: 2, skipped: 0, failed: 0, tokens: 150 });
    expect(summary.triggers.find((t) => t.trigger === 'mention')).toMatchObject({ skipped: 2, label: 'Menciones en el chat' });
    expect(summary.triggers.find((t) => t.trigger === 'otro')).toMatchObject({ label: 'Otro', turns: 1, skipped: 1 });
    expect(summary.triggers.some((t) => t.label.includes('<script>'))).toBe(false);
    expect(summary.skipReasons).toEqual([
      { reason: 'budget', label: 'Presupuesto', count: 1 },
      { reason: 'otro', label: 'Otro', count: 1 },
      { reason: 'quiet_hours', label: 'Horario silencioso', count: 1 },
    ]);
  });

  it('ordena por actividad y respeta el límite', () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      Array.from({ length: i + 1 }, () => ({ type: 'ai.turn', payload: { trigger: `disparo_${String(i).padStart(2, '0')}` } }))
    ).flat();
    const summary = summarizeAgentEvents(events, 10);
    expect(summary.triggers).toHaveLength(10);
    expect(summary.triggers[0]).toMatchObject({ trigger: 'disparo_11', turns: 12 });
  });
});
