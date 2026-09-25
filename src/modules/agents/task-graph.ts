import { prisma } from '@/lib/prisma';
import { MAX_FANOUT } from './delegation';

/**
 * TaskGraph (B5) — el DAG de un run: tasks con dependsOn, fan-out acotado,
 * cancelación en cascada (en delegation.ts) y estado agregado para el
 * OpsPanel/MissionCard del front.
 */

export interface TaskNode {
  id: string;
  parentRunId: string;
  assignedAgentId: string | null;
  objective: string;
  status: string;
  dependsOn: string[];
  startedAt?: string;
  completedAt?: string;
  error?: string | null;
}

export interface RunGraph {
  rootRunId: string;
  tasks: TaskNode[];
  counts: Record<string, number>;
  /** true si aún hay trabajo vivo en el grafo */
  active: boolean;
}

/** Estado del DAG de un run raíz (incluye tasks de sub-runs delegados). */
export async function runGraph(rootRunId: string): Promise<RunGraph> {
  const rows = await prisma.agentTask.findMany({
    where: { rootRunId },
    orderBy: { createdAt: 'asc' },
  }).catch(() => [] as never[]);
  const tasks: TaskNode[] = (rows as Array<{
    id: string; parentRunId: string; assignedAgentId: string | null;
    objective: string; status: string; dependsOn: string[];
    createdAt: Date; completedAt: Date | null; error: string | null;
  }>).map((t) => ({
    id: t.id,
    parentRunId: t.parentRunId,
    assignedAgentId: t.assignedAgentId,
    objective: t.objective,
    status: t.status,
    dependsOn: t.dependsOn,
    completedAt: t.completedAt?.toISOString(),
    error: t.error,
  }));
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return {
    rootRunId,
    tasks,
    counts,
    active: tasks.some((t) => ['pending', 'ready', 'running'].includes(t.status)),
  };
}

/** Candado de fan-out: cuántas tareas vivas tiene el run. */
export async function fanoutAvailable(rootRunId: string): Promise<{ ok: boolean; active: number; max: number }> {
  const active = await prisma.agentTask.count({
    where: { rootRunId, status: { in: ['pending', 'ready', 'running'] } },
  }).catch(() => 0);
  return { ok: active < MAX_FANOUT, active, max: MAX_FANOUT };
}

/** Profundidad real de delegación del run (cuántos niveles de runs hijos). */
export async function delegationDepth(runId: string): Promise<number> {
  let depth = 0;
  let cur: string | null = runId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur) && depth < 8) {
    seen.add(cur);
    const run: { parentRunId: string | null } | null = await prisma.agentRun.findUnique({
      where: { id: cur },
      select: { parentRunId: true },
    }).catch(() => null);
    cur = run?.parentRunId ?? null;
    if (cur) depth += 1;
  }
  return depth;
}
