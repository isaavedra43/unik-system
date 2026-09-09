import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getInbox } from '@/modules/chat/chat-service';
import { getTotalUnread } from '@/modules/chat/chat-presence-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/chat/api/inbox
 *
 * Returns a summary of all channels for the current user with unread counts,
 * last message preview, and presence of the other user (for DMs).
 * Used for polling when no SSE is active.
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const [inbox, totalUnread] = await Promise.all([
    getInbox(session.user.id),
    getTotalUnread(session.user.id),
  ]);

  return NextResponse.json({ data: inbox, totalUnread });
}
