import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const count = await getUnreadNotificationCount(session.user.id);
  return NextResponse.json({ count });
}
