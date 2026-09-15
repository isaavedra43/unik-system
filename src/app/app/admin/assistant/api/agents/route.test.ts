import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return {
    fake: createOpsFake(),
    getCurrentSession: vi.fn(),
    listAiConfig: vi.fn(),
    updateAiConfig: vi.fn(async () => undefined),
    checkAgentBudget: vi.fn(),
    getAreaAiUsage: vi.fn(),
    recordAiAuditEvent: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/auth/authorization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/authorization')>()),
  getCurrentSession: mocks.getCurrentSession,
}));
vi.mock('@/modules/ai/ai-admin-config-service', async () => {
  const { normalizeAgentSettings } = await import('@/modules/ai/agent-settings');
  return {
    listAiConfig: mocks.listAiConfig,
    updateAiConfig: mocks.updateAiConfig,
    mergeWithDefaults: (stored: { agents?: unknown } | null) => ({ agents: normalizeAgentSettings(stored?.agents) }),
  };
});
vi.mock('@/modules/agents/budget', () => ({
  budgetPeriod: () => ({ day: '2026-09-15', month: '2026-09' }),
  checkAgentBudget: mocks.checkAgentBudget,
  getAreaAiUsage: mocks.getAreaAiUsage,
}));
vi.mock('@/modules/ai/ai-audit', () => ({ recordAiAuditEvent: mocks.recordAiAuditEvent }));

import { AGENT_KEYS } from '@/modules/agents/identity-catalog';
import { makeCurrentUser, seedUser } from '@/modules/operations/testing/fixtures';
import type { AgentsAdminData } from './_agents-admin';
import { GET, PATCH } from './route';

const { fake } = mocks;
const perms = (...keys: string[]) => keys as CurrentUser['permissionKeys'];
const assistantAdmin = makeCurrentUser({ id: 'u-adm', permissionKeys: perms('assistant.admin') });
const operator = makeCurrentUser({ id: 'u-op', permissionKeys: perms('operations.admin') });

function usage(tokens: number) {
  return {
    from: '2026-08-17',
    to: '2026-09-15',
    monthlyFeeUsd: null,
    areas: [{ areaKey: 'compras', label: 'Compras', tokens, usd: 0, flatTokens: tokens, amortizedUsd: 0, turns: 3 }],
    agents: [{ agentKey: 'area:compras', label: 'IA de Compras', tokens, usd: 0.25, flatTokens: tokens, turns: 3, skipped: 1 }],
    days: [{ period: '2026-09-15', tokens, usd: 0.25, turns: 3 }],
    totals: { tokens, usd: 0.25, flatTokens: tokens, amortizedUsd: 0, turns: 3, skipped: 1 },
  };
}

function budget(state: 'ok' | 'degraded' | 'exhausted', pct: number) {
  return { state, pct, tokensToday: 1000, usdMonth: 1, dailyTokenBudget: 150000, monthlyCostBudgetUsd: 40, degradeAtPct: 80, day: '2026-09-15', month: '2026-09' };
}

function signIn(user: CurrentUser | null) {
  mocks.getCurrentSession.mockResolvedValue(user ? { sessionId: 's1', user } : null);
}

function get(query = '') {
  return GET(new Request(`http://localhost/app/admin/assistant/api/agents${query}`) as unknown as NextRequest);
}

function patch(body: unknown, raw?: string) {
  return PATCH(
    new Request('http://localhost/app/admin/assistant/api/agents', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    }) as unknown as NextRequest
  );
}

beforeEach(() => {
  fake.tables.clear();
  vi.clearAllMocks();
  signIn(assistantAdmin);
  mocks.listAiConfig.mockResolvedValue({ settings: { agents: { enabled: true } } });
  mocks.getAreaAiUsage.mockImplementation(async ({ from }: { from: string }) => usage(from.endsWith('-01') ? 900 : 5000));
  mocks.checkAgentBudget.mockImplementation(async (identity: { key: string }) =>
    identity.key === 'admin' ? budget('degraded', 85) : budget('ok', 10)
  );
  // Admin first on purpose: the answer follows the catalog order.
  seedUser(fake, { id: 'bot-admin', username: 'ia_admin', isBot: true });
  seedUser(fake, { id: 'bot-compras', username: 'ia_compras', isBot: true });
  fake.seed('agentIdentity', { id: 'ai-admin', key: 'admin', kind: 'admin', displayName: 'IA administradora', botUserId: 'bot-admin', createdAt: new Date(), updatedAt: new Date() });
  fake.seed('agentIdentity', { id: 'ai-compras', key: 'area:compras', kind: 'area', areaKey: 'compras', displayName: 'IA de Compras', botUserId: 'bot-compras', createdAt: new Date(), updatedAt: new Date() });
});

describe('GET /app/admin/assistant/api/agents', () => {
  it('sin sesión 401 y sin assistant.admin 403', async () => {
    signIn(null);
    expect((await get()).status).toBe(401);
    signIn(operator);
    expect((await get()).status).toBe(403);
    expect(mocks.getAreaAiUsage).not.toHaveBeenCalled();
  });

  it('devuelve identidades en orden del catálogo con modo, presupuesto, estado y consumo', async () => {
    const now = new Date();
    fake.seed('operationalEvent', { id: BigInt(1), type: 'ai.turn', actorType: 'ai', occurredAt: now, recordedAt: now, payload: { trigger: 'unblock', promptTokens: 300, completionTokens: 100 } });
    fake.seed('operationalEvent', { id: BigInt(2), type: 'ai.turn_skipped', actorType: 'ai', occurredAt: now, recordedAt: now, payload: { trigger: 'mention', reason: 'budget' } });
    fake.seed('operationalEvent', { id: BigInt(3), type: 'request.created', actorType: 'user', occurredAt: now, recordedAt: now, payload: {} });

    const res = await get('?days=7');
    expect(res.status).toBe(200);
    const data = (await res.json()) as AgentsAdminData;

    expect(data.range).toEqual({ from: '2026-09-09', to: '2026-09-15', days: 7 });
    expect(mocks.getAreaAiUsage).toHaveBeenCalledWith({ from: '2026-09-09', to: '2026-09-15' });
    expect(mocks.getAreaAiUsage).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-15' });
    expect(data.identities.map((i) => i.key)).toEqual(['area:compras', 'admin']);
    expect(data.identities[0]).toMatchObject({
      displayName: 'IA de Compras',
      mode: 'active',
      dailyTokenBudget: 150000,
      monthlyCostBudgetUsd: 40,
      maxTurnsPerCasePerDay: 4,
      bot: { username: 'ia_compras', isBot: true, isActive: true },
      budget: { state: 'ok' },
      usage: { tokens: 5000, turns: 3, skipped: 1 },
    });
    expect(data.identities[1]).toMatchObject({ budget: { state: 'degraded', pct: 85 }, usage: { tokens: 0, turns: 0 } });
    expect(data.missingAgents.map((m) => m.key)).toEqual(AGENT_KEYS.filter((k) => k !== 'admin' && k !== 'area:compras'));
    expect(data.month.tokens).toBe(900);
    expect(data.events).toMatchObject({ turns: 1, skippedByBudget: 1 });
    expect(data.events.triggers.find((t) => t.trigger === 'unblock')).toMatchObject({ tokens: 400 });
    expect(data.eventsTruncated).toBe(false);
    expect(data.settings.enabled).toBe(true);
  });

  it('un presupuesto ilegible no tumba el panel', async () => {
    mocks.checkAgentBudget.mockRejectedValue(new Error('db'));
    const data = (await (await get()).json()) as AgentsAdminData;
    expect(data.range.days).toBe(30);
    expect(data.identities.every((i) => i.budget === null)).toBe(true);
  });
});

describe('PATCH /app/admin/assistant/api/agents', () => {
  it('sin sesión 401, sin permiso 403, JSON inválido o fuera de esquema 400', async () => {
    signIn(null);
    expect((await patch({ agents: { enabled: false } })).status).toBe(401);
    signIn(operator);
    expect((await patch({ agents: { enabled: false } })).status).toBe(403);
    signIn(assistantAdmin);
    expect((await patch(null, '{no')).status).toBe(400);
    expect((await patch({ agents: { llmTriggers: { borrar: true } } })).status).toBe(400);
    expect((await patch({ identities: [{ key: 'admin', dailyTokenBudget: -5 }] })).status).toBe(400);
    expect(mocks.updateAiConfig).not.toHaveBeenCalled();
  });

  it('una identidad que aún no existe responde 404 y no cambia nada', async () => {
    const res = await patch({ identities: [{ key: 'area:compras', mode: 'paused' }, { key: 'area:ventas', mode: 'paused' }] });
    expect(res.status).toBe(404);
    expect(fake.rows('agentIdentity').find((r) => r.key === 'area:compras')?.mode).toBe('active');
  });

  it('cambia modo y presupuestos de la identidad y lo audita', async () => {
    const res = await patch({ identities: [{ key: 'area:compras', mode: 'on_demand', dailyTokenBudget: 0, monthlyCostBudgetUsd: 12.5, maxTurnsPerCasePerDay: 2 }] });
    expect(res.status).toBe(200);
    expect(fake.rows('agentIdentity').find((r) => r.key === 'area:compras')).toMatchObject({
      mode: 'on_demand',
      dailyTokenBudget: 0,
      monthlyCostBudgetUsd: 12.5,
      maxTurnsPerCasePerDay: 2,
    });
    expect(mocks.updateAiConfig).not.toHaveBeenCalled();
    expect(mocks.recordAiAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'u-adm', action: 'assistant.agents_changed', targetId: 'area:compras' })
    );
  });

  it('el interruptor global y los disparos se fusionan sobre la configuración guardada', async () => {
    mocks.listAiConfig.mockResolvedValue({ settings: { agents: { enabled: true, llmTriggers: { digest: false } } } });
    const res = await patch({ agents: { enabled: false, llmTriggers: { mention: false } } });
    expect(res.status).toBe(200);
    const saved = (mocks.updateAiConfig.mock.calls[0] as unknown as [{ settings: { agents: { enabled: boolean; llmTriggers: Record<string, boolean> } } }])[0];
    expect(Object.keys(saved.settings)).toEqual(['agents']);
    expect(saved.settings.agents.enabled).toBe(false);
    expect(saved.settings.agents.llmTriggers).toMatchObject({ mention: false, digest: false, unblock: true });
    expect(await res.json()).toMatchObject({ ok: true, settings: { enabled: false } });
  });
});
