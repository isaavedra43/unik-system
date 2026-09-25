import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getPersonalStats } from '@/modules/chat/chat-stats-service';
import { apiErrorResponse } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  try {
    const stats = await getPersonalStats(session.user.id);
    return NextResponse.json({ data: stats });
  } catch (err) {
    return apiErrorResponse(err, { status: 400, safeNames: ['ChatError'], context: 'chat' });
  }
}
