import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listChatUsers } from '@/modules/chat/chat-admin-service';

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

  const users = await listChatUsers();
  return NextResponse.json({ users });
}
