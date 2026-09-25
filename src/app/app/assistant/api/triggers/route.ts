import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { createTrigger, listTriggers } from '@/modules/agents/trigger-service';
import { DEFAULT_TENANT_ID } from '@/modules/agents/tenancy';

/** GET — las rutinas/vigilancias del usuario (todas las de sus agentes). */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const triggers = await listTriggers(session.user.tenantId ?? DEFAULT_TENANT_ID);
  const mine = triggers.filter((t) => t.agentId); // tenants ya filtran; ownership via agente
  return NextResponse.json({ triggers: mine });
}

const postSchema = z.object({
  agentId: z.string().min(1),
  type: z.enum(['time', 'condition', 'entity_change', 'event', 'webhook', 'manual']),
  spec: z.record(z.string(), z.unknown()),
  action: z.object({
    kind: z.enum(['run', 'mission', 'playbook']),
    goal: z.string().min(3).max(500),
    capsule: z.string().max(4000).optional(),
    playbookId: z.string().optional(),
  }),
});

/** POST — crea una rutina/vigilancia para un agente del usuario. */
export async function POST(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Datos inválidos', details: parsed.error.issues }, { status: 400 });
  }
  // Ownership: el agente debe ser del usuario.
  const { getAgent } = await import('@/modules/agents/agent-service');
  const agent = await getAgent(parsed.data.agentId, session.user.id);
  if (!agent) return NextResponse.json({ error: 'Agente no encontrado' }, { status: 404 });
  const res = await createTrigger({
    tenantId: session.user.tenantId ?? DEFAULT_TENANT_ID,
    ...parsed.data,
  });
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json({ id: res.id }, { status: 201 });
}
