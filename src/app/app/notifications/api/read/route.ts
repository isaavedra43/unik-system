import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
} from '@/modules/notifications/notification-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.union([
  z.object({ id: z.string().min(1), unread: z.literal(true).optional() }),
  z.object({ all: z.literal(true) }),
]);

/** POST { id } | { id, unread: true } | { all: true } — used by the bell, the list and the service worker. */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  if ('all' in parsed.data) await markAllNotificationsRead(session.user.id);
  else if (parsed.data.unread) await markNotificationUnread(session.user.id, parsed.data.id);
  else await markNotificationRead(session.user.id, parsed.data.id);
  return NextResponse.json({ ok: true });
}
