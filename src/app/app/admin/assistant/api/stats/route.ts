import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getAiStats, getAiStatsByDay, getTopTools, getTopUsers } from '@/modules/ai/ai-admin-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'assistant.admin')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const [stats, byDay, topTools, topUsers] = await Promise.all([
    getAiStats(),
    getAiStatsByDay(30),
    getTopTools(10),
    getTopUsers(10),
  ]);

  return NextResponse.json({ stats, byDay, topTools, topUsers });
}
