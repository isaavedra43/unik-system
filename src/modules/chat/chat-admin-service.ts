import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { CurrentUser } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';

// =====================================================
// Stats
// =====================================================

export interface ChatStats {
  totalChannels: number;
  totalDmChannels: number;
  totalGroupChannels: number;
  totalMessages: number;
  totalAttachments: number;
  activeUsers24h: number;
  activeUsers7d: number;
  messages24h: number;
  messages7d: number;
  messages30d: number;
  totalPolls: number;
  totalEvents: number;
  totalMentions: number;
  unreadMentions: number;
  activeAlerts: number;
}

export async function getChatStats(): Promise<ChatStats> {
  const [
    totalChannels,
    totalDmChannels,
    totalGroupChannels,
    totalMessages,
    totalAttachments,
    activeUsers24h,
    activeUsers7d,
    messages24h,
    messages7d,
    messages30d,
    totalPolls,
    totalEvents,
    totalMentions,
    unreadMentions,
    activeAlerts,
  ] = await Promise.all([
    prisma.internalChatChannel.count(),
    prisma.internalChatChannel.count({ where: { type: 'dm' } }),
    prisma.internalChatChannel.count({ where: { type: 'group' } }),
    prisma.internalChatMessage.count(),
    prisma.internalChatAttachment.count(),
    prisma.internalChatMessage.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } },
      select: { senderId: true },
      distinct: ['senderId'],
    }),
    prisma.internalChatMessage.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 604_800_000) } },
      select: { senderId: true },
      distinct: ['senderId'],
    }),
    prisma.internalChatMessage.count({
      where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    }),
    prisma.internalChatMessage.count({
      where: { createdAt: { gte: new Date(Date.now() - 604_800_000) } },
    }),
    prisma.internalChatMessage.count({
      where: { createdAt: { gte: new Date(Date.now() - 2_592_000_000) } },
    }),
    prisma.internalChatPoll.count(),
    prisma.internalChatEvent.count(),
    prisma.internalChatMention.count(),
    prisma.internalChatMention.count({ where: { readAt: null } }),
    prisma.internalChatAlert.count({ where: { resolvedAt: null } }),
  ]);

  return {
    totalChannels,
    totalDmChannels,
    totalGroupChannels,
    totalMessages,
    totalAttachments,
    activeUsers24h: activeUsers24h.length,
    activeUsers7d: activeUsers7d.length,
    messages24h,
    messages7d,
    messages30d,
    totalPolls,
    totalEvents,
    totalMentions,
    unreadMentions,
    activeAlerts,
  };
}

export interface ChatActivityByDay {
  date: string;
  messages: number;
}

export async function getChatActivityByDay(days = 30): Promise<ChatActivityByDay[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const messages = await prisma.internalChatMessage.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true },
  });

  const byDay = new Map<string, number>();
  for (const m of messages) {
    const date = m.createdAt.toISOString().slice(0, 10);
    byDay.set(date, (byDay.get(date) ?? 0) + 1);
  }

  const result: ChatActivityByDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const date = d.toISOString().slice(0, 10);
    result.push({ date, messages: byDay.get(date) ?? 0 });
  }
  return result;
}

interface ChatTopUser {
  userId: string;
  userName: string;
  messageCount: number;
  attachmentCount: number;
  lastActivity: string | null;
}

export async function getTopChatUsers(limit = 10): Promise<ChatTopUser[]> {
  const users = await prisma.user.findMany({
    where: {
      chatMessages: { some: {} },
    },
    select: {
      id: true,
      name: true,
      _count: {
        select: {
          chatMessages: true,
        },
      },
      chatMessages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
    orderBy: { chatMessages: { _count: 'desc' } },
    take: limit,
  });

  const userIds = users.map((u) => u.id);

  // Count attachments per user via a single query
  const attachmentByUser = await prisma.internalChatAttachment.findMany({
    where: { message: { senderId: { in: userIds } } },
    select: { message: { select: { senderId: true } } },
  });
  const userAttachmentMap = new Map<string, number>();
  for (const a of attachmentByUser) {
    const uid = a.message?.senderId;
    if (!uid) continue;
    userAttachmentMap.set(uid, (userAttachmentMap.get(uid) ?? 0) + 1);
  }

  return users.map((u) => ({
    userId: u.id,
    userName: u.name,
    messageCount: u._count.chatMessages,
    attachmentCount: userAttachmentMap.get(u.id) ?? 0,
    lastActivity: u.chatMessages[0]?.createdAt.toISOString() ?? null,
  }));
}

// =====================================================
// Conversations (admin view)
// =====================================================

interface AdminChannelView {
  id: string;
  type: string;
  name: string | null;
  createdBy: string;
  memberCount: number;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export async function listAllChannels(
  options: {
    type?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ channels: AdminChannelView[]; total: number }> {
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  const where: Prisma.InternalChatChannelWhereInput = {};
  if (options.type) where.type = options.type;
  if (options.search) {
    where.OR = [{ name: { contains: options.search, mode: 'insensitive' } }];
  }

  const [channels, total] = await Promise.all([
    prisma.internalChatChannel.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: offset,
      take: limit,
      include: {
        _count: {
          select: { members: true, messages: true },
        },
      },
    }),
    prisma.internalChatChannel.count({ where }),
  ]);

  return {
    channels: channels.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      createdBy: c.createdBy,
      memberCount: c._count.members,
      messageCount: c._count.messages,
      lastMessageAt: c.lastMessageAt.toISOString(),
      createdAt: c.createdAt.toISOString(),
    })),
    total,
  };
}

export async function getChannelMessagesAdmin(
  channelId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<{
  messages: Array<{
    id: string;
    senderId: string;
    senderName: string;
    content: string | null;
    createdAt: string;
    deletedAt: string | null;
  }>;
  hasMore: boolean;
}> {
  const limit = Math.min(options.limit ?? 50, 100);
  const messages = await prisma.internalChatMessage.findMany({
    where: {
      channelId,
      ...(options.cursor ? { createdAt: { lt: new Date(options.cursor) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: { sender: { select: { name: true } } },
  });

  const hasMore = messages.length > limit;
  const slice = hasMore ? messages.slice(0, limit) : messages;

  return {
    messages: slice.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      senderName: m.sender.name,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      deletedAt: m.deletedAt?.toISOString() ?? null,
    })),
    hasMore,
  };
}

// =====================================================
// Global message search (admin)
// =====================================================

export async function searchAllMessages(
  query: string,
  options: { channelId?: string; userId?: string; limit?: number } = {}
): Promise<
  Array<{
    id: string;
    channelId: string;
    channelName: string | null;
    senderId: string;
    senderName: string;
    content: string | null;
    createdAt: string;
  }>
> {
  const q = query.trim();
  if (q.length < 2) return [];

  const limit = Math.min(options.limit ?? 50, 100);
  const messages = await prisma.internalChatMessage.findMany({
    where: {
      content: { contains: q, mode: 'insensitive' },
      deletedAt: null,
      ...(options.channelId ? { channelId: options.channelId } : {}),
      ...(options.userId ? { senderId: options.userId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      sender: { select: { name: true } },
      channel: { select: { name: true } },
    },
  });

  return messages.map((m) => ({
    id: m.id,
    channelId: m.channelId,
    channelName: m.channel.name,
    senderId: m.senderId,
    senderName: m.sender.name,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
  }));
}

// =====================================================
// User activity (admin)
// =====================================================

interface AdminUserActivity {
  userId: string;
  userName: string;
  username: string;
  email: string | null;
  messageCount: number;
  channelCount: number;
  attachmentCount: number;
  lastActivity: string | null;
}

export async function listChatUsers(): Promise<AdminUserActivity[]> {
  const users = await prisma.user.findMany({
    where: {
      OR: [{ chatMessages: { some: {} } }, { chatMemberships: { some: {} } }],
    },
    select: {
      id: true,
      name: true,
      username: true,
      email: true,
      _count: {
        select: {
          chatMessages: true,
          chatMemberships: true,
        },
      },
      chatMessages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
    orderBy: { chatMessages: { _count: 'desc' } },
  });

  const userIds = users.map((u) => u.id);
  const attachmentCounts = await prisma.internalChatAttachment.findMany({
    where: { message: { senderId: { in: userIds } } },
    select: { message: { select: { senderId: true } } },
  });
  const attachmentMap = new Map<string, number>();
  for (const a of attachmentCounts) {
    const uid = a.message?.senderId;
    if (!uid) continue;
    attachmentMap.set(uid, (attachmentMap.get(uid) ?? 0) + 1);
  }

  return users.map((u) => ({
    userId: u.id,
    userName: u.name,
    username: u.username,
    email: u.email,
    messageCount: u._count.chatMessages,
    channelCount: u._count.chatMemberships,
    attachmentCount: attachmentMap.get(u.id) ?? 0,
    lastActivity: u.chatMessages[0]?.createdAt.toISOString() ?? null,
  }));
}

// =====================================================
// Moderation
// =====================================================

export async function adminDeleteMessage(actor: CurrentUser, messageId: string): Promise<void> {
  const msg = await prisma.internalChatMessage.findUnique({ where: { id: messageId } });
  if (!msg) throw new Error('Mensaje no encontrado');
  if (msg.deletedAt) return;

  await prisma.internalChatMessage.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), content: null },
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'chat.admin.delete_message',
    targetType: 'chat_message',
    targetId: messageId,
    metadata: { channelId: msg.channelId, originalSenderId: msg.senderId },
  });
}

export async function adminDeleteChannel(actor: CurrentUser, channelId: string): Promise<void> {
  const channel = await prisma.internalChatChannel.findUnique({ where: { id: channelId } });
  if (!channel) throw new Error('Canal no encontrado');

  await prisma.internalChatChannel.delete({ where: { id: channelId } });

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'chat.admin.delete_channel',
    targetType: 'chat_channel',
    targetId: channelId,
    metadata: { type: channel.type, name: channel.name },
  });
}

// =====================================================
// Alerts (anti-fraude)
// =====================================================

export async function listAlerts(
  options: {
    resolved?: boolean;
    type?: string;
    severity?: string;
    limit?: number;
  } = {}
): Promise<
  {
    id: string;
    type: string;
    severity: string;
    userId: string | null;
    channelId: string | null;
    messageId: string | null;
    metadata: Prisma.JsonValue | null;
    resolvedAt: string | null;
    resolvedBy: string | null;
    createdAt: string;
  }[]
> {
  const limit = Math.min(options.limit ?? 50, 100);
  const where: Prisma.InternalChatAlertWhereInput = {};
  if (options.resolved !== undefined) {
    where.resolvedAt = options.resolved ? { not: null } : null;
  }
  if (options.type) where.type = options.type;
  if (options.severity) where.severity = options.severity;

  const alerts = await prisma.internalChatAlert.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return alerts.map((a) => ({
    id: a.id,
    type: a.type,
    severity: a.severity,
    userId: a.userId,
    channelId: a.channelId,
    messageId: a.messageId,
    metadata: a.metadata,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    resolvedBy: a.resolvedBy,
    createdAt: a.createdAt.toISOString(),
  }));
}

export async function resolveAlert(actor: CurrentUser, alertId: string): Promise<void> {
  await prisma.internalChatAlert.update({
    where: { id: alertId },
    data: { resolvedAt: new Date(), resolvedBy: actor.id },
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'chat.admin.resolve_alert',
    targetType: 'chat_alert',
    targetId: alertId,
  });
}

// =====================================================
// Alert detection (called from sendMessage hook)
// =====================================================

const SENSITIVE_KEYWORDS = [
  'confidencial',
  'password',
  'contraseña',
  'robar',
  'enviar a casa',
  'datos bancarios',
  'tarjeta de crédito',
  'número de cuenta',
];

const EXTERNAL_LINK_REGEX = /https?:\/\/(?!localhost|127\.0\.0\.1|unik)[^\s]+/gi;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export async function detectChatAlerts(message: {
  id: string;
  channelId: string;
  senderId: string;
  content: string | null;
  createdAt: Date;
}): Promise<void> {
  if (!message.content) return;
  const contentLower = message.content.toLowerCase();

  // 1. Sensitive keywords
  for (const keyword of SENSITIVE_KEYWORDS) {
    if (contentLower.includes(keyword)) {
      await prisma.internalChatAlert.create({
        data: {
          type: 'keyword',
          severity: 'medium',
          userId: message.senderId,
          channelId: message.channelId,
          messageId: message.id,
          metadata: { keyword, preview: message.content.slice(0, 200) },
        },
      });
    }
  }

  // 2. External links / emails
  const links = message.content.match(EXTERNAL_LINK_REGEX);
  const emails = message.content.match(EMAIL_REGEX);
  if (links || emails) {
    await prisma.internalChatAlert.create({
      data: {
        type: 'external_share',
        severity: 'low',
        userId: message.senderId,
        channelId: message.channelId,
        messageId: message.id,
        metadata: {
          links: links?.slice(0, 5) ?? [],
          emails: emails?.slice(0, 5) ?? [],
        },
      },
    });
  }

  // 3. Off-hours activity (configurable; default 6am-10pm)
  const hour = message.createdAt.getHours();
  if (hour < 6 || hour >= 22) {
    await prisma.internalChatAlert.create({
      data: {
        type: 'off_hours',
        severity: 'low',
        userId: message.senderId,
        channelId: message.channelId,
        messageId: message.id,
        metadata: { hour },
      },
    });
  }

  // 4. Volume spike (more than 30 messages in 1 hour from same user)
  const oneHourAgo = new Date(message.createdAt.getTime() - 60 * 60 * 1000);
  const recentCount = await prisma.internalChatMessage.count({
    where: { senderId: message.senderId, createdAt: { gte: oneHourAgo } },
  });
  if (recentCount > 30) {
    await prisma.internalChatAlert.create({
      data: {
        type: 'volume_spike',
        severity: 'medium',
        userId: message.senderId,
        channelId: message.channelId,
        messageId: message.id,
        metadata: { count: recentCount, window: '1h' },
      },
    });
  }
}

// =====================================================
// Config
// =====================================================

export async function getConfig(): Promise<Record<string, string>> {
  const configs = await prisma.internalChatConfig.findMany();
  const result: Record<string, string> = {};
  for (const c of configs) {
    result[c.key] = c.value;
  }
  return result;
}

export async function setConfig(actor: CurrentUser, key: string, value: string): Promise<void> {
  await prisma.internalChatConfig.upsert({
    where: { key },
    create: { id: key, key, value },
    update: { value },
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'chat.admin.update_config',
    targetType: 'chat_config',
    targetId: key,
    metadata: { key },
  });
}

// =====================================================
// 1. Suspend / unsuspend users
// =====================================================

const SUSPENDED_KEY = 'chat.suspended_users';

export async function getSuspendedUserIds(): Promise<Set<string>> {
  const config = await prisma.internalChatConfig.findUnique({ where: { key: SUSPENDED_KEY } });
  if (!config?.value) return new Set();
  return new Set(config.value.split(',').filter(Boolean));
}

export async function suspendUser(actor: CurrentUser, userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
  if (!user) throw new Error('Usuario no encontrado');

  const current = await getSuspendedUserIds();
  if (current.has(userId)) throw new Error('El usuario ya está suspendido');
  current.add(userId);

  await prisma.internalChatConfig.upsert({
    where: { key: SUSPENDED_KEY },
    create: { id: SUSPENDED_KEY, key: SUSPENDED_KEY, value: Array.from(current).join(',') },
    update: { value: Array.from(current).join(',') },
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'chat.admin.suspend_user',
    targetType: 'user',
    targetId: userId,
    metadata: { userName: user.name },
  });
}

export async function unsuspendUser(actor: CurrentUser, userId: string): Promise<void> {
  const current = await getSuspendedUserIds();
  if (!current.has(userId)) throw new Error('El usuario no está suspendido');
  current.delete(userId);

  await prisma.internalChatConfig.upsert({
    where: { key: SUSPENDED_KEY },
    create: { id: SUSPENDED_KEY, key: SUSPENDED_KEY, value: Array.from(current).join(',') },
    update: { value: Array.from(current).join(',') },
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'chat.admin.unsuspend_user',
    targetType: 'user',
    targetId: userId,
  });
}

export async function isUserSuspended(userId: string): Promise<boolean> {
  const suspended = await getSuspendedUserIds();
  return suspended.has(userId);
}

// =====================================================
// 2. Export channel messages
// =====================================================

export async function exportChannelMessages(
  channelId: string,
  format: 'csv' | 'json' = 'csv'
): Promise<{ data: string; filename: string; contentType: string }> {
  const channel = await prisma.internalChatChannel.findUnique({
    where: { id: channelId },
    select: { name: true },
  });
  if (!channel) throw new Error('Canal no encontrado');

  const messages = await prisma.internalChatMessage.findMany({
    where: { channelId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { sender: { select: { name: true } } },
    take: 10000,
  });

  const channelName = channel.name ?? channelId;
  const safeName = channelName.replace(/[^a-zA-Z0-9_-]/g, '_');

  if (format === 'json') {
    const data = JSON.stringify(
      messages.map((m) => ({
        id: m.id,
        sender: m.sender.name,
        senderId: m.senderId,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
      null,
      2
    );
    return {
      data,
      filename: `${safeName}.json`,
      contentType: 'application/json',
    };
  }

  // CSV
  const header = 'id,remitente,remitente_id,contenido,fecha\n';
  const rows = messages.map((m) => {
    const content = (m.content ?? '').replace(/"/g, '""').replace(/\n/g, ' ');
    const sender = m.sender.name.replace(/"/g, '""');
    return `"${m.id}","${sender}","${m.senderId}","${content}","${m.createdAt.toISOString()}"`;
  });
  return {
    data: header + rows.join('\n'),
    filename: `${safeName}.csv`,
    contentType: 'text/csv',
  };
}

// =====================================================
// 3. List all calls (call monitoring)
// =====================================================

export async function listAllCalls(
  options: { status?: string; limit?: number; offset?: number } = {}
): Promise<{
  calls: Array<{
    id: string;
    channelId: string;
    channelName: string | null;
    callerId: string;
    callerName: string;
    type: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    createdAt: string;
    participantCount: number;
  }>;
  total: number;
}> {
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = options.offset ?? 0;
  const where: Prisma.InternalChatCallWhereInput = {};
  if (options.status) where.status = options.status;

  const [calls, total] = await Promise.all([
    prisma.internalChatCall.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
      include: {
        caller: { select: { name: true } },
        channel: { select: { name: true } },
        _count: { select: { participants: true } },
      },
    }),
    prisma.internalChatCall.count({ where }),
  ]);

  return {
    calls: calls.map((c) => ({
      id: c.id,
      channelId: c.channelId,
      channelName: c.channel.name,
      callerId: c.callerId,
      callerName: c.caller.name,
      type: c.type,
      status: c.status,
      startedAt: c.startedAt?.toISOString() ?? null,
      endedAt: c.endedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      participantCount: c._count.participants,
    })),
    total,
  };
}

// =====================================================
// 4. Global broadcast (send system message to all channels)
// =====================================================

export async function sendBroadcast(
  actor: CurrentUser,
  message: string
): Promise<{ sentCount: number }> {
  if (!message.trim()) throw new Error('El mensaje no puede estar vacío');

  const channels = await prisma.internalChatChannel.findMany({
    where: { type: 'group' },
    select: { id: true },
  });

  if (channels.length === 0) {
    return { sentCount: 0 };
  }

  // Create a message in each group channel
  await prisma.internalChatMessage.createMany({
    data: channels.map((c) => ({
      channelId: c.id,
      senderId: actor.id,
      content: `[ANUNCIO] ${message}`,
      priority: 'urgent',
    })),
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'chat.admin.broadcast',
    targetType: 'chat_channel',
    targetId: 'broadcast',
    metadata: { message: message.slice(0, 200), channelCount: channels.length },
  });

  return { sentCount: channels.length };
}

// =====================================================
// 5. Chat audit log
// =====================================================

export async function listChatAuditLog(
  options: { limit?: number; offset?: number; action?: string } = {}
): Promise<{
  entries: Array<{
    id: string;
    actorUserId: string | null;
    actorName: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    metadata: Prisma.JsonValue | null;
    createdAt: string;
  }>;
  total: number;
}> {
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = options.offset ?? 0;
  const where: Prisma.AuditLogWhereInput = {
    action: options.action ?? { startsWith: 'chat.' },
  };

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  // Fetch actor names separately (AuditLog has no relation to User)
  const actorIds = [...new Set(entries.map((e) => e.actorUserId).filter(Boolean))] as string[];
  const actors = actorIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const actorMap = new Map(actors.map((a) => [a.id, a.name]));

  return {
    entries: entries.map((e) => ({
      id: e.id,
      actorUserId: e.actorUserId,
      actorName: e.actorUserId ? actorMap.get(e.actorUserId) ?? null : null,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
    })),
    total,
  };
}
