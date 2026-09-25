import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getIncomingCalls } from '@/modules/chat/chat-calls-service';
import { apiErrorResponse } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Returns all ringing calls where the current user is a participant
 * (and hasn't accepted or declined yet). Used for global incoming call
 * polling so users receive call notifications even when they're not
 * currently viewing the channel where the call was initiated.
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  try {
    const calls = await getIncomingCalls(session.user.id);
    return NextResponse.json({ data: calls });
  } catch (err) {
    return apiErrorResponse(err, { status: 400, safeNames: ['ChatError'], context: 'chat' });
  }
}
