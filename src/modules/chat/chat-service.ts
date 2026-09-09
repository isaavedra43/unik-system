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
} from './chat-events';
import { getPresence } from './chat-presence-service';

export class ChatError extends Error {
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
  },
  currentUserId: string
): Promise<ChatMessageDTO> {
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
    createdAt: msg.createdAt.toISOString(),
    attachments: msg.attachments.map(toAttachmentDTO),
    reactions: toReactionDTO(msg.reactions),
    readBy: msg.readReceipts.filter((r) => r.userId !== currentUserId).map((r) => r.userId),
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

export interface SendMessageInput {
  channelId: string;
  content?: string | null;
  replyToId?: string | null;
  forwardedFromId?: string | null;
  attachmentIds?: string[]; // pre-saved attachments to link
}

export async function sendMessage(
  actor: CurrentUser,
  input: SendMessageInput
): Promise<ChatMessageDTO> {
  await assertChannelMember(input.channelId, actor.id);

  if (!input.content && (!input.attachmentIds || input.attachmentIds.length === 0)) {
    throw new ChatError('El mensaje debe tener contenido o adjuntos');
  }

  const content = input.content?.trim() || null;
  if (content && content.length > 10_000) {
    throw new ChatError('El mensaje es demasiado largo (máx 10,000 caracteres)');
  }

  const message = await prisma.internalChatMessage.create({
    data: {
      channelId: input.channelId,
      senderId: actor.id,
      content,
      replyToId: input.replyToId ?? null,
      forwardedFromId: input.forwardedFromId ?? null,
      forwardedBy: input.forwardedFromId ? actor.id : null,
    },
    include: {
      sender: true,
      replyTo: { include: { sender: true } },
      attachments: true,
      reactions: { include: { user: true } },
      readReceipts: true,
    },
  });

  // Link pre-saved attachments if any
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    await prisma.internalChatAttachment.updateMany({
      where: { id: { in: input.attachmentIds } },
      data: { messageId: message.id },
    });
  }

  // Update channel's lastMessageAt
  await prisma.internalChatChannel.update({
    where: { id: input.channelId },
    data: { lastMessageAt: message.createdAt },
  });

  // Re-fetch with attachments linked
  const fullMessage = await prisma.internalChatMessage.findUnique({
    where: { id: message.id },
    include: {
      sender: true,
      replyTo: { include: { sender: true } },
      attachments: true,
      reactions: { include: { user: true } },
      readReceipts: true,
    },
  });

  if (!fullMessage) throw new ChatError('Error al crear el mensaje');

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
    include: {
      sender: true,
      replyTo: { include: { sender: true } },
      attachments: true,
      reactions: { include: { user: true } },
      readReceipts: true,
    },
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
    include: {
      sender: true,
      replyTo: { include: { sender: true } },
      attachments: true,
      reactions: { include: { user: true } },
      readReceipts: true,
    },
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
      include: {
        sender: true,
        replyTo: { include: { sender: true } },
        attachments: true,
        reactions: { include: { user: true } },
        readReceipts: true,
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
      include: {
        sender: true,
        replyTo: { include: { sender: true } },
        attachments: true,
        reactions: { include: { user: true } },
        readReceipts: true,
      },
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
}

const typingUsers = new Map<string, TypingState>(); // key: channelId:userId
const TYPING_TIMEOUT_MS = 5000;

export function setTyping(userId: string, channelId: string): void {
  typingUsers.set(`${channelId}:${userId}`, {
    userId,
    channelId,
    expiresAt: Date.now() + TYPING_TIMEOUT_MS,
  });
}

export function clearTyping(userId: string, channelId: string): void {
  typingUsers.delete(`${channelId}:${userId}`);
}

export function getTypingUsers(channelId: string): { userId: string }[] {
  const now = Date.now();
  const result: { userId: string }[] = [];
  for (const [key, state] of typingUsers) {
    if (state.channelId !== channelId) continue;
    if (state.expiresAt < now) {
      typingUsers.delete(key);
      continue;
    }
    result.push({ userId: state.userId });
  }
  return result;
}
