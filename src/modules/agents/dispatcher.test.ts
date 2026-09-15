import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dispatcher of the coordinated AI layer over the in-memory FakePrisma: real
 * identities, chat bridge, chat service, budget, jobs and core commands; the ONE
 * orchestrator (`runAssistant`) is scripted, so no model is ever called.
 */

type Ev = { type: string; data?: unknown };

const h = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  const sent = new Set<string>();
  const delivered: Array<Record<string, unknown>> = [];
  const deliver = (input: Record<string, unknown>) => {
    const key = typeof input.dedupeKey === 'string' ? input.dedupeKey : null;
    if (key && sent.has(key)) return { id: null, inApp: false, push: false, suppressed: true, reason: 'duplicate' };
    if (key) sent.add(key);
    delivered.push(input);
    return { id: `notification_${delivered.length}`, inApp: true, push: false, suppressed: false };
  };
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
    sent,
    delivered,
    deliver,
    runAssistant: vi.fn(),
    caseStarted: [] as Array<(event: unknown) => unknown>,
    maybeSummarizeCase: vi.fn(),
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
  notifyUser: vi.fn(async (input: Record<string, unknown>) => h.deliver(input)),
  notifyUsers: vi.fn(async (userIds: string[], input: Record<string, unknown>) =>
    userIds.map((userId) =>
      h.deliver({ ...input, userId, dedupeKey: input.dedupeKeyPrefix ? `${String(input.dedupeKeyPrefix)}:${userId}` : null })
    )
  ),
}));
vi.mock('@/modules/ai/ai-admin-config-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/ai/ai-admin-config-service')>();
  return { ...actual, getAiSettings: vi.fn(async () => ({ ...actual.DEFAULT_AI_SETTINGS, isEnabled: true, agents: h.agents })) };
});
vi.mock('@/modules/ai/ai-orchestrator', () => ({ runAssistant: h.runAssistant }));
vi.mock('@/modules/ai/copilot-surfaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/ai/copilot-surfaces')>();
  return {
    ...actual,
    getOrCreateSurfaceConversation: vi.fn(async (actor: { id: string }, surface: { kind: string; id: string }) => ({
      id: `conv:${actor.id}:${surface.kind}:${surface.id}`,
      created: false,
    })),
    shouldRunAutoTurn: vi.fn(
      async (conversationId: string, anchor: Date) =>
        !h.fake.rows('aiMessage').some((m) => m.conversationId === conversationId && m.createdAt > anchor)
    ),
  };
});
vi.mock('@/modules/operations/case-service', () => ({
  onCaseStarted: vi.fn((listener: (event: unknown) => unknown) => {
    h.caseStarted.push(listener);
    return () => undefined;
  }),
}));
vi.mock('@/modules/agents/case-summary', () => ({ maybeSummarizeCase: h.maybeSummarizeCase }));

import { DEFAULT_AGENT_SETTINGS } from '@/modules/ai/agent-settings';
import type { OperationalEventRecord } from '@/modules/operations/events-service';
import { seedAreas, seedResponsible, seedUser } from '@/modules/operations/testing/fixtures';
import { triggerHashOf } from './agent-runner';
import { ensureCaseRoom } from './chat-bridge';
import {
  AGENTS_DISPATCH_JOB,
  dispatchPriority,
  handleBotMentioned,
  handleCaseStarted,
  handleOperationalEvents,
  isWithinQuietHours,
  quietHoursEndAt,
  quietWindowFor,
  runDispatch,
  runStuckScan,
  startOfLocalDay,
} from './dispatcher';
import { ensureAgentIdentities } from './identities';
import { matchTriggers } from './trigger-matrix';

const fake = h.fake;
/** 11:00 in Mexico City (outside the default 20:00–07:00 quiet hours). */
const NOW = new Date('2026-09-15T17:00:00.000Z');
const MIN = 60_000;
const MX = 'America/Mexico_City';

const botId = (username: string) => fake.rows('user').find((u) => u.username === username)!.id as string;
const identity = (key: string) => fake.rows('agentIdentity').find((i) => i.key === key)!;
const eventsOf = (type: string) => fake.rows('operationalEvent').filter((e) => e.type === type);
const messagesIn = (channelId: string) => fake.rows('internalChatMessage').filter((m) => m.channelId === channelId);
const caseRow = (id = 'case_1') => fake.rows('operationalCase').find((c) => c.id === id)!;
const dispatchJobs = () => fake.rows('backgroundJob').filter((j) => j.type === AGENTS_DISPATCH_JOB);

function scriptTurn(events: Ev[]) {
  h.runAssistant.mockImplementation(async function* () {
    for (const event of events) yield event;
  });
}

function conclude(outcome: string, message: string | null, before: Ev[] = []): Ev[] {
  return [
    ...before,
    { type: 'tool_call_start', data: { name: 'concludeAgentTurn', args: JSON.stringify({ outcome, message }) } },
    { type: 'tool_call_end', data: { name: 'concludeAgentTurn', success: true } },
    { type: 'done', data: { content: '', promptTokens: 1200, completionTokens: 80, model: 'kimi-k2.6', messageId: 'ai_msg_1' } },
  ];
}

function seedCase(id: string, overrides: Record<string, unknown> = {}) {
  return fake.seed('operationalCase', {
    id,
    caseSeq: Number(id.replace(/\D/g, '')) || 1,
    caseNumber: `EXP-${id.replace(/\D/g, '') || '1'}`,
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: `so_${id}`,
    processVersionId: 'pv_1',
    ownerUserId: 'vendedor',
    salesOrderNumber: 'OV-23131',
    customerName: 'Constructora Norte',
    openedAt: new Date(NOW.getTime() - 60 * MIN),
    lastActivityAt: NOW,
    ...overrides,
  });
}

function seedEvent(input: Record<string, unknown> & { type: string }): string {
  const row = fake.seed('operationalEvent', {
    actorType: 'system',
    occurredAt: new Date(NOW.getTime() - 5 * MIN),
    recordedAt: new Date(NOW.getTime() - 5 * MIN),
    ...input,
  });
  return row.id.toString();
}

const overdueEvent = (overrides: Record<string, unknown> = {}) =>
  seedEvent({
    type: 'request.overdue',
    caseId: 'case_1',
    areaKey: 'compras',
    objectType: 'area_request',
    objectId: 'req_1',
    payload: { requestId: 'req_1', kind: 'purchase_shortfall', fromAreaKey: 'inventario', toAreaKey: 'compras', level: 1, overdueMinutes: 90 },
    ...overrides,
  });

async function seedWorld() {
  fake.tables.clear();
  seedAreas(fake);
  seedUser(fake, { id: 'root', name: 'Root', superAdmin: true });
  for (const [id, name] of [
    ['carla', 'Carla'],
    ['luis', 'Luis'],
    ['marta', 'Marta'],
    ['nico', 'Nico'],
    ['vero', 'Vero'],
    ['vendedor', 'Vendedor'],
  ]) {
    seedUser(fake, { id, name });
  }
  seedResponsible(fake, { area: 'inventario', userId: 'carla', backupUserId: 'luis' });
  seedResponsible(fake, { area: 'compras', userId: 'marta', backupUserId: 'nico' });
  seedResponsible(fake, { area: 'ventas', userId: 'vero' });
  seedCase('case_1');
  fake.seed('areaRequest', {
    id: 'req_1',
    caseId: 'case_1',
    fromAreaKey: 'inventario',
    toAreaKey: 'compras',
    kind: 'purchase_shortfall',
    objectType: 'case_demand',
    objectId: 'dem_1',
    title: 'Faltan 15 m² de Loseta Perla',
    payload: { demandId: 'dem_1', sku: 'LP-01', productName: 'Loseta Perla', missingQty: 15, unit: 'm²', neededBy: '2026-09-18' },
    priority: 'high',
    blocksDelivery: true,
    dueAt: new Date('2026-09-15T23:00:00.000Z'),
    ownerUserId: 'marta',
    backupUserId: 'nico',
    createdByType: 'system',
  });
  await ensureAgentIdentities();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.agents = structuredClone(DEFAULT_AGENT_SETTINGS) as unknown as Record<string, unknown>;
  h.sent.clear();
  h.delivered.length = 0;
  h.runAssistant.mockReset();
  h.maybeSummarizeCase.mockReset();
  scriptTurn(conclude('acted', 'Escalé la solicitud con Marta.'));
  await seedWorld();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('time windows (pure)', () => {
  const night = { start: '20:00', end: '07:00', tz: MX };

  it('detects quiet hours across midnight and computes their end', () => {
    expect(isWithinQuietHours(new Date('2026-09-16T03:00:00Z'), night)).toBe(true); // 21:00
    expect(isWithinQuietHours(new Date('2026-09-16T12:59:00Z'), night)).toBe(true); // 06:59
    expect(isWithinQuietHours(new Date('2026-09-16T13:00:00Z'), night)).toBe(false); // 07:00
    expect(isWithinQuietHours(NOW, night)).toBe(false); // 11:00
    expect(quietHoursEndAt(new Date('2026-09-16T03:00:00Z'), night).toISOString()).toBe('2026-09-16T13:00:00.000Z');
    expect(quietHoursEndAt(new Date('2026-09-16T02:10:30Z'), night).toISOString()).toBe('2026-09-16T13:00:00.000Z');
  });

  it('honours the weekday on which the window starts', () => {
    // 2026-09-15 is a Tuesday (2).
    expect(isWithinQuietHours(new Date('2026-09-16T03:00:00Z'), { ...night, days: [2] })).toBe(true);
    expect(isWithinQuietHours(new Date('2026-09-16T03:00:00Z'), { ...night, days: [3] })).toBe(false);
    // Wednesday 04:00 local still belongs to Tuesday's window.
    expect(isWithinQuietHours(new Date('2026-09-16T10:00:00Z'), { ...night, days: [2] })).toBe(true);
    expect(isWithinQuietHours(new Date('2026-09-16T10:00:00Z'), { ...night, days: [3] })).toBe(false);
  });

  it('computes the local day start and the identity window', () => {
    expect(startOfLocalDay(NOW, MX).toISOString()).toBe('2026-09-15T06:00:00.000Z');
    expect(quietWindowFor({ quietHours: null }, DEFAULT_AGENT_SETTINGS)).toEqual(DEFAULT_AGENT_SETTINGS.quietHours);
    expect(quietWindowFor({ quietHours: { start: '22:00', end: '06:00', days: [1, 9] } }, DEFAULT_AGENT_SETTINGS)).toEqual({
      start: '22:00',
      end: '06:00',
      tz: MX,
      days: [1],
    });
    expect(quietWindowFor({ quietHours: { start: '25:00', end: '06:00' } }, DEFAULT_AGENT_SETTINGS)).toEqual(
      DEFAULT_AGENT_SETTINGS.quietHours
    );
  });
});

describe('producers', () => {
  const record = (overrides: Partial<OperationalEventRecord> = {}): OperationalEventRecord => ({
    id: '900',
    type: 'case.created',
    actorType: 'system',
    actorId: null,
    commandId: null,
    caseId: 'case_1',
    areaKey: null,
    objectType: 'operational_case',
    objectId: 'case_1',
    payload: { caseNumber: 'EXP-1' },
    occurredAt: NOW.toISOString(),
    recordedAt: NOW.toISOString(),
    ...overrides,
  });

  it('a duplicated event (two commits of listeners + onCaseStarted) enqueues ONE single-attempt job', async () => {
    expect(await handleOperationalEvents([record()])).toBe(1);
    expect(await handleOperationalEvents([record()])).toBe(0);
    expect(
      await handleCaseStarted({
        caseId: 'case_1',
        caseNumber: 'EXP-1',
        zohoSalesOrderId: null,
        salesOrderNumber: null,
        customerName: null,
        ownerUserId: 'vendedor',
        manual: false,
        commandId: null,
        eventId: '900',
        occurredAt: NOW.toISOString(),
      })
    ).toBe(false);
    expect(dispatchJobs()).toHaveLength(1);
    expect(dispatchJobs()[0]).toMatchObject({ dedupeKey: 'agents:dispatch:900', maxAttempts: 1, payload: { kind: 'event', eventId: '900' } });
  });

  it('ignores events the matrix does not react to', async () => {
    expect(await handleOperationalEvents([record({ id: '901', type: 'ai.turn' }), record({ id: '902', type: 'stock.reserved' })])).toBe(0);
    expect(dispatchJobs()).toHaveLength(0);
  });

  it('a bot mention enqueues one interactive job per message', async () => {
    const event = {
      messageId: 'msg_9',
      channelId: 'ch_9',
      channelType: 'case',
      senderId: 'marta',
      senderName: 'Marta',
      content: '@ia_compras hola',
      threadId: null,
      replyToId: null,
      createdAt: NOW.toISOString(),
      bots: [{ userId: botId('ia_compras'), username: 'ia_compras', name: 'IA de Compras' }],
    };
    expect(await handleBotMentioned(event)).toBe(true);
    expect(await handleBotMentioned(event)).toBe(false);
    expect(dispatchJobs()).toHaveLength(1);
    expect(dispatchJobs()[0]).toMatchObject({ dedupeKey: 'agents:mention:msg_9', priority: 10, payload: { kind: 'mention', botUserIds: [botId('ia_compras')] } });
  });

  it('uses the most urgent priority of the decisions', () => {
    const decisions = matchTriggers({ id: '1', type: 'request.overdue', caseId: 'c', areaKey: 'compras', payload: { requestId: 'r', toAreaKey: 'compras' } });
    expect(dispatchPriority(decisions)).toBe(10);
  });
});

describe('rules (no model)', () => {
  it('case.created ensures the room and posts the opening template once', async () => {
    const eventId = seedEvent({ type: 'case.created', caseId: 'case_1', objectType: 'operational_case', objectId: 'case_1', payload: { caseNumber: 'EXP-1' } });
    const first = await runDispatch({ eventId }, { now: NOW });
    expect(first.decisions).toEqual([expect.objectContaining({ trigger: 'ensure_case_room', outcome: 'done' })]);
    const room = caseRow().chatChannelId as string;
    expect(room).toBeTruthy();
    await runDispatch({ eventId }, { now: NOW });
    const opening = messagesIn(room).filter((m) => (m.meta as Record<string, unknown>)?.eventType === 'case.started');
    expect(opening).toHaveLength(1);
    expect(opening[0]).toMatchObject({ senderId: botId('ia_admin') });
    expect(String(opening[0].content)).toContain('EXP-1');
    expect(h.runAssistant).not.toHaveBeenCalled();
  });

  it('announces a request in the room with meta and chatMessageId, copies it to the area and notifies the responsible', async () => {
    const eventId = seedEvent({
      type: 'request.created',
      caseId: 'case_1',
      areaKey: 'compras',
      objectType: 'area_request',
      objectId: 'req_1',
      payload: { requestId: 'req_1', kind: 'purchase_shortfall', fromAreaKey: 'inventario', toAreaKey: 'compras', hasFreeText: false },
    });
    const report = await runDispatch({ eventId }, { now: NOW });
    expect(report.decisions).toEqual([expect.objectContaining({ trigger: 'announce_request', agent: 'area:inventario', outcome: 'done' })]);

    const room = caseRow().chatChannelId as string;
    const [card] = messagesIn(room).filter((m) => (m.meta as Record<string, unknown>)?.kind === 'agent_request');
    expect(card).toMatchObject({
      senderId: botId('ia_inventario'),
      meta: {
        kind: 'agent_request',
        requestId: 'req_1',
        caseId: 'case_1',
        areaKey: 'compras',
        quickActions: ['accept', 'block', 'open_case'],
        actorUserIds: ['marta', 'nico'],
      },
    });
    expect(String(card.content)).toContain('Solicitud a Compras · OV-23131 — Faltan 15 m² de Loseta Perla (LP-01)');
    expect(String(card.content)).toContain('Responsable: Marta (respaldo Nico)');
    expect(fake.rows('areaRequest').find((r) => r.id === 'req_1')!.chatMessageId).toBe(card.id);

    const comprasChannel = fake.rows('area').find((a) => a.key === 'compras')!.chatChannelId as string;
    expect(messagesIn(comprasChannel)).toEqual([
      expect.objectContaining({ senderId: botId('ia_compras'), meta: expect.objectContaining({ requestId: 'req_1', copyOf: card.id, quickActions: [] }) }),
    ]);
    // The core notified the responsible when it created the request: the announcement adds no second notice.
    expect(h.delivered.filter((n) => n.category === 'agent_request')).toEqual([]);

    // A re-delivered job posts nothing new.
    await runDispatch({ eventId }, { now: NOW });
    expect(messagesIn(room).filter((m) => (m.meta as Record<string, unknown>)?.kind === 'agent_request')).toHaveLength(1);
    expect(messagesIn(comprasChannel)).toHaveLength(1);
    expect(h.runAssistant).not.toHaveBeenCalled();
  });

  describe('shortfall_to_purchase_request', () => {
    const shortfallEvent = () =>
      seedEvent({
        type: 'demand.shortfall_confirmed',
        caseId: 'case_1',
        areaKey: 'ventas',
        objectType: 'case_demand',
        objectId: 'dem_1',
        payload: { demandId: 'dem_1', shortfall: '15', unit: 'm²', source: 'purchase' },
      });

    beforeEach(() => {
      fake.seed('caseDemand', {
        id: 'dem_1',
        caseId: 'case_1',
        lineRef: 'l1',
        name: 'Loseta Perla',
        sku: 'LP-01',
        quantity: 40,
        unit: 'm²',
        baseQuantity: 40,
        baseUnit: 'm²',
      });
      fake.seed('demandAllocation', { id: 'al_stock', demandId: 'dem_1', caseId: 'case_1', source: 'stock', quantity: 25, status: 'reserved' });
    });

    it('does nothing when the engine already requested the purchase', async () => {
      const report = await runDispatch({ eventId: shortfallEvent() }, { now: NOW });
      expect(report.decisions).toEqual([expect.objectContaining({ outcome: 'noop', reason: 'already_requested' })]);
      expect(fake.rows('areaRequest')).toHaveLength(1);
    });

    it('leaves the request to a pending engine step', async () => {
      fake.rows('areaRequest')[0].status = 'cancelled';
      fake.seed('demandAllocation', { id: 'al_buy', demandId: 'dem_1', caseId: 'case_1', source: 'purchase', quantity: 15, status: 'planned' });
      fake.seed('caseStep', { id: 'st_buy', caseId: 'case_1', stepKey: 'solicitar_compra', allocationId: 'al_buy', areaKey: 'compras', kind: 'action', status: 'pending' });
      const report = await runDispatch({ eventId: shortfallEvent() }, { now: NOW });
      expect(report.decisions).toEqual([expect.objectContaining({ outcome: 'noop', reason: 'engine_pending' })]);
      expect(fake.rows('areaRequest').filter((r) => r.status !== 'cancelled')).toHaveLength(0);
    });

    it('creates the purchase request as the IA de Inventario when nothing covers the shortfall, only once', async () => {
      fake.rows('areaRequest')[0].status = 'cancelled';
      const eventId = shortfallEvent();
      const report = await runDispatch({ eventId }, { now: NOW });
      expect(report.decisions).toEqual([expect.objectContaining({ trigger: 'shortfall_to_purchase_request', outcome: 'done' })]);
      const created = fake.rows('areaRequest').filter((r) => r.status !== 'cancelled');
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        kind: 'purchase_shortfall',
        fromAreaKey: 'inventario',
        toAreaKey: 'compras',
        objectType: 'case_demand',
        objectId: 'dem_1',
        createdByType: 'ai',
        createdById: botId('ia_inventario'),
        ownerUserId: 'marta',
        blocksDelivery: true,
      });
      expect(created[0].payload).toMatchObject({ demandId: 'dem_1', sku: 'LP-01', missingQty: 15, unit: 'm²' });
      expect(fake.rows('workItem').filter((w) => w.objectId === created[0].id)).toHaveLength(1);

      const again = await runDispatch({ eventId }, { now: NOW });
      expect(again.decisions).toEqual([expect.objectContaining({ outcome: 'noop', reason: 'already_requested' })]);
      expect(fake.rows('areaRequest').filter((r) => r.status !== 'cancelled')).toHaveLength(1);
    });
  });
});

describe('model decisions: guards', () => {
  const skippedReasons = () => eventsOf('ai.turn_skipped').map((e) => (e.payload as Record<string, unknown>).reason);
  const skippedMeter = (agentKey: string) =>
    fake.rows('usageMeter').find((r) => r.dimension === 'ai_agent' && r.key === agentKey && r.unit === 'skipped');

  it('runs the turn when every guard passes', async () => {
    const report = await runDispatch({ eventId: overdueEvent() }, { now: NOW });
    expect(report.decisions).toEqual([expect.objectContaining({ trigger: 'unblock', agent: 'area:compras', outcome: 'done' })]);
    expect(h.runAssistant).toHaveBeenCalledTimes(1);
    expect(eventsOf('ai.turn')).toHaveLength(1);
  });

  it('a person wrote in the room after the event ⇒ skipped human_handling', async () => {
    const room = (await ensureCaseRoom('case_1')).id;
    fake.seed('internalChatMessage', { channelId: room, senderId: 'marta', content: 'Ya lo estoy viendo con el proveedor', createdAt: new Date(NOW.getTime() - MIN) });
    const report = await runDispatch({ eventId: overdueEvent() }, { now: NOW });
    expect(report.decisions).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'human_handling' })]);
    expect(h.runAssistant).not.toHaveBeenCalled();
    expect(eventsOf('ai.turn_skipped')[0]).toMatchObject({
      actorType: 'ai',
      actorId: botId('ia_compras'),
      caseId: 'case_1',
      objectType: 'area_request',
      objectId: 'req_1',
      payload: expect.objectContaining({ reason: 'human_handling', trigger: 'unblock', agentKey: 'area:compras' }),
    });
    expect(skippedMeter('area:compras')).toMatchObject({ count: 1 });
  });

  it('a turn of the same trigger and object already in the bot thread after the event ⇒ skipped already_handled', async () => {
    const conversationId = `conv:${botId('ia_compras')}:case:case_1`;
    fake.seed('aiMessage', { conversationId, role: 'user', content: '⟦auto:unblock⟧ área=compras expediente=case_1 solicitud=req_1 · Destraba.', createdAt: new Date(NOW.getTime() - MIN) });
    const report = await runDispatch({ eventId: overdueEvent() }, { now: NOW });
    expect(report.decisions).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'already_handled' })]);
    expect(h.runAssistant).not.toHaveBeenCalled();
  });

  it('earlier turns of other triggers or objects in the shared bot thread never cancel a decision', async () => {
    const conversationId = `conv:${botId('ia_compras')}:case:case_1`;
    fake.seed('aiMessage', { conversationId, role: 'user', content: '⟦auto:triage⟧ área=compras expediente=case_1 incidencia=inc_1 · Clasifica.', createdAt: new Date(NOW.getTime() - MIN) });
    fake.seed('aiMessage', { conversationId, role: 'user', content: '⟦auto:unblock⟧ área=compras expediente=case_1 solicitud=req_10 · Destraba.', createdAt: new Date(NOW.getTime() - MIN) });
    const report = await runDispatch({ eventId: overdueEvent() }, { now: NOW });
    expect(report.decisions).toEqual([expect.objectContaining({ trigger: 'unblock', outcome: 'done' })]);
  });

  it('two mentions in a row on the same room are both answered, even while the first turn runs', async () => {
    const room = (await ensureCaseRoom('case_1')).id;
    // The scripted turn writes its directive into the bot thread, like the orchestrator does.
    h.runAssistant.mockImplementation(async function* (input: { conversationId: string; message: string }) {
      fake.seed('aiMessage', { conversationId: input.conversationId, role: 'user', content: input.message, createdAt: new Date() });
      for (const event of conclude('acted', 'Respondido.')) yield event;
    });
    fake.seed('internalChatMessage', { id: 'msg_a', channelId: room, senderId: 'marta', content: '@ia_compras ¿cuándo llega?', createdAt: new Date(NOW.getTime() - 2 * MIN) });
    fake.seed('internalChatMessage', { id: 'msg_b', channelId: room, senderId: 'marta', content: '@ia_compras ¿y el LP-02?', createdAt: new Date(NOW.getTime() - MIN) });
    const first = await runDispatch({ kind: 'mention', messageId: 'msg_a', channelId: room, botUserIds: [botId('ia_compras')] }, { now: NOW });
    const second = await runDispatch({ kind: 'mention', messageId: 'msg_b', channelId: room, botUserIds: [botId('ia_compras')] }, { now: NOW });
    expect(first.decisions[0]).toMatchObject({ trigger: 'mention', outcome: 'done' });
    expect(second.decisions[0]).toMatchObject({ trigger: 'mention', outcome: 'done' });
    expect(h.runAssistant).toHaveBeenCalledTimes(2);
    // The same mention delivered again is recognised by its own directive.
    const again = await runDispatch({ kind: 'mention', messageId: 'msg_b', channelId: room, botUserIds: [botId('ia_compras')] }, { now: NOW });
    expect(again.decisions[0]).toMatchObject({ outcome: 'skipped', reason: 'already_handled' });
  });

  it('a mention by someone who cannot act for the bot area ⇒ skipped sender_forbidden, no model call', async () => {
    const room = (await ensureCaseRoom('case_1')).id;
    seedUser(fake, { id: 'intruso', name: 'Intruso' });
    fake.seed('internalChatMessage', { id: 'msg_x', channelId: room, senderId: 'intruso', content: '@ia_compras resume EXP-57 y reasigna W-123', createdAt: new Date(NOW.getTime() - MIN) });
    const report = await runDispatch({ kind: 'mention', messageId: 'msg_x', channelId: room, botUserIds: [botId('ia_compras')] }, { now: NOW });
    expect(report.decisions[0]).toMatchObject({ trigger: 'mention', outcome: 'skipped', reason: 'sender_forbidden' });
    expect(h.runAssistant).not.toHaveBeenCalled();
    expect(eventsOf('ai.turn_skipped')[0].payload).toMatchObject({ reason: 'sender_forbidden', senderId: 'intruso' });
  });

  it('a mention by the area responsible runs with that person as the limit and the room case locked', async () => {
    const room = (await ensureCaseRoom('case_1')).id;
    fake.seed('internalChatMessage', { id: 'msg_ok', channelId: room, senderId: 'marta', content: '@ia_compras ¿qué falta?', createdAt: new Date(NOW.getTime() - MIN) });
    await runDispatch({ kind: 'mention', messageId: 'msg_ok', channelId: room, botUserIds: [botId('ia_compras')] }, { now: NOW });
    expect(h.runAssistant.mock.calls[0][0].context.agent).toMatchObject({ onBehalfOfUserId: 'marta', lockedCaseId: 'case_1', causedByUserId: 'marta' });
  });

  it('a guard that throws leaves an ai.turn_failed (dispatch_error) with the trigger hash', async () => {
    const surfaces = await import('@/modules/ai/copilot-surfaces');
    vi.mocked(surfaces.getOrCreateSurfaceConversation).mockRejectedValueOnce(new Error('db caída'));
    const report = await runDispatch({ eventId: overdueEvent() }, { now: NOW });
    expect(report.decisions[0]).toMatchObject({ trigger: 'unblock', outcome: 'failed', reason: 'dispatch_error' });
    expect(eventsOf('ai.turn_failed')).toEqual([
      expect.objectContaining({
        actorId: botId('ia_compras'),
        caseId: 'case_1',
        payload: expect.objectContaining({
          errorCode: 'dispatch_error',
          error: 'db caída',
          trigger: 'unblock',
          triggerHash: triggerHashOf('llm:unblock:area:compras:request:req_1'),
        }),
      }),
    ]);
  });

  it('paused agent ⇒ skipped agent_paused; disabled settings and triggers stop first', async () => {
    identity('area:compras').mode = 'paused';
    expect((await runDispatch({ eventId: overdueEvent() }, { now: NOW })).decisions[0]).toMatchObject({ outcome: 'skipped', reason: 'agent_paused' });
    h.agents = { ...h.agents, llmTriggers: { ...DEFAULT_AGENT_SETTINGS.llmTriggers, unblock: false } };
    expect((await runDispatch({ eventId: overdueEvent() }, { now: NOW })).decisions[0]).toMatchObject({ reason: 'trigger_disabled' });
    h.agents = { ...h.agents, enabled: false };
    expect((await runDispatch({ eventId: overdueEvent() }, { now: NOW })).decisions[0]).toMatchObject({ reason: 'agents_disabled' });
    expect(skippedReasons()).toEqual(['agent_paused', 'trigger_disabled', 'agents_disabled']);
    expect(h.runAssistant).not.toHaveBeenCalled();
  });

  it('on-demand agent only takes mentions and failed actions', async () => {
    identity('area:compras').mode = 'on_demand';
    expect((await runDispatch({ eventId: overdueEvent() }, { now: NOW })).decisions[0]).toMatchObject({ outcome: 'skipped', reason: 'on_demand' });
    expect(h.runAssistant).not.toHaveBeenCalled();
  });

  it('exhausted budget ⇒ skipped, one "paused by budget" template in the room and one admin notice', async () => {
    fake.seed('usageMeter', { dimension: 'ai_agent', key: 'area:compras', period: '2026-09-15', unit: 'tokens', count: 9, amount: 200_000 });
    fake.seed('incident', {
      id: 'inc_1',
      caseId: 'case_1',
      areaKey: 'compras',
      kind: 'purchase_difference',
      severity: 'high',
      title: 'Proveedor sin existencias',
      detail: { description: 'El proveedor dice que no tiene loseta hasta octubre' },
      dedupeKey: 'inc_1',
    });
    const incidentEvent = seedEvent({
      type: 'incident.opened',
      actorType: 'user',
      actorId: 'marta',
      caseId: 'case_1',
      areaKey: 'compras',
      objectType: 'incident',
      objectId: 'inc_1',
      payload: { incidentId: 'inc_1', kind: 'purchase_difference', severity: 'high', title: 'Proveedor sin existencias' },
    });
    const first = await runDispatch({ eventId: overdueEvent() }, { now: NOW });
    const second = await runDispatch({ eventId: incidentEvent }, { now: NOW });
    expect(first.decisions[0]).toMatchObject({ outcome: 'skipped', reason: 'budget_exhausted' });
    expect(second.decisions).toEqual([expect.objectContaining({ trigger: 'triage', outcome: 'skipped', reason: 'budget_exhausted' })]);
    expect(h.runAssistant).not.toHaveBeenCalled();

    const room = caseRow().chatChannelId as string;
    const pauses = messagesIn(room).filter((m) => (m.meta as Record<string, unknown>)?.notice === 'budget_exhausted');
    expect(pauses).toHaveLength(1);
    expect(String(pauses[0].content)).toBe('⏸️ IA de Compras en pausa por presupuesto, atiende Marta');
    expect(eventsOf('ai.budget_exhausted')).toEqual([expect.objectContaining({ caseId: 'case_1', areaKey: 'compras', payload: expect.objectContaining({ chatMessageId: pauses[0].id }) })]);
    expect(h.delivered.filter((n) => n.category === 'agent_budget')).toEqual([
      expect.objectContaining({ userId: 'root', type: 'agent_budget_exhausted' }),
    ]);
    expect(skippedMeter('area:compras')).toMatchObject({ count: 2 });
  });

  it('degraded budget ⇒ routine triggers skipped', async () => {
    fake.seed('usageMeter', { dimension: 'ai_agent', key: 'area:compras', period: '2026-09-15', unit: 'tokens', count: 9, amount: 130_000 });
    expect((await runDispatch({ eventId: overdueEvent() }, { now: NOW })).decisions[0]).toMatchObject({ outcome: 'skipped', reason: 'budget_degraded' });
    expect(h.runAssistant).not.toHaveBeenCalled();
  });

  it('quiet hours ⇒ the model decision is re-enqueued at the end of the window and runs then', async () => {
    const night = new Date('2026-09-16T03:00:00.000Z'); // 21:00 local
    vi.setSystemTime(night);
    const eventId = overdueEvent({ occurredAt: new Date(night.getTime() - 5 * MIN) });
    const report = await runDispatch({ eventId }, { now: night });
    expect(report.decisions[0]).toMatchObject({ outcome: 'deferred', reason: 'quiet_hours' });
    expect(h.runAssistant).not.toHaveBeenCalled();
    const deferred = dispatchJobs().find((j) => String(j.dedupeKey).startsWith('agents:deferred:'))!;
    expect(deferred.runAt.toISOString()).toBe('2026-09-16T13:00:00.000Z');
    expect(deferred).toMatchObject({ maxAttempts: 1, payload: { eventId, deferred: true, llmOnly: ['llm:unblock:area:compras:request:req_1'] } });
    expect(eventsOf('ai.turn_skipped')[0].payload).toMatchObject({ reason: 'quiet_hours', deferredUntil: '2026-09-16T13:00:00.000Z' });

    const morning = new Date('2026-09-16T13:05:00.000Z');
    vi.setSystemTime(morning);
    const later = await runDispatch(deferred.payload, { now: morning });
    expect(later.decisions).toEqual([expect.objectContaining({ trigger: 'unblock', outcome: 'done' })]);
    expect(h.runAssistant).toHaveBeenCalledTimes(1);
  });

  it('quiet hours: the same deferral found again records nothing new', async () => {
    const night = new Date('2026-09-16T03:00:00.000Z');
    vi.setSystemTime(night);
    const eventId = overdueEvent({ occurredAt: new Date(night.getTime() - 5 * MIN) });
    await runDispatch({ eventId }, { now: night });
    const again = await runDispatch({ eventId }, { now: new Date(night.getTime() + 60 * MIN) });
    expect(again.decisions[0]).toMatchObject({ outcome: 'deferred', reason: 'quiet_hours' });
    expect(eventsOf('ai.turn_skipped')).toHaveLength(1);
    expect(skippedMeter('area:compras')).toMatchObject({ count: 1 });
  });

  it('two night decisions deferred on the same case both run in the morning', async () => {
    const night = new Date('2026-09-16T03:00:00.000Z');
    vi.setSystemTime(night);
    h.runAssistant.mockImplementation(async function* (input: { conversationId: string; message: string }) {
      fake.seed('aiMessage', { conversationId: input.conversationId, role: 'user', content: input.message, createdAt: new Date() });
      for (const event of conclude('acted', 'Atendido.')) yield event;
    });
    fake.seed('incident', { id: 'inc_n', caseId: 'case_1', areaKey: 'compras', kind: 'purchase_difference', severity: 'high', title: 'Proveedor sin existencias', detail: { description: 'No hay loseta hasta octubre' }, dedupeKey: 'inc_n' });
    const overdue = overdueEvent({ occurredAt: new Date(night.getTime() - 5 * MIN) });
    const incident = seedEvent({ type: 'incident.opened', actorType: 'user', actorId: 'marta', caseId: 'case_1', areaKey: 'compras', objectType: 'incident', objectId: 'inc_n', occurredAt: new Date(night.getTime() - 4 * MIN), payload: { incidentId: 'inc_n' } });
    await runDispatch({ eventId: overdue }, { now: night });
    await runDispatch({ eventId: incident }, { now: night });
    const deferred = dispatchJobs().filter((j) => String(j.dedupeKey).startsWith('agents:deferred:'));
    expect(deferred).toHaveLength(2);
    const morning = new Date('2026-09-16T13:00:00.000Z');
    vi.setSystemTime(morning);
    const results = [];
    for (const job of deferred) results.push(await runDispatch(job.payload, { now: morning }));
    expect(results.map((r) => r.decisions[0])).toEqual([
      expect.objectContaining({ trigger: 'unblock', outcome: 'done' }),
      expect.objectContaining({ trigger: 'triage', outcome: 'done' }),
    ]);
  });

  it('a mention is answered during quiet hours', async () => {
    const night = new Date('2026-09-16T03:00:00.000Z');
    vi.setSystemTime(night);
    const room = (await ensureCaseRoom('case_1')).id;
    fake.seed('internalChatMessage', { id: 'msg_n', channelId: room, senderId: 'marta', content: '@ia_compras ¿ya hay proveedor?', createdAt: new Date(night.getTime() - MIN) });
    const report = await runDispatch({ kind: 'mention', messageId: 'msg_n', channelId: room, botUserIds: [botId('ia_compras')] }, { now: night });
    expect(report.decisions[0]).toMatchObject({ trigger: 'mention', outcome: 'done' });
  });

  it('the fifth model turn of the day on a case ⇒ skipped case_turn_cap, counting every bot and failed turns', async () => {
    const turns: Array<[string, string]> = [
      ['ai.turn', botId('ia_inventario')],
      ['ai.turn_failed', botId('ia_compras')],
      ['ai.turn', botId('ia_ventas')],
      ['ai.turn_failed', botId('ia_admin')],
    ];
    turns.forEach(([type, actorId], i) => {
      seedEvent({ type, actorType: 'ai', actorId, caseId: 'case_1', occurredAt: new Date(NOW.getTime() - (60 + i) * MIN), payload: { triggerHash: `other_${i}` } });
    });
    // Skipped decisions do not spend tokens and never count.
    seedEvent({ type: 'ai.turn_skipped', actorType: 'ai', actorId: botId('ia_compras'), caseId: 'case_1', occurredAt: new Date(NOW.getTime() - 10 * MIN), payload: {} });
    const report = await runDispatch({ eventId: overdueEvent() }, { now: NOW });
    expect(report.decisions[0]).toMatchObject({ outcome: 'skipped', reason: 'case_turn_cap', detail: { turnsToday: 4, cap: 4, scope: 'case' } });
    expect(h.runAssistant).not.toHaveBeenCalled();
  });

  it('a lower identity cap limits that bot on the case while the case cap still has room', async () => {
    identity('area:compras').maxTurnsPerCasePerDay = 1;
    seedEvent({ type: 'ai.turn_failed', actorType: 'ai', actorId: botId('ia_compras'), caseId: 'case_1', occurredAt: new Date(NOW.getTime() - 60 * MIN), payload: { triggerHash: 'other' } });
    const report = await runDispatch({ eventId: overdueEvent() }, { now: NOW });
    expect(report.decisions[0]).toMatchObject({ outcome: 'skipped', reason: 'case_turn_cap', detail: { turnsToday: 1, cap: 1, scope: 'identity' } });
  });

  it('the same trigger already ran in the last 24 h ⇒ skipped duplicate_trigger', async () => {
    seedEvent({
      type: 'ai.turn_failed',
      actorType: 'ai',
      actorId: botId('ia_compras'),
      caseId: 'case_1',
      occurredAt: new Date(NOW.getTime() - 3 * 60 * MIN),
      payload: { triggerHash: triggerHashOf('llm:unblock:area:compras:request:req_1') },
    });
    const report = await runDispatch({ eventId: overdueEvent() }, { now: NOW });
    expect(report.decisions[0]).toMatchObject({ outcome: 'skipped', reason: 'duplicate_trigger' });
    expect(h.runAssistant).not.toHaveBeenCalled();
  });

  it('provider down ⇒ ai.turn_failed, while the templates were already posted', async () => {
    fake.rows('areaRequest')[0].freeText = 'Urgente: el cliente cambió el color, confirma antes de comprar';
    h.runAssistant.mockImplementation(async function* () {
      yield* [];
      throw new Error('503 upstream unavailable');
    });
    const eventId = seedEvent({
      type: 'request.created',
      actorType: 'user',
      actorId: 'carla',
      caseId: 'case_1',
      areaKey: 'compras',
      objectType: 'area_request',
      objectId: 'req_1',
      payload: { requestId: 'req_1', kind: 'purchase_shortfall', fromAreaKey: 'inventario', toAreaKey: 'compras', hasFreeText: true },
    });
    const report = await runDispatch({ eventId }, { now: NOW });
    expect(report.decisions).toEqual([
      expect.objectContaining({ trigger: 'announce_request', mode: 'rule', outcome: 'done' }),
      expect.objectContaining({ trigger: 'interpret_request', mode: 'llm', outcome: 'failed', reason: 'provider_error' }),
    ]);
    const room = caseRow().chatChannelId as string;
    expect(messagesIn(room).filter((m) => (m.meta as Record<string, unknown>)?.kind === 'agent_request')).toHaveLength(1);
    expect(h.runAssistant).toHaveBeenCalledTimes(1);
    expect(eventsOf('ai.turn_failed')).toEqual([
      expect.objectContaining({
        actorId: botId('ia_compras'),
        payload: expect.objectContaining({ errorCode: 'provider_error', trigger: 'interpret_request', error: '503 upstream unavailable' }),
      }),
    ]);
    expect(eventsOf('ai.turn')).toHaveLength(0);
  });

  it('a mention in the room is answered by the mentioned bot, in reply, even if on demand and people keep writing', async () => {
    identity('area:compras').mode = 'on_demand';
    const room = (await ensureCaseRoom('case_1')).id;
    fake.seed('internalChatMessage', { id: 'msg_1', channelId: room, senderId: 'marta', content: '@ia_compras ¿ya tenemos proveedor para la loseta?', createdAt: new Date(NOW.getTime() - 2 * MIN) });
    fake.seed('internalChatMessage', { channelId: room, senderId: 'nico', content: 'yo también quiero saber', createdAt: new Date(NOW.getTime() - MIN) });
    scriptTurn(conclude('acted', 'Sí: Proveedora Norte confirma entrega el 17 sep.'));
    const report = await runDispatch({ kind: 'mention', messageId: 'msg_1', channelId: room, botUserIds: [botId('ia_compras')] }, { now: NOW });
    expect(report.decisions).toEqual([expect.objectContaining({ trigger: 'mention', agent: 'area:compras', outcome: 'done' })]);
    const call = h.runAssistant.mock.calls[0][0];
    expect(call.context).toMatchObject({ caseId: 'case_1', agent: { agentKey: 'area:compras', trigger: 'mention' } });
    expect(call.message).toMatch(/^⟦auto:mention⟧/);
    expect(call.message).toContain('<untrusted source="chat"');
    const reply = messagesIn(room).find((m) => (m.meta as Record<string, unknown>)?.kind === 'agent_reply')!;
    expect(reply).toMatchObject({ senderId: botId('ia_compras'), replyToId: 'msg_1', content: 'Sí: Proveedora Norte confirma entrega el 17 sep.' });
  });

  it('delivered case with incidents runs the one-time summary through maybeSummarizeCase', async () => {
    fake.seed('incident', { id: 'inc_2', caseId: 'case_1', areaKey: 'logistica', kind: 'partial_delivery', title: 'Entrega parcial', dedupeKey: 'inc_2', status: 'resolved' });
    h.maybeSummarizeCase.mockResolvedValue({ outcome: 'updated', newEvents: 9, summary: 'Entregado con una incidencia.', model: 'minimax-m3', promptTokens: 700, completionTokens: 60, lastEventId: '5' });
    const eventId = seedEvent({ type: 'case.delivered', caseId: 'case_1', areaKey: 'logistica', objectType: 'operational_case', objectId: 'case_1' });
    const report = await runDispatch({ eventId }, { now: NOW });
    expect(report.decisions).toEqual([
      expect.objectContaining({ trigger: 'announce_case_delivered', outcome: 'done' }),
      expect.objectContaining({ trigger: 'case_summary', outcome: 'done' }),
    ]);
    expect(h.maybeSummarizeCase).toHaveBeenCalledWith('case_1', { force: true, now: NOW });
    expect(eventsOf('ai.turn')[0].payload).toMatchObject({ trigger: 'case_summary', model: 'minimax-m3' });
    const again = await runDispatch({ eventId }, { now: NOW });
    expect(again.decisions.map((d) => d.trigger)).toEqual(['announce_case_delivered']);
    expect(h.maybeSummarizeCase).toHaveBeenCalledTimes(1);
  });
});

describe('stuck scan', () => {
  it('emits stuck_review for open cases idle 24 h, skipping delivered and recently active ones, once per day', async () => {
    caseRow('case_1').lastActivityAt = new Date(NOW.getTime() - 30 * 60 * MIN);
    seedCase('case_2', { lastActivityAt: new Date(NOW.getTime() - 30 * 60 * MIN) });
    seedEvent({ type: 'case.delivered', caseId: 'case_2', occurredAt: new Date(NOW.getTime() - 30 * 60 * MIN) });
    seedCase('case_3', { lastActivityAt: new Date(NOW.getTime() - 30 * 60 * MIN) });
    seedEvent({ type: 'workitem.completed', caseId: 'case_3', occurredAt: new Date(NOW.getTime() - 2 * 60 * MIN) });
    seedEvent({ type: 'ai.turn', caseId: 'case_1', actorType: 'ai', occurredAt: new Date(NOW.getTime() - 60 * MIN) });

    expect(await runStuckScan({ now: NOW })).toEqual({ scanned: 3, enqueued: 1, recentActivity: 1, delivered: 1, alreadyReviewed: 0 });
    expect((await runStuckScan({ now: NOW })).enqueued).toBe(0);
    const [job] = dispatchJobs();
    expect(job).toMatchObject({ dedupeKey: 'agents:stuck:case_1:2026-09-15', payload: { kind: 'synthetic', event: { type: 'case.stuck', caseId: 'case_1' } } });

    const report = await runDispatch(job.payload, { now: NOW });
    expect(report.decisions).toEqual([expect.objectContaining({ trigger: 'stuck_review', agent: 'admin', outcome: 'done' })]);
    expect(h.runAssistant.mock.calls[0][0].context).toMatchObject({ caseId: 'case_1', agent: { agentKey: 'admin', areaKey: null, trigger: 'stuck_review' } });
  });

  it('cases already reviewed today leave room for the next idle ones and are never re-enqueued', async () => {
    const idle = new Date(NOW.getTime() - 40 * 60 * MIN);
    caseRow('case_1').lastActivityAt = idle;
    seedCase('case_2', { lastActivityAt: new Date(idle.getTime() + MIN) });
    // case_1 was already reviewed today (the turn was skipped by quiet hours and deferred).
    seedEvent({ type: 'ai.turn_skipped', actorType: 'ai', caseId: 'case_1', occurredAt: new Date(NOW.getTime() - 5 * 60 * MIN), payload: { trigger: 'stuck_review', reason: 'quiet_hours' } });
    const report = await runStuckScan({ now: NOW, limit: 1 });
    expect(report).toMatchObject({ enqueued: 1, alreadyReviewed: 1 });
    expect(dispatchJobs().map((j) => j.dedupeKey)).toEqual(['agents:stuck:case_2:2026-09-15']);

    // Once its job ran (completed jobs free the dedupe key), a later hourly scan does not enqueue it again.
    const job = dispatchJobs()[0];
    await runDispatch(job.payload, { now: NOW });
    job.status = 'completed';
    job.dedupeKey = null;
    const later = await runStuckScan({ now: new Date(NOW.getTime() + 60 * MIN), limit: 5 });
    expect(later).toMatchObject({ enqueued: 0, alreadyReviewed: 2 });
  });
});
