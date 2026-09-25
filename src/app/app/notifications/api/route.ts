import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  deleteNotification,
  getNotifications,
} from '@/modules/notifications/notification-service';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const page = searchParams.get('page') ? Number(searchParams.get('page')) : 1;
  const pageSize = searchParams.get('page_size') ? Number(searchParams.get('page_size')) : 25;
  const unreadOnly = searchParams.get('unread') === 'true';
  const category = searchParams.get('category') || undefined;

  const result = await getNotifications(session.user.id, { page, pageSize, unreadOnly, category });
  return NextResponse.json(result);
}

/** DELETE ?id=<notificationId> — dismiss a single notification from the list. */
export async function DELETE(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Falta id' }, { status: 400 });
  await deleteNotification(session.user.id, id);
  return NextResponse.json({ ok: true });
}
