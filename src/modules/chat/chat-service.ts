import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { CurrentUser, AuthorizationError } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import type {
  ChatMessageDTO,
  ChatChannelDTO,
  ChatChannelMemberDTO,
  ChatAttachmentDTO,
  ChatReactionDTO,
  ChatInboxItem,
  ChatPollDTO,
  ChatEventDTO,
} from './chat-events';
import { getPresence } from './chat-presence-service';
import { detectChatAlerts } from './chat-admin-service';

class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

// =====================================================
// DTO mappers
// =====================================================

function toAttachmentDTO(a: {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbnailPath: string | null;
}): ChatAttachmentDTO {
  return {
    id: a.id,
    fileName: a.fileName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    hasThumbnail: !!a.thumbnailPath,
  };
}

function toReactionDTO(
  reactions: { emoji: string; userId: string; user: { name: string } }[]
): ChatReactionDTO[] {
  const grouped = new Map<string, ChatReactionDTO>();
  for (const r of reactions) {
    grouped.set(r.userId + r.emoji, { emoji: r.emoji, userId: r.userId, userName: r.user.name });
  }
  return Array.from(grouped.values());
}

async function toMessageDTO(
  msg: {
    id: string;
    channelId: string;
    senderId: string;
    content: string | null;
    replyToId: string | null;
    forwardedFromId: string | null;
    forwardedBy: string | null;
    editedAt: Date | null;
    deletedAt: Date | null;
    priority: string;
    threadId: string | null;
    createdAt: Date;
    sender: { name: string };
    replyTo: { content: string | null; sender: { name: string } } | null;
    attachments: {
      id: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      width: number | null;
      height: number | null;
      durationMs: number | null;
      thumbnailPath: string | null;
    }[];
    reactions: { emoji: string; userId: string; user: { name: string } }[];
    readReceipts: { userId: string }[];
    mentions?: { userId: string }[];
    location?: { latitude: number; longitude: number; label: string | null } | null;
    poll?: {
      id: string;
      question: string;
      isMulti: boolean;
      isAnonymous: boolean;
      closesAt: Date | null;
      options: {
        id: string;
        text: string;
        votes: { userId: string }[];
      }[];
    } | null;
    event?: {
      id: string;
      title: string;
      description: string | null;
      startsAt: Date;
      endsAt: Date | null;
      location: string | null;
      createdBy: string;
      rsvps: { userId: string; status: string }[];
    } | null;
    pins?: { id: string }[];
    bookmarks?: { id: string; userId: string }[];
    thread?: { id: string; rootMessageId: string } | null;
  },
  currentUserId: string
): Promise<ChatMessageDTO> {
  let pollDto: ChatPollDTO | null = null;
  if (msg.poll) {
    const totalVotes = msg.poll.options.reduce((sum, o) => sum + o.votes.length, 0);
    const userVotedOptionIds: string[] = [];
    for (const opt of msg.poll.options) {
      if (opt.votes.some((v) => v.userId === currentUserId)) {
        userVotedOptionIds.push(opt.id);
      }
    }
    pollDto = {
      id: msg.poll.id,
      question: msg.poll.question,
      isMulti: msg.poll.isMulti,
      isAnonymous: msg.poll.isAnonymous,
      closesAt: msg.poll.closesAt?.toISOString() ?? null,
      totalVotes,
      options: msg.poll.options.map((o) => ({
        id: o.id,
        text: o.text,
        voteCount: o.votes.length,
        hasVoted: o.votes.some((v) => v.userId === currentUserId),
      })),
      userVotedOptionIds,
    };
  }

  let eventDto: ChatEventDTO | null = null;
  if (msg.event) {
    const rsvpCounts = { yes: 0, no: 0, maybe: 0 };
    let userRsvp: string | null = null;
    for (const r of msg.event.rsvps) {
      if (r.status === 'yes') rsvpCounts.yes++;
      else if (r.status === 'no') rsvpCounts.no++;
      else if (r.status === 'maybe') rsvpCounts.maybe++;
      if (r.userId === currentUserId) userRsvp = r.status;
    }
    eventDto = {
      id: msg.event.id,
      title: msg.event.title,
      description: msg.event.description,
      startsAt: msg.event.startsAt.toISOString(),
      endsAt: msg.event.endsAt?.toISOString() ?? null,
      location: msg.event.location,
      createdBy: msg.event.createdBy,
      rsvpCounts,
      userRsvp,
    };
  }

  return {
    id: msg.id,
    channelId: msg.channelId,
    senderId: msg.senderId,
    senderName: msg.sender.name,
    content: msg.content,
    replyToId: msg.replyToId,
    replyToPreview: msg.replyTo?.content ?? null,
    replyToSenderName: msg.replyTo?.sender.name ?? null,
    forwardedFromId: msg.forwardedFromId,
    forwardedBy: msg.forwardedBy,
    editedAt: msg.editedAt?.toISOString() ?? null,
    deletedAt: msg.deletedAt?.toISOString() ?? null,
    priority: (msg.priority as 'normal' | 'urgent') ?? 'normal',
    threadId: msg.threadId ?? null,
    threadRootMessageId: msg.thread?.rootMessageId ?? null,
    createdAt: msg.createdAt.toISOString(),
    attachments: msg.attachments.map(toAttachmentDTO),
    reactions: toReactionDTO(msg.reactions),
    readBy: msg.readReceipts.filter((r) => r.userId !== currentUserId).map((r) => r.userId),
    mentions: (msg.mentions ?? []).map((m) => m.userId),
    location: msg.location
      ? {
          latitude: msg.location.latitude,
          longitude: msg.location.longitude,
          label: msg.location.label,
        }
      : null,
    poll: pollDto,
    event: eventDto,
    isPinned: (msg.pins ?? []).length > 0,
    isBookmarked: (msg.bookmarks ?? []).some((b) => b.userId === currentUserId) || false,
  };
}

// =====================================================
// Channel operations
// =====================================================

export async function createDmChannel(
  actor: CurrentUser,
  otherUserId: string
): Promise<{ id: string; isNew: boolean }> {
  if (actor.id === otherUserId) {
    throw new ChatError('No puedes crear un chat contigo mismo');
  }

  const otherUser = await prisma.user.findUnique({
    where: { id: otherUserId, isActive: true },
  });
  if (!otherUser) {
    throw new ChatError('Usuario no encontrado o inactivo');
  }

  // Try to find an existing DM with both users
  const existing = await prisma.internalChatChannel.findFirst({
    where: {
      type: 'dm',
      members: {
        every: { userId: { in: [actor.id, otherUserId] } },
      },
      AND: [
        { members: { some: { userId: actor.id, leftAt: null } } },
        { members: { some: { userId: otherUserId, leftAt: null } } },
      ],
    },
    include: { _count: { select: { members: true } } },
  });

  // Verify it's exactly a 2-person DM
  if (existing && existing._count.members === 2) {
    return { id: existing.id, isNew: false };
  }

  const channel = await prisma.internalChatChannel.create({
    data: {
      type: 'dm',
      createdBy: actor.id,
      members: {
        create: [
          { userId: actor.id, role: 'member' },
          { userId: otherUserId, role: 'member' },
        ],
      },
    },
  });

  return { id: channel.id, isNew: true };
}

export async function createGroupChannel(
  actor: CurrentUser,
  name: string,
  memberIds: string[]
): Promise<{ id: string }> {
  const trimmedName = name.trim();
  if (trimmedName.length < 1 || trimmedName.length > 100) {
    throw new ChatError('El nombre del grupo debe tener entre 1 y 100 caracteres');
  }
  if (memberIds.length < 1) {
    throw new ChatError('Debes agregar al menos un miembro al grupo');
  }

  // Verify all members exist and are active
  const users = await prisma.user.findMany({
    where: { id: { in: memberIds }, isActive: true },
    select: { id: true },
  });
  if (users.length !== memberIds.length) {
    throw new ChatError('Alguno de los usuarios seleccionados no existe o está inactivo');
  }

  const allMemberIds = Array.from(new Set([actor.id, ...memberIds]));

  const channel = await prisma.internalChatChannel.create({
    data: {
      type: 'group',
      name: trimmedName,
      createdBy: actor.id,
      members: {
        create: allMemberIds.map((userId) => ({
          userId,
          role: userId === actor.id ? 'owner' : 'member',
        })),
      },
    },
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'chat.group_created',
    targetType: 'chat_channel',
    targetId: channel.id,
    metadata: { name: trimmedName, memberCount: allMemberIds.length },
  });

  return { id: channel.id };
}

export async function listUserChannels(userId: string): Promise<ChatChannelDTO[]> {
  const memberships = await prisma.internalChatMember.findMany({
    where: { userId, leftAt: null },
    include: {
      channel: {
        include: {
          members: {
            where: { leftAt: null },
            include: { user: true },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { sender: true },
          },
        },
      },
    },
    orderBy: { channel: { lastMessageAt: 'desc' } },
  });

  const userIds = new Set<string>();
  for (const m of memberships) {
    for (const mem of m.channel.members) {
      userIds.add(mem.userId);
    }
  }
  const presenceMap = await getPresence(Array.from(userIds));

  const result: ChatChannelDTO[] = [];
  for (const m of memberships) {
    const channel = m.channel;
    const lastMsg = channel.messages[0];
    const unreadCount = await prisma.internalChatMessage.count({
      where: {
        channelId: channel.id,
        createdAt: { gt: m.lastReadAt },
        senderId: { not: userId },
        deletedAt: null,
      },
    });

    const members: ChatChannelMemberDTO[] = channel.members.map((mem) => ({
      userId: mem.userId,
      name: mem.user.name,
      username: mem.user.username,
      role: mem.role,
      status: presenceMap.get(mem.userId) ?? 'offline',
      lastSeenAt: mem.joinedAt.toISOString(),
    }));

    result.push({
      id: channel.id,
      type: channel.type,
      name: channel.name,
      avatarPath: channel.avatarPath,
      createdBy: channel.createdBy,
      lastMessageAt: channel.lastMessageAt.toISOString(),
      createdAt: channel.createdAt.toISOString(),
      unreadCount,
      lastMessagePreview: lastMsg?.content ?? (lastMsg ? '[Archivo]' : null),
      lastMessageSenderName: lastMsg?.sender.name ?? null,
      members,
    });
  }

  return result;
}

export async function getChannel(
  channelId: string,
  userId: string
): Promise<ChatChannelDTO | null> {
  const membership = await prisma.internalChatMember.findFirst({
    where: { channelId, userId, leftAt: null },
    include: {
      channel: {
        include: {
          members: {
            where: { leftAt: null },
            include: { user: true },
          },
        },
      },
    },
  });

  if (!membership) return null;

  const channel = membership.channel;
  const userIds = channel.members.map((m) => m.userId);
  const presenceMap = await getPresence(userIds);

  const members: ChatChannelMemberDTO[] = channel.members.map((mem) => ({
    userId: mem.userId,
    name: mem.user.name,
    username: mem.user.username,
    role: mem.role,
    status: presenceMap.get(mem.userId) ?? 'offline',
    lastSeenAt: mem.joinedAt.toISOString(),
  }));

  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    avatarPath: channel.avatarPath,
    createdBy: channel.createdBy,
    lastMessageAt: channel.lastMessageAt.toISOString(),
    createdAt: channel.createdAt.toISOString(),
    unreadCount: 0,
    lastMessagePreview: null,
    lastMessageSenderName: null,
    members,
  };
}

export async function assertChannelMember(channelId: string, userId: string): Promise<void> {
  const membership = await prisma.internalChatMember.findFirst({
    where: { channelId, userId, leftAt: null },
  });
  if (!membership) {
    throw new AuthorizationError('No eres miembro de este canal');
  }
}

export async function assertChannelAdmin(channelId: string, userId: string): Promise<void> {
  const membership = await prisma.internalChatMember.findFirst({
    where: { channelId, userId, leftAt: null },
  });
  if (!membership) {
    throw new AuthorizationError('No eres miembro de este canal');
  }
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new AuthorizationError('No tienes permisos de administrador en este canal');
  }
}

// =====================================================
// Message operations
// =====================================================

interface SendMessageInput {
  channelId: string;
  content?: string | null;
  replyToId?: string | null;
  forwardedFromId?: string | null;
  attachmentIds?: string[]; // pre-saved attachments to link
  location?: { latitude: number; longitude: number; label?: string } | null;
  poll?: {
    question: string;
    options: string[];
    isMulti?: boolean;
    isAnonymous?: boolean;
    closesAt?: string | null;
  } | null;
  event?: {
    title: string;
    description?: string;
    startsAt: string;
    endsAt?: string | null;
    location?: string | null;
  } | null;
  priority?: 'normal' | 'urgent';
  threadId?: string | null;
}

const MESSAGE_INCLUDE = {
  sender: true,
  replyTo: { include: { sender: true } },
  attachments: true,
  reactions: { include: { user: true } },
  readReceipts: true,
  mentions: { select: { userId: true } },
  location: true,
  poll: {
    include: {
      options: { include: { votes: { select: { userId: true } } } },
    },
  },
  event: {
    include: {
      rsvps: { select: { userId: true, status: true } },
    },
  },
  pins: { select: { id: true } },
  bookmarks: { select: { id: true, userId: true } },
  thread: { select: { id: true, rootMessageId: true } },
} as const;

export async function sendMessage(
  actor: CurrentUser,
  input: SendMessageInput
): Promise<ChatMessageDTO> {
  await assertChannelMember(input.channelId, actor.id);

  if (
    !input.content &&
    (!input.attachmentIds || input.attachmentIds.length === 0) &&
    !input.location &&
    !input.poll &&
    !input.event
  ) {
    throw new ChatError('El mensaje debe tener contenido o adjuntos');
  }

  const content = input.content?.trim() || null;
  if (content && content.length > 10_000) {
    throw new ChatError('El mensaje es demasiado largo (máx 10,000 caracteres)');
  }

  // Validate poll
  if (input.poll) {
    if (input.poll.question.trim().length < 1 || input.poll.question.length > 200) {
      throw new ChatError('La pregunta de la encuesta debe tener entre 1 y 200 caracteres');
    }
    if (input.poll.options.length < 2 || input.poll.options.length > 10) {
      throw new ChatError('La encuesta debe tener entre 2 y 10 opciones');
    }
    for (const opt of input.poll.options) {
      if (opt.trim().length < 1 || opt.length > 100) {
        throw new ChatError('Cada opción debe tener entre 1 y 100 caracteres');
      }
    }
  }

  // Validate event
  if (input.event) {
    if (input.event.title.trim().length < 1 || input.event.title.length > 200) {
      throw new ChatError('El título del evento debe tener entre 1 y 200 caracteres');
    }
    const startsAt = new Date(input.event.startsAt);
    if (isNaN(startsAt.getTime())) {
      throw new ChatError('Fecha de inicio inválida');
    }
  }

  // Validate thread if provided
  let threadId = input.threadId ?? null;
  if (threadId) {
    const thread = await prisma.internalChatThread.findUnique({
      where: { id: threadId },
    });
    if (!thread || thread.channelId !== input.channelId) {
      throw new ChatError('Hilo no válido para este canal');
    }
  } else if (input.replyToId) {
    // Auto-create thread if replying and no thread exists yet for this root
    const existingThread = await prisma.internalChatThread.findUnique({
      where: { rootMessageId: input.replyToId },
    });
    if (existingThread) {
      threadId = existingThread.id;
    }
  }

  const message = await prisma.internalChatMessage.create({
    data: {
      channelId: input.channelId,
      senderId: actor.id,
      content,
      replyToId: input.replyToId ?? null,
      forwardedFromId: input.forwardedFromId ?? null,
      forwardedBy: input.forwardedFromId ? actor.id : null,
      priority: input.priority ?? 'normal',
      threadId,
    },
  });

  // Create thread if replying and no thread exists yet
  if (input.replyToId && !threadId) {
    const newThread = await prisma.internalChatThread.create({
      data: {
        channelId: input.channelId,
        rootMessageId: input.replyToId,
      },
    });
    await prisma.internalChatMessage.update({
      where: { id: message.id },
      data: { threadId: newThread.id },
    });
  }

  // Link pre-saved attachments if any
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    await prisma.internalChatAttachment.updateMany({
      where: { id: { in: input.attachmentIds } },
      data: { messageId: message.id },
    });
  }

  // Create location
  if (input.location) {
    await prisma.internalChatLocation.create({
      data: {
        messageId: message.id,
        latitude: input.location.latitude,
        longitude: input.location.longitude,
        label: input.location.label ?? null,
      },
    });
  }

  // Create poll
  if (input.poll) {
    const poll = await prisma.internalChatPoll.create({
      data: {
        messageId: message.id,
        question: input.poll.question.trim(),
        isMulti: input.poll.isMulti ?? false,
        isAnonymous: input.poll.isAnonymous ?? true,
        closesAt: input.poll.closesAt ? new Date(input.poll.closesAt) : null,
      },
    });
    await prisma.internalChatPollOption.createMany({
      data: input.poll.options.map((opt) => ({
        pollId: poll.id,
        text: opt.trim(),
      })),
    });
  }

  // Create event
  if (input.event) {
    await prisma.internalChatEvent.create({
      data: {
        messageId: message.id,
        channelId: input.channelId,
        title: input.event.title.trim(),
        description: input.event.description ?? null,
        startsAt: new Date(input.event.startsAt),
        endsAt: input.event.endsAt ? new Date(input.event.endsAt) : null,
        location: input.event.location ?? null,
        createdBy: actor.id,
      },
    });
  }

  // Parse mentions from content
  const mentionedUsernames: string[] = [];
  if (content) {
    const matches = content.match(/@(\w+)/g);
    if (matches) {
      for (const m of matches) {
        mentionedUsernames.push(m.slice(1));
      }
    }
  }

  if (mentionedUsernames.length > 0) {
    const channelMembers = await prisma.internalChatMember.findMany({
      where: { channelId: input.channelId, leftAt: null },
      include: { user: { select: { username: true } } },
    });
    const memberUsernames = new Map(channelMembers.map((m) => [m.user.username, m.userId]));
    const mentionUserIds = new Set<string>();
    for (const username of mentionedUsernames) {
      const userId = memberUsernames.get(username);
      if (userId) mentionUserIds.add(userId);
    }
    if (mentionUserIds.size > 0) {
      await prisma.internalChatMention.createMany({
        data: Array.from(mentionUserIds).map((userId) => ({
          messageId: message.id,
          userId,
        })),
        skipDuplicates: true,
      });
    }
  }

  // Update channel's lastMessageAt
  await prisma.internalChatChannel.update({
    where: { id: input.channelId },
    data: { lastMessageAt: message.createdAt },
  });

  // Re-fetch with all relations
  const fullMessage = await prisma.internalChatMessage.findUnique({
    where: { id: message.id },
    include: MESSAGE_INCLUDE,
  });

  if (!fullMessage) throw new ChatError('Error al crear el mensaje');

  // Run anti-fraud alert detection (async, non-blocking)
  detectChatAlerts({
    id: message.id,
    channelId: input.channelId,
    senderId: actor.id,
    content: content,
    createdAt: message.createdAt,
  }).catch(() => {
    // silent — alert detection failures should not block message sending
  });

  return toMessageDTO(fullMessage, actor.id);
}

export async function listMessages(
  channelId: string,
  userId: string,
  options: { cursor?: string; limit?: number } = {}
): Promise<{ messages: ChatMessageDTO[]; hasMore: boolean }> {
  await assertChannelMember(channelId, userId);
  const limit = Math.min(options.limit ?? 50, 100);

  const messages = await prisma.internalChatMessage.findMany({
    where: {
      channelId,
      ...(options.cursor ? { createdAt: { lt: new Date(options.cursor) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: MESSAGE_INCLUDE,
  });

  const hasMore = messages.length > limit;
  const slice = hasMore ? messages.slice(0, limit) : messages;

  const dtos = await Promise.all(slice.reverse().map((m) => toMessageDTO(m, userId)));
  return { messages: dtos, hasMore };
}

export async function getMessagesSince(
  channelId: string,
  userId: string,
  since: Date
): Promise<ChatMessageDTO[]> {
  await assertChannelMember(channelId, userId);

  const messages = await prisma.internalChatMessage.findMany({
    where: { channelId, createdAt: { gt: since } },
    orderBy: { createdAt: 'asc' },
    include: MESSAGE_INCLUDE,
  });

  return Promise.all(messages.map((m) => toMessageDTO(m, userId)));
}

export async function editMessage(
  actor: CurrentUser,
  messageId: string,
  content: string
): Promise<{ messageId: string; content: string; editedAt: string }> {
  const msg = await prisma.internalChatMessage.findUnique({ where: { id: messageId } });
  if (!msg) throw new ChatError('Mensaje no encontrado');
  if (msg.senderId !== actor.id)
    throw new AuthorizationError('Solo puedes editar tus propios mensajes');
  if (msg.deletedAt) throw new ChatError('No puedes editar un mensaje eliminado');

  // Verify the user is still a member of the channel
  await assertChannelMember(msg.channelId, actor.id);

  const elapsed = Date.now() - msg.createdAt.getTime();
  if (elapsed > 24 * 60 * 60 * 1000) {
    throw new ChatError('No puedes editar mensajes después de 24 horas');
  }

  const trimmed = content.trim();
  if (trimmed.length < 1 || trimmed.length > 10_000) {
    throw new ChatError('Contenido inválido');
  }

  const updated = await prisma.internalChatMessage.update({
    where: { id: messageId },
    data: { content: trimmed, editedAt: new Date() },
  });

  return {
    messageId: updated.id,
    content: updated.content!,
    editedAt: updated.editedAt!.toISOString(),
  };
}

export async function deleteMessage(actor: CurrentUser, messageId: string): Promise<void> {
  const msg = await prisma.internalChatMessage.findUnique({
    where: { id: messageId },
    include: { channel: { include: { members: { where: { userId: actor.id } } } } },
  });

  if (!msg) throw new ChatError('Mensaje no encontrado');
  if (msg.deletedAt) return; // already deleted

  const isSender = msg.senderId === actor.id;
  const membership = msg.channel.members[0];
  const isAdmin = membership && (membership.role === 'owner' || membership.role === 'admin');

  if (!isSender && !isAdmin) {
    throw new AuthorizationError('Solo puedes eliminar tus propios mensajes');
  }

  await prisma.internalChatMessage.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), content: null },
  });
}

export async function forwardMessage(
  actor: CurrentUser,
  messageId: string,
  targetChannelIds: string[]
): Promise<ChatMessageDTO[]> {
  if (targetChannelIds.length === 0) {
    throw new ChatError('Debes seleccionar al menos un canal');
  }

  const original = await prisma.internalChatMessage.findUnique({
    where: { id: messageId },
    include: { attachments: true },
  });

  if (!original) throw new ChatError('Mensaje no encontrado');

  const results: ChatMessageDTO[] = [];
  for (const targetId of targetChannelIds) {
    await assertChannelMember(targetId, actor.id);

    const newMsg = await prisma.internalChatMessage.create({
      data: {
        channelId: targetId,
        senderId: actor.id,
        content: original.content,
        forwardedFromId: original.id,
        forwardedBy: actor.id,
      },
    });

    // Copy attachments
    if (original.attachments.length > 0) {
      await prisma.internalChatAttachment.createMany({
        data: original.attachments.map((a) => ({
          messageId: newMsg.id,
          fileName: a.fileName,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          storagePath: a.storagePath,
          width: a.width,
          height: a.height,
          durationMs: a.durationMs,
          thumbnailPath: a.thumbnailPath,
        })),
      });
    }

    await prisma.internalChatChannel.update({
      where: { id: targetId },
      data: { lastMessageAt: newMsg.createdAt },
    });

    const fullMsg = await prisma.internalChatMessage.findUnique({
      where: { id: newMsg.id },
      include: MESSAGE_INCLUDE,
    });

    if (fullMsg) {
      results.push(await toMessageDTO(fullMsg, actor.id));
    }
  }

  return results;
}

// =====================================================
// Read receipts
// =====================================================

export async function markAsRead(actor: CurrentUser, channelId: string): Promise<string> {
  await assertChannelMember(channelId, actor.id);
  const now = new Date();

  await prisma.internalChatMember.update({
    where: { channelId_userId: { channelId, userId: actor.id } },
    data: { lastReadAt: now },
  });

  return now.toISOString();
}

// =====================================================
// Reactions
// =====================================================

const ALLOWED_EMOJIS = new Set([
  '👍',
  '❤️',
  '😂',
  '😮',
  '😢',
  '🎉',
  '🔥',
  '👏',
  '🙏',
  '💯',
  '✅',
  '❌',
  '👀',
  '💪',
  '🤝',
  '😅',
  '🤔',
  '⭐',
  '❓',
  '❗',
]);

export async function addReaction(
  actor: CurrentUser,
  messageId: string,
  emoji: string
): Promise<{ messageId: string; userId: string; userName: string; emoji: string }> {
  if (!ALLOWED_EMOJIS.has(emoji)) {
    throw new ChatError('Emoji no permitido');
  }

  const msg = await prisma.internalChatMessage.findUnique({
    where: { id: messageId },
    include: { channel: { include: { members: { where: { userId: actor.id, leftAt: null } } } } },
  });

  if (!msg) throw new ChatError('Mensaje no encontrado');
  if (!msg.channel.members.length) throw new AuthorizationError('No eres miembro de este canal');

  try {
    await prisma.internalChatReaction.create({
      data: { messageId, userId: actor.id, emoji },
    });
  } catch (err) {
    // Unique constraint = already exists, that's fine
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code !== 'P2002') throw err;
  }

  return { messageId, userId: actor.id, userName: actor.name, emoji };
}

export async function removeReaction(
  actor: CurrentUser,
  messageId: string,
  emoji: string
): Promise<{ messageId: string; userId: string; emoji: string }> {
  await prisma.internalChatReaction.deleteMany({
    where: { messageId, userId: actor.id, emoji },
  });
  return { messageId, userId: actor.id, emoji };
}

export async function getMessageReactions(messageId: string): Promise<ChatReactionDTO[]> {
  const reactions = await prisma.internalChatReaction.findMany({
    where: { messageId },
    include: { user: true },
  });
  return toReactionDTO(
    reactions.map((r) => ({ emoji: r.emoji, userId: r.userId, user: { name: r.user.name } }))
  );
}

// =====================================================
// Group management
// =====================================================

export async function updateGroup(
  actor: CurrentUser,
  channelId: string,
  data: { name?: string }
): Promise<void> {
  await assertChannelAdmin(channelId, actor.id);
  if (data.name !== undefined) {
    const trimmed = data.name.trim();
    if (trimmed.length < 1 || trimmed.length > 100) {
      throw new ChatError('Nombre inválido');
    }
    await prisma.internalChatChannel.update({ where: { id: channelId }, data: { name: trimmed } });
  }
}

export async function addMembers(
  actor: CurrentUser,
  channelId: string,
  userIds: string[]
): Promise<void> {
  await assertChannelAdmin(channelId, actor.id);
  if (userIds.length === 0) throw new ChatError('No hay usuarios para agregar');

  const channel = await prisma.internalChatChannel.findUnique({ where: { id: channelId } });
  if (!channel || channel.type !== 'group') {
    throw new ChatError('Solo se pueden agregar miembros a grupos');
  }

  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, isActive: true },
    select: { id: true },
  });
  if (users.length !== userIds.length) {
    throw new ChatError('Alguno de los usuarios no existe o está inactivo');
  }

  // Upsert memberships (re-join if previously left)
  for (const userId of userIds) {
    await prisma.internalChatMember.upsert({
      where: { channelId_userId: { channelId, userId } },
      create: { channelId, userId, role: 'member' },
      update: { leftAt: null, role: 'member' },
    });
  }
}

export async function removeMember(
  actor: CurrentUser,
  channelId: string,
  userId: string
): Promise<void> {
  const channel = await prisma.internalChatChannel.findUnique({ where: { id: channelId } });
  if (!channel) throw new ChatError('Canal no encontrado');

  // Self-leave is always allowed
  if (actor.id === userId) {
    await prisma.internalChatMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { leftAt: new Date() },
    });
    return;
  }

  // Removing others requires admin
  await assertChannelAdmin(channelId, actor.id);
  if (channel.type !== 'group') {
    throw new ChatError('Solo se pueden remover miembros de grupos');
  }

  await prisma.internalChatMember.update({
    where: { channelId_userId: { channelId, userId } },
    data: { leftAt: new Date() },
  });
}

export async function deleteGroup(actor: CurrentUser, channelId: string): Promise<void> {
  const channel = await prisma.internalChatChannel.findUnique({ where: { id: channelId } });
  if (!channel) throw new ChatError('Canal no encontrado');
  if (channel.type !== 'group') throw new ChatError('Solo se pueden eliminar grupos');

  const membership = await prisma.internalChatMember.findFirst({
    where: { channelId, userId: actor.id, leftAt: null },
  });
  if (!membership) throw new AuthorizationError('No eres miembro de este canal');
  if (membership.role !== 'owner') {
    throw new AuthorizationError('Solo el creador puede eliminar el grupo');
  }

  await prisma.internalChatChannel.delete({ where: { id: channelId } });

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'chat.group_deleted',
    targetType: 'chat_channel',
    targetId: channelId,
  });
}

// =====================================================
// User search
// =====================================================

export async function searchUsers(
  actor: CurrentUser,
  query: string
): Promise<{ id: string; name: string; username: string; email: string | null; status: string }[]> {
  const q = query.trim();
  if (q.length < 1) return [];

  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      id: { not: actor.id },
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: 20,
    orderBy: { name: 'asc' },
    select: { id: true, name: true, username: true, email: true, chatPresence: true },
  });

  const presenceMap = await getPresence(users.map((u) => u.id));

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    email: u.email,
    status: presenceMap.get(u.id) ?? 'offline',
  }));
}

// =====================================================
// Inbox summary
// =====================================================

export async function getInbox(userId: string): Promise<ChatInboxItem[]> {
  const memberships = await prisma.internalChatMember.findMany({
    where: { userId, leftAt: null },
    include: {
      channel: {
        include: {
          members: {
            where: { leftAt: null, userId: { not: userId } },
            include: { user: true },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { sender: true },
          },
        },
      },
    },
    orderBy: { channel: { lastMessageAt: 'desc' } },
  });

  const otherUserIds = new Set<string>();
  for (const m of memberships) {
    for (const mem of m.channel.members) {
      otherUserIds.add(mem.userId);
    }
  }
  const presenceMap = await getPresence(Array.from(otherUserIds));

  const result: ChatInboxItem[] = [];
  for (const m of memberships) {
    const channel = m.channel;
    const lastMsg = channel.messages[0];
    const unreadCount = await prisma.internalChatMessage.count({
      where: {
        channelId: channel.id,
        createdAt: { gt: m.lastReadAt },
        senderId: { not: userId },
        deletedAt: null,
      },
    });

    const otherMember = channel.members[0];
    result.push({
      channelId: channel.id,
      type: channel.type,
      name: channel.name,
      unreadCount,
      lastMessagePreview: lastMsg?.content ?? (lastMsg ? '[Archivo]' : null),
      lastMessageAt: channel.lastMessageAt.toISOString(),
      lastMessageSenderName: lastMsg?.sender.name ?? null,
      otherUserId: otherMember?.userId ?? null,
      otherUserName: otherMember?.user.name ?? null,
      otherUserStatus: otherMember ? (presenceMap.get(otherMember.userId) ?? 'offline') : null,
    });
  }

  return result;
}

// =====================================================
// Typing indicators (in-memory, ephemeral)
// =====================================================

interface TypingState {
  userId: string;
  channelId: string;
  expiresAt: number;
  preview?: string;
}

const typingUsers = new Map<string, TypingState>(); // key: channelId:userId
const TYPING_TIMEOUT_MS = 5000;

export function setTyping(userId: string, channelId: string, preview?: string): void {
  const trimmedPreview = preview ? preview.slice(0, 20) : undefined;
  typingUsers.set(`${channelId}:${userId}`, {
    userId,
    channelId,
    expiresAt: Date.now() + TYPING_TIMEOUT_MS,
    preview: trimmedPreview,
  });
}

export function clearTyping(userId: string, channelId: string): void {
  typingUsers.delete(`${channelId}:${userId}`);
}

export function getTypingUsers(channelId: string): { userId: string; preview?: string }[] {
  const now = Date.now();
  const result: { userId: string; preview?: string }[] = [];
  for (const [key, state] of typingUsers) {
    if (state.channelId !== channelId) continue;
    if (state.expiresAt < now) {
      typingUsers.delete(key);
      continue;
    }
    result.push({ userId: state.userId, preview: state.preview });
  }
  return result;
}

// =====================================================
// Polls
// =====================================================

export async function votePoll(
  actor: CurrentUser,
  pollId: string,
  optionIds: string[]
): Promise<void> {
  const poll = await prisma.internalChatPoll.findUnique({
    where: { id: pollId },
    include: {
      message: { select: { channelId: true } },
      options: true,
    },
  });
  if (!poll) throw new ChatError('Encuesta no encontrada');

  await assertChannelMember(poll.message.channelId, actor.id);

  if (poll.closesAt && poll.closesAt < new Date()) {
    throw new ChatError('La encuesta ya está cerrada');
  }

  if (!poll.isMulti && optionIds.length > 1) {
    throw new ChatError('Esta encuesta solo permite una opción');
  }

  // Validate optionIds belong to this poll
  const validOptionIds = new Set(poll.options.map((o) => o.id));
  for (const optId of optionIds) {
    if (!validOptionIds.has(optId)) {
      throw new ChatError('Opción inválida');
    }
  }

  // Remove existing votes by this user (for single-vote polls)
  if (!poll.isMulti) {
    await prisma.internalChatPollVote.deleteMany({
      where: {
        userId: actor.id,
        option: { pollId },
      },
    });
  }

  // Add new votes
  for (const optionId of optionIds) {
    try {
      await prisma.internalChatPollVote.create({
        data: { optionId, userId: actor.id },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code !== 'P2002') throw err;
    }
  }
}

// =====================================================
// Events
// =====================================================

export async function rsvpEvent(
  actor: CurrentUser,
  eventId: string,
  status: 'yes' | 'no' | 'maybe'
): Promise<void> {
  const event = await prisma.internalChatEvent.findUnique({
    where: { id: eventId },
    include: { message: { select: { channelId: true } } },
  });
  if (!event) throw new ChatError('Evento no encontrado');

  await assertChannelMember(event.message.channelId, actor.id);

  await prisma.internalChatEventRsvp.upsert({
    where: { eventId_userId: { eventId, userId: actor.id } },
    create: { eventId, userId: actor.id, status },
    update: { status },
  });
}

export async function listUpcomingEvents(userId: string, days = 30): Promise<ChatEventDTO[]> {
  const memberships = await prisma.internalChatMember.findMany({
    where: { userId, leftAt: null },
    select: { channelId: true },
  });
  const channelIds = memberships.map((m) => m.channelId);
  if (channelIds.length === 0) return [];

  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const events = await prisma.internalChatEvent.findMany({
    where: {
      channelId: { in: channelIds },
      startsAt: { gte: now, lte: until },
    },
    orderBy: { startsAt: 'asc' },
    take: 50,
    include: {
      rsvps: { select: { userId: true, status: true } },
    },
  });

  return events.map((e) => {
    const rsvpCounts = { yes: 0, no: 0, maybe: 0 };
    let userRsvp: string | null = null;
    for (const r of e.rsvps) {
      if (r.status === 'yes') rsvpCounts.yes++;
      else if (r.status === 'no') rsvpCounts.no++;
      else if (r.status === 'maybe') rsvpCounts.maybe++;
      if (r.userId === userId) userRsvp = r.status;
    }
    return {
      id: e.id,
      title: e.title,
      description: e.description,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt?.toISOString() ?? null,
      location: e.location,
      createdBy: e.createdBy,
      rsvpCounts,
      userRsvp,
    };
  });
}

// =====================================================
// Mentions
// =====================================================

export async function getUnreadMentions(userId: string): Promise<
  {
    id: string;
    messageId: string;
    channelId: string;
    senderName: string;
    content: string | null;
    createdAt: string;
  }[]
> {
  const mentions = await prisma.internalChatMention.findMany({
    where: { userId, readAt: null },
    include: {
      message: {
        select: {
          id: true,
          channelId: true,
          content: true,
          createdAt: true,
          sender: { select: { name: true } },
        },
      },
    },
    orderBy: { message: { createdAt: 'desc' } },
    take: 50,
  });

  return mentions.map((m) => ({
    id: m.id,
    messageId: m.message.id,
    channelId: m.message.channelId,
    senderName: m.message.sender.name,
    content: m.message.content,
    createdAt: m.message.createdAt.toISOString(),
  }));
}

export async function markMentionsAsRead(userId: string, mentionIds?: string[]): Promise<void> {
  await prisma.internalChatMention.updateMany({
    where: {
      userId,
      readAt: null,
      ...(mentionIds && mentionIds.length > 0 ? { id: { in: mentionIds } } : {}),
    },
    data: { readAt: new Date() },
  });
}

// =====================================================
// Pinned messages
// =====================================================

export async function pinMessage(
  actor: CurrentUser,
  channelId: string,
  messageId: string
): Promise<void> {
  await assertChannelMember(channelId, actor.id);
  const msg = await prisma.internalChatMessage.findUnique({ where: { id: messageId } });
  if (!msg || msg.channelId !== channelId) {
    throw new ChatError('Mensaje no encontrado en este canal');
  }
  try {
    await prisma.internalChatPinnedMessage.create({
      data: { channelId, messageId, pinnedBy: actor.id },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code !== 'P2002') throw err;
  }
}

export async function unpinMessage(
  actor: CurrentUser,
  channelId: string,
  messageId: string
): Promise<void> {
  await assertChannelMember(channelId, actor.id);
  await prisma.internalChatPinnedMessage.deleteMany({
    where: { channelId, messageId },
  });
}

export async function listPinnedMessages(
  channelId: string,
  userId: string
): Promise<ChatMessageDTO[]> {
  await assertChannelMember(channelId, userId);
  const pins = await prisma.internalChatPinnedMessage.findMany({
    where: { channelId },
    orderBy: { pinnedAt: 'desc' },
    include: { message: { include: MESSAGE_INCLUDE } },
  });
  return Promise.all(pins.map((p) => toMessageDTO(p.message, userId)));
}

// =====================================================
// Bookmarks
// =====================================================

export async function bookmarkMessage(actor: CurrentUser, messageId: string): Promise<void> {
  const msg = await prisma.internalChatMessage.findUnique({ where: { id: messageId } });
  if (!msg) throw new ChatError('Mensaje no encontrado');
  await assertChannelMember(msg.channelId, actor.id);
  try {
    await prisma.internalChatBookmark.create({
      data: { userId: actor.id, messageId },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code !== 'P2002') throw err;
  }
}

export async function unbookmarkMessage(actor: CurrentUser, messageId: string): Promise<void> {
  await prisma.internalChatBookmark.deleteMany({
    where: { userId: actor.id, messageId },
  });
}

export async function listBookmarks(userId: string): Promise<ChatMessageDTO[]> {
  const bookmarks = await prisma.internalChatBookmark.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { message: { include: MESSAGE_INCLUDE } },
  });
  const result: ChatMessageDTO[] = [];
  for (const b of bookmarks) {
    // Verify user still has access to the channel
    const membership = await prisma.internalChatMember.findFirst({
      where: { channelId: b.message.channelId, userId, leftAt: null },
    });
    if (membership) {
      result.push(await toMessageDTO(b.message, userId));
    }
  }
  return result;
}

// =====================================================
// Snippets
// =====================================================

export async function listSnippets(
  userId: string
): Promise<{ id: string; title: string; content: string; createdAt: string }[]> {
  const snippets = await prisma.internalChatSnippet.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return snippets.map((s) => ({
    id: s.id,
    title: s.title,
    content: s.content,
    createdAt: s.createdAt.toISOString(),
  }));
}

export async function createSnippet(
  actor: CurrentUser,
  title: string,
  content: string
): Promise<{ id: string }> {
  if (title.trim().length < 1 || title.length > 100) {
    throw new ChatError('El título debe tener entre 1 y 100 caracteres');
  }
  if (content.trim().length < 1 || content.length > 5000) {
    throw new ChatError('El contenido debe tener entre 1 y 5000 caracteres');
  }
  const snippet = await prisma.internalChatSnippet.create({
    data: { userId: actor.id, title: title.trim(), content: content.trim() },
  });
  return { id: snippet.id };
}

export async function deleteSnippet(actor: CurrentUser, snippetId: string): Promise<void> {
  const snippet = await prisma.internalChatSnippet.findUnique({ where: { id: snippetId } });
  if (!snippet) throw new ChatError('Snippet no encontrado');
  if (snippet.userId !== actor.id)
    throw new AuthorizationError('No puedes eliminar snippets de otros');
  await prisma.internalChatSnippet.delete({ where: { id: snippetId } });
}

// =====================================================
// Tags
// =====================================================

export async function listTags(): Promise<{ id: string; name: string; color: string }[]> {
  const tags = await prisma.internalChatTag.findMany({
    orderBy: { name: 'asc' },
  });
  return tags.map((t) => ({ id: t.id, name: t.name, color: t.color }));
}

export async function createTag(
  actor: CurrentUser,
  name: string,
  color?: string
): Promise<{ id: string }> {
  if (name.trim().length < 1 || name.length > 50) {
    throw new ChatError('El nombre del tag debe tener entre 1 y 50 caracteres');
  }
  try {
    const tag = await prisma.internalChatTag.create({
      data: { name: name.trim(), color: color ?? '#6b7280' },
    });
    return { id: tag.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ChatError('Ya existe un tag con ese nombre');
    }
    throw err;
  }
}

export async function tagChannel(
  actor: CurrentUser,
  channelId: string,
  tagId: string
): Promise<void> {
  await assertChannelMember(channelId, actor.id);
  try {
    await prisma.internalChatChannelTag.create({
      data: { channelId, tagId },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code !== 'P2002') throw err;
  }
}

export async function untagChannel(
  actor: CurrentUser,
  channelId: string,
  tagId: string
): Promise<void> {
  await assertChannelMember(channelId, actor.id);
  await prisma.internalChatChannelTag.deleteMany({
    where: { channelId, tagId },
  });
}

// =====================================================
// Mute
// =====================================================

export async function muteChannel(
  actor: CurrentUser,
  channelId: string,
  durationMs: number | null
): Promise<void> {
  await assertChannelMember(channelId, actor.id);
  const mutedUntil = durationMs === null ? null : new Date(Date.now() + durationMs);
  await prisma.internalChatMember.update({
    where: { channelId_userId: { channelId, userId: actor.id } },
    data: { mutedUntil },
  });
}

export async function unmuteChannel(actor: CurrentUser, channelId: string): Promise<void> {
  await assertChannelMember(channelId, actor.id);
  await prisma.internalChatMember.update({
    where: { channelId_userId: { channelId, userId: actor.id } },
    data: { mutedUntil: null },
  });
}

// =====================================================
// Notification preferences
// =====================================================

export async function getNotificationPreference(
  userId: string,
  channelId: string
): Promise<string> {
  const pref = await prisma.internalChatNotificationPreference.findUnique({
    where: { userId_channelId: { userId, channelId } },
  });
  return pref?.level ?? 'all';
}

export async function setNotificationPreference(
  actor: CurrentUser,
  channelId: string,
  level: 'all' | 'mentions' | 'none'
): Promise<void> {
  await assertChannelMember(channelId, actor.id);
  await prisma.internalChatNotificationPreference.upsert({
    where: { userId_channelId: { userId: actor.id, channelId } },
    create: { userId: actor.id, channelId, level },
    update: { level },
  });
}

// =====================================================
// Scheduled messages
// =====================================================

export async function scheduleMessage(
  actor: CurrentUser,
  channelId: string,
  content: string,
  sendAt: Date
): Promise<{ id: string }> {
  await assertChannelMember(channelId, actor.id);
  if (content.trim().length < 1) {
    throw new ChatError('El mensaje no puede estar vacío');
  }
  if (sendAt <= new Date()) {
    throw new ChatError('La fecha de envío debe ser en el futuro');
  }
  const scheduled = await prisma.internalChatScheduledMessage.create({
    data: {
      channelId,
      senderId: actor.id,
      content: content.trim(),
      sendAt,
    },
  });
  return { id: scheduled.id };
}

export async function listScheduledMessages(userId: string): Promise<
  {
    id: string;
    channelId: string;
    content: string | null;
    sendAt: string;
    sentAt: string | null;
  }[]
> {
  const scheduled = await prisma.internalChatScheduledMessage.findMany({
    where: { senderId: userId, sentAt: null },
    orderBy: { sendAt: 'asc' },
  });
  return scheduled.map((s) => ({
    id: s.id,
    channelId: s.channelId,
    content: s.content,
    sendAt: s.sendAt.toISOString(),
    sentAt: s.sentAt?.toISOString() ?? null,
  }));
}

export async function cancelScheduledMessage(actor: CurrentUser, id: string): Promise<void> {
  const scheduled = await prisma.internalChatScheduledMessage.findUnique({ where: { id } });
  if (!scheduled) throw new ChatError('Mensaje programado no encontrado');
  if (scheduled.senderId !== actor.id)
    throw new AuthorizationError('No puedes cancelar mensajes de otros');
  if (scheduled.sentAt) throw new ChatError('El mensaje ya fue enviado');
  await prisma.internalChatScheduledMessage.delete({ where: { id } });
}

// =====================================================
// Search
// =====================================================

export async function searchMessages(
  userId: string,
  query: string,
  options: { channelId?: string; limit?: number } = {}
): Promise<ChatMessageDTO[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const memberships = await prisma.internalChatMember.findMany({
    where: { userId, leftAt: null },
    select: { channelId: true },
  });
  const channelIds = memberships.map((m) => m.channelId);
  if (channelIds.length === 0) return [];

  const limit = Math.min(options.limit ?? 30, 50);
  const messages = await prisma.internalChatMessage.findMany({
    where: {
      channelId: options.channelId ? options.channelId : { in: channelIds },
      content: { contains: q, mode: 'insensitive' },
      deletedAt: null,
      ...(options.channelId ? {} : { channelId: { in: channelIds } }),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: MESSAGE_INCLUDE,
  });

  return Promise.all(messages.map((m) => toMessageDTO(m, userId)));
}

// =====================================================
// Export channel
// =====================================================

export async function exportChannel(
  channelId: string,
  userId: string
): Promise<{ messages: ChatMessageDTO[]; channelName: string | null }> {
  await assertChannelMember(channelId, userId);
  const channel = await prisma.internalChatChannel.findUnique({ where: { id: channelId } });
  const messages = await prisma.internalChatMessage.findMany({
    where: { channelId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 1000,
    include: MESSAGE_INCLUDE,
  });
  return {
    channelName: channel?.name ?? null,
    messages: await Promise.all(messages.map((m) => toMessageDTO(m, userId))),
  };
}

// =====================================================
// Broadcast to multiple channels
// =====================================================

const MAX_BROADCAST_CHANNELS = 5;

export async function broadcastMessage(
  actor: CurrentUser,
  input: {
    channelIds: string[];
    content: string;
    attachmentIds?: string[];
    priority?: 'normal' | 'urgent';
  }
): Promise<ChatMessageDTO[]> {
  if (input.channelIds.length === 0) {
    throw new ChatError('Debes seleccionar al menos un canal');
  }
  if (input.channelIds.length > MAX_BROADCAST_CHANNELS) {
    throw new ChatError(`Máximo ${MAX_BROADCAST_CHANNELS} canales por difusión`);
  }

  const trimmed = input.content.trim();
  if (trimmed.length < 1 || trimmed.length > 10_000) {
    throw new ChatError('Contenido inválido');
  }

  // Verify membership in all channels
  for (const channelId of input.channelIds) {
    await assertChannelMember(channelId, actor.id);
  }

  const results: ChatMessageDTO[] = [];
  for (const channelId of input.channelIds) {
    const message = await prisma.internalChatMessage.create({
      data: {
        channelId,
        senderId: actor.id,
        content: trimmed,
        priority: input.priority ?? 'normal',
      },
    });

    if (input.attachmentIds && input.attachmentIds.length > 0) {
      await prisma.internalChatAttachment.updateMany({
        where: { id: { in: input.attachmentIds } },
        data: { messageId: message.id },
      });
    }

    await prisma.internalChatChannel.update({
      where: { id: channelId },
      data: { lastMessageAt: message.createdAt },
    });

    const fullMsg = await prisma.internalChatMessage.findUnique({
      where: { id: message.id },
      include: MESSAGE_INCLUDE,
    });
    if (fullMsg) {
      results.push(await toMessageDTO(fullMsg, actor.id));
    }
  }

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'chat.broadcast',
    targetType: 'chat_channel',
    metadata: {
      channelIds: input.channelIds,
      contentLength: trimmed.length,
      priority: input.priority ?? 'normal',
    },
  });

  return results;
}

// =====================================================
// Threads
// =====================================================

export async function listThreadMessages(
  threadId: string,
  userId: string
): Promise<ChatMessageDTO[]> {
  const thread = await prisma.internalChatThread.findUnique({
    where: { id: threadId },
    include: { channel: { include: { members: { where: { userId, leftAt: null } } } } },
  });
  if (!thread) throw new ChatError('Hilo no encontrado');
  if (!thread.channel.members.length) throw new AuthorizationError('No eres miembro de este canal');

  const messages = await prisma.internalChatMessage.findMany({
    where: { threadId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 100,
    include: MESSAGE_INCLUDE,
  });

  return Promise.all(messages.map((m) => toMessageDTO(m, userId)));
}

export async function getThreadByRootMessage(
  rootMessageId: string
): Promise<{ id: string; channelId: string } | null> {
  const thread = await prisma.internalChatThread.findUnique({
    where: { rootMessageId },
    select: { id: true, channelId: true },
  });
  return thread;
}

// =====================================================
// Read receipts detailed
// =====================================================

export async function getMessageReaders(
  messageId: string,
  userId: string
): Promise<{ userId: string; name: string; readAt: string }[]> {
  const message = await prisma.internalChatMessage.findUnique({
    where: { id: messageId },
    include: { channel: { include: { members: { where: { userId, leftAt: null } } } } },
  });
  if (!message) throw new ChatError('Mensaje no encontrado');
  if (!message.channel.members.length)
    throw new AuthorizationError('No tienes acceso a este mensaje');

  const receipts = await prisma.internalChatReadReceipt.findMany({
    where: { messageId, userId: { not: userId } },
    include: { user: { select: { name: true } } },
    orderBy: { readAt: 'asc' },
  });

  return receipts.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    readAt: r.readAt.toISOString(),
  }));
}
