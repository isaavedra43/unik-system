import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { cancelTask } from '@/modules/agents/delegation';

type Params = { params: Promise<{ id: string }> };

/** POST /app/assistant/api/tasks/:id/cancel — cancela la tarea y sus hijas. */
export async function POST(_req: NextRequest, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }
  const { id } = await params;
  const ok = await cancelTask(id, session.user.id);
  return NextResponse.json({ cancelled: ok });
}
