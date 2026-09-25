import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { approveMission, getMissionWithEvents, setMissionStatus } from '@/modules/missions/mission-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/assistant/api/missions/[id] — mission detail + journal. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  const data = await getMissionWithEvents(session.user.id, id);
  if (!data) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  return NextResponse.json(data);
}

/**
 * POST /app/assistant/api/missions/[id]
 * Body: { action: 'approve' | 'pause' | 'resume' | 'cancel' }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { action?: string } | null;
  const action = body?.action;
  let ok = false;
  if (action === 'approve') ok = await approveMission(session.user.id, id);
  else if (action === 'pause') ok = await setMissionStatus(session.user.id, id, 'blocked');
  else if (action === 'resume') ok = await setMissionStatus(session.user.id, id, 'active');
  else if (action === 'cancel') ok = await setMissionStatus(session.user.id, id, 'cancelled');
  else return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  if (!ok) return NextResponse.json({ error: 'No se pudo aplicar (estado actual no lo permite)' }, { status: 409 });
  return NextResponse.json({ ok: true });
}
