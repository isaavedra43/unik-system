import { prisma } from '@/lib/prisma';
import { notifyUser } from '@/modules/notifications/notification-service';

/**
 * Push/in-app notifications for internal chat messages.
 *
 * Honors, per member: the channel preference (`all` | `mentions` | `none`) and
 * temporary mutes (`mutedUntil`). Mentions and urgent messages get through a
 * `mentions` preference and a mute; `none` silences everything. The sender is
 * never notified. Errors never surface to the sender (fire-and-forget).
 */

export interface ChatMessageNotificationInput {
  messageId: string;
  channelId: string;
  senderId: string;
  senderName: string;
  content: string | null;
  priority?: 'normal' | 'urgent' | string | null;
  mentionedUserIds?: Iterable<string>;
  kind?: 'text' | 'attachment' | 'location' | 'poll' | 'event';
}

function preview(input: ChatMessageNotificationInput): string {
  const text = (input.content ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 140 ? `${text.slice(0, 137)}…` : text;
  switch (input.kind) {
    case 'attachment':
      return '📎 Envió un archivo';
    case 'location':
      return '📍 Compartió una ubicación';
    case 'poll':
      return '📊 Creó una encuesta';
    case 'event':
      return '📅 Creó un evento';
    default:
      return 'Mensaje nuevo';
  }
}

export async function notifyChatMessage(input: ChatMessageNotificationInput): Promise<void> {
  const [channel, members, prefs] = await Promise.all([
    prisma.internalChatChannel.findUnique({
      where: { id: input.channelId },
      select: { type: true, name: true },
    }),
    prisma.internalChatMember.findMany({
      where: { channelId: input.channelId, leftAt: null, userId: { not: input.senderId } },
      select: { userId: true, mutedUntil: true },
    }),
    prisma.internalChatNotificationPreference.findMany({
      where: { channelId: input.channelId },
      select: { userId: true, level: true },
    }),
  ]);
  if (!channel || members.length === 0) return;

  const levelByUser = new Map(prefs.map((p) => [p.userId, p.level]));
  const mentioned = new Set(input.mentionedUserIds ?? []);
  const urgent = input.priority === 'urgent';
  const now = Date.now();
  const isDm = channel.type === 'dm';
  const channelLabel = channel.name ? `#${channel.name}` : 'el chat';
  const body = preview(input);
  const url = `/app/chat?channel=${encodeURIComponent(input.channelId)}`;

  for (const member of members) {
    const level = levelByUser.get(member.userId) ?? 'all';
    if (level === 'none') continue;
    const isMention = mentioned.has(member.userId);
    const muted = member.mutedUntil ? member.mutedUntil.getTime() > now : false;
    const priorityDelivery = isMention || urgent;
    if (!priorityDelivery && (level === 'mentions' || muted)) continue;

    const title = isMention
      ? `${input.senderName} te mencionó${isDm ? '' : ` en ${channelLabel}`}`
      : urgent
        ? `🔴 Urgente · ${input.senderName}${isDm ? '' : ` en ${channelLabel}`}`
        : isDm
          ? input.senderName
          : `${input.senderName} en ${channelLabel}`;

    await notifyUser({
      userId: member.userId,
      actorUserId: input.senderId,
      category: isMention ? 'chat_mention' : 'chat_message',
      type: isMention ? 'chat_mention' : urgent ? 'chat_message_urgent' : 'chat_message',
      title,
      body,
      url,
      entityType: 'chat_channel',
      entityId: input.channelId,
      dedupeKey: `chat_msg:${input.messageId}:${member.userId}`,
      metadata: { channelId: input.channelId, messageId: input.messageId, senderId: input.senderId },
      push: {
        // One OS notification per channel: the latest message replaces the previous one.
        tag: `chat:${input.channelId}`,
        renotify: true,
        requireInteraction: urgent,
        urgency: urgent || isMention ? 'high' : 'normal',
      },
    });
  }
}
