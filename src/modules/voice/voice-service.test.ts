import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Voice service contract with an in-memory Prisma stub and the LiveKit mock
 * (no LIVEKIT_URL): pause/generation gating, single task per call request,
 * approval for oral official-quote requests, supervision without permission,
 * egress_ended with a missing file, retention.
 */

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {};
let seq = 0;
const nextId = () => `id${++seq}`;
const publishedEvents: Array<{ channel: string; type: string; payload: unknown }> = [];
const enqueued: Array<{ type: string; payload: unknown; dedupeKey?: string }> = [];
const audit: Row[] = [];
const deletedObjects: Array<{ id: string; force?: boolean }> = [];
const proposals: Row[] = [];
const state = new Map<string, unknown>();
let headObjectResult: { sizeBytes: number; contentType: string | null } | null = null;

function table(name: string): Row[] {
  if (!db[name]) db[name] = [];
  return db[name];
}

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond === null || cond === undefined)
    return actual === cond || (cond === null && actual === null);
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (typeof cond !== 'object') return actual === cond;
  const c = cond as Record<string, unknown>;
  if ('path' in c && 'equals' in c) {
    let v: unknown = actual;
    for (const seg of c.path as string[])
      v = v && typeof v === 'object' ? (v as Row)[seg] : undefined;
    return v === c.equals;
  }
  if ('in' in c) return (c.in as unknown[]).includes(actual);
  if ('notIn' in c) return !(c.notIn as unknown[]).includes(actual);
  if ('not' in c)
    return c.not === null ? actual !== null && actual !== undefined : actual !== c.not;
  if ('lt' in c)
    return actual instanceof Date && c.lt instanceof Date
      ? actual < c.lt
      : Number(actual) < Number(c.lt);
  if ('gte' in c)
    return actual instanceof Date && c.gte instanceof Date
      ? actual >= c.gte
      : Number(actual) >= Number(c.gte);
  if ('startsWith' in c)
    return typeof actual === 'string' && actual.startsWith(String(c.startsWith));
  if ('hasSome' in c)
    return Array.isArray(actual) && (c.hasSome as unknown[]).some((v) => actual.includes(v));
  if ('isEmpty' in c) return Array.isArray(actual) && (actual.length === 0) === Boolean(c.isEmpty);
  if ('some' in c)
    return Array.isArray(actual) && actual.some((r) => matches(r as Row, c.some as Row));
  return false;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Row[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (key === 'participants') {
      const parts = table('voiceParticipant').filter((p) => p.callId === row.id);
      if (!matchValue(parts, cond)) return false;
      continue;
    }
    if (!matchValue(row[key], cond)) return false;
  }
  return true;
}

function withInclude(name: string, row: Row | undefined, include?: Row): Row | null {
  if (!row) return null;
  if (!include) return { ...row };
  const out: Row = { ...row };
  if (name === 'voiceCall') {
    if (include.participants) {
      const opt = include.participants as { where?: Row } | true;
      out.participants = table('voiceParticipant')
        .filter((p) => p.callId === row.id && (opt === true ? true : matches(p, opt.where)))
        .map((p) => ({ ...p }));
    }
    if (include.supervisions) {
      const opt = include.supervisions as { where?: Row } | true;
      out.supervisions = table('voiceSupervision')
        .filter((s) => s.callId === row.id && (opt === true ? true : matches(s, opt.where)))
        .map((s) => ({ ...s }));
    }
  }
  return out;
}

function applyUpdate(row: Row, data: Row): Row {
  const next = { ...row };
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Row)) {
      next[k] = Number(next[k] ?? 0) + Number((v as Row).increment);
    } else {
      next[k] = v;
    }
  }
  next.updatedAt = new Date();
  return next;
}

function model(name: string, defaults: () => Row = () => ({})) {
  return {
    create: async ({ data, include }: { data: Row; include?: Row }) => {
      const { participants, ...scalars } = data as Row & {
        participants?: { create: Row[] };
      };
      const row: Row = {
        id: nextId(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...defaults(),
        ...scalars,
      };
      table(name).push(row);
      if (participants?.create) {
        for (const p of participants.create) {
          table('voiceParticipant').push({
            id: nextId(),
            joinedAt: new Date(),
            leftAt: null,
            muted: false,
            userId: null,
            callId: row.id,
            ...p,
          });
        }
      }
      return withInclude(name, row, include);
    },
    findUnique: async ({ where, include }: { where: Row; include?: Row }) =>
      withInclude(
        name,
        table(name).find((r) => matches(r, where)),
        include
      ),
    findFirst: async ({ where, include }: { where?: Row; include?: Row }) =>
      withInclude(
        name,
        table(name).find((r) => matches(r, where)),
        include
      ),
    findMany: async ({
      where,
      include,
      take,
      orderBy,
    }: {
      where?: Row;
      include?: Row;
      take?: number;
      orderBy?: Row;
    }) => {
      let rows = table(name).filter((r) => matches(r, where));
      if (orderBy) {
        const [[key, dir]] = Object.entries(orderBy);
        rows = [...rows].sort((a, b) => {
          const av = a[key] as number | Date;
          const bv = b[key] as number | Date;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      if (take) rows = rows.slice(0, take);
      return rows.map((r) => withInclude(name, r, include));
    },
    count: async ({ where }: { where?: Row }) =>
      table(name).filter((r) => matches(r, where)).length,
    update: async ({ where, data, include }: { where: Row; data: Row; include?: Row }) => {
      const idx = table(name).findIndex((r) => matches(r, where));
      if (idx < 0) throw new Error(`${name} not found`);
      table(name)[idx] = applyUpdate(table(name)[idx], data);
      return withInclude(name, table(name)[idx], include);
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      db[name] = table(name).map((r) => (matches(r, where) ? (count++, applyUpdate(r, data)) : r));
      return { count };
    },
    deleteMany: async ({ where }: { where?: Row }) => {
      const before = table(name).length;
      db[name] = table(name).filter((r) => !matches(r, where));
      return { count: before - db[name].length };
    },
    delete: async ({ where }: { where: Row }) => {
      db[name] = table(name).filter((r) => !matches(r, where));
      return {};
    },
  };
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    voiceCall: model('voiceCall', () => ({
      status: 'ringing',
      provider: 'livekit',
      aiState: 'off',
      aiGeneration: 0,
      aiPausedAt: null,
      recordingState: 'off',
      egressId: null,
      recordingObjectId: null,
      transcriptObjectId: null,
      summary: null,
      startedAt: null,
      endedAt: null,
      durationSec: null,
      recordingExpiresAt: null,
      transcriptExpiresAt: null,
      accountId: null,
      contactId: null,
      initiatedByUserId: null,
      externalNumber: null,
      fromIdentity: null,
      toIdentity: null,
    })),
    voiceParticipant: model('voiceParticipant', () => ({
      joinedAt: new Date(),
      leftAt: null,
      muted: false,
      userId: null,
    })),
    voiceTranscriptSegment: model('voiceTranscriptSegment'),
    voiceSupervision: model('voiceSupervision', () => ({ startedAt: new Date(), endedAt: null })),
    commAccount: model('commAccount', () => ({ status: 'active', teamKeys: [] })),
    commContact: model('commContact'),
    storageObject: model('storageObject'),
    user: model('user', () => ({ isActive: true })),
    auditLog: { create: async ({ data }: { data: Row }) => audit.push(data) },
  },
}));
vi.mock('@/modules/auth/audit-service', () => ({
  recordAuditEvent: async (event: Row) => {
    audit.push(event);
  },
}));
vi.mock('@/modules/realtime/realtime-service', () => ({
  REALTIME_CHANNELS: {
    user: (id: string) => `user:${id}`,
    call: (id: string) => `call:${id}`,
    inbox: (s: string) => `inbox:${s}`,
  },
  publishRealtime: async (channel: string, type: string, payload: unknown) => {
    publishedEvents.push({ channel, type, payload });
    return { id: '1', channel, type, payload, createdAt: new Date().toISOString() };
  },
}));
vi.mock('@/modules/jobs/job-queue', () => ({
  JOB_PRIORITY: { interactive: 10, normal: 100, maintenance: 300, bulk: 500 },
  enqueueJob: async (input: { type: string; payload: unknown; dedupeKey?: string }) => {
    enqueued.push(input);
    return { id: nextId(), status: 'pending', deduplicated: false };
  },
}));
vi.mock('@/modules/storage/storage-settings-service', () => ({
  getStorageSettings: async () => ({ recordingRetentionDays: 30, transcriptRetentionDays: 90 }),
  getStorageState: async (key: string) => state.get(key) ?? null,
  setStorageState: async (key: string, value: unknown) => {
    state.set(key, value);
  },
}));
vi.mock('@/modules/storage/drivers', () => ({
  getObjectStorageDriver: () => ({
    provider: 'disk',
    headObject: async () => headObjectResult,
  }),
}));
vi.mock('@/modules/storage/storage-service', () => ({
  StorageError: class StorageError extends Error {},
  deleteObjectIfUnreferenced: async (id: string, opts?: { force?: boolean }) => {
    deletedObjects.push({ id, force: opts?.force });
    return { deleted: true, references: 0 };
  },
  getStorageObject: async (id: string) => table('storageObject').find((o) => o.id === id) ?? null,
  openObjectStream: async () => null,
  saveGeneratedFile: async () => ({ id: nextId() }),
}));
vi.mock('@/modules/extensions/proposals-service', () => ({
  createProposal: async (input: { tool: { name: string; effect?: string }; summary: string }) => {
    const p = {
      id: `prop-${proposals.length + 1}`,
      toolName: input.tool.name,
      summary: input.summary,
      effect: input.tool.effect ?? 'read',
      expiresAt: new Date(Date.now() + 60_000),
    };
    proposals.push(p);
    return p;
  },
}));
vi.mock('@/modules/extensions/extension-audit', () => ({
  recordExtensionExecution: async () => undefined,
}));

import {
  aiResultIsCurrent,
  buildInboundTwiml,
  createInternalCall,
  createOutboundCall,
  handleLiveKitEvent,
  ingestTranscriptSegment,
  pauseAi,
  registerInboundCall,
  resumeAi,
  runVoiceRetention,
  startSupervision,
  VoiceError,
} from './voice-service';
import { getLiveKitMockState, receiveWebhook, resetLiveKitMockForTests } from './livekit-service';
import { voiceAiActor, voiceToolsFor } from './voice-ai-service';
import { executeTool, registerTool } from '@/modules/ai/tools/registry';
import { VOICE_SETTINGS_KEY } from './voice-settings';

const user = (overrides: Partial<CurrentUser> = {}): CurrentUser => ({
  id: 'u1',
  username: 'agent',
  name: 'Agente',
  email: null,
  mustChangePassword: false,
  roleKeys: ['ventas'],
  permissionKeys: ['calls.use'] as never,
  isSuperAdmin: false,
  ...overrides,
});

let quoteToolRegistered = false;

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  publishedEvents.length = 0;
  enqueued.length = 0;
  audit.length = 0;
  deletedObjects.length = 0;
  proposals.length = 0;
  state.clear();
  headObjectResult = null;
  delete process.env.LIVEKIT_URL;
  process.env.LIVEKIT_MOCK_WEBHOOK_SECRET = 'mock-secret';
  resetLiveKitMockForTests();
  table('user').push(
    { id: 'u1', name: 'Agente', isActive: true },
    { id: 'u2', name: 'Colega', isActive: true }
  );
  table('commAccount').push({
    id: 'acc1',
    provider: 'twilio_sms',
    identifier: '+5215511111111',
    label: 'Ventas',
    status: 'active',
    teamKeys: ['ventas'],
  });
  state.set(VOICE_SETTINGS_KEY, {
    copilotEnabled: true,
    copilotEveryNSegments: 100,
    aiAnswerDefault: true,
  });
});

describe('Pausar IA y generaciones', () => {
  it('rejects new analysis while paused and discards late results after resume', async () => {
    const { call } = await createInternalCall(user(), { calleeUserIds: ['u2'] });
    expect(call.aiState).toBe('active');
    expect(call.aiGeneration).toBe(0);

    const first = await ingestTranscriptSegment(
      call.id,
      { speakerIdentity: 'user-u1', text: 'Hola', startMs: 0, endMs: 500 },
      0
    );
    expect(first.accepted).toBe(true);

    const paused = await pauseAi(user(), call.id);
    expect(paused.aiState).toBe('paused');
    expect(paused.aiGeneration).toBe(1);

    const whilePaused = await ingestTranscriptSegment(
      call.id,
      { speakerIdentity: 'user-u1', text: 'Sigo', startMs: 600, endMs: 900 },
      1
    );
    expect(whilePaused).toEqual({ accepted: false, reason: 'ai_paused' });
    expect(await aiResultIsCurrent(call.id, 0)).toBe(false);

    const resumed = await resumeAi(user(), call.id);
    expect(resumed.aiState).toBe('active');
    expect(resumed.aiGeneration).toBe(2);

    // A transcription started before the pause carries the old generation → discarded.
    const late = await ingestTranscriptSegment(
      call.id,
      { speakerIdentity: 'user-u1', text: 'Tarde', startMs: 1000, endMs: 1200 },
      0
    );
    expect(late).toEqual({ accepted: false, reason: 'stale_generation' });
    expect(await aiResultIsCurrent(call.id, 1)).toBe(false);
    expect(await aiResultIsCurrent(call.id, 2)).toBe(true);

    const fresh = await ingestTranscriptSegment(
      call.id,
      { speakerIdentity: 'user-u1', text: 'Nuevo', startMs: 1300, endMs: 1500 },
      2
    );
    expect(fresh.accepted).toBe(true);
    expect(table('voiceTranscriptSegment')).toHaveLength(2);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['voice.ai_paused', 'voice.ai_resumed'])
    );
  });
});

describe('Cotización oficial pedida oralmente', () => {
  it('goes through the approval executor and is not offered to the voice AI', async () => {
    if (!quoteToolRegistered) {
      quoteToolRegistered = true;
      registerTool({
        name: 'approveOfficialQuoteTest',
        description: 'Aprueba y envía cotización oficial',
        category: 'communication',
        enabledByDefault: true,
        parameters: z.object({ quoteId: z.string() }),
        effect: 'business_write',
        approvalPolicy: 'require_approval',
        execute: async () => ({ sent: true }),
      });
    }
    const actor = voiceAiActor();
    const res = await executeTool(
      'approveOfficialQuoteTest',
      actor,
      { quoteId: 'q1' },
      { enabledToolNames: ['approveOfficialQuoteTest'] }
    );
    expect(res.success).toBe(false);
    expect(res.needsApproval).toBe(true);
    expect(res.proposal?.effect).toBe('business_write');
    expect(proposals).toHaveLength(1);

    const tools = await voiceToolsFor(actor);
    expect(tools.map((t) => t.name)).not.toContain('approveOfficialQuoteTest');
    expect(
      tools.every(
        (t) => t.effect === 'read' || t.effect === undefined
      )
    ).toBe(true);
  });
});

describe('Supervisión', () => {
  it('issues no token without calls.supervise or outside the supervisor teams', async () => {
    const { call } = await createOutboundCall(user(), {
      toNumber: '+5215500000000',
      accountId: 'acc1',
    });
    await expect(
      startSupervision(
        user({ id: 'sup', permissionKeys: ['calls.use'] as never }),
        call.id,
        'listen'
      )
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      startSupervision(
        user({ id: 'sup', roleKeys: ['compras'], permissionKeys: ['calls.supervise'] as never }),
        call.id,
        'listen'
      )
    ).rejects.toMatchObject({ code: 'forbidden' });
    const room = getLiveKitMockState().rooms.find((r) => r.name === call.roomName);
    expect(room?.participants.some((p) => p.identity.startsWith('sup-'))).toBe(false);
    expect(table('voiceSupervision')).toHaveLength(0);

    const ok = await startSupervision(
      user({ id: 'sup', roleKeys: ['ventas'], permissionKeys: ['calls.supervise'] as never }),
      call.id,
      'listen'
    );
    expect(ok.token.grants).toEqual({ canPublish: false, canSubscribe: true, hidden: true });
    expect(ok.token.mock).toBe(true);
    expect(table('voiceSupervision')).toHaveLength(1);
  });

  it('whisper tokens target the human agent; barge publishes normally', async () => {
    const { call } = await createInternalCall(user(), { calleeUserIds: ['u2'] });
    const supervisor = user({ id: 'sup', permissionKeys: ['calls.supervise'] as never });
    const whisper = await startSupervision(supervisor, call.id, 'whisper');
    expect(whisper.token.grants.canPublish).toBe(true);
    expect(whisper.token.grants.hidden).toBe(true);
    const meta = JSON.parse(
      getLiveKitMockState().rooms[0].participants.find((p) => p.identity === 'sup-sup')!.metadata
    ) as Row;
    expect(meta.whisperTo).toBe('user-u1');
    const barge = await startSupervision(supervisor, call.id, 'barge');
    expect(barge.token.grants).toEqual({ canPublish: true, canSubscribe: true, hidden: false });
  });
});

describe('Llamadas entrantes y webhooks', () => {
  it('registers an inbound call with the AI answering and returns SIP TwiML', async () => {
    const { call, sipUri, aiAnswers } = await registerInboundCall({
      fromNumber: '+5215500000000',
      toNumber: '+5215511111111',
      providerCallSid: 'CA1',
    });
    expect(aiAnswers).toBe(true);
    expect(call.type).toBe('inbound');
    expect(call.accountId).toBe('acc1');
    expect(call.aiMode).toBe('answer');
    expect(sipUri).toBe(`sip:${call.id}@mock.sip.local`);
    const twiml = buildInboundTwiml(call.id, sipUri);
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain(`<Sip>sip:${call.id}@mock.sip.local;transport=udp?X-Unik-Call=${call.id}</Sip>`);
  });

  it('egress_ended with a missing file registers the object as missing; present file → ready + transcription job', async () => {
    const { call } = await createInternalCall(user(), { calleeUserIds: ['u2'] });
    await handleLiveKitEvent({
      event: 'participant_joined',
      roomName: call.roomName,
      participant: { identity: 'user-u2', metadata: null },
      egress: null,
      mock: true,
    });
    const egressStart = await import('./livekit-service').then((m) =>
      m.startRecording(call.id, call.roomName, 'rec1')
    );
    db.voiceCall[0].egressId = egressStart.egressId;
    db.voiceCall[0].recordingState = 'recording';

    headObjectResult = null;
    const missing = await handleLiveKitEvent({
      event: 'egress_ended',
      roomName: call.roomName,
      participant: null,
      egress: {
        egressId: egressStart.egressId,
        roomName: call.roomName,
        status: 'EGRESS_COMPLETE',
        error: null,
        files: [
          {
            filename: `${egressStart.filepath}.mp4`,
            location: '',
            sizeBytes: 100,
            durationMs: 1000,
          },
        ],
      },
      mock: true,
    });
    expect(missing.handled).toBe(true);
    const obj = table('storageObject')[0];
    expect(obj.status).toBe('missing');
    expect(obj.purpose).toBe('recording');
    expect(obj.bucketAlias).toBe('recordings');
    expect(db.voiceCall[0].recordingObjectId).toBe(obj.id);
    expect(db.voiceCall[0].recordingState).toBe('stopped');
    expect(enqueued.some((j) => j.type === 'voice.transcribe')).toBe(false);

    headObjectResult = { sizeBytes: 100, contentType: 'audio/mp4' };
    db.voiceCall[0].egressId = 'EG_2';
    await handleLiveKitEvent({
      event: 'egress_ended',
      roomName: call.roomName,
      participant: null,
      egress: {
        egressId: 'EG_2',
        roomName: call.roomName,
        status: 'EGRESS_COMPLETE',
        error: null,
        files: [
          {
            filename: `recordings/${call.id}/rec2.mp4`,
            location: '',
            sizeBytes: 100,
            durationMs: 1000,
          },
        ],
      },
      mock: true,
    });
    expect(table('storageObject')[1].status).toBe('ready');
    expect(table('storageObject')[1].expiresAt).toBeInstanceOf(Date);
    expect(enqueued.some((j) => j.type === 'voice.transcribe')).toBe(true);
  });

  it('room_finished ends the call and enqueues the summary when there are segments', async () => {
    const { call } = await createInternalCall(user(), { calleeUserIds: ['u2'] });
    await handleLiveKitEvent({
      event: 'participant_joined',
      roomName: call.roomName,
      participant: { identity: 'user-u2', metadata: null },
      egress: null,
      mock: true,
    });
    expect(db.voiceCall[0].status).toBe('active');
    await ingestTranscriptSegment(
      call.id,
      { speakerIdentity: 'user-u1', text: 'Hola', startMs: 0, endMs: 1 },
      0
    );
    await handleLiveKitEvent({
      event: 'room_finished',
      roomName: call.roomName,
      participant: null,
      egress: null,
      mock: true,
    });
    expect(db.voiceCall[0].status).toBe('ended');
    expect(enqueued.some((j) => j.type === 'voice.summarize')).toBe(true);
    expect(publishedEvents.some((e) => e.type === 'call_ended')).toBe(true);
  });

  it('mock webhooks require the shared secret', async () => {
    await expect(receiveWebhook('{}', { mockSecret: 'wrong' })).rejects.toMatchObject({
      status: 401,
    });
    const event = await receiveWebhook(
      JSON.stringify({ event: 'room_finished', room: { name: 'call-x' } }),
      { mockSecret: 'mock-secret' }
    );
    expect(event).toMatchObject({ event: 'room_finished', roomName: 'call-x', mock: true });
  });
});

describe('Retención', () => {
  it('deletes expired recordings and transcripts and clears their references', async () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 1_000_000);
    table('voiceCall').push(
      {
        id: 'c1',
        roomName: 'call-c1',
        type: 'internal',
        status: 'ended',
        recordingObjectId: 'obj1',
        recordingExpiresAt: past,
        transcriptObjectId: 'tr1',
        transcriptExpiresAt: past,
        summary: 'x',
        aiState: 'active',
        aiGeneration: 0,
        createdAt: new Date(),
      },
      {
        id: 'c2',
        roomName: 'call-c2',
        type: 'internal',
        status: 'ended',
        recordingObjectId: 'obj2',
        recordingExpiresAt: future,
        transcriptObjectId: null,
        transcriptExpiresAt: future,
        summary: 'keep',
        aiState: 'active',
        aiGeneration: 0,
        createdAt: new Date(),
      }
    );
    table('voiceTranscriptSegment').push(
      { id: 's1', callId: 'c1', text: 'a', createdAt: new Date() },
      { id: 's2', callId: 'c2', text: 'b', createdAt: new Date() }
    );
    const result = await runVoiceRetention();
    expect(result).toMatchObject({ recordings: 1, transcripts: 1 });
    expect(deletedObjects).toEqual(
      expect.arrayContaining([
        { id: 'obj1', force: true },
        { id: 'tr1', force: true },
      ])
    );
    const c1 = table('voiceCall').find((c) => c.id === 'c1')!;
    expect(c1.recordingObjectId).toBeNull();
    expect(c1.transcriptObjectId).toBeNull();
    expect(c1.summary).toBeNull();
    const c2 = table('voiceCall').find((c) => c.id === 'c2')!;
    expect(c2.recordingObjectId).toBe('obj2');
    expect(c2.summary).toBe('keep');
    expect(table('voiceTranscriptSegment').map((s) => s.id)).toEqual(['s2']);
  });
});

describe('Errores', () => {
  it('outbound calls validate the number and the account team', async () => {
    await expect(createOutboundCall(user(), { toNumber: '12345' })).rejects.toBeInstanceOf(
      VoiceError
    );
    await expect(
      createOutboundCall(user({ roleKeys: ['compras'] }), {
        toNumber: '+5215500000000',
        accountId: 'acc1',
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
