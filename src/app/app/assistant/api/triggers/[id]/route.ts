import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { prisma } from '@/lib/prisma';

type Params = { params: Promise<{ id: string }> };

/** The trigger only if it belongs to one of the caller's agents (shared tenant). */
async function ownedTrigger(id: string, userId: string, tenantId: string) {
  const t = await prisma.trigger.findFirst({ where: { id, tenantId }, select: { id: true, agentId: true } }).catch(() => null);
  if (!t) return null;
  const agent = await prisma.agent
    .findFirst({ where: { id: t.agentId, ownerUserId: userId }, select: { id: true } })
    .catch(() => null);
  return agent ? t : null;
}

/** PATCH — pausar/reanudar una rutina. DELETE — apagarla. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }
  const { id } = await params;
  const tenantId = session.user.tenantId ?? 'unik';
  if (!(await ownedTrigger(id, session.user.id, tenantId))) {
    return NextResponse.json({ error: 'Rutina no encontrada' }, { status: 404 });
  }
  const body = (await req.json().catch(() => null)) as { enabled?: boolean } | null;
  const t = await prisma.trigger.updateMany({
    where: { id, tenantId },
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
  const tenantId = session.user.tenantId ?? 'unik';
  if (!(await ownedTrigger(id, session.user.id, tenantId))) {
    return NextResponse.json({ error: 'Rutina no encontrada' }, { status: 404 });
  }
  const t = await prisma.trigger.deleteMany({
    where: { id, tenantId },
  }).catch(() => ({ count: 0 }));
  return NextResponse.json({ deleted: t.count > 0 });
}
