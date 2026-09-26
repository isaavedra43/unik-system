import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { prisma } from '@/lib/prisma';
import { DEFAULT_TENANT_ID } from '@/modules/agents/tenancy';

/**
 * GET /app/assistant/api/usage — costo del mes actual para el OpsPanel.
 * Todo viene de datos medidos: AgentRun (modelo/tools/venue USD) + VenueSession
 * (minutos facturados) + eventos 'route' (llamadas Jev). Sin cifras inventadas:
 * si nada se midió, todo es 0.
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const tenantId = session.user.tenantId ?? DEFAULT_TENANT_ID;

  const [runAgg, venueAgg, runIds] = await Promise.all([
    prisma.agentRun
      .aggregate({
        _sum: { modelCostUsd: true, toolsCostUsd: true, venueCostUsd: true },
        _count: { id: true },
        where: { userId: session.user.id, tenantId, startedAt: { gte: monthStart } },
      })
      .catch(() => null),
    prisma.venueSession
      .aggregate({
        _sum: { billedMinutes: true },
        where: { userId: session.user.id, createdAt: { gte: monthStart } },
      })
      .catch(() => null),
    prisma.agentRun
      .findMany({
        where: { userId: session.user.id, tenantId, startedAt: { gte: monthStart } },
        select: { id: true },
        take: 2000,
      })
      .catch(() => [] as { id: string }[]),
  ]);
  const jevCount = runIds.length
    ? await prisma.agentEvent
        .count({
          where: { type: 'route', runId: { in: runIds.map((r) => r.id) } },
        })
        .catch(() => 0)
    : 0;

  const llm = Number(runAgg?._sum?.modelCostUsd ?? 0) + Number(runAgg?._sum?.toolsCostUsd ?? 0);
  const venueUsd = Number(runAgg?._sum?.venueCostUsd ?? 0);
  const venueMinutes = Number(venueAgg?._sum?.billedMinutes ?? 0);
  return NextResponse.json({
    llm,
    // USD only — minutes travel separately. Mixing them here made the panel
    // print "58 minutes" as "$58.000".
    venue: venueUsd,
    venueMinutes,
    jev: jevCount,
    runs: runAgg?._count.id ?? 0,
    spent: llm + venueUsd,
    label: 'este mes',
  });
}
