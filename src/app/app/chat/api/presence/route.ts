import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { heartbeat, setAway, setOffline, getPresence } from '@/modules/chat/chat-presence-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const presenceSchema = z.object({
  status: z.enum(['online', 'away', 'offline']),
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
    // Allow empty body for heartbeat
    await heartbeat(session.user.id);
    return NextResponse.json({ ok: true });
  }

  const parsed = presenceSchema.safeParse(body);
  if (!parsed.success) {
    await heartbeat(session.user.id);
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.status === 'online') await heartbeat(session.user.id);
  else if (parsed.data.status === 'away') await setAway(session.user.id);
  else await setOffline(session.user.id);

  return NextResponse.json({ ok: true });
}

export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const userIdsParam = searchParams.get('userIds');
  if (!userIdsParam) return NextResponse.json({ data: {} });

  const userIds = userIdsParam.split(',').filter(Boolean);
  const presenceMap = await getPresence(userIds);
  const result: Record<string, string> = {};
  for (const [uid, status] of presenceMap) {
    result[uid] = status;
  }
  return NextResponse.json({ data: result });
}
