import { prisma } from '@/lib/prisma';

/**
 * Chat personal stats service.
 *
 * Provides per-user metrics for the personal stats panel.
 * All queries are scoped to the requesting user's data.
 */

export interface PersonalStatsDTO {
  totalMessages: number;
  totalAttachments: number;
  totalReactions: number;
  activeChannels: number;
  activeDays: number;
  messagesToday: number;
  messages7d: number;
  messages30d: number;
  activityByDay: { date: string; count: number }[];
  topContacts: { userId: string; name: string; messageCount: number }[];
  messagesByHour: { hour: number; count: number }[];
}

export async function getPersonalStats(userId: string): Promise<PersonalStatsDTO> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalMessages,
    totalAttachments,
    totalReactions,
    activeChannels,
    messagesToday,
    messages7d,
    messages30d,
    recentMessages,
  ] = await Promise.all([
    prisma.internalChatMessage.count({ where: { senderId: userId, deletedAt: null } }),
    prisma.internalChatAttachment.count({ where: { message: { senderId: userId } } }),
    prisma.internalChatReaction.count({ where: { userId } }),
    prisma.internalChatMember.count({ where: { userId, leftAt: null } }),
    prisma.internalChatMessage.count({
      where: { senderId: userId, deletedAt: null, createdAt: { gte: todayStart } },
    }),
    prisma.internalChatMessage.count({
      where: { senderId: userId, deletedAt: null, createdAt: { gte: sevenDaysAgo } },
    }),
    prisma.internalChatMessage.count({
      where: { senderId: userId, deletedAt: null, createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.internalChatMessage.findMany({
      where: { senderId: userId, deletedAt: null, createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true, channelId: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  // Activity by day (last 30 days)
  const byDay = new Map<string, number>();
  const activeDaysSet = new Set<string>();
  for (const m of recentMessages) {
    const date = m.createdAt.toISOString().slice(0, 10);
    byDay.set(date, (byDay.get(date) ?? 0) + 1);
    activeDaysSet.add(date);
  }

  const activityByDay: { date: string; count: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const date = d.toISOString().slice(0, 10);
    activityByDay.push({ date, count: byDay.get(date) ?? 0 });
  }

  // Messages by hour (aggregated from last 30 days)
  const byHour = new Array(24).fill(0);
  for (const m of recentMessages) {
    byHour[m.createdAt.getHours()]++;
  }
  const messagesByHour = byHour.map((count, hour) => ({ hour, count }));

  // Top contacts: users who received messages from this user (DM channels)
  // Find DM channels where this user is a member, then count messages sent by this user
  const dmMemberships = await prisma.internalChatMember.findMany({
    where: { userId, leftAt: null, channel: { type: 'dm' } },
    select: {
      channelId: true,
      channel: {
        select: {
          members: {
            where: { userId: { not: userId }, leftAt: null },
            select: { userId: true, user: { select: { name: true } } },
          },
        },
      },
    },
  });

  const contactCounts = new Map<string, { name: string; count: number }>();
  for (const dm of dmMemberships) {
    const other = dm.channel.members[0];
    if (!other) continue;
    const count = await prisma.internalChatMessage.count({
      where: { channelId: dm.channelId, senderId: userId, deletedAt: null },
    });
    if (count > 0) {
      contactCounts.set(other.userId, { name: other.user.name, count });
    }
  }

  const topContacts = Array.from(contactCounts.entries())
    .map(([userId, { name, count }]) => ({ userId, name, messageCount: count }))
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 5);

  return {
    totalMessages,
    totalAttachments,
    totalReactions: totalReactions,
    activeChannels,
    activeDays: activeDaysSet.size,
    messagesToday,
    messages7d,
    messages30d,
    activityByDay,
    topContacts,
    messagesByHour,
  };
}
