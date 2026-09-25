import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { ensurePrincipal, listAgents, createAgent } from '@/modules/agents/agent-service';
import { DEFAULT_TENANT_ID } from '@/modules/agents/tenancy';

/**
 * GET /app/assistant/api/agents — el equipo del usuario: principal (fijado
 * arriba) + especialistas activos. Garantiza que el principal exista.
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }
  const tenantId = session.user.tenantId ?? DEFAULT_TENANT_ID;
  const principal = await ensurePrincipal(tenantId, session.user.id, session.user.name);
  const agents = await listAgents(tenantId, session.user.id);
  const ordered =
    principal && !agents.some((a) => a.id === principal.id) ? [principal, ...agents] : agents;
  return NextResponse.json({ agents: ordered });
}

/** POST — crear un especialista. Sus permisos nunca superan los del dueño. */
export async function POST(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as {
    name?: string;
    purpose?: string;
    persona?: string;
    icon?: string;
    color?: string;
    autonomy?: string;
    venuePolicy?: string;
    toolAllowlist?: string[];
  } | null;
  if (!body?.name?.trim()) {
    return NextResponse.json({ error: 'El nombre es obligatorio' }, { status: 400 });
  }
  const agent = await createAgent(session.user.tenantId ?? DEFAULT_TENANT_ID, session.user.id, {
    ...body,
    name: body.name,
  });
  if (!agent) {
    return NextResponse.json(
      { error: 'Los agentes aún no están disponibles en esta instalación' },
      { status: 503 }
    );
  }
  return NextResponse.json({ agent }, { status: 201 });
}
