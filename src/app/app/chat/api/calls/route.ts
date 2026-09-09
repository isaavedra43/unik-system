import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { initiateCall } from '@/modules/chat/chat-calls-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const initiateSchema = z.object({
  channelId: z.string().min(1),
  type: z.enum(['audio', 'video']),
  participantIds: z.array(z.string().min(1)).min(1),
});

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = initiateSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );

  try {
    const call = await initiateCall(
      session.user,
      parsed.data.channelId,
      parsed.data.type,
      parsed.data.participantIds
    );
    return NextResponse.json({ data: call });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error desconocido' },
      { status: 400 }
    );
  }
}
