import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Jobs of the agents layer: registration, and the daily Control Tower digest
 * (template always; narrative through the existing chatCompletion, mocked).
 */

const h = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return {
    fake: createOpsFake({
      relations: {
        internalChatChannel: {
          members: { model: 'internalChatMember', childFk: 'channelId' },
          messages: { model: 'internalChatMessage', childFk: 'channelId' },
        },
        internalChatMember: {
          user: { model: 'user', fk: 'userId' },
          channel: { model: 'internalChatChannel', fk: 'channelId' },
        },
        internalChatMessage: {
          sender: { model: 'user', fk: 'senderId' },
          replyTo: { model: 'internalChatMessage', fk: 'replyToId' },
          attachments: { model: 'internalChatAttachment', childFk: 'messageId' },
          reactions: { model: 'internalChatReaction', childFk: 'messageId' },
          readReceipts: { model: 'internalChatReadReceipt', childFk: 'messageId' },
          mentions: { model: 'internalChatMention', childFk: 'messageId' },
          pins: { model: 'internalChatPinnedMessage', childFk: 'messageId' },
          bookmarks: { model: 'internalChatBookmark', childFk: 'messageId' },
        },
        internalChatReaction: { user: { model: 'user', fk: 'userId' } },
      },
      defaults: {
        internalChatChannel: () => ({ name: null, avatarPath: null, lastMessageAt: new Date(), createdAt: new Date() }),
        internalChatMessage: () => ({
          content: null,
          replyToId: null,
          forwardedFromId: null,
          forwardedBy: null,
          editedAt: null,
          deletedAt: null,
          priority: 'normal',
          threadId: null,
          meta: null,
          createdAt: new Date(),
        }),
      },
      uniques: {
        internalChatThread: [['rootMessageId']],
        internalChatMention: [['messageId', 'userId']],
        usageMeter: [['dimension', 'key', 'period', 'unit']],
      },
    }),
    agents: {} as Record<string, unknown>,
    chatCompletion: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: h.fake.client }));
vi.mock('@/modules/chat/chat-presence-service', () => ({
  getPresence: vi.fn(async () => new Map<string, string>()),
  getTotalUnread: vi.fn(async () => 0),
}));
vi.mock('@/modules/chat/chat-admin-service', () => ({
  detectChatAlerts: vi.fn(async () => {}),
  isUserSuspended: vi.fn(async () => false),
}));
vi.mock('@/modules/chat/chat-notifications', () => ({ notifyChatMessage: vi.fn(async () => {}) }));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: vi.fn(async () => {}) }));
vi.mock('@/modules/realtime/realtime-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/realtime/realtime-service')>()),
  publishRealtime: vi.fn(async () => undefined),
}));
vi.mock('@/modules/notifications/notification-service', () => ({
  notifyUser: vi.fn(async () => ({ id: null, inApp: false, push: false, suppressed: true })),
  notifyUsers: vi.fn(async () => []),
}));
vi.mock('@/modules/ai/ai-admin-config-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/ai/ai-admin-config-service')>();
  return {
    ...actual,
    getAiSettings: vi.fn(async () => ({ ...actual.DEFAULT_AI_SETTINGS, isEnabled: true, utilityModel: 'minimax-m3', agents: h.agents })),
  };
});
vi.mock('@/modules/ai/ai-client', () => ({ chatCompletion: h.chatCompletion }));
vi.mock('@/modules/ai/ai-orchestrator', () => ({ runAssistant: vi.fn() }));
vi.mock('@/modules/operations/case-service', () => ({ onCaseStarted: vi.fn(() => () => undefined) }));
vi.mock('@/modules/agents/case-summary', () => ({ maybeSummarizeCase: vi.fn() }));

import { DEFAULT_AGENT_SETTINGS } from '@/modules/ai/agent-settings';
import { hasJobHandler, type JobContext } from '@/modules/jobs/job-queue';
import { listRecurringJobs } from '@/modules/jobs/scheduled-jobs';
import { seedAreas, seedUser } from '@/modules/operations/testing/fixtures';
import {
  AGENTS_JOB_TYPES,
  DIGEST_CHECK_EVERY_MS,
  isDigestDue,
  renderControlTowerDigest,
  runControlTowerDigest,
  runDispatchJob,
  STUCK_SCAN_EVERY_MS,
  type ControlTowerKpis,
} from './agents-jobs';
import { ensureAgentIdentities } from './identities';

const fake = h.fake;
const MX = 'America/Mexico_City';
const NOW = new Date('2026-09-15T17:00:00.000Z'); // 11:00 local
const HOUR = 60 * 60_000;

const adminChannel = () => fake.rows('area').find((a) => a.key === 'administracion')!.chatChannelId as string;
const botId = (username: string) => fake.rows('user').find((u) => u.username === username)!.id as string;
const notices = () =>
  fake.rows('internalChatMessage').filter((m) => String((m.meta as Record<string, unknown> | null)?.notice ?? '').startsWith('control_tower_digest'));

const KPIS: ControlTowerKpis = {
  day: '2026-09-15',
  openCases: 12,
  blockedCases: 3,
  stuckCases: 1,
  overdueWorkItems: 5,
  overdueRequests: 2,
  openIncidents: 4,
  severeIncidents: 1,
  deliveredYesterday: 6,
  topOverdueAreas: [
    { areaKey: 'compras', label: 'Compras', count: 3 },
    { areaKey: 'logistica', label: 'Logística', count: 2 },
  ],
  ai: { tokens: 120_000, usd: 0.4, turns: 30, skipped: 3 },
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fake.tables.clear();
  h.agents = structuredClone(DEFAULT_AGENT_SETTINGS) as unknown as Record<string, unknown>;
  h.chatCompletion.mockReset();
  h.chatCompletion.mockResolvedValue({
    content: 'Atiende primero los 3 expedientes bloqueados.\nCompras concentra los vencidos.',
    finishReason: 'stop',
    promptTokens: 400,
    completionTokens: 40,
    totalTokens: 440,
    model: 'minimax-m3',
    durationMs: 5,
  });
  seedAreas(fake);
  seedUser(fake, { id: 'vendedor', name: 'Vendedor' });
  await ensureAgentIdentities();
  fake.seed('operationalCase', {
    id: 'case_1',
    caseSeq: 1,
    caseNumber: 'EXP-1',
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: 'so_1',
    processVersionId: 'pv_1',
    ownerUserId: 'vendedor',
    status: 'blocked',
    lastActivityAt: new Date(NOW.getTime() - 30 * HOUR),
  });
  fake.seed('workItem', { caseId: 'case_1', areaKey: 'compras', kind: 'action', title: 'Cotizar', ownerUserId: 'vendedor', dueAt: new Date(NOW.getTime() - 2 * HOUR) });
  fake.seed('incident', { caseId: 'case_1', areaKey: 'compras', kind: 'sla_breach', severity: 'critical', title: 'Vencido', dedupeKey: 'i1' });
  fake.seed('operationalEvent', { type: 'case.delivered', actorType: 'system', caseId: 'case_2', occurredAt: new Date('2026-09-14T20:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registration', () => {
  it('registers the three handlers, the hourly stuck scan and the digest check', () => {
    expect(hasJobHandler(AGENTS_JOB_TYPES.dispatch)).toBe(true);
    expect(hasJobHandler(AGENTS_JOB_TYPES.stuckScan)).toBe(true);
    expect(hasJobHandler(AGENTS_JOB_TYPES.controlTowerDigest)).toBe(true);
    const recurring = listRecurringJobs();
    expect(recurring).toContainEqual(expect.objectContaining({ type: 'agents.stuck_scan', everyMs: STUCK_SCAN_EVERY_MS }));
    expect(recurring).toContainEqual(expect.objectContaining({ type: 'agents.control_tower_digest', everyMs: DIGEST_CHECK_EVERY_MS }));
    expect(STUCK_SCAN_EVERY_MS).toBe(HOUR);
  });

  it('the dispatch job reports invalid payloads without throwing', async () => {
    const job = { id: 'j1', type: 'agents.dispatch', payload: { nope: true }, attempt: 1, signal: new AbortController().signal } as unknown as JobContext<unknown>;
    expect(await runDispatchJob(job)).toMatchObject({ status: 'skipped', reason: 'invalid_payload', decisions: [] });
  });
});

describe('control tower digest', () => {
  it('is due from 07:30 Mexico City time', () => {
    expect(isDigestDue(new Date('2026-09-15T13:29:00.000Z'), MX)).toBe(false);
    expect(isDigestDue(new Date('2026-09-15T13:30:00.000Z'), MX)).toBe(true);
  });

  it('renders the KPIs with a template', () => {
    expect(renderControlTowerDigest(KPIS, { now: NOW, tz: MX })).toBe(
      [
        '📊 Pulso operativo · 15 sep',
        '• Expedientes abiertos: 12 (3 bloqueados, 1 sin avance en 24 h)',
        '• Trabajos vencidos: 5 · Solicitudes vencidas: 2',
        '• Incidencias abiertas: 4 (1 alta o crítica)',
        '• Entregas de ayer: 6',
        '• Áreas con más vencidos: Compras 3 · Logística 2',
        '• IA ayer: 120,000 tokens · US$0.40 · 3 disparos saltados',
      ].join('\n')
    );
  });

  it('posts the template and the utility narrative once a day in the Administración channel', async () => {
    const report = await runControlTowerDigest({ now: NOW });
    expect(report).toMatchObject({ status: 'posted', day: '2026-09-15', narrative: 'posted' });
    expect(report.kpis).toMatchObject({ openCases: 1, blockedCases: 1, stuckCases: 1, overdueWorkItems: 1, openIncidents: 1, severeIncidents: 1, deliveredYesterday: 1 });

    const [template, narrative] = notices();
    expect(template).toMatchObject({ channelId: adminChannel(), senderId: botId('ia_admin') });
    expect(String(template.content)).toContain('• Expedientes abiertos: 1 (1 bloqueado, 1 sin avance en 24 h)');
    expect(narrative).toMatchObject({ content: 'Atiende primero los 3 expedientes bloqueados.\nCompras concentra los vencidos.' });

    expect(h.chatCompletion).toHaveBeenCalledTimes(1);
    const call = h.chatCompletion.mock.calls[0][0];
    expect(call.model).toBe('minimax-m3');
    expect(call.messages[1].content).toContain('<untrusted source="kpis_operacion"');
    expect(fake.rows('usageMeter').find((r) => r.dimension === 'ai_agent' && r.key === 'admin' && r.unit === 'tokens')).toMatchObject({ amount: 440 });
    expect(fake.rows('operationalEvent').find((e) => e.type === 'ai.turn')!.payload).toMatchObject({ trigger: 'digest', model: 'minimax-m3', outcome: 'acted' });

    expect(await runControlTowerDigest({ now: new Date(NOW.getTime() + HOUR) })).toMatchObject({ status: 'skipped', reason: 'already_posted' });
    expect(notices()).toHaveLength(2);
    expect(h.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('waits until 07:30', async () => {
    const early = new Date('2026-09-15T13:00:00.000Z');
    vi.setSystemTime(early);
    expect(await runControlTowerDigest({ now: early })).toMatchObject({ status: 'skipped', reason: 'not_due' });
    expect(notices()).toHaveLength(0);
  });

  it('keeps the template but skips the narrative when the digest trigger is off or the admin agent is not active', async () => {
    h.agents = { ...h.agents, llmTriggers: { ...DEFAULT_AGENT_SETTINGS.llmTriggers, digest: false } };
    expect(await runControlTowerDigest({ now: NOW })).toMatchObject({ status: 'posted', narrative: 'skipped', narrativeReason: 'trigger_disabled' });
    expect(h.chatCompletion).not.toHaveBeenCalled();

    fake.rows('internalChatMessage').length = 0;
    h.agents = structuredClone(DEFAULT_AGENT_SETTINGS) as unknown as Record<string, unknown>;
    fake.rows('agentIdentity').find((i) => i.key === 'admin')!.mode = 'on_demand';
    expect(await runControlTowerDigest({ now: NOW })).toMatchObject({ status: 'posted', narrative: 'skipped', narrativeReason: 'mode_on_demand' });
    expect(h.chatCompletion).not.toHaveBeenCalled();
    expect(notices()).toHaveLength(1);
  });
});
