import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getCall } from '@/modules/chat/chat-calls-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { id } = await params;
  try {
    const call = await getCall(id);
    if (!call) return NextResponse.json({ error: 'Llamada no encontrada' }, { status: 404 });

    // Authorization: only caller or participant can check status
    const isCaller = call.callerId === session.user.id;
    const isParticipant = call.participants.some((p) => p.userId === session.user.id);
    if (!isCaller && !isParticipant) {
      return NextResponse.json({ error: 'No eres participante de esta llamada' }, { status: 403 });
    }

    return NextResponse.json({ data: call });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error desconocido' },
      { status: 400 }
    );
  }
}
