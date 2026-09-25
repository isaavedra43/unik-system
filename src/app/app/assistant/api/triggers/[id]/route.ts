import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { prisma } from '@/lib/prisma';

type Params = { params: Promise<{ id: string }> };

/** PATCH — pausar/reanudar una rutina. DELETE — apagarla. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { enabled?: boolean } | null;
  const t = await prisma.trigger.updateMany({
    where: { id, tenantId: session.user.tenantId ?? 'unik' },
    data: { enabled: Boolean(body?.enabled) },
  }).catch(() => ({ count: 0 }));
  return NextResponse.json({ updated: t.count > 0 });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }
  const { id } = await params;
  const t = await prisma.trigger.deleteMany({
    where: { id, tenantId: session.user.tenantId ?? 'unik' },
  }).catch(() => ({ count: 0 }));
  return NextResponse.json({ deleted: t.count > 0 });
}
