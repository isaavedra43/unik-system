import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listUserChannels, createDmChannel, createGroupChannel } from '@/modules/chat/chat-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const channels = await listUserChannels(session.user.id);
  return NextResponse.json({ data: channels });
}

const createSchema = z.object({
  type: z.enum(['dm', 'group']),
  name: z.string().min(1).max(100).optional(),
  memberIds: z.array(z.string().min(1)).optional(),
  otherUserId: z.string().min(1).optional(),
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

  const parsed = createSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );

  const { type, name, memberIds, otherUserId } = parsed.data;

  try {
    if (type === 'dm') {
      if (!otherUserId)
        return NextResponse.json({ error: 'otherUserId es requerido para DM' }, { status: 400 });
      const result = await createDmChannel(session.user, otherUserId);
      return NextResponse.json(result);
    } else {
      if (!name)
        return NextResponse.json({ error: 'name es requerido para grupo' }, { status: 400 });
      if (!memberIds || memberIds.length === 0)
        return NextResponse.json({ error: 'memberIds es requerido' }, { status: 400 });
      const result = await createGroupChannel(session.user, name, memberIds);
      return NextResponse.json(result);
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error desconocido' },
      { status: 400 }
    );
  }
}
