import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { markAsRead } from '@/modules/chat/chat-service';
import { apiErrorResponse } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { id } = await params;
  try {
    const lastReadAt = await markAsRead(session.user, id);
    return NextResponse.json({ lastReadAt });
  } catch (err) {
    return apiErrorResponse(err, { status: 403, safeNames: ['ChatError'], context: 'chat' });
  }
}
