import webpush, { type PushSubscription as WebPushSubscription, WebPushError } from 'web-push';
import { prisma } from '@/lib/prisma';

/**
 * Web Push (VAPID) transport. Works on Android (Chrome, Firefox...), desktop
 * browsers and iOS 16.4+ when the app is installed on the home screen.
 *
 * Configuration (see .env.example):
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — `npx web-push generate-vapid-keys`
 *   VAPID_SUBJECT — mailto: or https: contact for the push services
 *
 * Without keys the transport is disabled: in-app notifications keep working and
 * the settings screen explains that push is not configured.
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'push', event, ...extra }));

interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let configured: VapidConfig | null | undefined;

function getVapidConfig(): VapidConfig | null {
  if (configured !== undefined) return configured;
  const publicKey = (process.env.VAPID_PUBLIC_KEY ?? '').trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY ?? '').trim();
  const subjectRaw = (process.env.VAPID_SUBJECT ?? '').trim();
  const subject = subjectRaw || (process.env.APP_URL ? process.env.APP_URL.trim() : '');
  if (!publicKey || !privateKey || !subject) {
    configured = null;
    return null;
  }
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = { publicKey, privateKey, subject };
  } catch (err) {
    log('vapid_invalid', { message: err instanceof Error ? err.message : String(err) });
    configured = null;
  }
  return configured;
}

export function isPushConfigured(): boolean {
  return getVapidConfig() !== null;
}

export function getVapidPublicKey(): string | null {
  return getVapidConfig()?.publicKey ?? null;
}

/** Payload the service worker (public/sw.js) understands. */
export interface PushPayload {
  notificationId?: string;
  title: string;
  body?: string;
  /** In-app path to open on tap (relative, e.g. /app/chat?channel=x). */
  url?: string;
  /** Collapses several pushes into one OS notification (e.g. one per chat channel). */
  tag?: string;
  category?: string;
  /** Renotify even when a notification with the same tag is showing. */
  renotify?: boolean;
  /** Keep on screen until the user interacts (incoming call). */
  requireInteraction?: boolean;
  icon?: string;
  badge?: string;
  data?: Record<string, unknown>;
}

export type PushPlatform = 'ios' | 'android' | 'desktop' | 'unknown';

export function detectPlatform(userAgent: string | null | undefined): PushPlatform {
  const ua = (userAgent ?? '').toLowerCase();
  if (!ua) return 'unknown';
  if (/iphone|ipad|ipod/.test(ua) || (ua.includes('macintosh') && ua.includes('mobile'))) return 'ios';
  if (ua.includes('android')) return 'android';
  if (/windows|macintosh|linux|cros/.test(ua)) return 'desktop';
  return 'unknown';
}

export interface SubscribeInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
}

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  platform: PushPlatform;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

function formatRow(row: {
  id: string;
  endpoint: string;
  platform: string;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}): PushSubscriptionRow {
  return {
    id: row.id,
    endpoint: row.endpoint,
    platform: row.platform as PushPlatform,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/** Registers (or re-attaches to `userId`) a browser subscription. */
export async function savePushSubscription(
  userId: string,
  input: SubscribeInput
): Promise<PushSubscriptionRow> {
  const platform = detectPlatform(input.userAgent);
  const row = await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      platform,
    },
    update: {
      userId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      platform,
      failureCount: 0,
    },
  });
  log('subscribed', { userId, platform, id: row.id });
  return formatRow(row);
}

export async function removePushSubscription(userId: string, endpoint: string): Promise<void> {
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
}

export async function removePushSubscriptionById(userId: string, id: string): Promise<void> {
  await prisma.pushSubscription.deleteMany({ where: { userId, id } });
}

export async function listPushSubscriptions(userId: string): Promise<PushSubscriptionRow[]> {
  const rows = await prisma.pushSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(formatRow);
}

export interface PushSendResult {
  sent: number;
  failed: number;
  removed: number;
  /** No device registered or push not configured. */
  skipped: boolean;
}

const MAX_FAILURES_BEFORE_REMOVAL = 5;

/**
 * Sends `payload` to every device of `userId`. Gone subscriptions (404/410)
 * are removed immediately; other errors count towards eventual removal.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  options: { ttlSeconds?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' } = {}
): Promise<PushSendResult> {
  if (!getVapidConfig()) return { sent: 0, failed: 0, removed: 0, skipped: true };

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subscriptions.length === 0) return { sent: 0, failed: 0, removed: 0, skipped: true };

  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  let removed = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      const target: WebPushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webpush.sendNotification(target, body, {
          TTL: options.ttlSeconds ?? 60 * 60,
          urgency: options.urgency ?? 'normal',
          topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
        });
        sent += 1;
        await prisma.pushSubscription
          .update({ where: { id: sub.id }, data: { lastUsedAt: new Date(), failureCount: 0 } })
          .catch(() => undefined);
      } catch (err) {
        failed += 1;
        const status = err instanceof WebPushError ? err.statusCode : undefined;
        const gone = status === 404 || status === 410;
        const shouldRemove = gone || sub.failureCount + 1 >= MAX_FAILURES_BEFORE_REMOVAL;
        log('send_failed', {
          userId,
          subscriptionId: sub.id,
          platform: sub.platform,
          status,
          message: err instanceof Error ? err.message.slice(0, 200) : String(err),
          removed: shouldRemove,
        });
        if (shouldRemove) {
          removed += 1;
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
        } else {
          await prisma.pushSubscription
            .update({ where: { id: sub.id }, data: { failureCount: { increment: 1 } } })
            .catch(() => undefined);
        }
      }
    })
  );

  return { sent, failed, removed, skipped: false };
}

/** Test push from the settings screen (goes only to the calling device when `endpoint` is given). */
export async function sendTestPush(userId: string, endpoint?: string): Promise<PushSendResult> {
  if (!getVapidConfig()) return { sent: 0, failed: 0, removed: 0, skipped: true };
  const payload: PushPayload = {
    title: 'UNIK — notificaciones activas',
    body: 'Así se verán los avisos de llamadas, mensajes y tareas de la IA.',
    url: '/app/account/notifications',
    tag: 'unik-test',
    category: 'system',
  };
  if (!endpoint) return sendPushToUser(userId, payload);
  const sub = await prisma.pushSubscription.findFirst({ where: { userId, endpoint } });
  if (!sub) return { sent: 0, failed: 0, removed: 0, skipped: true };
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 60 }
    );
    return { sent: 1, failed: 0, removed: 0, skipped: false };
  } catch (err) {
    const status = err instanceof WebPushError ? err.statusCode : undefined;
    if (status === 404 || status === 410) {
      await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
      return { sent: 0, failed: 1, removed: 1, skipped: false };
    }
    return { sent: 0, failed: 1, removed: 0, skipped: false };
  }
}
