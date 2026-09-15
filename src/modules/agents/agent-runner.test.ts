import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Agent runner: one automatic turn of a bot through the scripted orchestrator,
 * with the real chat bridge, identities and events over FakePrisma.
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
    sent,
    delivered,
    deliver,
    runAssistant: vi.fn(),
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
  notifyUsers: vi.fn(async (userIds: string[], input: Record<string, unknown>) => userIds.map((userId) => h.deliver({ ...input, userId }))),
}));
vi.mock('@/modules/ai/ai-admin-config-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/ai/ai-admin-config-service')>();
  return { ...actual, getAiSettings: vi.fn(async () => ({ ...actual.DEFAULT_AI_SETTINGS, isEnabled: true })) };
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
  };
});

import { seedAreas, seedResponsible, seedUser } from '@/modules/operations/testing/fixtures';
import {
  isToolChoiceUnsupportedError,
  parseConclusion,
  runAgentTurn,
  triggerHashOf,
  turnObjectRef,
} from './agent-runner';
import { ensureAgentIdentities } from './identities';

const fake = h.fake;
const NOW = new Date('2026-09-15T17:00:00.000Z');

const botId = (username: string) => fake.rows('user').find((u) => u.username === username)!.id as string;
const eventsOf = (type: string) => fake.rows('operationalEvent').filter((e) => e.type === type);
const messagesIn = (channelId: string) => fake.rows('internalChatMessage').filter((m) => m.channelId === channelId);
const metaKind = (m: Record<string, unknown>) => (m.meta as Record<string, unknown> | null)?.kind;

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

const unblockTurn = () =>
  runAgentTurn({
    agentKey: 'area:compras',
    surface: 'case',
    trigger: 'unblock',
    detail: { caseId: 'case_1', requestId: 'req_1', areaKey: 'compras', hoursOverdue: 1.5 },
    eventId: '77',
    eventType: 'request.overdue',
    triggerHash: triggerHashOf('llm:unblock:area:compras:request:req_1'),
    now: NOW,
  });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fake.tables.clear();
  h.sent.clear();
  h.delivered.length = 0;
  h.runAssistant.mockReset();
  seedAreas(fake);
  for (const [id, name] of [
    ['marta', 'Marta'],
    ['nico', 'Nico'],
    ['vero', 'Vero'],
    ['vendedor', 'Vendedor'],
  ]) {
    seedUser(fake, { id, name });
  }
  seedResponsible(fake, { area: 'compras', userId: 'marta', backupUserId: 'nico' });
  seedResponsible(fake, { area: 'ventas', userId: 'vero' });
  fake.seed('operationalCase', {
    id: 'case_1',
    caseSeq: 1,
    caseNumber: 'EXP-1',
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: 'so_1',
    processVersionId: 'pv_1',
    ownerUserId: 'vendedor',
    salesOrderNumber: 'OV-23131',
    customerName: 'Constructora Norte',
  });
  await ensureAgentIdentities();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pure helpers', () => {
  it('parses the conclusion contract', () => {
    // Tool arguments arrive as valid JSON: the newline inside the message is escaped.
    expect(parseConclusion('{"outcome":"acted","message":"  Listo,\\n escalé  "}')).toEqual({ outcome: 'acted', message: 'Listo, escalé' });
    // A raw control character is not valid JSON, so there is no conclusion.
    expect(parseConclusion('{"outcome":"acted","message":"a\nb"}')).toBeNull();
    expect(parseConclusion({ outcome: 'no_action' })).toEqual({ outcome: 'no_action', message: null });
    expect(parseConclusion('{"outcome":"maybe"}')).toBeNull();
    expect(parseConclusion('not json')).toBeNull();
    expect(parseConclusion({ outcome: 'needs_human', message: 'x'.repeat(400) })!.message).toHaveLength(300);
  });

  it('recognizes providers that reject tool_choice', () => {
    expect(isToolChoiceUnsupportedError(new Error("400 tool_choice 'required' is not supported for this model"))).toBe(true);
    expect(isToolChoiceUnsupportedError(new Error('Invalid value for tool_choice: required'))).toBe(true);
    expect(isToolChoiceUnsupportedError(new Error('503 upstream unavailable'))).toBe(false);
    expect(isToolChoiceUnsupportedError(new Error('tool_choice ok but rate limited'))).toBe(false);
  });

  it('maps the turn object and hashes triggers', () => {
    expect(turnObjectRef({ caseId: 'c', requestId: 'r' })).toEqual({ objectType: 'area_request', objectId: 'r' });
    expect(turnObjectRef({ caseId: 'c' })).toEqual({ objectType: 'operational_case', objectId: 'c' });
    expect(turnObjectRef({})).toEqual({ objectType: null, objectId: null });
    expect(triggerHashOf('a')).toMatch(/^[0-9a-f]{32}$/);
    expect(triggerHashOf('a')).toBe(triggerHashOf('a'));
    expect(triggerHashOf('a')).not.toBe(triggerHashOf('b'));
  });
});

describe('runAgentTurn', () => {
  it('publishes the proposal card in the room with the approver scope, notifies approvers and records ai.turn', async () => {
    scriptTurn(
      conclude('needs_human', 'Propuse reservar 15 m²; Marta o Nico aprueban.', [
        { type: 'tool_call_start', data: { name: 'reserveStock', args: '{"qty":15}' } },
        {
          type: 'proposal',
          data: {
            id: 'prop_1',
            toolName: 'reserveStock',
            summary: 'Reservar 15 m² de Loseta Perla',
            effect: 'business_write',
            expiresAt: '2026-09-15T23:00:00.000Z',
            args: { qty: 15, secret: 'no-debe-ir-al-chat' },
          },
        },
        { type: 'tool_call_end', data: { name: 'reserveStock', success: false, needsApproval: true } },
      ])
    );
    const result = await unblockTurn();
    expect(result).toMatchObject({ status: 'done', outcome: 'needs_human', proposalIds: ['prop_1'], toolsUsed: ['reserveStock', 'concludeAgentTurn'] });

    const call = h.runAssistant.mock.calls[0][0];
    const identity = fake.rows('agentIdentity').find((i) => i.key === 'area:compras')!;
    expect(call).toMatchObject({ conversationId: `conv:${botId('ia_compras')}:case:case_1`, actor: { id: botId('ia_compras') } });
    expect(call.message).toMatch(/^⟦auto:unblock⟧ .*solicitud=req_1/);
    expect(call.context).toEqual({
      caseId: 'case_1',
      agent: {
        identityId: identity.id,
        areaKey: 'compras',
        trigger: 'unblock',
        botUserId: botId('ia_compras'),
        agentKey: 'area:compras',
        // Compras registers `purchases.approve`, so its holders also approve the card.
        approverScope: { caseId: 'case_1', areaKey: 'compras', permission: 'purchases.approve', userIds: ['marta', 'nico'] },
      },
    });

    const room = fake.rows('operationalCase')[0].chatChannelId as string;
    const card = messagesIn(room).find((m) => metaKind(m) === 'agent_proposal')!;
    expect(card).toMatchObject({
      senderId: botId('ia_compras'),
      meta: expect.objectContaining({ proposalId: 'prop_1', caseId: 'case_1', toolName: 'reserveStock', status: 'pending', approverUserIds: ['marta', 'nico'] }),
    });
    expect(card.meta).not.toHaveProperty('args');
    expect(String(card.content)).toContain('IA de Compras propone una acción · OV-23131 — Reservar 15 m² de Loseta Perla');
    expect(String(card.content)).toContain('Aprueba Marta o Nico');
    expect(h.delivered.filter((n) => n.category === 'agent_proposal').map((n) => n.userId)).toEqual(['marta', 'nico']);
    // The case timeline shows the same card the room shows.
    expect(eventsOf('ai.proposal_created')).toEqual([
      expect.objectContaining({ caseId: 'case_1', areaKey: 'compras', objectType: 'ai_proposal', objectId: 'prop_1', actorId: botId('ia_compras'), payload: expect.objectContaining({ chatMessageId: card.id, toolName: 'reserveStock' }) }),
    ]);

    expect(messagesIn(room).find((m) => metaKind(m) === 'agent_reply')).toMatchObject({ content: 'Propuse reservar 15 m²; Marta o Nico aprueban.' });
    const [turn] = eventsOf('ai.turn');
    expect(turn).toMatchObject({ actorType: 'ai', actorId: botId('ia_compras'), caseId: 'case_1', areaKey: 'compras', objectType: 'area_request', objectId: 'req_1' });
    expect(turn.payload).toMatchObject({
      agentKey: 'area:compras',
      trigger: 'unblock',
      triggerHash: triggerHashOf('llm:unblock:area:compras:request:req_1'),
      eventId: '77',
      model: 'kimi-k2.6',
      promptTokens: 1200,
      completionTokens: 80,
      proposalIds: ['prop_1'],
      toolsUsed: ['reserveStock', 'concludeAgentTurn'],
      outcome: 'needs_human',
    });
    expect(typeof (turn.payload as Record<string, unknown>).costUsd).toBe('number');
  });

  it('does not publish anything when the outcome is no_action', async () => {
    scriptTurn(conclude('no_action', 'Nada que hacer'));
    const result = await unblockTurn();
    expect(result).toMatchObject({ status: 'done', outcome: 'no_action', message: null, postedMessageId: null });
    expect(fake.rows('internalChatMessage')).toHaveLength(0);
    expect(eventsOf('ai.turn')[0].payload).toMatchObject({ outcome: 'no_action' });
  });

  it('an orchestrator error ⇒ ai.turn_failed without retry', async () => {
    scriptTurn([{ type: 'error', data: { message: 'El asistente alcanzó el límite de iteraciones de tools.' } }]);
    const result = await unblockTurn();
    expect(result).toMatchObject({ status: 'failed', errorCode: 'turn_error' });
    expect(h.runAssistant).toHaveBeenCalledTimes(1);
    expect(eventsOf('ai.turn')).toHaveLength(0);
    expect(eventsOf('ai.turn_failed')[0].payload).toMatchObject({ errorCode: 'turn_error', trigger: 'unblock' });
  });

  it('retries once asking for concludeAgentTurn by name when the provider rejects tool_choice required', async () => {
    h.runAssistant
      .mockImplementationOnce(async function* () {
        yield* [];
        throw new Error("400 Bad Request: tool_choice 'required' is not supported for this model");
      })
      .mockImplementationOnce(async function* () {
        for (const event of conclude('acted', 'Confirmé con Marta.')) yield event;
      });
    const result = await unblockTurn();
    expect(result).toMatchObject({ status: 'done', outcome: 'acted', retriedWithNamedTool: true });
    expect(h.runAssistant).toHaveBeenCalledTimes(2);
    expect(h.runAssistant.mock.calls[0][0].context.agent).not.toHaveProperty('forceToolName');
    expect(h.runAssistant.mock.calls[1][0].context.agent).toMatchObject({ forceToolName: 'concludeAgentTurn', reuseUserMessage: true });
    expect(eventsOf('ai.turn')[0].payload).toMatchObject({ retriedWithNamedTool: true });
  });

  it('a turn that already concluded is finished even if the stream ends with an error', async () => {
    scriptTurn([
      { type: 'tool_call_start', data: { name: 'concludeAgentTurn', args: JSON.stringify({ outcome: 'needs_human', message: 'Decide Marta' }) } },
      { type: 'tool_call_end', data: { name: 'concludeAgentTurn', success: true } },
      { type: 'error', data: { message: 'El asistente alcanzó el límite de iteraciones de tools.' } },
    ]);
    const result = await unblockTurn();
    expect(result).toMatchObject({ status: 'done', outcome: 'needs_human', message: 'Decide Marta' });
    expect(eventsOf('ai.turn_failed')).toHaveLength(0);
    expect(eventsOf('ai.turn')[0].payload).toMatchObject({ outcome: 'needs_human' });
  });

  it('model-written lines never mention people of the room', async () => {
    scriptTurn(conclude('acted', 'Listo @marta y @vero: revisen'));
    const result = await unblockTurn();
    expect(result.message).toBe('Listo @\u200bmarta y @\u200bvero: revisen');
    const room = fake.rows('operationalCase')[0].chatChannelId as string;
    const reply = messagesIn(room).find((m) => metaKind(m) === 'agent_reply')!;
    expect(fake.rows('internalChatMention').filter((m) => m.messageId === reply.id)).toHaveLength(0);
    expect(h.delivered.filter((n) => n.category === 'chat_mention')).toHaveLength(0);
  });

  it('passes the mention person, the room case and the causing human to the orchestrator', async () => {
    scriptTurn(conclude('acted', 'Respondido.'));
    await runAgentTurn({
      agentKey: 'area:compras',
      surface: 'case',
      trigger: 'mention',
      detail: { caseId: 'case_1', messageId: 'msg_1', areaKey: 'compras', text: 'hola' },
      onBehalfOfUserId: 'marta',
      lockedCaseId: 'case_1',
      causedByUserId: 'marta',
      now: NOW,
    });
    expect(h.runAssistant.mock.calls[0][0].context.agent).toMatchObject({ onBehalfOfUserId: 'marta', lockedCaseId: 'case_1', causedByUserId: 'marta' });
    expect(eventsOf('ai.turn')[0].payload).toMatchObject({ causedByUserId: 'marta' });
  });

  it('does not retry other provider errors', async () => {
    h.runAssistant.mockImplementation(async function* () {
      yield* [];
      throw new Error('503 upstream unavailable');
    });
    const result = await unblockTurn();
    expect(result).toMatchObject({ status: 'failed', errorCode: 'provider_error', retriedWithNamedTool: false });
    expect(h.runAssistant).toHaveBeenCalledTimes(1);
  });

  it('an inactive bot never runs and the failure is recorded', async () => {
    fake.rows('user').find((u) => u.username === 'ia_compras')!.isActive = false;
    const result = await unblockTurn();
    expect(result).toMatchObject({ status: 'failed', errorCode: 'bot_inactive' });
    expect(h.runAssistant).not.toHaveBeenCalled();
    expect(eventsOf('ai.turn_failed')[0]).toMatchObject({ actorId: botId('ia_compras'), payload: expect.objectContaining({ errorCode: 'bot_inactive' }) });
  });

  it('without a case the turn runs on the area surface and posts in the area channel', async () => {
    scriptTurn(conclude('acted', 'Revisé las solicitudes vencidas del área.'));
    const result = await runAgentTurn({ agentKey: 'area:compras', surface: 'case', trigger: 'triage', detail: { incidentId: 'inc_9' }, now: NOW });
    expect(result.status).toBe('done');
    expect(h.runAssistant.mock.calls[0][0]).toMatchObject({
      conversationId: `conv:${botId('ia_compras')}:area:compras`,
      context: { areaKey: 'compras', agent: { approverScope: { areaKey: 'compras', userIds: ['marta', 'nico'] } } },
    });
    const channel = fake.rows('area').find((a) => a.key === 'compras')!.chatChannelId as string;
    expect(messagesIn(channel)).toEqual([expect.objectContaining({ content: 'Revisé las solicitudes vencidas del área.', senderId: botId('ia_compras') })]);
  });

  it('rejects unknown agents and triggers', async () => {
    expect(await runAgentTurn({ agentKey: 'area:marketing', surface: 'area', trigger: 'unblock', detail: {}, now: NOW })).toMatchObject({ status: 'failed', errorCode: 'unknown_agent' });
    expect(
      await runAgentTurn({ agentKey: 'area:compras', surface: 'area', trigger: 'open' as never, detail: {}, now: NOW })
    ).toMatchObject({ status: 'failed', errorCode: 'invalid_trigger' });
    expect(h.runAssistant).not.toHaveBeenCalled();
  });
});
