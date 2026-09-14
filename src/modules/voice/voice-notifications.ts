import { prisma } from '@/lib/prisma';
import { findUsersWithPermission } from '@/modules/notifications/audience';
import { notifyUser, notifyUsers } from '@/modules/notifications/notification-service';

/**
 * Telephony notifications. Incoming calls are `urgent` (they bypass quiet
 * hours and mutes, and the push is `high` urgency with a short TTL: a ring
 * delivered two minutes late is noise, not help).
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'voice-notifications', event, ...extra }));

function callUrl(callId: string): string {
  return `/app/calls?call=${encodeURIComponent(callId)}`;
}

async function loadCallContext(callId: string) {
  const call = await prisma.voiceCall.findUnique({
    where: { id: callId },
    include: { participants: true },
  });
  if (!call) return null;
  const [contact, account] = await Promise.all([
    call.contactId
      ? prisma.commContact.findUnique({ where: { id: call.contactId }, select: { displayName: true } })
      : Promise.resolve(null),
    call.accountId
      ? prisma.commAccount.findUnique({
          where: { id: call.accountId },
          select: { label: true, teamKeys: true },
        })
      : Promise.resolve(null),
  ]);
  return { call, contact, account };
}

/** Agents who may answer calls on this account (team keys = role keys). */
async function agentsFor(teamKeys: string[] | undefined, exclude: Array<string | null | undefined> = []) {
  return findUsersWithPermission('calls.use', { roleKeys: teamKeys ?? [], excludeUserIds: exclude });
}

export async function notifyIncomingCall(callId: string): Promise<void> {
  const ctx = await loadCallContext(callId);
  if (!ctx) return;
  const { call, contact, account } = ctx;
  const who = contact?.displayName ?? call.externalNumber ?? 'Número desconocido';
  const agents = await agentsFor(account?.teamKeys);
  if (agents.length === 0) return;
  await notifyUsers(agents, {
    category: 'call_incoming',
    title: `📞 Llamada entrante · ${who}`,
    body: account?.label ? `Línea: ${account.label}` : (call.externalNumber ?? null),
    url: callUrl(callId),
    entityType: 'voice_call',
    entityId: callId,
    dedupeKeyPrefix: `call_in:${callId}`,
    metadata: { callId, from: call.externalNumber, accountId: call.accountId },
    push: { tag: `call:${callId}`, requireInteraction: true, renotify: true, ttlSeconds: 60, urgency: 'high' },
  });
  log('incoming_notified', { callId, agents: agents.length });
}

export async function notifyMissedCall(callId: string): Promise<void> {
  const ctx = await loadCallContext(callId);
  if (!ctx) return;
  const { call, contact, account } = ctx;
  if (call.type !== 'inbound') return;
  const who = contact?.displayName ?? call.externalNumber ?? 'Número desconocido';
  const agents = await agentsFor(account?.teamKeys);
  if (agents.length === 0) return;
  await notifyUsers(agents, {
    category: 'call_missed',
    title: `Llamada perdida · ${who}`,
    body: call.externalNumber
      ? `${call.externalNumber}${account?.label ? ` · ${account.label}` : ''}`
      : (account?.label ?? null),
    url: callUrl(callId),
    entityType: 'voice_call',
    entityId: callId,
    dedupeKeyPrefix: `call_missed:${callId}`,
    metadata: { callId, from: call.externalNumber, contactId: call.contactId },
    push: { tag: `call:${callId}`, renotify: true },
  });
}

/** Call transferred by a person or by the AI agent to a specific user. */
export async function notifyCallTransfer(input: {
  callId: string;
  targetUserId: string;
  fromUserId?: string | null;
  fromName: string;
}): Promise<void> {
  const ctx = await loadCallContext(input.callId);
  const who = ctx?.contact?.displayName ?? ctx?.call.externalNumber ?? 'una llamada';
  await notifyUser({
    userId: input.targetUserId,
    actorUserId: input.fromUserId ?? null,
    category: 'call_incoming',
    type: 'call_transfer',
    title: `📞 ${input.fromName} te transfiere una llamada`,
    body: `Con ${who}`,
    url: callUrl(input.callId),
    entityType: 'voice_call',
    entityId: input.callId,
    dedupeKey: `call_transfer:${input.callId}:${input.targetUserId}`,
    metadata: { callId: input.callId, from: input.fromUserId ?? null },
    push: { tag: `call:${input.callId}`, requireInteraction: true, renotify: true, ttlSeconds: 60, urgency: 'high' },
  });
}

/** AI summary ready: the humans on the call, or the account's agents when the AI handled it alone. */
export async function notifyCallSummary(callId: string, summary: string): Promise<void> {
  const ctx = await loadCallContext(callId);
  if (!ctx) return;
  const { call, contact, account } = ctx;
  const humans = new Set<string>();
  for (const p of call.participants) if (p.userId && p.role !== 'supervisor') humans.add(p.userId);
  if (call.initiatedByUserId) humans.add(call.initiatedByUserId);
  let recipients = [...humans];
  let aiHandled = false;
  if (recipients.length === 0 && call.type === 'inbound') {
    recipients = await agentsFor(account?.teamKeys);
    aiHandled = true;
  }
  if (recipients.length === 0) return;
  const who = contact?.displayName ?? call.externalNumber ?? 'llamada';
  const firstLine = summary.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  await notifyUsers(recipients, {
    category: 'call_summary',
    type: aiHandled ? 'call_summary_ai' : 'call_summary',
    title: aiHandled ? `La IA atendió a ${who}` : `Resumen listo · ${who}`,
    body: firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine || 'Resumen de la llamada disponible',
    url: callUrl(callId),
    entityType: 'voice_call',
    entityId: callId,
    dedupeKeyPrefix: `call_summary:${callId}:${call.aiGeneration}`,
    metadata: { callId, aiHandled },
    push: { tag: `call-summary:${callId}` },
  });
}

/** The AI agent asked for a human: ring the account's agents (the caller is waiting). */
export async function notifyTransferRequested(callId: string, reason: string | null): Promise<void> {
  const ctx = await loadCallContext(callId);
  if (!ctx) return;
  const { call, contact, account } = ctx;
  const who = contact?.displayName ?? call.externalNumber ?? 'Número desconocido';
  const recipients = call.initiatedByUserId ? [call.initiatedByUserId] : await agentsFor(account?.teamKeys);
  if (recipients.length === 0) return;
  await notifyUsers(recipients, {
    category: 'call_incoming',
    type: 'call_transfer_requested',
    title: `📞 La IA pide que atiendas a ${who}`,
    body: reason ? reason.slice(0, 160) : 'El cliente quiere hablar con una persona',
    url: callUrl(callId),
    entityType: 'voice_call',
    entityId: callId,
    dedupeKeyPrefix: `call_transfer_req:${callId}:${call.aiGeneration}`,
    metadata: { callId, reason },
    push: { tag: `call:${callId}`, requireInteraction: true, renotify: true, ttlSeconds: 90, urgency: 'high' },
  });
}
