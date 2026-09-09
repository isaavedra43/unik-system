import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import {
  getChatStats,
  getChatActivityByDay,
  getTopChatUsers,
} from '@/modules/chat/chat-admin-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'chat.admin')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const [stats, activity, topUsers] = await Promise.all([
    getChatStats(),
    getChatActivityByDay(30),
    getTopChatUsers(10),
  ]);

  return NextResponse.json({ stats, activity, topUsers });
}
