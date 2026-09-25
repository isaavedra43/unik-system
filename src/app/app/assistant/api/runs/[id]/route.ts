import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { prisma } from '@/lib/prisma';
import { runGraph } from '@/modules/agents/task-graph';

type Params = { params: Promise<{ id: string }> };

/** GET /app/assistant/api/runs/:id — run + su DAG de tasks (MissionCard/OpsPanel). */
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }
  const { id } = await params;
  const run = await prisma.agentRun.findFirst({
    where: { id, userId: session.user.id },
  }).catch(() => null);
  if (!run) return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  const graph = await runGraph(run.rootRunId);
  const events = await prisma.agentEvent.findMany({
    where: { runId: id },
    orderBy: { createdAt: 'asc' },
    take: 200,
  }).catch(() => []);
  return NextResponse.json({ run, graph, events });
}
