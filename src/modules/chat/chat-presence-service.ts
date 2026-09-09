import { prisma } from '@/lib/prisma';

/**
 * Chat presence service.
 *
 * Tracks user online/away/offline status and provides unread message counts
 * for the inbox sidebar. Presence is updated via heartbeat from the client
 * and expires to "offline" after a configurable timeout.
 */

const AWAY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const OFFLINE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes after last heartbeat

export type PresenceStatus = 'online' | 'away' | 'offline';

export async function heartbeat(userId: string): Promise<void> {
  await prisma.internalChatPresence.upsert({
    where: { userId },
    create: { userId, status: 'online', lastSeenAt: new Date() },
    update: { status: 'online', lastSeenAt: new Date() },
  });
}

export async function setAway(userId: string): Promise<void> {
  await prisma.internalChatPresence.upsert({
    where: { userId },
    create: { userId, status: 'away', lastSeenAt: new Date() },
    update: { status: 'away', lastSeenAt: new Date() },
  });
}

export async function setOffline(userId: string): Promise<void> {
  await prisma.internalChatPresence.upsert({
    where: { userId },
    create: { userId, status: 'offline', lastSeenAt: new Date() },
    update: { status: 'offline', lastSeenAt: new Date() },
  });
}

export async function getPresence(userIds: string[]): Promise<Map<string, PresenceStatus>> {
  if (userIds.length === 0) return new Map();
  const records = await prisma.internalChatPresence.findMany({
    where: { userId: { in: userIds } },
  });
  const now = Date.now();
  const result = new Map<string, PresenceStatus>();
  for (const userId of userIds) {
    const record = records.find((r) => r.userId === userId);
    if (!record) {
      result.set(userId, 'offline');
      continue;
    }
    const elapsed = now - record.lastSeenAt.getTime();
    if (record.status === 'offline') {
      result.set(userId, 'offline');
    } else if (elapsed > OFFLINE_TIMEOUT_MS) {
      result.set(userId, 'offline');
    } else if (elapsed > AWAY_TIMEOUT_MS) {
      result.set(userId, 'away');
    } else {
      result.set(userId, 'online');
    }
  }
  return result;
}

export async function getPresenceStatus(userId: string): Promise<PresenceStatus> {
  const map = await getPresence([userId]);
  return map.get(userId) ?? 'offline';
}

/**
 * Returns unread message counts per channel for a user.
 * A message is "unread" if it was created after the user's lastReadAt
 * and was not sent by the user themselves.
 */
export async function getUnreadCounts(userId: string): Promise<Map<string, number>> {
  const memberships = await prisma.internalChatMember.findMany({
    where: { userId, leftAt: null },
    select: { channelId: true, lastReadAt: true },
  });

  const result = new Map<string, number>();
  for (const m of memberships) {
    const count = await prisma.internalChatMessage.count({
      where: {
        channelId: m.channelId,
        createdAt: { gt: m.lastReadAt },
        senderId: { not: userId },
        deletedAt: null,
      },
    });
    if (count > 0) {
      result.set(m.channelId, count);
    }
  }
  return result;
}

export async function getTotalUnread(userId: string): Promise<number> {
  const map = await getUnreadCounts(userId);
  let total = 0;
  for (const count of map.values()) total += count;
  return total;
}
