import { randomBytes } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import {
  Prisma,
  type VoiceCall,
  type VoiceParticipant,
  type VoiceSupervision,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { publishRealtime, REALTIME_CHANNELS } from '@/modules/realtime/realtime-service';
import { getObjectStorageDriver } from '@/modules/storage/drivers';
import {
  deleteObjectIfUnreferenced,
  getStorageObject,
  openObjectStream,
  saveGeneratedFile,
} from '@/modules/storage/storage-service';
import { getStorageSettings } from '@/modules/storage/storage-settings-service';
import * as livekit from './livekit-service';
import type { SupervisionMode } from './livekit-service';
import {
  aiAnswersAccount,
  getVoiceSettings,
  isTaskTypeAllowed,
  type VoiceSettings,
} from './voice-settings';

/**
 * Voice service — calls over LiveKit (internal, inbound and outbound through
 * the Twilio SIP trunk), AI state ("Pausar IA" stops listening, transcription,
 * analysis and voice), recording (separate, visible control), supervision
 * (listen / whisper / barge) and retention.
 *
 * Authorization is decided here, on the server, for every operation:
 * - `calls.use`       → own calls (participant) and inbound calls of the
 *                        accounts whose team keys match the user's role keys.
 * - `calls.supervise` → calls of the permitted teams (account.teamKeys ∩
 *                        actor.roleKeys) plus internal calls. Without it, no
 *                        token and no media are ever issued.
 * - super_admin       → everything.
 *
 * Team keys of a CommAccount are compared with the user's role keys (same
 * convention as the communications inbox).
 */

export const VOICE_TRANSCRIBE_JOB = 'voice.transcribe';
export const VOICE_SUMMARIZE_JOB = 'voice.summarize';
export const VOICE_COPILOT_JOB = 'voice.copilot';
export const VOICE_RETENTION_JOB = 'voice.retention';

export type VoiceErrorCode = 'not_found' | 'forbidden' | 'invalid' | 'state' | 'provider';

export class VoiceError extends Error {
  constructor(
    message: string,
    public readonly code: VoiceErrorCode,
    public readonly status: number
  ) {
    super(message);
    this.name = 'VoiceError';
  }
}

export type CallStatus = 'ringing' | 'active' | 'ended' | 'failed' | 'missed';
export type CallType = 'internal' | 'inbound' | 'outbound';
export type AiState = 'active' | 'paused' | 'off';
export type AiMode = 'answer' | 'copilot' | 'off';
export type RecordingState = 'off' | 'recording' | 'stopped';

export interface VoiceParticipantDTO {
  id: string;
  identity: string;
  userId: string | null;
  userName: string | null;
  role: string;
  joinedAt: string;
  leftAt: string | null;
  muted: boolean;
}

export interface VoiceSupervisionDTO {
  id: string;
  supervisorUserId: string;
  mode: SupervisionMode;
  startedAt: string;
  endedAt: string | null;
}

export interface VoiceCallDTO {
  id: string;
  type: CallType;
  status: CallStatus;
  roomName: string;
  fromIdentity: string | null;
  toIdentity: string | null;
  externalNumber: string | null;
  accountId: string | null;
  contactId: string | null;
  initiatedByUserId: string | null;
  aiState: AiState;
  aiMode: AiMode;
  aiGeneration: number;
  recordingState: RecordingState;
  recordingObjectId: string | null;
  transcriptObjectId: string | null;
  recordingExpiresAt: string | null;
  transcriptExpiresAt: string | null;
  summary: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  createdAt: string;
  participants: VoiceParticipantDTO[];
  supervisions: VoiceSupervisionDTO[];
  segmentCount: number;
  mock: boolean;
}

export interface TranscriptSegmentDTO {
  id: string;
  speakerIdentity: string;
  text: string;
  startMs: number;
  endMs: number;
  generation: number;
  createdAt: string;
}

export interface TranscriptSegmentInput {
  speakerIdentity: string;
  text: string;
  startMs: number;
  endMs: number;
}

type CallWithRelations = VoiceCall & {
  participants: VoiceParticipant[];
  supervisions: VoiceSupervision[];
};

const CALL_INCLUDE = {
  participants: { orderBy: { joinedAt: 'asc' as const } },
  supervisions: { where: { endedAt: null } },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function actorHas(actor: CurrentUser, permission: string): boolean {
  return actor.isSuperAdmin || (actor.permissionKeys as string[]).includes(permission);
}

export function newCallId(): string {
  return `vc${randomBytes(10).toString('hex')}`;
}

export const IDENTITY = {
  user: (userId: string) => `user-${userId}`,
  supervisor: (userId: string) => `sup-${userId}`,
  ai: (callId: string) => `ai-${callId}`,
  sip: (callId: string) => `sip-${callId}`,
} as const;

function userIdFromIdentity(identity: string): string | null {
  if (identity.startsWith('user-')) return identity.slice(5);
  if (identity.startsWith('sup-')) return identity.slice(4);
  return null;
}

function roleFromIdentity(identity: string, call: VoiceCall): string {
  if (identity.startsWith('ai-')) return 'ai';
  if (identity.startsWith('sup-')) return 'supervisor';
  if (identity.startsWith('user-')) return call.type === 'internal' ? 'callee' : 'agent';
  // SIP participants: the external party.
  return call.type === 'inbound' ? 'caller' : 'callee';
}

function isMock(): boolean {
  try {
    return livekit.getLiveKitConfig().mock;
  } catch {
    return true;
  }
}

function aiModeOf(call: CallWithRelations): AiMode {
  if (call.aiState === 'off') return 'off';
  const aiActive = call.participants.some((p) => p.role === 'ai' && !p.leftAt);
  return aiActive ? 'answer' : 'copilot';
}

async function userNames(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

export async function toCallDTO(call: CallWithRelations): Promise<VoiceCallDTO> {
  const names = await userNames(
    call.participants.map((p) => p.userId).filter((v): v is string => Boolean(v))
  );
  const segmentCount = await prisma.voiceTranscriptSegment.count({ where: { callId: call.id } });
  return {
    id: call.id,
    type: call.type as CallType,
    status: call.status as CallStatus,
    roomName: call.roomName,
    fromIdentity: call.fromIdentity,
    toIdentity: call.toIdentity,
    externalNumber: call.externalNumber,
    accountId: call.accountId,
    contactId: call.contactId,
    initiatedByUserId: call.initiatedByUserId,
    aiState: call.aiState as AiState,
    aiMode: aiModeOf(call),
    aiGeneration: call.aiGeneration,
    recordingState: call.recordingState as RecordingState,
    recordingObjectId: call.recordingObjectId,
    transcriptObjectId: call.transcriptObjectId,
    recordingExpiresAt: call.recordingExpiresAt?.toISOString() ?? null,
    transcriptExpiresAt: call.transcriptExpiresAt?.toISOString() ?? null,
    summary: call.summary,
    startedAt: call.startedAt?.toISOString() ?? null,
    endedAt: call.endedAt?.toISOString() ?? null,
    durationSec: call.durationSec,
    createdAt: call.createdAt.toISOString(),
    participants: call.participants.map((p) => ({
      id: p.id,
      identity: p.identity,
      userId: p.userId,
      userName: p.userId ? (names.get(p.userId) ?? null) : null,
      role: p.role,
      joinedAt: p.joinedAt.toISOString(),
      leftAt: p.leftAt?.toISOString() ?? null,
      muted: p.muted,
    })),
    supervisions: call.supervisions
      .filter((s) => !s.endedAt)
      .map((s) => ({
        id: s.id,
        supervisorUserId: s.supervisorUserId,
        mode: s.mode as SupervisionMode,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
      })),
    segmentCount,
    mock: isMock(),
  };
}

async function loadCall(callId: string): Promise<CallWithRelations> {
  const call = await prisma.voiceCall.findUnique({ where: { id: callId }, include: CALL_INCLUDE });
  if (!call) throw new VoiceError('Llamada no encontrada', 'not_found', 404);
  return call as CallWithRelations;
}

async function publishCall(
  call: CallWithRelations,
  type: string,
  extra: Record<string, unknown> = {}
) {
  const dto = await toCallDTO(call);
  await publishRealtime(REALTIME_CHANNELS.call(call.id), type, { call: dto, ...extra });
  return dto;
}

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

async function accountTeamKeys(accountId: string | null): Promise<string[] | null> {
  if (!accountId) return null;
  const account = await prisma.commAccount.findUnique({
    where: { id: accountId },
    select: { teamKeys: true },
  });
  return account?.teamKeys ?? [];
}

function sharesTeam(actor: CurrentUser, teamKeys: string[]): boolean {
  return teamKeys.some((key) => actor.roleKeys.includes(key));
}

/** Supervisors reach internal calls and calls of accounts sharing a team key. */
export async function supervisorCanAccess(actor: CurrentUser, call: VoiceCall): Promise<boolean> {
  if (actor.isSuperAdmin) return true;
  if (!actorHas(actor, 'calls.supervise')) return false;
  if (call.type === 'internal' || !call.accountId) return true;
  const keys = await accountTeamKeys(call.accountId);
  return Boolean(keys && sharesTeam(actor, keys));
}

/** Agents (`calls.use`) may answer inbound calls of their team accounts. */
async function agentCanAnswer(actor: CurrentUser, call: VoiceCall): Promise<boolean> {
  if (!actorHas(actor, 'calls.use')) return false;
  if (call.type !== 'inbound') return false;
  if (!call.accountId) return true;
  const keys = await accountTeamKeys(call.accountId);
  return Boolean(keys && (keys.length === 0 || sharesTeam(actor, keys)));
}

function isParticipant(actor: CurrentUser, call: CallWithRelations): boolean {
  return call.participants.some((p) => p.userId === actor.id && p.role !== 'supervisor');
}

export async function canAccessCall(actor: CurrentUser, call: CallWithRelations): Promise<boolean> {
  if (actor.isSuperAdmin) return true;
  if (actorHas(actor, 'calls.use') && isParticipant(actor, call)) return true;
  if (await supervisorCanAccess(actor, call)) return true;
  if (await agentCanAnswer(actor, call)) return true;
  return false;
}

async function requireCallAccess(actor: CurrentUser, callId: string): Promise<CallWithRelations> {
  const call = await loadCall(callId);
  if (!(await canAccessCall(actor, call))) {
    // Do not reveal existence to users outside the call's scope.
    throw new VoiceError('Llamada no encontrada', 'not_found', 404);
  }
  return call;
}

/** Controls (pause AI, record, transfer, end) require being on the call or supervising it. */
async function requireCallControl(actor: CurrentUser, callId: string): Promise<CallWithRelations> {
  const call = await requireCallAccess(actor, callId);
  const supervising = call.supervisions.some((s) => s.supervisorUserId === actor.id && !s.endedAt);
  const allowed =
    actor.isSuperAdmin ||
    (actorHas(actor, 'calls.use') && isParticipant(actor, call)) ||
    (supervising && actorHas(actor, 'calls.supervise')) ||
    (await supervisorCanAccess(actor, call));
  if (!allowed) throw new VoiceError('Sin permiso para controlar esta llamada', 'forbidden', 403);
  return call;
}

// ---------------------------------------------------------------------------
// Call creation
// ---------------------------------------------------------------------------

async function retentionDates(): Promise<{ recording: Date | null; transcript: Date | null }> {
  const settings = await getStorageSettings();
  const now = Date.now();
  return {
    recording:
      settings.recordingRetentionDays > 0
        ? new Date(now + settings.recordingRetentionDays * 24 * 60 * 60 * 1000)
        : null,
    transcript:
      settings.transcriptRetentionDays > 0
        ? new Date(now + settings.transcriptRetentionDays * 24 * 60 * 60 * 1000)
        : null,
  };
}

export async function createInternalCall(
  actor: CurrentUser,
  input: { calleeUserIds: string[] }
): Promise<{ call: VoiceCallDTO; token: livekit.IssuedToken }> {
  if (!actorHas(actor, 'calls.use')) throw new VoiceError('Sin permiso', 'forbidden', 403);
  const calleeIds = [...new Set(input.calleeUserIds)].filter((id) => id !== actor.id);
  if (calleeIds.length === 0) {
    throw new VoiceError('Selecciona al menos un participante', 'invalid', 400);
  }
  const callees = await prisma.user.findMany({
    where: { id: { in: calleeIds }, isActive: true },
    select: { id: true, name: true },
  });
  if (callees.length !== calleeIds.length) {
    throw new VoiceError('Algún participante no existe o está inactivo', 'invalid', 400);
  }
  const settings = await getVoiceSettings();
  const id = newCallId();
  const room = await livekit.createRoom(id, { maxParticipants: calleeIds.length + 6 });
  await prisma.voiceCall.create({
    data: {
      id,
      type: 'internal',
      roomName: room.roomName,
      status: 'ringing',
      fromIdentity: IDENTITY.user(actor.id),
      toIdentity: callees.map((c) => IDENTITY.user(c.id)).join(','),
      initiatedByUserId: actor.id,
      aiState: settings.copilotEnabled ? 'active' : 'off',
      recordingState: 'off',
      participants: {
        create: [
          { identity: IDENTITY.user(actor.id), userId: actor.id, role: 'caller' },
          ...callees.map((c) => ({ identity: IDENTITY.user(c.id), userId: c.id, role: 'callee' })),
        ],
      },
    },
  });
  const call = await loadCall(id);
  const token = await livekit.issueToken({
    identity: IDENTITY.user(actor.id),
    roomName: call.roomName,
    role: 'participant',
    name: actor.name,
    metadata: { userId: actor.id },
  });
  const dto = await publishCall(call, 'call_updated');
  for (const callee of callees) {
    await publishRealtime(REALTIME_CHANNELS.user(callee.id), 'call_invite', {
      callId: id,
      from: { id: actor.id, name: actor.name },
    });
  }
  return { call: dto, token };
}

const E164 = /^\+[1-9]\d{6,14}$/;

export async function createOutboundCall(
  actor: CurrentUser,
  input: { toNumber: string; accountId?: string | null; contactId?: string | null }
): Promise<{ call: VoiceCallDTO; token: livekit.IssuedToken }> {
  if (!actorHas(actor, 'calls.use')) throw new VoiceError('Sin permiso', 'forbidden', 403);
  if (!E164.test(input.toNumber)) {
    throw new VoiceError('Número inválido (usa formato E.164, ej. +5215512345678)', 'invalid', 400);
  }
  let accountId: string | null = null;
  if (input.accountId) {
    const account = await prisma.commAccount.findUnique({ where: { id: input.accountId } });
    if (!account || account.status !== 'active') {
      throw new VoiceError('Cuenta telefónica no disponible', 'invalid', 400);
    }
    if (
      !actor.isSuperAdmin &&
      account.teamKeys.length > 0 &&
      !sharesTeam(actor, account.teamKeys)
    ) {
      throw new VoiceError('No perteneces al equipo de esta cuenta', 'forbidden', 403);
    }
    accountId = account.id;
  }
  let contactId: string | null = input.contactId ?? null;
  if (!contactId) {
    const contact = await prisma.commContact.findFirst({
      where: { phone: input.toNumber },
      select: { id: true },
    });
    contactId = contact?.id ?? null;
  }
  const settings = await getVoiceSettings();
  const id = newCallId();
  const room = await livekit.createRoom(id);
  await prisma.voiceCall.create({
    data: {
      id,
      type: 'outbound',
      roomName: room.roomName,
      status: 'ringing',
      fromIdentity: IDENTITY.user(actor.id),
      toIdentity: IDENTITY.sip(id),
      externalNumber: input.toNumber,
      accountId,
      contactId,
      initiatedByUserId: actor.id,
      aiState: settings.copilotEnabled ? 'active' : 'off',
      recordingState: 'off',
      participants: {
        create: [{ identity: IDENTITY.user(actor.id), userId: actor.id, role: 'agent' }],
      },
    },
  });
  try {
    await livekit.sipCreateOutbound(id, room.roomName, input.toNumber, IDENTITY.sip(id));
  } catch (err) {
    await prisma.voiceCall.update({
      where: { id },
      data: { status: 'failed', endedAt: new Date() },
    });
    throw err;
  }
  await prisma.voiceParticipant.create({
    data: { callId: id, identity: IDENTITY.sip(id), role: 'callee' },
  });
  const call = await loadCall(id);
  const token = await livekit.issueToken({
    identity: IDENTITY.user(actor.id),
    roomName: call.roomName,
    role: 'participant',
    name: actor.name,
    metadata: { userId: actor.id },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'voice.outbound_call_started',
    targetType: 'voice_call',
    targetId: id,
    metadata: { accountId, hasContact: Boolean(contactId) },
  });
  const dto = await publishCall(call, 'call_updated');
  return { call: dto, token };
}

/**
 * Registers a PSTN call arriving through Twilio. Returns the SIP URI Twilio
 * must dial so the call lands in the LiveKit room of this VoiceCall.
 */
export async function registerInboundCall(input: {
  fromNumber: string;
  toNumber: string;
  providerCallSid: string;
}): Promise<{ call: VoiceCallDTO; sipUri: string; aiAnswers: boolean }> {
  const account = await prisma.commAccount.findFirst({
    where: { identifier: input.toNumber, provider: { startsWith: 'twilio' } },
    select: { id: true, status: true, teamKeys: true },
  });
  const contact = await prisma.commContact.findFirst({
    where: { phone: input.fromNumber },
    select: { id: true },
  });
  const settings = await getVoiceSettings();
  const aiAnswers = aiAnswersAccount(settings, account?.id ?? null);
  // Idempotent per Twilio CallSid: retries of the voice webhook (timeouts,
  // fallback handler) must answer the same TwiML instead of creating a new
  // call for the same PSTN leg.
  const existing = await prisma.voiceCall.findFirst({
    where: { fromIdentity: `twilio:${input.providerCallSid}`, type: 'inbound' },
    select: { id: true },
  });
  if (existing) {
    return {
      call: await publishCall(await loadCall(existing.id), 'call_updated'),
      sipUri: livekit.buildInboundSipUri(existing.id),
      aiAnswers,
    };
  }
  const id = newCallId();
  const room = await livekit.createRoom(id);
  await prisma.voiceCall.create({
    data: {
      id,
      type: 'inbound',
      roomName: room.roomName,
      status: 'ringing',
      fromIdentity: `twilio:${input.providerCallSid}`,
      toIdentity: input.toNumber,
      externalNumber: input.fromNumber,
      accountId: account?.id ?? null,
      contactId: contact?.id ?? null,
      aiState: aiAnswers || settings.copilotEnabled ? 'active' : 'off',
      recordingState: 'off',
      participants: aiAnswers ? { create: [{ identity: IDENTITY.ai(id), role: 'ai' }] } : undefined,
    },
  });
  const call = await loadCall(id);
  const dto = await publishCall(call, 'call_updated');
  await publishRealtime(REALTIME_CHANNELS.inbox(account?.id ?? 'voice'), 'call_incoming', {
    callId: id,
    accountId: account?.id ?? null,
  });
  return { call: dto, sipUri: livekit.buildInboundSipUri(id), aiAnswers };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** TwiML that bridges the PSTN leg into the LiveKit room through SIP. */
export function buildInboundTwiml(callId: string, sipUri: string): string {
  const uri = `${sipUri}?X-Unik-Call=${encodeURIComponent(callId)}`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Dial answerOnBridge="true" timeout="45">' +
    `<Sip>${escapeXml(uri)}</Sip>` +
    '</Dial>' +
    '</Response>'
  );
}

export function buildRejectTwiml(reason: 'busy' | 'rejected' = 'rejected'): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="${reason}"/></Response>`;
}

// ---------------------------------------------------------------------------
// Tokens (join)
// ---------------------------------------------------------------------------

export async function issueParticipantToken(
  actor: CurrentUser,
  callId: string
): Promise<livekit.IssuedToken> {
  if (!actorHas(actor, 'calls.use') && !actor.isSuperAdmin) {
    throw new VoiceError('Sin permiso', 'forbidden', 403);
  }
  const call = await loadCall(callId);
  if (call.status === 'ended' || call.status === 'failed' || call.status === 'missed') {
    throw new VoiceError('La llamada ya terminó', 'state', 409);
  }
  const participant = call.participants.find(
    (p) => p.userId === actor.id && p.role !== 'supervisor'
  );
  if (!participant) {
    if (!(await agentCanAnswer(actor, call)) && !actor.isSuperAdmin) {
      throw new VoiceError('Llamada no encontrada', 'not_found', 404);
    }
    await prisma.voiceParticipant.create({
      data: { callId, identity: IDENTITY.user(actor.id), userId: actor.id, role: 'agent' },
    });
  } else if (participant.leftAt) {
    await prisma.voiceParticipant.update({
      where: { id: participant.id },
      data: { leftAt: null, joinedAt: new Date() },
    });
  }
  const token = await livekit.issueToken({
    identity: IDENTITY.user(actor.id),
    roomName: call.roomName,
    role: 'participant',
    name: actor.name,
    metadata: { userId: actor.id },
  });
  if (call.status === 'ringing' && call.type !== 'internal') {
    // A human answered: the call is active even before the LiveKit webhook.
    await markActive(callId);
  }
  await publishCall(await loadCall(callId), 'participant_joined', {
    identity: IDENTITY.user(actor.id),
  });
  return token;
}

async function markActive(callId: string): Promise<void> {
  const call = await prisma.voiceCall.findUnique({ where: { id: callId } });
  if (!call || call.status !== 'ringing') return;
  await prisma.voiceCall.update({
    where: { id: callId },
    data: { status: 'active', startedAt: call.startedAt ?? new Date() },
  });
  const settings = await getVoiceSettings();
  if (settings.recordByDefault && call.recordingState === 'off') {
    await startCallRecording(callId, 'service:voice');
  }
}

// ---------------------------------------------------------------------------
// Listing and detail
// ---------------------------------------------------------------------------

export interface ListCallsFilter {
  status?: CallStatus[];
  type?: CallType[];
  limit?: number;
}

export async function listCalls(
  actor: CurrentUser,
  filter: ListCallsFilter = {}
): Promise<VoiceCallDTO[]> {
  const canUse = actorHas(actor, 'calls.use');
  const canSupervise = actorHas(actor, 'calls.supervise');
  if (!canUse && !canSupervise && !actor.isSuperAdmin) {
    throw new VoiceError('Sin permiso', 'forbidden', 403);
  }
  const scope: Prisma.VoiceCallWhereInput[] = [];
  if (!actor.isSuperAdmin) {
    const teamAccounts = await prisma.commAccount.findMany({
      where: { teamKeys: { hasSome: actor.roleKeys } },
      select: { id: true },
    });
    const teamAccountIds = teamAccounts.map((a) => a.id);
    if (canUse) {
      scope.push({ participants: { some: { userId: actor.id } } });
      // Inbound calls waiting for an agent of the user's teams.
      scope.push({
        type: 'inbound',
        status: 'ringing',
        OR: [{ accountId: null }, { accountId: { in: teamAccountIds } }],
      });
    }
    if (canSupervise) {
      scope.push({ type: 'internal' });
      scope.push({ accountId: null });
      scope.push({ accountId: { in: teamAccountIds } });
    }
  }
  const where: Prisma.VoiceCallWhereInput = {
    ...(scope.length > 0 ? { OR: scope } : {}),
    ...(filter.status && filter.status.length > 0 ? { status: { in: filter.status } } : {}),
    ...(filter.type && filter.type.length > 0 ? { type: { in: filter.type } } : {}),
  };
  const calls = await prisma.voiceCall.findMany({
    where,
    include: CALL_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(filter.limit ?? 50, 1), 200),
  });
  const out: VoiceCallDTO[] = [];
  for (const call of calls) out.push(await toCallDTO(call as CallWithRelations));
  return out;
}

export async function getCall(actor: CurrentUser, callId: string): Promise<VoiceCallDTO> {
  const call = await requireCallAccess(actor, callId);
  return toCallDTO(call);
}

// ---------------------------------------------------------------------------
// AI controls
// ---------------------------------------------------------------------------

/**
 * "Pausar IA": stops listening, transcription, analysis and voice. The
 * generation counter is bumped so any result computed before the pause
 * (transcription, analysis, TTS) is discarded when it arrives.
 */
export async function pauseAi(actor: CurrentUser, callId: string): Promise<VoiceCallDTO> {
  const call = await requireCallControl(actor, callId);
  if (call.aiState === 'paused') return toCallDTO(call);
  await prisma.voiceCall.update({
    where: { id: callId },
    data: { aiState: 'paused', aiPausedAt: new Date(), aiGeneration: { increment: 1 } },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'voice.ai_paused',
    targetType: 'voice_call',
    targetId: callId,
  });
  return publishCall(await loadCall(callId), 'ai_state', { by: actor.id });
}

export async function resumeAi(actor: CurrentUser, callId: string): Promise<VoiceCallDTO> {
  const call = await requireCallControl(actor, callId);
  if (call.aiState === 'active') return toCallDTO(call);
  await prisma.voiceCall.update({
    where: { id: callId },
    data: { aiState: 'active', aiPausedAt: null, aiGeneration: { increment: 1 } },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'voice.ai_resumed',
    targetType: 'voice_call',
    targetId: callId,
  });
  return publishCall(await loadCall(callId), 'ai_state', { by: actor.id });
}

/** Result gate used by every asynchronous AI pipeline stage. */
export async function aiResultIsCurrent(callId: string, generation: number): Promise<boolean> {
  const call = await prisma.voiceCall.findUnique({
    where: { id: callId },
    select: { aiState: true, aiGeneration: true },
  });
  return Boolean(call && call.aiState === 'active' && generation >= call.aiGeneration);
}

// ---------------------------------------------------------------------------
// Recording (independent control, always visible)
// ---------------------------------------------------------------------------

async function startCallRecording(callId: string, by: string): Promise<CallWithRelations> {
  const call = await loadCall(callId);
  if (call.recordingState === 'recording') return call;
  const egress = await livekit.startRecording(callId, call.roomName);
  const retention = await retentionDates();
  await prisma.voiceCall.update({
    where: { id: callId },
    data: {
      recordingState: 'recording',
      egressId: egress.egressId,
      recordingExpiresAt: retention.recording,
    },
  });
  const updated = await loadCall(callId);
  await publishCall(updated, 'recording_state', { by });
  return updated;
}

async function stopCallRecording(callId: string, by: string): Promise<CallWithRelations> {
  const call = await loadCall(callId);
  if (call.recordingState !== 'recording') return call;
  if (call.egressId) {
    try {
      await livekit.stopRecording(call.egressId);
    } catch {
      // The egress may have ended already; the webhook finalizes the object.
    }
  }
  await prisma.voiceCall.update({ where: { id: callId }, data: { recordingState: 'stopped' } });
  const updated = await loadCall(callId);
  await publishCall(updated, 'recording_state', { by });
  return updated;
}

export async function setRecording(
  actor: CurrentUser,
  callId: string,
  on: boolean
): Promise<VoiceCallDTO> {
  const call = await requireCallControl(actor, callId);
  if (call.status !== 'active' && call.status !== 'ringing') {
    throw new VoiceError('La llamada no está activa', 'state', 409);
  }
  const updated = on
    ? await startCallRecording(callId, actor.id)
    : await stopCallRecording(callId, actor.id);
  await recordAuditEvent({
    actorUserId: actor.id,
    action: on ? 'voice.recording_started' : 'voice.recording_stopped',
    targetType: 'voice_call',
    targetId: callId,
  });
  return toCallDTO(updated);
}

// ---------------------------------------------------------------------------
// Transfer to a human
// ---------------------------------------------------------------------------

export async function transferToHuman(
  actor: CurrentUser,
  callId: string,
  targetUserId: string
): Promise<VoiceCallDTO> {
  const call = await requireCallControl(actor, callId);
  if (call.status !== 'active' && call.status !== 'ringing') {
    throw new VoiceError('La llamada no está activa', 'state', 409);
  }
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, name: true, isActive: true },
  });
  if (!target || !target.isActive)
    throw new VoiceError('Usuario destino no válido', 'invalid', 400);
  const existing = call.participants.find((p) => p.userId === target.id && p.role !== 'supervisor');
  if (!existing) {
    await prisma.voiceParticipant.create({
      data: { callId, identity: IDENTITY.user(target.id), userId: target.id, role: 'agent' },
    });
  } else if (existing.leftAt) {
    await prisma.voiceParticipant.update({
      where: { id: existing.id },
      data: { leftAt: null, joinedAt: new Date() },
    });
  }
  // The AI stops speaking once a human takes over (it may keep suggesting as copilot).
  await prisma.voiceParticipant.updateMany({
    where: { callId, role: 'ai', leftAt: null },
    data: { leftAt: new Date() },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'voice.call_transferred',
    targetType: 'voice_call',
    targetId: callId,
    metadata: { targetUserId: target.id },
  });
  await publishRealtime(REALTIME_CHANNELS.user(target.id), 'call_transfer', {
    callId,
    from: { id: actor.id, name: actor.name },
  });
  return publishCall(await loadCall(callId), 'transfer', {
    targetUserId: target.id,
    targetName: target.name,
  });
}

// ---------------------------------------------------------------------------
// Supervision
// ---------------------------------------------------------------------------

export async function startSupervision(
  actor: CurrentUser,
  callId: string,
  mode: SupervisionMode
): Promise<{ supervision: VoiceSupervisionDTO; token: livekit.IssuedToken }> {
  if (!actorHas(actor, 'calls.supervise')) {
    throw new VoiceError('Sin permiso de supervisión', 'forbidden', 403);
  }
  const call = await loadCall(callId);
  if (!(await supervisorCanAccess(actor, call))) {
    throw new VoiceError('Llamada fuera de tus equipos', 'forbidden', 403);
  }
  if (call.status !== 'active' && call.status !== 'ringing') {
    throw new VoiceError('La llamada no está activa', 'state', 409);
  }
  const agent = call.participants.find(
    (p) =>
      !p.leftAt && (p.role === 'agent' || p.role === 'caller' || p.role === 'callee') && p.userId
  );
  await prisma.voiceSupervision.updateMany({
    where: { callId, supervisorUserId: actor.id, endedAt: null },
    data: { endedAt: new Date() },
  });
  const supervision = await prisma.voiceSupervision.create({
    data: { callId, supervisorUserId: actor.id, mode },
  });
  const identity = IDENTITY.supervisor(actor.id);
  const existing = call.participants.find((p) => p.identity === identity);
  if (!existing) {
    await prisma.voiceParticipant.create({
      data: { callId, identity, userId: actor.id, role: 'supervisor' },
    });
  } else {
    await prisma.voiceParticipant.update({
      where: { id: existing.id },
      data: { leftAt: null, joinedAt: new Date() },
    });
  }
  const token = await livekit.issueToken({
    identity,
    roomName: call.roomName,
    role: mode,
    name: actor.name,
    whisperTo: mode === 'whisper' ? (agent?.identity ?? undefined) : undefined,
    metadata: { userId: actor.id, supervision: mode },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'voice.supervision_started',
    targetType: 'voice_call',
    targetId: callId,
    metadata: { mode },
  });
  await publishCall(await loadCall(callId), 'supervision', { mode, supervisorUserId: actor.id });
  return {
    supervision: {
      id: supervision.id,
      supervisorUserId: supervision.supervisorUserId,
      mode,
      startedAt: supervision.startedAt.toISOString(),
      endedAt: null,
    },
    token,
  };
}

export async function endSupervision(actor: CurrentUser, callId: string): Promise<VoiceCallDTO> {
  const call = await loadCall(callId);
  const active = call.supervisions.find((s) => s.supervisorUserId === actor.id && !s.endedAt);
  if (!active && !actor.isSuperAdmin) {
    throw new VoiceError('No estás supervisando esta llamada', 'state', 409);
  }
  await prisma.voiceSupervision.updateMany({
    where: { callId, supervisorUserId: actor.id, endedAt: null },
    data: { endedAt: new Date() },
  });
  await prisma.voiceParticipant.updateMany({
    where: { callId, identity: IDENTITY.supervisor(actor.id), leftAt: null },
    data: { leftAt: new Date() },
  });
  try {
    await livekit.removeParticipant(call.roomName, IDENTITY.supervisor(actor.id));
  } catch {
    // Already gone.
  }
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'voice.supervision_ended',
    targetType: 'voice_call',
    targetId: callId,
  });
  return publishCall(await loadCall(callId), 'supervision', {
    ended: true,
    supervisorUserId: actor.id,
  });
}

// ---------------------------------------------------------------------------
// Ending calls
// ---------------------------------------------------------------------------

async function finishCall(callId: string, status: 'ended' | 'failed' | 'missed', by: string) {
  const call = await loadCall(callId);
  if (call.status === 'ended' || call.status === 'failed' || call.status === 'missed') return call;
  if (call.recordingState === 'recording') await stopCallRecording(callId, by);
  const endedAt = new Date();
  const durationSec = call.startedAt
    ? Math.max(0, Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000))
    : null;
  const retention = await retentionDates();
  await prisma.voiceCall.update({
    where: { id: callId },
    data: {
      status,
      endedAt,
      durationSec,
      transcriptExpiresAt: retention.transcript,
    },
  });
  await prisma.voiceParticipant.updateMany({
    where: { callId, leftAt: null },
    data: { leftAt: endedAt },
  });
  await prisma.voiceSupervision.updateMany({
    where: { callId, endedAt: null },
    data: { endedAt },
  });
  await livekit.deleteRoom(call.roomName);
  const updated = await loadCall(callId);
  await publishCall(updated, 'call_ended', { by });
  if (status === 'ended' && updated.aiState === 'active') {
    const segments = await prisma.voiceTranscriptSegment.count({ where: { callId } });
    if (segments > 0) {
      await enqueueJob({
        type: VOICE_SUMMARIZE_JOB,
        payload: { callId, generation: updated.aiGeneration },
        priority: JOB_PRIORITY.interactive,
        dedupeKey: `${VOICE_SUMMARIZE_JOB}:${callId}`,
        groupKey: `call:${callId}`,
      });
    }
  }
  return updated;
}

export async function endCall(actor: CurrentUser, callId: string): Promise<VoiceCallDTO> {
  const call = await requireCallControl(actor, callId);
  const status = call.status === 'ringing' && call.type === 'inbound' ? 'missed' : 'ended';
  const updated = await finishCall(callId, status, actor.id);
  return toCallDTO(updated);
}

// ---------------------------------------------------------------------------
// LiveKit webhooks
// ---------------------------------------------------------------------------

export async function handleLiveKitEvent(
  event: livekit.NormalizedWebhookEvent
): Promise<{ handled: boolean; callId?: string; reason?: string }> {
  if (event.event.startsWith('egress_')) {
    if (!event.egress) return { handled: false, reason: 'no_egress' };
    const call = await prisma.voiceCall.findFirst({ where: { egressId: event.egress.egressId } });
    if (!call) return { handled: false, reason: 'unknown_egress' };
    if (event.event === 'egress_ended') {
      await finalizeRecording(call.id, event.egress);
      return { handled: true, callId: call.id };
    }
    return { handled: true, callId: call.id };
  }
  if (!event.roomName) return { handled: false, reason: 'no_room' };
  const call = await prisma.voiceCall.findUnique({ where: { roomName: event.roomName } });
  if (!call) return { handled: false, reason: 'unknown_room' };

  switch (event.event) {
    case 'participant_joined': {
      if (!event.participant) return { handled: false, reason: 'no_participant' };
      const identity = event.participant.identity;
      const existing = await prisma.voiceParticipant.findFirst({
        where: { callId: call.id, identity },
      });
      if (!existing) {
        await prisma.voiceParticipant.create({
          data: {
            callId: call.id,
            identity,
            userId: userIdFromIdentity(identity),
            role: roleFromIdentity(identity, call),
          },
        });
      } else if (existing.leftAt) {
        await prisma.voiceParticipant.update({
          where: { id: existing.id },
          data: { leftAt: null, joinedAt: new Date() },
        });
      }
      const humans = await prisma.voiceParticipant.count({
        where: { callId: call.id, leftAt: null, role: { notIn: ['supervisor'] } },
      });
      // Internal/outbound: active when two parties are present; inbound: when
      // the caller lands (an agent or the AI is expected to pick up).
      if (call.status === 'ringing' && (humans >= 2 || call.type === 'inbound')) {
        await markActive(call.id);
      }
      await publishCall(await loadCall(call.id), 'participant_joined', { identity });
      return { handled: true, callId: call.id };
    }
    case 'participant_left': {
      if (!event.participant) return { handled: false, reason: 'no_participant' };
      await prisma.voiceParticipant.updateMany({
        where: { callId: call.id, identity: event.participant.identity, leftAt: null },
        data: { leftAt: new Date() },
      });
      await publishCall(await loadCall(call.id), 'participant_left', {
        identity: event.participant.identity,
      });
      return { handled: true, callId: call.id };
    }
    case 'room_finished': {
      const status =
        call.status === 'ringing' ? (call.type === 'inbound' ? 'missed' : 'failed') : 'ended';
      await finishCall(call.id, status, 'service:livekit');
      return { handled: true, callId: call.id };
    }
    case 'room_started':
    case 'track_published':
    case 'track_unpublished':
    case 'participant_connection_aborted':
      return { handled: true, callId: call.id };
    default:
      return { handled: false, callId: call.id, reason: 'ignored_event' };
  }
}

/**
 * `egress_ended`: the recording was written by LiveKit directly to R2. We
 * verify the object exists (HEAD) before registering it as `ready`; otherwise
 * the StorageObject is created as `missing` so the gap is visible.
 */
export async function finalizeRecording(
  callId: string,
  egress: NonNullable<livekit.NormalizedWebhookEvent['egress']>
): Promise<{ objectId: string | null; status: 'ready' | 'missing' | 'failed' }> {
  const call = await prisma.voiceCall.findUnique({ where: { id: callId } });
  if (!call) throw new VoiceError('Llamada no encontrada', 'not_found', 404);
  const file = egress.files[0];
  if (!file || !file.filename) {
    await prisma.voiceCall.update({
      where: { id: callId },
      data: { recordingState: 'stopped' },
    });
    await publishRealtime(REALTIME_CHANNELS.call(callId), 'recording_state', {
      failed: true,
      error: egress.error ?? 'Sin archivo de salida',
    });
    return { objectId: null, status: 'failed' };
  }
  const key = file.filename.replace(/^\/+/, '');
  const driver = getObjectStorageDriver();
  let head: { sizeBytes: number; contentType: string | null } | null = null;
  try {
    head = await driver.headObject('recordings', key);
  } catch {
    head = null;
  }
  const settings = await getStorageSettings();
  const expiresAt =
    settings.recordingRetentionDays > 0
      ? new Date(Date.now() + settings.recordingRetentionDays * 24 * 60 * 60 * 1000)
      : null;
  const mime = key.endsWith('.mp4') || key.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4';
  const status: 'ready' | 'missing' = head ? 'ready' : 'missing';
  const object = await prisma.storageObject.create({
    data: {
      provider: driver.provider,
      bucketAlias: 'recordings',
      objectKey: key,
      versionId: egress.egressId,
      originalName: `grabacion-${callId}.mp4`,
      declaredMimeType: mime,
      detectedMimeType: head?.contentType ?? mime,
      sizeBytes: BigInt(head?.sizeBytes ?? file.sizeBytes ?? 0),
      status,
      createdBy: 'service:livekit',
      purpose: 'recording',
      retentionPolicy: 'default',
      expiresAt,
      metadata: {
        restricted: true,
        callId,
        egressId: egress.egressId,
        durationMs: file.durationMs,
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.voiceCall.update({
    where: { id: callId },
    data: {
      recordingState: 'stopped',
      recordingObjectId: object.id,
      recordingExpiresAt: expiresAt,
    },
  });
  await publishRealtime(REALTIME_CHANNELS.call(callId), 'recording_ready', {
    objectId: object.id,
    status,
  });
  if (status === 'ready' && call.aiState === 'active') {
    await enqueueJob({
      type: VOICE_TRANSCRIBE_JOB,
      payload: { callId, generation: call.aiGeneration },
      priority: JOB_PRIORITY.normal,
      dedupeKey: `${VOICE_TRANSCRIBE_JOB}:${callId}:${object.id}`,
      groupKey: `call:${callId}`,
    });
  }
  return { objectId: object.id, status };
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export async function getTranscript(
  actor: CurrentUser,
  callId: string
): Promise<{ call: VoiceCallDTO; segments: TranscriptSegmentDTO[] }> {
  const call = await requireCallAccess(actor, callId);
  const rows = await prisma.voiceTranscriptSegment.findMany({
    where: { callId },
    orderBy: { startMs: 'asc' },
    take: 2000,
  });
  return {
    call: await toCallDTO(call),
    segments: rows.map((s) => ({
      id: s.id,
      speakerIdentity: s.speakerIdentity,
      text: s.text,
      startMs: s.startMs,
      endMs: s.endMs,
      generation: s.generation,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

export type IngestResult =
  | { accepted: true; segment: TranscriptSegmentDTO }
  | { accepted: false; reason: 'ai_paused' | 'ai_off' | 'stale_generation' | 'call_not_active' };

/**
 * Stores a live transcript segment. Results with an older generation (produced
 * before a pause/resume) or arriving while the AI is paused are discarded.
 */
export async function ingestTranscriptSegment(
  callId: string,
  input: TranscriptSegmentInput,
  generation: number
): Promise<IngestResult> {
  const call = await prisma.voiceCall.findUnique({ where: { id: callId } });
  if (!call) throw new VoiceError('Llamada no encontrada', 'not_found', 404);
  if (call.status !== 'active' && call.status !== 'ringing') {
    return { accepted: false, reason: 'call_not_active' };
  }
  if (call.aiState === 'off') return { accepted: false, reason: 'ai_off' };
  if (call.aiState !== 'active') return { accepted: false, reason: 'ai_paused' };
  if (generation < call.aiGeneration) return { accepted: false, reason: 'stale_generation' };
  const text = input.text.trim().slice(0, 4000);
  if (!text) return { accepted: false, reason: 'call_not_active' };
  const row = await prisma.voiceTranscriptSegment.create({
    data: {
      callId,
      speakerIdentity: input.speakerIdentity.slice(0, 120),
      text,
      startMs: Math.max(0, Math.round(input.startMs)),
      endMs: Math.max(0, Math.round(input.endMs)),
      generation: call.aiGeneration,
    },
  });
  const segment: TranscriptSegmentDTO = {
    id: row.id,
    speakerIdentity: row.speakerIdentity,
    text: row.text,
    startMs: row.startMs,
    endMs: row.endMs,
    generation: row.generation,
    createdAt: row.createdAt.toISOString(),
  };
  await publishRealtime(REALTIME_CHANNELS.call(callId), 'transcript_segment', { segment });

  const settings = await getVoiceSettings();
  if (settings.copilotEnabled) {
    const count = await prisma.voiceTranscriptSegment.count({ where: { callId } });
    if (count % settings.copilotEveryNSegments === 0) {
      await enqueueJob({
        type: VOICE_COPILOT_JOB,
        payload: { callId, generation: call.aiGeneration, upToCount: count },
        priority: JOB_PRIORITY.interactive,
        dedupeKey: `${VOICE_COPILOT_JOB}:${callId}:${count}`,
        groupKey: `call:${callId}`,
        maxAttempts: 1,
      });
    }
  }
  return { accepted: true, segment };
}

/**
 * Job body for `voice.transcribe`: streams the recording to a temporary file,
 * transcribes it with the configured provider and stores the transcript JSON
 * as a restricted `transcript` object with its own retention.
 */
export async function transcribeRecording(
  callId: string,
  generation: number
): Promise<{ skipped?: string; objectId?: string; chars?: number }> {
  const call = await prisma.voiceCall.findUnique({ where: { id: callId } });
  if (!call) return { skipped: 'call_not_found' };
  if (!call.recordingObjectId) return { skipped: 'no_recording' };
  if (call.aiState !== 'active') return { skipped: 'ai_not_active' };
  if (generation < call.aiGeneration) return { skipped: 'stale_generation' };
  const { getAiSettings } = await import('@/modules/ai/ai-admin-config-service');
  const aiSettings = await getAiSettings();
  if (!aiSettings.isEnabled || !aiSettings.voiceEnabled) return { skipped: 'voice_disabled' };

  const object = await getStorageObject(call.recordingObjectId);
  if (!object || object.status !== 'ready') return { skipped: 'recording_not_ready' };
  const MAX_BYTES = 24 * 1024 * 1024; // provider upload limit
  if (Number(object.sizeBytes) > MAX_BYTES) return { skipped: 'recording_too_large' };

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unik-voice-'));
  const tmpFile = path.join(dir, 'recording.mp4');
  try {
    const stream = await openObjectStream(object);
    if (!stream) return { skipped: 'recording_missing' };
    await pipeline(stream.stream, fs.createWriteStream(tmpFile));
    const audio = await fsp.readFile(tmpFile);
    const { openaiProvider } = await import('@/modules/ai/providers');
    if (!openaiProvider.transcribe) return { skipped: 'provider_no_stt' };
    const text = await openaiProvider.transcribe(
      audio,
      object.detectedMimeType ?? object.declaredMimeType,
      aiSettings.sttModel || undefined
    );
    // Discard late results: the AI may have been paused while we transcribed.
    if (!(await aiResultIsCurrent(callId, generation))) return { skipped: 'discarded_after_pause' };
    const meta = (object.metadata as Record<string, unknown> | null) ?? {};
    const durationMs = typeof meta.durationMs === 'number' ? meta.durationMs : 0;
    const segment = await prisma.voiceTranscriptSegment.create({
      data: {
        callId,
        speakerIdentity: 'recording',
        text: text.trim().slice(0, 100_000),
        startMs: 0,
        endMs: durationMs,
        generation: call.aiGeneration,
      },
    });
    const settings = await getStorageSettings();
    const expiresAt =
      settings.transcriptRetentionDays > 0
        ? new Date(Date.now() + settings.transcriptRetentionDays * 24 * 60 * 60 * 1000)
        : null;
    const transcript = await saveGeneratedFile({
      createdBy: 'service:voice',
      purpose: 'transcript',
      fileName: `transcripcion-${callId}.json`,
      mimeType: 'application/json',
      source: {
        buffer: Buffer.from(
          JSON.stringify({
            callId,
            generation: call.aiGeneration,
            createdAt: new Date().toISOString(),
            segments: [
              { id: segment.id, speaker: 'recording', startMs: 0, endMs: durationMs, text },
            ],
          })
        ),
      },
      restricted: true,
      expiresAt,
      metadata: { callId, restricted: true },
    });
    await prisma.voiceCall.update({
      where: { id: callId },
      data: { transcriptObjectId: transcript.id, transcriptExpiresAt: expiresAt },
    });
    await publishRealtime(REALTIME_CHANNELS.call(callId), 'transcript_ready', {
      objectId: transcript.id,
    });
    await enqueueJob({
      type: VOICE_SUMMARIZE_JOB,
      payload: { callId, generation: call.aiGeneration },
      priority: JOB_PRIORITY.normal,
      dedupeKey: `${VOICE_SUMMARIZE_JOB}:${callId}:post-transcript`,
      groupKey: `call:${callId}`,
    });
    return { objectId: transcript.id, chars: text.length };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Tasks created from calls (allowed catalog, one task per call+type)
// ---------------------------------------------------------------------------

export interface CreateTaskFromCallInput {
  callId: string;
  type: string;
  title: string;
  description?: string;
  /** User creating the task (human) or null when the AI creates it. */
  actorUserId: string | null;
  assigneeUserId?: string | null;
  priority?: 'normal' | 'high' | 'urgent';
}

export type CreateTaskResult =
  | { created: true; requestId: string }
  | { created: false; requestId: string; reason: 'duplicate' }
  | { created: false; reason: 'type_not_allowed' | 'no_owner' | 'call_not_found' };

/**
 * A single call request creates ONE task: the same (callId, type) pair is
 * deduplicated. The type must be in the admin-allowed catalog.
 */
export async function createTaskFromCall(
  input: CreateTaskFromCallInput,
  settings?: VoiceSettings
): Promise<CreateTaskResult> {
  const voiceSettings = settings ?? (await getVoiceSettings());
  if (!isTaskTypeAllowed(voiceSettings, input.type))
    return { created: false, reason: 'type_not_allowed' };
  const call = await prisma.voiceCall.findUnique({ where: { id: input.callId } });
  if (!call) return { created: false, reason: 'call_not_found' };
  const existing = await prisma.internalRequest.findFirst({
    where: {
      type: input.type,
      dossier: { path: ['callId'], equals: input.callId },
    },
    select: { id: true },
  });
  if (existing) return { created: false, requestId: existing.id, reason: 'duplicate' };

  const owner =
    input.actorUserId ??
    input.assigneeUserId ??
    call.initiatedByUserId ??
    voiceSettings.defaultTaskOwnerUserId;
  if (!owner) return { created: false, reason: 'no_owner' };
  const request = await prisma.internalRequest.create({
    data: {
      type: input.type,
      title: input.title.trim().slice(0, 200),
      description: input.description?.trim().slice(0, 4000) ?? null,
      requesterUserId: owner,
      assigneeUserId: input.assigneeUserId ?? (input.actorUserId ? null : owner),
      status: 'open',
      priority: input.priority ?? 'normal',
      contactId: call.contactId,
      dossier: {
        source: 'voice',
        callId: call.id,
        callType: call.type,
        externalNumber: call.externalNumber,
        createdBy: input.actorUserId ?? 'service:voice',
      } as Prisma.InputJsonValue,
      events: {
        create: [
          {
            type: 'created',
            body: input.actorUserId
              ? 'Tarea creada desde una llamada'
              : 'Tarea creada por la IA durante una llamada (pendiente de revisión humana)',
            actorUserId: input.actorUserId,
            metadata: { callId: call.id } as Prisma.InputJsonValue,
          },
        ],
      },
    },
  });
  await publishRealtime(REALTIME_CHANNELS.call(call.id), 'task_created', {
    requestId: request.id,
    type: input.type,
    title: request.title,
  });
  return { created: true, requestId: request.id };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export async function runVoiceRetention(
  now: Date = new Date()
): Promise<{ recordings: number; transcripts: number; segments: number }> {
  const settings = await getStorageSettings();
  let recordings = 0;
  let transcripts = 0;

  const expiredRecordings = await prisma.voiceCall.findMany({
    where: { recordingObjectId: { not: null }, recordingExpiresAt: { lt: now } },
    select: { id: true, recordingObjectId: true },
    take: 500,
  });
  for (const call of expiredRecordings) {
    if (!call.recordingObjectId) continue;
    await deleteObjectIfUnreferenced(call.recordingObjectId, { force: true });
    await prisma.voiceCall.update({
      where: { id: call.id },
      data: { recordingObjectId: null },
    });
    recordings++;
  }

  const expiredTranscripts = await prisma.voiceCall.findMany({
    where: {
      transcriptExpiresAt: { lt: now },
      OR: [{ transcriptObjectId: { not: null } }, { summary: { not: null } }],
    },
    select: { id: true, transcriptObjectId: true },
    take: 500,
  });
  for (const call of expiredTranscripts) {
    if (call.transcriptObjectId) {
      await deleteObjectIfUnreferenced(call.transcriptObjectId, { force: true });
    }
    await prisma.voiceTranscriptSegment.deleteMany({ where: { callId: call.id } });
    await prisma.voiceCall.update({
      where: { id: call.id },
      data: { transcriptObjectId: null, summary: null },
    });
    transcripts++;
  }

  let segments = 0;
  if (settings.transcriptRetentionDays > 0) {
    const cutoff = new Date(now.getTime() - settings.transcriptRetentionDays * 24 * 60 * 60 * 1000);
    const removed = await prisma.voiceTranscriptSegment.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    segments = removed.count;
  }
  return { recordings, transcripts, segments };
}
