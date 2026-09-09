import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listAlerts, resolveAlert } from '@/modules/chat/chat-admin-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'chat.admin')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const resolved = searchParams.get('resolved');
  const type = searchParams.get('type') ?? undefined;
  const severity = searchParams.get('severity') ?? undefined;
  const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined;

  const alerts = await listAlerts({
    resolved: resolved === null ? undefined : resolved === 'true',
    type,
    severity,
    limit,
  });
  return NextResponse.json({ alerts });
}

const resolveSchema = z.object({
  alertId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'chat.admin')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  }

  try {
    await resolveAlert(session.user, parsed.data.alertId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Error al resolver alerta' },
      { status: 500 }
    );
  }
}
