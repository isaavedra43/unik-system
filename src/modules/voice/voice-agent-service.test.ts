import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Voice agent integration contract (worker side is in services/voice-agent):
 * brief content and secrets, explicit dispatch only in answer mode, tool
 * allow-list enforced in UNIK, transcript speaker mapping, hangup drops the
 * room. Uses the LiveKit mock (no LIVEKIT_URL) and small module stubs.
 */

type Row = Record<string, unknown>;

const calls: Row[] = [];
const participants: Row[] = [];
const contacts: Row[] = [];
const accounts: Row[] = [];
const published: Array<{ channel: string; type: string; payload: unknown }> = [];
const ingested: Array<{
  callId: string;
  speakerIdentity: string;
  text: string;
  generation: number;
}> = [];
const executed: Array<{ name: string; args: unknown }> = [];
let aiSettings = { isEnabled: true, voiceEnabled: true };
let providerKey = 'sk-test';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    voiceCall: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        const call = calls.find((c) => c.id === where.id);
        if (!call) return null;
        return include?.participants
          ? { ...call, participants: participants.filter((p) => p.callId === call.id) }
          : { ...call };
      },
    },
    voiceParticipant: {
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = participants.find((p) => p.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    commContact: {
      findUnique: async ({ where }: { where: Row }) =>
        contacts.find((c) => c.id === where.id) ?? null,
    },
    commAccount: {
      findUnique: async ({ where }: { where: Row }) =>
        accounts.find((a) => a.id === where.id) ?? null,
    },
  },
}));

vi.mock('@/modules/realtime/realtime-service', () => ({
  REALTIME_CHANNELS: {
    user: (id: string) => `user:${id}`,
    call: (id: string) => `call:${id}`,
    inbox: (id: string) => `inbox:${id}`,
  },
  publishRealtime: async (channel: string, type: string, payload: unknown) => {
    published.push({ channel, type, payload });
  },
}));

vi.mock('@/modules/ai/ai-admin-config-service', () => ({
  getAiSettings: async () => aiSettings,
}));

vi.mock('@/modules/ai/ai-config', () => ({
  getProviderConfig: async () => ({ apiKey: providerKey, endpoint: '' }),
}));

vi.mock('@/modules/ai/tools/registry', () => ({
  toOpenAiTools: (tools: Array<{ name: string; description: string }>) =>
    tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    })),
  executeTool: async (name: string, _actor: unknown, args: unknown) => {
    executed.push({ name, args });
    return { success: true, result: { hits: 1 }, durationMs: 1 };
  },
}));

vi.mock('@/modules/voice/voice-ai-service', () => ({
  voiceAiActor: () => ({ id: 'service:voice', name: 'IA', roleKeys: [], permissionKeys: [] }),
  voiceToolsFor: async () => [
    { name: 'searchSalesOrders', description: 'Busca pedidos', effect: 'read' },
  ],
}));

vi.mock('@/modules/voice/voice-settings', () => ({
  getVoiceSettings: async () => ({ maxAiAnswerSeconds: 600 }),
}));

vi.mock('@/modules/storage/storage-settings-service', () => ({
  getStorageState: async () => agentSettingsStored,
  setStorageState: async (_k: string, v: unknown) => {
    agentSettingsStored = v;
  },
}));
let agentSettingsStored: unknown = null;

vi.mock('@/modules/voice/voice-service', () => ({
  IDENTITY: { ai: (id: string) => `ai-${id}`, sip: (id: string) => `sip-${id}` },
  VoiceError: class VoiceError extends Error {
    constructor(
      message: string,
      public code: string,
      public status = 500
    ) {
      super(message);
    }
  },
  ingestTranscriptSegment: async (
    callId: string,
    input: { speakerIdentity: string; text: string },
    generation: number
  ) => {
    ingested.push({ callId, speakerIdentity: input.speakerIdentity, text: input.text, generation });
    return { accepted: true };
  },
}));

import * as livekit from './livekit-service';
import { DEFAULT_VOICE_AGENT_SETTINGS } from './voice-agent-settings';
import {
  buildAgentContext,
  buildAgentInstructions,
  dispatchVoiceAgent,
  getAgentState,
  recordAgentEvent,
  recordAgentTranscript,
  runAgentTool,
} from './voice-agent-service';

function seedCall(overrides: Row = {}, withAi = true) {
  const id = 'vc1';
  calls.push({
    id,
    type: 'inbound',
    status: 'active',
    roomName: 'call-_vc1',
    aiState: 'active',
    aiGeneration: 3,
    accountId: 'acc1',
    contactId: 'ct1',
    externalNumber: '+524773790184',
    initiatedByUserId: null,
    endedAt: null,
    ...overrides,
  });
  if (withAi)
    participants.push({ id: 'p-ai', callId: id, identity: 'ai-vc1', role: 'ai', leftAt: null });
  participants.push({
    id: 'p-sip',
    callId: id,
    identity: 'sip_+524773790184',
    role: 'caller',
    leftAt: null,
    userId: null,
  });
  contacts.push({ id: 'ct1', displayName: 'Israel Saavedra', phone: '+524773790184' });
  accounts.push({ id: 'acc1', label: 'VOZ' });
  return id;
}

beforeEach(() => {
  delete process.env.LIVEKIT_URL;
  livekit.resetLiveKitMockForTests();
  calls.length = 0;
  participants.length = 0;
  contacts.length = 0;
  accounts.length = 0;
  published.length = 0;
  ingested.length = 0;
  executed.length = 0;
  aiSettings = { isEnabled: true, voiceEnabled: true };
  providerKey = 'sk-test';
  agentSettingsStored = null;
});

describe('brief', () => {
  it('builds a Spanish brief with persona, contact-aware greeting, key and tools', async () => {
    const id = seedCall();
    const ctx = await buildAgentContext(id);
    expect(ctx.aiAnswers).toBe(true);
    expect(ctx.openaiApiKey).toBe('sk-test');
    expect(ctx.greeting).toContain('Israel Saavedra');
    expect(ctx.instructions).toContain('Valeria');
    expect(ctx.instructions).toContain('registrado a nombre de "Israel Saavedra"');
    expect(ctx.tools.map((t) => t.name)).toEqual([
      'searchSalesOrders',
      'solicitarTransferencia',
      'terminarLlamada',
    ]);
  });

  it('never hands out the OpenAI key when voice is disabled', async () => {
    aiSettings = { isEnabled: true, voiceEnabled: false };
    const id = seedCall();
    const ctx = await buildAgentContext(id);
    expect(ctx.openaiApiKey).toBeNull();
  });

  it('instructions carry the honesty and confidentiality rules', () => {
    const text = buildAgentInstructions({
      settings: DEFAULT_VOICE_AGENT_SETTINGS,
      enabledTools: ['searchSalesOrders'],
      contactName: null,
      contactPhone: '+52',
      contactKnown: false,
      accountLabel: 'VOZ',
      now: new Date('2026-09-12T18:00:00Z'),
      maxAnswerSeconds: 600,
    });
    expect(text).toContain('No te presentas como persona');
    expect(text).toContain('asistente virtual de UNIK');
    expect(text).toContain('quién es el dueño');
    expect(text).toContain('no está registrado');
    expect(text).toContain('solicitarTransferencia');
    expect(text).toContain('terminarLlamada');
  });
});

describe('admin settings', () => {
  it('filters tools by allowed domains and uses the configured persona/model/voice', async () => {
    agentSettingsStored = {
      personaName: 'Sofía',
      companyName: 'Mi Empresa',
      model: 'gpt-realtime-mini',
      voice: 'cedar',
      allowedDomains: ['products'],
      publicInfo: 'Horario: lunes a viernes de 9 a 18.',
      forbiddenTopics: 'competencia\nsalarios',
    };
    const id = seedCall();
    const ctx = await buildAgentContext(id);
    expect(ctx.personaName).toBe('Sofía');
    expect(ctx.model).toBe('gpt-realtime-mini');
    expect(ctx.voice).toBe('cedar');
    expect(ctx.greeting).toContain('Mi Empresa');
    // searchSalesOrders belongs to "orders", which is not allowed → only control tools remain.
    expect(ctx.tools.map((t) => t.name)).toEqual(['solicitarTransferencia', 'terminarLlamada']);
    expect(ctx.instructions).toContain('Horario: lunes a viernes');
    expect(ctx.instructions).toContain('competencia; salarios');
    expect(ctx.instructions).toContain('asistente virtual de Mi Empresa');
    const res = await runAgentTool({
      callId: id,
      name: 'searchSalesOrders',
      args: {},
      generation: 3,
    });
    expect(res).toMatchObject({ ok: false, code: 'tool_not_allowed' });
  });

  it('keeps the honesty rule even when the default prompt is replaced', async () => {
    agentSettingsStored = {
      replaceDefaultPrompt: true,
      customInstructions: 'Eres Max, vendes llantas.',
    };
    const id = seedCall();
    const ctx = await buildAgentContext(id);
    expect(ctx.instructions.startsWith('Eres Max, vendes llantas.')).toBe(true);
    expect(ctx.instructions).toContain('No te presentas como persona');
  });
});

describe('dispatch', () => {
  it('dispatches the worker only while the AI answers', async () => {
    const id = seedCall();
    const ok = await dispatchVoiceAgent(id, 'inbound');
    expect(ok.dispatched).toBe(true);
    const state = livekit.getLiveKitMockState();
    expect(state.dispatches).toHaveLength(1);
    expect(state.dispatches[0]).toMatchObject({
      roomName: 'call-_vc1',
      agentName: 'unik-voice',
      metadata: { callId: id, generation: 3, reason: 'inbound' },
    });
    expect(published.some((e) => e.type === 'agent_dispatched')).toBe(true);
  });

  it('skips paused calls and calls without an AI participant', async () => {
    const id = seedCall({ aiState: 'paused' });
    expect(await dispatchVoiceAgent(id, 'resume')).toMatchObject({
      dispatched: false,
      reason: 'not_answer_mode',
    });
    calls.length = 0;
    participants.length = 0;
    const copilotOnly = seedCall({}, false);
    expect(await dispatchVoiceAgent(copilotOnly, 'inbound')).toMatchObject({ dispatched: false });
    expect(livekit.getLiveKitMockState().dispatches).toHaveLength(0);
  });

  it('skips when voice is disabled in the assistant settings', async () => {
    aiSettings = { isEnabled: false, voiceEnabled: true };
    const id = seedCall();
    expect(await dispatchVoiceAgent(id, 'inbound')).toMatchObject({ reason: 'voice_disabled' });
  });
});

describe('tools', () => {
  it('runs allow-listed registry tools through the executor', async () => {
    const id = seedCall();
    const res = await runAgentTool({
      callId: id,
      name: 'searchSalesOrders',
      args: { q: '4578' },
      generation: 3,
    });
    expect(res).toEqual({ ok: true, result: { hits: 1 } });
    expect(executed).toEqual([{ name: 'searchSalesOrders', args: { q: '4578' } }]);
  });

  it('rejects tools outside the voice allow-list before the executor', async () => {
    const id = seedCall();
    const res = await runAgentTool({
      callId: id,
      name: 'deleteEverything',
      args: {},
      generation: 3,
    });
    expect(res).toMatchObject({ ok: false, code: 'tool_not_allowed' });
    expect(executed).toHaveLength(0);
  });

  it('refuses stale generations (paused in the meantime)', async () => {
    const id = seedCall();
    const res = await runAgentTool({
      callId: id,
      name: 'searchSalesOrders',
      args: {},
      generation: 2,
    });
    expect(res).toMatchObject({ ok: false, code: 'ai_paused' });
  });

  it('transfer request notifies the team without ending the AI leg', async () => {
    const id = seedCall();
    const res = await runAgentTool({
      callId: id,
      name: 'solicitarTransferencia',
      args: { motivo: 'cliente molesto' },
      generation: 3,
    });
    expect(res.ok).toBe(true);
    expect(published.map((e) => e.type)).toEqual(
      expect.arrayContaining(['transfer_requested', 'call_incoming'])
    );
    const state = await getAgentState(id);
    expect(state.aiAnswers).toBe(true);
  });
});

describe('transcript and events', () => {
  it('maps caller/ai speakers to identities and forwards the generation', async () => {
    const id = seedCall();
    await recordAgentTranscript({
      callId: id,
      speaker: 'caller',
      text: 'Hola, quiero saber de mi pedido',
      startMs: 0,
      endMs: 0,
      generation: 3,
    });
    await recordAgentTranscript({
      callId: id,
      speaker: 'ai',
      text: 'Con gusto, ¿me da su nombre?',
      startMs: 0,
      endMs: 0,
      generation: 3,
    });
    expect(ingested.map((s) => s.speakerIdentity)).toEqual(['caller', 'ai-vc1']);
    expect(ingested.every((s) => s.generation === 3)).toBe(true);
  });

  it('hangup retires the AI participant and drops the room', async () => {
    const id = seedCall();
    await livekit.createRoom(id);
    expect(livekit.getLiveKitMockState().rooms.map((r) => r.name)).toContain('call-_vc1');
    await recordAgentEvent({ callId: id, type: 'hangup', detail: 'despedida' });
    expect(participants.find((p) => p.id === 'p-ai')?.leftAt).toBeInstanceOf(Date);
    expect(livekit.getLiveKitMockState().rooms.map((r) => r.name)).not.toContain('call-_vc1');
  });

  it('state reflects pause, human presence and the phone leg', async () => {
    const id = seedCall({ aiState: 'paused' });
    participants.push({
      id: 'p-user',
      callId: id,
      identity: 'user-u1',
      role: 'agent',
      userId: 'u1',
      leftAt: null,
    });
    const state = await getAgentState(id);
    expect(state).toMatchObject({
      aiState: 'paused',
      aiAnswers: false,
      humanPresent: true,
      externalPresent: true,
    });
  });
});
