import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';

/**
 * Generic notification service.
 * Currently supports in-app notifications only.
 * The Notification model is designed to allow future channels (email, push,
 * SMS, WhatsApp) via additional fields without schema changes.
 */

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

function formatRow(row: {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  changeEventId: string | null;
  metadata: Prisma.JsonValue | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationRow {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    entityType: row.entityType,
    entityId: row.entityId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getUnreadNotificationCount(userId: string): Promise<number> {
  return prisma.notification.count({
    where: { userId, readAt: null },
  });
}

export async function getRecentNotifications(
  userId: string,
  limit = 10
): Promise<NotificationRow[]> {
  const notifications = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 50),
  });
  return notifications.map(formatRow);
}

export async function getNotifications(
  userId: string,
  options: { unreadOnly?: boolean; page?: number; pageSize?: number } = {}
): Promise<{ data: NotificationRow[]; total: number; unread: number }> {
  const page = options.page ?? 1;
  const pageSize = Math.min(options.pageSize ?? 25, 100);
  const skip = (page - 1) * pageSize;

  const where: Prisma.NotificationWhereInput = { userId };
  if (options.unreadOnly) where.readAt = null;

  const [notifications, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: pageSize,
      skip,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);

  return { data: notifications.map(formatRow), total, unread };
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { readAt: new Date() },
  });
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
}
