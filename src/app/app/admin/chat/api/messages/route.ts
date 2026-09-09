import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { searchAllMessages } from '@/modules/chat/chat-admin-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'chat.admin')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const query = searchParams.get('query') ?? '';
  const channelId = searchParams.get('channelId') ?? undefined;
  const userId = searchParams.get('userId') ?? undefined;
  const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined;

  const messages = await searchAllMessages(query, { channelId, userId, limit });
  return NextResponse.json({ messages });
}
