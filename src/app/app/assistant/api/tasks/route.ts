import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/tasks — the caller's delegated tasks of the last 48 h
 * (what the team is doing / did), so the workspace has history after a reload.
 * Ownership: the task's parent run belongs to the caller.
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const since = new Date(Date.now() - 48 * 3_600_000);
  try {
    const runs = await prisma.agentRun.findMany({
      where: { userId: session.user.id, startedAt: { gte: since } },
      select: { id: true },
      orderBy: { startedAt: 'desc' },
      take: 500,
    });
    if (runs.length === 0) return NextResponse.json({ tasks: [] });
    const rows = await prisma.agentTask.findMany({
      where: { parentRunId: { in: runs.map((r) => r.id) }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
    const tasks = rows.map((t) => {
      const capsule = (t.capsule ?? {}) as { conversationId?: string | null };
      const result = (t.result ?? {}) as { report?: string };
      const end = t.completedAt ?? null;
      return {
        taskId: t.id,
        status: t.status,
        title: t.objective.slice(0, 120),
        agentId: t.assignedAgentId,
        conversationId: capsule.conversationId ?? null,
        reportPreview:
          typeof result.report === 'string' ? result.report.slice(0, 400) : (t.error ?? null),
        durationMs: end ? end.getTime() - t.createdAt.getTime() : null,
        updatedAt: (end ?? t.createdAt).getTime(),
      };
    });
    return NextResponse.json({ tasks });
  } catch {
    // Agent tables not migrated yet: nothing to show.
    return NextResponse.json({ tasks: [] });
  }
}
