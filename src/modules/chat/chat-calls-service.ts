import { prisma } from '@/lib/prisma';
import { CurrentUser, AuthorizationError } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { assertChannelMember } from './chat-service';

class ChatCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatCallError';
  }
}

export interface ChatCallDTO {
  id: string;
  channelId: string;
  callerId: string;
  callerName: string;
  type: 'audio' | 'video';
  status: 'ringing' | 'active' | 'ended' | 'missed' | 'declined';
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  participants: {
    userId: string;
    name: string;
    acceptedAt: string | null;
    declinedAt: string | null;
  }[];
}

async function toCallDTO(call: {
  id: string;
  channelId: string;
  callerId: string;
  type: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  caller: { name: string };
  participants: {
    userId: string;
    acceptedAt: Date | null;
    declinedAt: Date | null;
    user: { name: string };
  }[];
}): Promise<ChatCallDTO> {
  return {
    id: call.id,
    channelId: call.channelId,
    callerId: call.callerId,
    callerName: call.caller.name,
    type: call.type as 'audio' | 'video',
    status: call.status as 'ringing' | 'active' | 'ended' | 'missed' | 'declined',
    startedAt: call.startedAt?.toISOString() ?? null,
    endedAt: call.endedAt?.toISOString() ?? null,
    createdAt: call.createdAt.toISOString(),
    // Include the caller as a virtual participant so the callee's
    // ChatCallDialog creates audio/video elements for the caller.
    // Without this, the callee has no element to play the caller's audio.
    participants: [
      {
        userId: call.callerId,
        name: call.caller.name,
        acceptedAt: call.startedAt?.toISOString() ?? null,
        declinedAt: null,
      },
      ...call.participants
        .filter((p) => p.userId !== call.callerId)
        .map((p) => ({
          userId: p.userId,
          name: p.user.name,
          acceptedAt: p.acceptedAt?.toISOString() ?? null,
          declinedAt: p.declinedAt?.toISOString() ?? null,
        })),
    ],
  };
}

const CALL_INCLUDE = {
  caller: { select: { name: true } },
  participants: { include: { user: { select: { name: true } } } },
} as const;

// =====================================================
// Initiate call
// =====================================================

export async function initiateCall(
  actor: CurrentUser,
  channelId: string,
  type: 'audio' | 'video',
  participantIds: string[]
): Promise<ChatCallDTO> {
  await assertChannelMember(channelId, actor.id);

  if (participantIds.length === 0) {
    throw new ChatCallError('Debes seleccionar al menos un participante');
  }

  // Check for existing active/ringing call in the channel
  const existing = await prisma.internalChatCall.findFirst({
    where: { channelId, status: { in: ['ringing', 'active'] } },
  });
  if (existing) {
    throw new ChatCallError('Ya hay una llamada activa en este canal');
  }

  // Verify all participants are members of the channel
  const channelMembers = await prisma.internalChatMember.findMany({
    where: { channelId, leftAt: null, userId: { in: participantIds } },
    select: { userId: true },
  });
  const validIds = new Set(channelMembers.map((m) => m.userId));
  for (const pid of participantIds) {
    if (!validIds.has(pid)) {
      throw new ChatCallError('Uno o más participantes no son miembros del canal');
    }
  }

  const call = await prisma.internalChatCall.create({
    data: {
      channelId,
      callerId: actor.id,
      type,
      status: 'ringing',
      participants: {
        create: participantIds.map((userId) => ({ userId })),
      },
    },
    include: CALL_INCLUDE,
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'chat.call_initiated',
    targetType: 'chat_call',
    targetId: call.id,
    metadata: { channelId, type, participantCount: participantIds.length },
  });

  return toCallDTO(call);
}

// =====================================================
// Accept call
// =====================================================

export async function acceptCall(actor: CurrentUser, callId: string): Promise<ChatCallDTO> {
  const call = await prisma.internalChatCall.findUnique({
    where: { id: callId },
    include: CALL_INCLUDE,
  });
  if (!call) throw new ChatCallError('Llamada no encontrada');

  const participant = call.participants.find((p) => p.userId === actor.id);
  if (!participant) throw new AuthorizationError('No eres participante de esta llamada');
  if (call.status === 'ended') throw new ChatCallError('La llamada ya terminó');
  if (call.status === 'declined') throw new ChatCallError('La llamada fue rechazada');

  await prisma.internalChatCallParticipant.update({
    where: { callId_userId: { callId, userId: actor.id } },
    data: { acceptedAt: new Date() },
  });

  // If this is the first acceptance, mark call as active
  if (call.status === 'ringing') {
    await prisma.internalChatCall.update({
      where: { id: callId },
      data: { status: 'active', startedAt: new Date() },
    });
  }

  const updated = await prisma.internalChatCall.findUnique({
    where: { id: callId },
    include: CALL_INCLUDE,
  });
  return toCallDTO(updated!);
}

// =====================================================
// Decline call
// =====================================================

export async function declineCall(actor: CurrentUser, callId: string): Promise<ChatCallDTO> {
  const call = await prisma.internalChatCall.findUnique({
    where: { id: callId },
    include: CALL_INCLUDE,
  });
  if (!call) throw new ChatCallError('Llamada no encontrada');

  const participant = call.participants.find((p) => p.userId === actor.id);
  if (!participant) throw new AuthorizationError('No eres participante de esta llamada');

  await prisma.internalChatCallParticipant.update({
    where: { callId_userId: { callId, userId: actor.id } },
    data: { declinedAt: new Date() },
  });

  // If all participants declined, mark call as declined
  const updated = await prisma.internalChatCall.findUnique({
    where: { id: callId },
    include: CALL_INCLUDE,
  });
  if (updated) {
    const allDeclined = updated.participants.every((p) => p.declinedAt);
    if (allDeclined && updated.status === 'ringing') {
      await prisma.internalChatCall.update({
        where: { id: callId },
        data: { status: 'declined', endedAt: new Date() },
      });
    }
  }

  const final = await prisma.internalChatCall.findUnique({
    where: { id: callId },
    include: CALL_INCLUDE,
  });
  return toCallDTO(final!);
}

// =====================================================
// End call
// =====================================================

export async function endCall(actor: CurrentUser, callId: string): Promise<ChatCallDTO> {
  const call = await prisma.internalChatCall.findUnique({
    where: { id: callId },
    include: CALL_INCLUDE,
  });
  if (!call) throw new ChatCallError('Llamada no encontrada');

  // Only caller or participant can end
  const isCaller = call.callerId === actor.id;
  const isParticipant = call.participants.some((p) => p.userId === actor.id);
  if (!isCaller && !isParticipant)
    throw new AuthorizationError('No eres participante de esta llamada');

  await prisma.internalChatCall.update({
    where: { id: callId },
    data: {
      status: call.status === 'ringing' ? 'missed' : 'ended',
      endedAt: new Date(),
    },
  });

  const updated = await prisma.internalChatCall.findUnique({
    where: { id: callId },
    include: CALL_INCLUDE,
  });
  return toCallDTO(updated!);
}

// =====================================================
// Get active call for channel
// =====================================================

export async function getActiveCall(channelId: string): Promise<ChatCallDTO | null> {
  const call = await prisma.internalChatCall.findFirst({
    where: { channelId, status: { in: ['ringing', 'active'] } },
    include: CALL_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  if (!call) return null;
  return toCallDTO(call);
}

// =====================================================
// Get call by id
// =====================================================

export async function getCall(callId: string): Promise<ChatCallDTO | null> {
  const call = await prisma.internalChatCall.findUnique({
    where: { id: callId },
    include: CALL_INCLUDE,
  });
  if (!call) return null;
  return toCallDTO(call);
}

// =====================================================
// WebRTC signaling
// =====================================================

export async function saveSignal(
  callId: string,
  fromUserId: string,
  toUserId: string,
  signalType: 'offer' | 'answer' | 'ice',
  signal: string
): Promise<void> {
  // Verify the call exists and both sender and recipient are participants
  const call = await prisma.internalChatCall.findUnique({
    where: { id: callId },
    include: CALL_INCLUDE,
  });
  if (!call) throw new ChatCallError('Llamada no encontrada');

  const isCaller = call.callerId === fromUserId;
  const isFromParticipant = call.participants.some((p) => p.userId === fromUserId);
  if (!isCaller && !isFromParticipant) {
    throw new AuthorizationError('No eres participante de esta llamada');
  }

  const isToCaller = call.callerId === toUserId;
  const isToParticipant = call.participants.some((p) => p.userId === toUserId);
  if (!isToCaller && !isToParticipant) {
    throw new AuthorizationError('El destinatario no es participante de esta llamada');
  }

  await prisma.internalChatCallSignal.create({
    data: { callId, fromUserId, toUserId, signalType, signal },
  });
}

export async function getPendingSignals(
  userId: string,
  callId?: string
): Promise<
  {
    id: string;
    callId: string;
    fromUserId: string;
    signalType: string;
    signal: string;
    createdAt: string;
  }[]
> {
  const where: { toUserId: string; deliveredAt: null; callId?: string } = {
    toUserId: userId,
    deliveredAt: null,
  };
  if (callId) where.callId = callId;

  const signals = await prisma.internalChatCallSignal.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  // Mark as delivered
  if (signals.length > 0) {
    await prisma.internalChatCallSignal.updateMany({
      where: { id: { in: signals.map((s) => s.id) } },
      data: { deliveredAt: new Date() },
    });
  }

  return signals.map((s) => ({
    id: s.id,
    callId: s.callId,
    fromUserId: s.fromUserId,
    signalType: s.signalType,
    signal: s.signal,
    createdAt: s.createdAt.toISOString(),
  }));
}

// =====================================================
// Get incoming calls for a user (ringing calls where user is a participant)
// =====================================================

export async function getIncomingCalls(userId: string): Promise<ChatCallDTO[]> {
  const calls = await prisma.internalChatCall.findMany({
    where: {
      status: 'ringing',
      participants: {
        some: {
          userId,
          acceptedAt: null,
          declinedAt: null,
        },
      },
      callerId: { not: userId },
    },
    include: CALL_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(calls.map(toCallDTO));
}

// =====================================================
// Cleanup old signals (housekeeping)
// =====================================================

export async function cleanupOldSignals(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
  await prisma.internalChatCallSignal.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
}
