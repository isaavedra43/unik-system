import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { updateAgent, getAgent } from '@/modules/agents/agent-service';
import { clearGrantCache } from '@/modules/agents/policy';

type Params = { params: Promise<{ id: string }> };

/** PATCH /app/assistant/api/agents/:id — renombrar, pausar, reconfigurar. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  const agent = await updateAgent(id, session.user.id, {
    name: typeof body.name === 'string' ? body.name : undefined,
    purpose: typeof body.purpose === 'string' ? body.purpose : undefined,
    persona: typeof body.persona === 'string' ? body.persona : undefined,
    icon: typeof body.icon === 'string' ? body.icon : undefined,
    color: typeof body.color === 'string' ? body.color : undefined,
    status: typeof body.status === 'string' ? (body.status as never) : undefined,
    autonomy: typeof body.autonomy === 'string' ? body.autonomy : undefined,
    venuePolicy: typeof body.venuePolicy === 'string' ? body.venuePolicy : undefined,
    modelDefault: typeof body.modelDefault === 'string' ? body.modelDefault : undefined,
    toolAllowlist: Array.isArray(body.toolAllowlist) ? (body.toolAllowlist as string[]) : undefined,
  });
  if (!agent) return NextResponse.json({ error: 'Agente no encontrado' }, { status: 404 });
  clearGrantCache(id);
  return NextResponse.json({ agent });
}

/** DELETE — archiva (no borra: los runs históricos conservan su agente). */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  const current = await getAgent(id, session.user.id);
  if (!current) return NextResponse.json({ error: 'Agente no encontrado' }, { status: 404 });
  if (current.kind === 'principal') {
    return NextResponse.json({ error: 'El agente principal no se puede archivar' }, { status: 400 });
  }
  const agent = await updateAgent(id, session.user.id, { status: 'archived' as never });
  return NextResponse.json({ agent });
}
