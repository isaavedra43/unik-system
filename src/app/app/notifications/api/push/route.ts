import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  getVapidPublicKey,
  isPushConfigured,
  listPushSubscriptions,
  removePushSubscription,
  savePushSubscription,
} from '@/modules/notifications/push-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET: push availability + the caller's registered devices. */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const subscriptions = await listPushSubscriptions(session.user.id);
  return NextResponse.json({
    configured: isPushConfigured(),
    publicKey: getVapidPublicKey(),
    subscriptions,
  });
}

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(200) }),
  }),
  userAgent: z.string().max(500).optional().nullable(),
});

/** POST: register this browser/device for the current user. */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!isPushConfigured()) {
    return NextResponse.json({ error: 'Push no configurado en el servidor' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Suscripción inválida' }, { status: 400 });
  }
  const row = await savePushSubscription(session.user.id, {
    endpoint: parsed.data.subscription.endpoint,
    keys: parsed.data.subscription.keys,
    userAgent: parsed.data.userAgent ?? request.headers.get('user-agent'),
  });
  return NextResponse.json({ subscription: row });
}

const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });

/** DELETE: forget this device. */
export async function DELETE(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = unsubscribeSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  await removePushSubscription(session.user.id, parsed.data.endpoint);
  return NextResponse.json({ ok: true });
}
