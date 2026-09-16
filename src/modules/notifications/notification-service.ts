import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { backgroundWorkDisabled } from '@/modules/jobs/background-tasks';
import { getCategoryDefinition, type NotificationCategory } from './catalog';
import { decideDelivery, getNotificationSettings } from './preferences-service';
import type { PushPayload } from './push-service';

// Node-only transports (web-push, EventEmitter) are loaded lazily: the
// `*-change-events.ts` producers are also imported by client components for
// their field labels, and a static import would drag web-push into the browser bundle.
const realtime = () => import('@/modules/realtime/realtime-service');
const pushTransport = () => import('./push-service');

/**
 * Central notification service. Every module creates notifications through
 * `notifyUser` / `notifyUsers`; the service applies the user's preferences,
 * stores the in-app row, pushes it to open tabs (SSE `user:{id}` channel) and
 * to the user's phones (Web Push).
 *
 * Rows created inside a Prisma transaction (`tx`) cannot be pushed before the
 * transaction commits, so they stay `pushStatus = pending` and the dispatcher
 * (`dispatchPendingNotifications`, woken right after creation and run
 * periodically) delivers them. Everything else is delivered inline.
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'notifications', event, ...extra }));

export interface NotificationRow {
  id: string;
  type: string;
  category: string;
  title: string;
  body: string | null;
  url: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

type NotificationRecord = {
  id: string;
  userId: string;
  type: string;
  category: string;
  title: string;
  body: string | null;
  url: string | null;
  entityType: string | null;
  entityId: string | null;
  changeEventId: string | null;
  metadata: Prisma.JsonValue | null;
  readAt: Date | null;
  createdAt: Date;
};

function formatRow(row: NotificationRecord): NotificationRow {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    title: row.title,
    body: row.body,
    url: row.url,
    entityType: row.entityType,
    entityId: row.entityId,
    metadata:
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface NotifyInput {
  userId: string;
  category: NotificationCategory;
  /** Fine-grained type (e.g. "chat_message", "sales_order_changed"). Defaults to the category. */
  type?: string;
  title: string;
  body?: string | null;
  /** In-app path to open when tapped. */
  url?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  changeEventId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Idempotency: a second call with the same key is a no-op. */
  dedupeKey?: string | null;
  /** The user who caused the event — never notified about their own action. */
  actorUserId?: string | null;
  /** Create the row inside this transaction; delivery happens after commit. */
  tx?: Prisma.TransactionClient;
  push?: {
    tag?: string;
    requireInteraction?: boolean;
    renotify?: boolean;
    ttlSeconds?: number;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
  };
}

export interface NotifyResult {
  id: string | null;
  inApp: boolean;
  push: boolean;
  /** true when nothing was created (preferences, actor == recipient, duplicate). */
  suppressed: boolean;
  reason?: string;
}

function pushPayloadFor(row: NotificationRecord, push?: NotifyInput['push']): PushPayload {
  const def = getCategoryDefinition(row.category);
  return {
    notificationId: row.id,
    title: row.title,
    body: row.body ?? undefined,
    url: row.url ?? '/app/notifications',
    tag: push?.tag ?? `unik-${row.category}`,
    category: row.category,
    renotify: push?.renotify ?? def.urgent ?? false,
    requireInteraction: push?.requireInteraction ?? def.urgent ?? false,
    data: { entityType: row.entityType, entityId: row.entityId },
  };
}

async function publishToTabs(row: NotificationRecord): Promise<void> {
  try {
    const { publishRealtime, REALTIME_CHANNELS } = await realtime();
    await publishRealtime(REALTIME_CHANNELS.user(row.userId), 'notification', formatRow(row));
  } catch (err) {
    log('realtime_failed', {
      id: row.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function deliverPush(row: NotificationRecord, push?: NotifyInput['push']): Promise<boolean> {
  const def = getCategoryDefinition(row.category);
  const { sendPushToUser } = await pushTransport();
  const result = await sendPushToUser(row.userId, pushPayloadFor(row, push), {
    ttlSeconds: push?.ttlSeconds ?? (def.urgent ? 90 : 60 * 60),
    urgency: push?.urgency ?? (def.urgent ? 'high' : 'normal'),
  });
  const status = result.skipped ? 'skipped' : result.sent > 0 ? 'sent' : 'failed';
  await prisma.notification
    .update({
      where: { id: row.id },
      data: { pushStatus: status, pushedAt: status === 'sent' ? new Date() : null },
    })
    .catch(() => undefined);
  return status === 'sent';
}

const pendingWakeTimers = new Set<ReturnType<typeof setTimeout>>();

/** Delivers transaction-created rows shortly after they become visible. */
function wakeDispatcher(delayMs = 1500): void {
  // Un proceso sin trabajador de fondo no abre trabajo asíncrono por su cuenta,
  // igual que `startJobWorker()` y `startRecurringScheduler()`. Sin esto el
  // temporizador escribe en `Notification` y `RealtimeEvent` 1,5 s después, ya
  // fuera de la prueba que lo provocó, y bloquea el `TRUNCATE` de la siguiente.
  // No se pierde nada: quien sí tiene trabajador corre además
  // `startNotificationDispatcher()` cada 20 s.
  if (backgroundWorkDisabled()) return;
  if (pendingWakeTimers.size >= 3) return;
  const timer = setTimeout(() => {
    pendingWakeTimers.delete(timer);
    void dispatchPendingNotifications().catch((err) =>
      log('dispatch_failed', { message: err instanceof Error ? err.message : String(err) })
    );
  }, delayMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  pendingWakeTimers.add(timer);
}

export async function notifyUser(input: NotifyInput): Promise<NotifyResult> {
  if (input.actorUserId && input.actorUserId === input.userId) {
    return { id: null, inApp: false, push: false, suppressed: true, reason: 'self' };
  }

  // Inside a transaction the preferences are read with it (no second pool connection).
  const settings = await getNotificationSettings(input.userId, input.tx);
  const decision = decideDelivery(settings, input.category);
  if (!decision.inApp && !decision.push) {
    return { id: null, inApp: false, push: false, suppressed: true, reason: decision.pushReason };
  }

  if (input.dedupeKey) {
    const client = input.tx ?? prisma;
    const dup = await client.notification.findUnique({
      where: { dedupeKey: input.dedupeKey },
      select: { id: true },
    });
    if (dup)
      return { id: dup.id, inApp: false, push: false, suppressed: true, reason: 'duplicate' };
  }

  const client = input.tx ?? prisma;
  let row: NotificationRecord;
  try {
    row = await client.notification.create({
      data: {
        userId: input.userId,
        type: input.type ?? input.category,
        category: input.category,
        title: input.title.slice(0, 200),
        body: input.body ? input.body.slice(0, 1000) : null,
        url: input.url ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        changeEventId: input.changeEventId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        metadata: (input.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        // Rows the user does not want in-app are only a push vehicle; hide them from the list.
        readAt: decision.inApp ? null : new Date(),
        pushStatus: decision.push ? 'pending' : 'skipped',
      },
    });
  } catch (err) {
    // Unique violation on dedupeKey from a concurrent producer.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { id: null, inApp: false, push: false, suppressed: true, reason: 'duplicate' };
    }
    throw err;
  }

  if (input.tx) {
    wakeDispatcher();
    return { id: row.id, inApp: decision.inApp, push: decision.push, suppressed: false };
  }

  await publishToTabs(row);
  let pushed = false;
  if (decision.push) {
    // Claim the row so the periodic dispatcher never double-sends it.
    const claimed = await prisma.notification.updateMany({
      where: { id: row.id, pushStatus: 'pending' },
      data: { pushStatus: 'sending' },
    });
    if (claimed.count === 1) pushed = await deliverPush(row, input.push);
  }
  return { id: row.id, inApp: decision.inApp, push: pushed, suppressed: false };
}

/** Same notification to several users (each with their own preferences). */
export async function notifyUsers(
  userIds: Iterable<string>,
  input: Omit<NotifyInput, 'userId' | 'dedupeKey'> & {
    /** Per-user idempotency key; the user id is appended. */
    dedupeKeyPrefix?: string;
  }
): Promise<NotifyResult[]> {
  const unique = [...new Set(userIds)].filter((id) => id && id !== input.actorUserId);
  const results: NotifyResult[] = [];
  for (const userId of unique) {
    try {
      results.push(
        await notifyUser({
          ...input,
          userId,
          dedupeKey: input.dedupeKeyPrefix ? `${input.dedupeKeyPrefix}:${userId}` : null,
        })
      );
    } catch (err) {
      log('notify_failed', {
        userId,
        category: input.category,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Delivers rows still `pending` (created inside transactions or left behind by
 * a crashed instance). Safe to run from several instances: rows are claimed
 * with an atomic status flip.
 */
export async function dispatchPendingNotifications(
  limit = 100
): Promise<{ delivered: number; pushed: number }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const staleClaim = new Date(Date.now() - 2 * 60 * 1000);
  const candidates = await prisma.notification.findMany({
    where: {
      createdAt: { gte: since },
      OR: [
        { pushStatus: 'pending' },
        // "sending" older than 2 minutes = instance died mid-flight.
        { pushStatus: 'sending', createdAt: { lt: staleClaim } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let delivered = 0;
  let pushed = 0;
  for (const row of candidates) {
    const claimed = await prisma.notification.updateMany({
      where: { id: row.id, pushStatus: row.pushStatus },
      data: { pushStatus: 'sending' },
    });
    if (claimed.count !== 1) continue;
    delivered += 1;
    await publishToTabs(row);
    if (await deliverPush(row)) pushed += 1;
  }
  if (delivered > 0) log('dispatched', { delivered, pushed });
  return { delivered, pushed };
}

// ---------------------------------------------------------------------------
// Read side (bell, list page, AI tool)
// ---------------------------------------------------------------------------

export async function getUnreadNotificationCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function getRecentNotifications(
  userId: string,
  limit = 10
): Promise<NotificationRow[]> {
  const rows = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 50),
  });
  return rows.map(formatRow);
}

export async function getNotifications(
  userId: string,
  options: { unreadOnly?: boolean; category?: string; page?: number; pageSize?: number } = {}
): Promise<{ data: NotificationRow[]; total: number; unread: number }> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(options.pageSize ?? 25, 100);
  const where: Prisma.NotificationWhereInput = { userId };
  if (options.unreadOnly) where.readAt = null;
  if (options.category) where.category = options.category;

  const [rows, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return { data: rows.map(formatRow), total, unread };
}

async function publishReadState(userId: string, ids: string[] | 'all'): Promise<void> {
  try {
    const unread = await getUnreadNotificationCount(userId);
    const { publishRealtime, REALTIME_CHANNELS } = await realtime();
    await publishRealtime(REALTIME_CHANNELS.user(userId), 'notification_read', { ids, unread });
  } catch {
    // badge refreshes on next poll
  }
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<void> {
  const res = await prisma.notification.updateMany({
    where: { id: notificationId, userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (res.count > 0) await publishReadState(userId, [notificationId]);
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  const res = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (res.count > 0) await publishReadState(userId, 'all');
}

/** Marks every unread notification pointing at an entity as read (user opened it). */
export async function markEntityNotificationsRead(
  userId: string,
  entityType: string,
  entityId: string
): Promise<void> {
  const res = await prisma.notification.updateMany({
    where: { userId, entityType, entityId, readAt: null },
    data: { readAt: new Date() },
  });
  if (res.count > 0) await publishReadState(userId, 'all');
}

export async function deleteNotification(userId: string, notificationId: string): Promise<void> {
  await prisma.notification.deleteMany({ where: { id: notificationId, userId } });
}

/** Retention: rows older than `days` are removed. */
export async function pruneNotifications(days = 90): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const res = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return res.count;
}
