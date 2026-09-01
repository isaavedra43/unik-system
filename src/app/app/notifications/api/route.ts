import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getNotifications } from '@/modules/sales/notifications-service';

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

  const result = await getNotifications(session.user.id, { page, pageSize, unreadOnly });
  return NextResponse.json(result);
}
