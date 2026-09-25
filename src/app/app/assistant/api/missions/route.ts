import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listMissions } from '@/modules/missions/mission-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/assistant/api/missions — missions of the current user (+progress). */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const status = request.nextUrl.searchParams.get('status') ?? undefined;
  const missions = await listMissions(session.user.id, { status });
  return NextResponse.json({ missions });
}
