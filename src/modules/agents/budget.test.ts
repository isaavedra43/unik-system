import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AI budgets of the coordinated layer: metering per area/agent/case, ok/degraded/exhausted,
 * month change, the once-a-day admin notice and the area dashboard with an amortized flat fee.
 * Prisma is the in-memory FakePrisma; notifications are captured (with the dedupe emulated).
 */

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  const sent = new Set<string>();
  return {
    fake: createOpsFake({ uniques: { usageMeter: [['dimension', 'key', 'period', 'unit']] } }),
    overrides: {} as Record<string, unknown>,
    sent,
    notifyUsers: vi.fn(async (userIds: string[], input: { dedupeKeyPrefix?: string }) =>
      userIds.map((id) => {
        const key = `${input.dedupeKeyPrefix}:${id}`;
        if (sent.has(key)) return { id: null, inApp: false, push: false, suppressed: true, reason: 'duplicate' };
        sent.add(key);
        return { id: key, inApp: true, push: false, suppressed: false };
      })
    ),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/ai/ai-admin-config-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/ai/ai-admin-config-service')>();
  return {
    ...actual,
    getAiSettings: vi.fn(async () => ({ ...actual.DEFAULT_AI_SETTINGS, ...mocks.overrides })),
  };
});
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUsers: mocks.notifyUsers }));

import { seedUser } from '@/modules/operations/testing/fixtures';
import { DEFAULT_AGENT_SETTINGS } from '@/modules/ai/agent-settings';
import { estimateCost } from '@/modules/ai/ai-admin-service';
import {
  budgetPeriod,
  checkAgentBudget,
  evaluateAgentBudget,
  getAreaAiUsage,
  notifyBudgetOnce,
  recordAgentSkip,
  recordAgentUsage,
  type AgentBudgetIdentity,
} from './budget';

const { fake } = mocks;

const COMPRAS: AgentBudgetIdentity = {
  key: 'area:compras',
  areaKey: 'compras',
  dailyTokenBudget: 150_000,
  monthlyCostBudgetUsd: new Prisma.Decimal(40),
};

/** 2026-09-15 21:00 in Mexico City (already the 16th in UTC). */
const EVENING = new Date('2026-09-16T03:00:00Z');

function meter(dimension: string, key: string, unit: string) {
  return fake.rows('usageMeter').find((r) => r.dimension === dimension && r.key === key && r.unit === unit);
}

function seedMeter(dimension: string, key: string, period: string, unit: string, amount: number, count = 1) {
  fake.seed('usageMeter', { dimension, key, period, unit, count, amount: new Prisma.Decimal(amount) });
}

beforeEach(() => {
  fake.tables.clear();
  mocks.sent.clear();
  mocks.notifyUsers.mockClear();
  for (const key of Object.keys(mocks.overrides)) delete mocks.overrides[key];
});

describe('recordAgentUsage', () => {
  it('meters a flat-rate agent turn on area, agent, case and user with usd 0, on the local day', async () => {
    const recorded = await recordAgentUsage({
      agentKey: 'area:compras',
      areaKey: 'compras',
      caseId: 'case-1',
      userId: 'bot-compras',
      promptTokens: 3_000,
      completionTokens: 500,
      model: 'moonshotai/kimi-k2.6',
      now: EVENING,
    });

    expect(recorded).toMatchObject({ tokens: 3_500, usd: 0, flatRate: true, day: '2026-09-15', failedWrites: 0 });
    for (const [dimension, key] of [
      ['ai_area', 'compras'],
      ['ai_agent', 'area:compras'],
      ['ai_case', 'case-1'],
    ]) {
      expect(meter(dimension, key, 'tokens')).toMatchObject({ period: '2026-09-15', count: 1 });
      expect(Number(meter(dimension, key, 'tokens')!.amount)).toBe(3_500);
      expect(Number(meter(dimension, key, 'usd')!.amount)).toBe(0);
      expect(Number(meter(dimension, key, 'flat_tokens')!.amount)).toBe(3_500);
    }
    expect(Number(meter('user', 'bot-compras', 'ai_tokens')!.amount)).toBe(3_500);
  });

  it('meters the paid cost of a priced model and accumulates turns', async () => {
    const turn = {
      areaKey: 'ventas',
      userId: 'seller-1',
      promptTokens: 10_000,
      completionTokens: 1_000,
      model: 'gpt-4o',
      now: EVENING,
    };
    await recordAgentUsage(turn);
    const second = await recordAgentUsage(turn);

    expect(second.usd).toBeCloseTo(estimateCost(10_000, 1_000, 'gpt-4o'), 6);
    expect(second.flatRate).toBe(false);
    expect(meter('ai_area', 'ventas', 'tokens')).toMatchObject({ count: 2 });
    expect(Number(meter('ai_area', 'ventas', 'usd')!.amount)).toBeCloseTo(2 * second.usd, 6);
    expect(meter('ai_area', 'ventas', 'flat_tokens')).toBeUndefined();
    expect(meter('ai_agent', 'ventas', 'tokens')).toBeUndefined();
  });

  it('ignores unknown area keys and writes nothing for a turn without tokens', async () => {
    await recordAgentUsage({ areaKey: 'marketing', userId: 'u', promptTokens: 10, completionTokens: 0, model: 'gpt-4o' });
    expect(fake.rows('usageMeter').some((r) => r.dimension === 'ai_area')).toBe(false);

    const empty = await recordAgentUsage({
      agentKey: 'admin',
      userId: 'bot-admin',
      promptTokens: 0,
      completionTokens: 0,
      model: 'gpt-4o',
    });
    expect(empty.tokens).toBe(0);
    expect(fake.rows('usageMeter').some((r) => r.dimension === 'ai_agent')).toBe(false);
  });
});

describe('checkAgentBudget', () => {
  it('ok below the degrade threshold', async () => {
    seedMeter('ai_agent', 'area:compras', '2026-09-15', 'tokens', 30_000);
    const status = await checkAgentBudget(COMPRAS, { now: EVENING });
    expect(status).toMatchObject({
      state: 'ok',
      pct: 20,
      tokensToday: 30_000,
      usdMonth: 0,
      dailyTokenBudget: 150_000,
      monthlyCostBudgetUsd: 40,
      day: '2026-09-15',
      month: '2026-09',
    });
  });

  it('degraded from degradeAtPct of the daily tokens', async () => {
    seedMeter('ai_agent', 'area:compras', '2026-09-15', 'tokens', 125_000);
    const status = await checkAgentBudget(COMPRAS, { now: EVENING });
    expect(status.state).toBe('degraded');
    expect(status.pct).toBeCloseTo(83.3, 1);
  });

  it('exhausted when the monthly paid cost reaches its budget, even with few tokens today', async () => {
    seedMeter('ai_agent', 'area:compras', '2026-09-02', 'usd', 25);
    seedMeter('ai_agent', 'area:compras', '2026-09-14', 'usd', 15);
    seedMeter('ai_agent', 'area:compras', '2026-09-15', 'tokens', 1_000);
    const status = await checkAgentBudget(COMPRAS, { now: EVENING });
    expect(status).toMatchObject({ state: 'exhausted', pct: 100, usdMonth: 40, tokensToday: 1_000 });
  });

  it('honors a configured degrade threshold and treats a budget ≤ 0 as unlimited', async () => {
    mocks.overrides.agents = { ...DEFAULT_AGENT_SETTINGS, degradeAtPct: 95 };
    seedMeter('ai_agent', 'area:compras', '2026-09-15', 'tokens', 135_000);
    expect((await checkAgentBudget(COMPRAS, { now: EVENING })).state).toBe('ok');

    const unlimited = await checkAgentBudget({ ...COMPRAS, dailyTokenBudget: 0, monthlyCostBudgetUsd: 0 }, { now: EVENING });
    expect(unlimited).toMatchObject({ state: 'ok', pct: 0 });
  });

  it('a new day resets the tokens and a new month resets the cost', async () => {
    seedMeter('ai_agent', 'area:compras', '2026-09-30', 'tokens', 149_000);
    seedMeter('ai_agent', 'area:compras', '2026-09-30', 'usd', 39.5);

    // 30 sep 14:00 local: both budgets nearly spent.
    const lastDay = await checkAgentBudget(COMPRAS, { now: new Date('2026-09-30T20:00:00Z') });
    expect(lastDay.state).toBe('degraded');
    expect(lastDay.usdMonth).toBe(39.5);

    // 1 oct 00:30 UTC is still 30 sep in Mexico City: same period.
    expect((await checkAgentBudget(COMPRAS, { now: new Date('2026-10-01T00:30:00Z') })).month).toBe('2026-09');

    // 1 oct 06:00 local: new day and new month.
    const firstDay = await checkAgentBudget(COMPRAS, { now: new Date('2026-10-01T12:00:00Z') });
    expect(firstDay).toMatchObject({ state: 'ok', tokensToday: 0, usdMonth: 0, day: '2026-10-01', month: '2026-10' });
  });

  it('pure evaluation and local periods', () => {
    expect(
      evaluateAgentBudget({ tokensToday: 80, usdMonth: 0, dailyTokenBudget: 100, monthlyCostBudgetUsd: 40, degradeAtPct: 80 })
    ).toEqual({ state: 'degraded', pct: 80 });
    expect(budgetPeriod(new Date('2026-01-01T05:59:00Z'), 'America/Mexico_City')).toEqual({
      day: '2025-12-31',
      month: '2025-12',
    });
  });
});

describe('notifyBudgetOnce', () => {
  function seedAdmins() {
    seedUser(fake, { id: 'admin-1', superAdmin: true });
    seedUser(fake, { id: 'ops-admin', permissions: ['operations.admin'] });
    seedUser(fake, { id: 'bot-admin', permissions: ['operations.admin'], isBot: true });
    seedUser(fake, { id: 'old-admin', superAdmin: true, isActive: false });
    seedUser(fake, { id: 'seller', permissions: ['operations.view'] });
  }

  it('does nothing below the alert threshold', async () => {
    seedAdmins();
    seedMeter('ai_agent', 'area:compras', '2026-09-15', 'tokens', 30_000);
    const status = await checkAgentBudget(COMPRAS, { now: EVENING });
    expect(await notifyBudgetOnce(COMPRAS, status)).toEqual({ notified: 0, skipped: 'below_alert_threshold' });
    expect(await notifyBudgetOnce(COMPRAS, 'ok')).toMatchObject({ notified: 0 });
    expect(mocks.notifyUsers).not.toHaveBeenCalled();
  });

  it('warns active human administrators once a day per identity and level', async () => {
    seedAdmins();
    seedMeter('ai_agent', 'area:compras', '2026-09-15', 'tokens', 125_000);
    const status = await checkAgentBudget(COMPRAS, { now: EVENING });

    const first = await notifyBudgetOnce(COMPRAS, status);
    expect(first).toEqual({ notified: 2, dedupeKeyPrefix: 'agent_budget:area:compras:alert:2026-09-15' });
    expect(mocks.notifyUsers).toHaveBeenCalledWith(
      ['admin-1', 'ops-admin'],
      expect.objectContaining({
        category: 'agent_budget',
        title: 'IA de Compras al 83 % de su presupuesto',
        url: '/app/admin/assistant',
        entityId: 'area:compras',
      })
    );

    // Same day, same level: no second notice.
    expect((await notifyBudgetOnce(COMPRAS, status)).notified).toBe(0);

    // Exhausted the same day: one more notice (different level).
    seedMeter('ai_agent', 'area:compras', '2026-09-15', 'usd', 40);
    const exhausted = await checkAgentBudget(COMPRAS, { now: EVENING });
    expect(exhausted.state).toBe('exhausted');
    const pause = await notifyBudgetOnce(COMPRAS, exhausted);
    expect(pause.notified).toBe(2);
    expect(mocks.notifyUsers).toHaveBeenLastCalledWith(
      ['admin-1', 'ops-admin'],
      expect.objectContaining({ title: 'IA de Compras en pausa por presupuesto', type: 'agent_budget_exhausted' })
    );

    // Next local day: notices again.
    const nextDay = await notifyBudgetOnce(COMPRAS, 'degraded', { now: new Date('2026-09-16T15:00:00Z') });
    expect(nextDay).toEqual({ notified: 2, dedupeKeyPrefix: 'agent_budget:area:compras:alert:2026-09-16' });
  });

  it('reports when there is nobody to warn', async () => {
    expect(await notifyBudgetOnce(COMPRAS, 'exhausted', { now: EVENING })).toEqual({
      notified: 0,
      skipped: 'no_admins',
    });
  });
});

describe('getAreaAiUsage', () => {
  it('aggregates per area and agent, counts turns and skips, and amortizes the flat fee by share', async () => {
    mocks.overrides.providerConfigs = {
      openai: { apiKey: 'k', endpoint: '', enabled: true },
      canopywave: { apiKey: 'k', endpoint: '', enabled: true, models: [], monthlyFeeUsd: 300 },
    };
    await recordAgentUsage({
      agentKey: 'area:compras',
      areaKey: 'compras',
      caseId: 'case-1',
      userId: 'bot-compras',
      promptTokens: 25_000,
      completionTokens: 5_000,
      model: 'moonshotai/kimi-k2.6',
      now: EVENING,
    });
    await recordAgentUsage({
      areaKey: 'ventas',
      userId: 'seller-1',
      promptTokens: 10_000,
      completionTokens: 0,
      model: 'gpt-4o',
      now: EVENING,
    });
    await recordAgentUsage({
      agentKey: 'admin',
      userId: 'bot-admin',
      promptTokens: 4_000,
      completionTokens: 1_000,
      model: 'moonshotai/kimi-k2.6',
      now: new Date('2026-09-10T18:00:00Z'),
    });
    await recordAgentSkip('area:compras', EVENING);
    await recordAgentSkip('area:compras', EVENING);
    // Company-wide flat-rate tokens of September (every Canopy call, not only agent turns).
    fake.seed('aiApiCall', {
      id: 'call-1',
      deployment: 'moonshotai/kimi-k2.6',
      promptTokens: 80_000,
      completionTokens: 20_000,
      totalTokens: 100_000,
      createdAt: new Date('2026-09-05T15:00:00Z'),
    });
    fake.seed('aiApiCall', {
      id: 'call-2',
      deployment: 'gpt-4o',
      promptTokens: 900_000,
      completionTokens: 0,
      totalTokens: 900_000,
      createdAt: new Date('2026-09-05T15:00:00Z'),
    });

    const usage = await getAreaAiUsage({ from: '2026-09-01', to: '2026-09-30' });

    expect(usage.monthlyFeeUsd).toBe(300);
    expect(usage.areas).toHaveLength(7);
    const compras = usage.areas.find((a) => a.areaKey === 'compras')!;
    expect(compras).toMatchObject({ label: 'Compras', tokens: 30_000, flatTokens: 30_000, usd: 0, turns: 1 });
    expect(compras.amortizedUsd).toBeCloseTo(90, 2);
    const ventas = usage.areas.find((a) => a.areaKey === 'ventas')!;
    expect(ventas).toMatchObject({ tokens: 10_000, flatTokens: 0, amortizedUsd: 0, turns: 1 });
    expect(ventas.usd).toBeCloseTo(0.025, 4);

    expect(usage.agents.find((a) => a.agentKey === 'area:compras')).toMatchObject({
      label: 'IA de Compras',
      tokens: 30_000,
      turns: 1,
      skipped: 2,
    });
    expect(usage.agents.find((a) => a.agentKey === 'admin')).toMatchObject({ label: 'IA administradora', tokens: 5_000 });

    expect(usage.totals).toMatchObject({ tokens: 45_000, flatTokens: 35_000, turns: 3, skipped: 2 });
    expect(usage.totals.amortizedUsd).toBeCloseTo(90, 2);
    expect(usage.days).toEqual([
      { period: '2026-09-10', tokens: 5_000, usd: 0, turns: 1 },
      { period: '2026-09-15', tokens: 40_000, usd: 0.025, turns: 2 },
    ]);
  });

  it('without a flat fee there is nothing to amortize and dates can be given as Date', async () => {
    await recordAgentUsage({
      areaKey: 'inventario',
      userId: 'u1',
      promptTokens: 1_000,
      completionTokens: 0,
      model: 'moonshotai/kimi-k2.6',
      now: EVENING,
    });
    const usage = await getAreaAiUsage({ from: new Date('2026-09-20T12:00:00Z'), to: new Date('2026-09-10T12:00:00Z') });
    expect(usage).toMatchObject({ from: '2026-09-10', to: '2026-09-20', monthlyFeeUsd: null });
    expect(usage.areas.find((a) => a.areaKey === 'inventario')).toMatchObject({ tokens: 1_000, amortizedUsd: 0 });
  });
});
