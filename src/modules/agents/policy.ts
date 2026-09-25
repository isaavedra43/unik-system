import { prisma } from '@/lib/prisma';

/**
 * ToolGateway para agentes (B10) — la pieza que el registry no conoce:
 * `ctx.agentId` activa la puerta de agente. Matriz autonomía×efecto +
 * AgentGrant ('tool:name' | 'effect:x' | 'cap:*') + presupuesto.
 *
 * Solo puede RESTRINGIR lo que el dueño ya puede: el chequeo de permisos del
 * registry corre siempre antes — esta puerta nunca concede, solo acota.
 */

export type GateDecision = 'allow' | 'deny' | 'require_approval';

const AUTONOMY_MATRIX: Record<string, Set<string>> = {
  // auto: corre lecturas, borradores y tareas internas sin preguntar
  auto: new Set(['read', 'draft', 'internal_task']),
  // notify: igual que auto pero cada efecto avisa (la propuesta fluye igual)
  notify: new Set(['read', 'draft', 'internal_task']),
  // approval (default): solo lecturas corren solas
  approval: new Set(['read']),
};

const grantCache = new Map<string, { grants: Map<string, GateDecision>; at: number }>();
const GRANT_TTL_MS = 60_000;

async function grantsFor(agentId: string): Promise<Map<string, GateDecision>> {
  const hit = grantCache.get(agentId);
  if (hit && Date.now() - hit.at < GRANT_TTL_MS) return hit.grants;
  const rows = await prisma.agentGrant.findMany({ where: { agentId } }).catch(() => [] as never[]);
  const grants = new Map<string, GateDecision>();
  for (const g of rows as Array<{ capability: string; decision: string }>) {
    grants.set(g.capability, g.decision as GateDecision);
  }
  grantCache.set(agentId, { grants, at: Date.now() });
  return grants;
}

export function clearGrantCache(agentId?: string): void {
  if (agentId) grantCache.delete(agentId);
  else grantCache.clear();
}

/**
 * Decide si el agente puede ejecutar la tool ahora.
 * Precedencia: grant explícito de tool > grant de effect > autonomía.
 */
export async function checkAgentGate(
  agentId: string,
  tool: { name: string; effect?: string },
): Promise<{ decision: GateDecision; reason: string }> {
  const grants = await grantsFor(agentId);
  const byTool = grants.get(`tool:${tool.name}`);
  if (byTool) return { decision: byTool, reason: `grant tool:${tool.name}` };

  const effect = tool.effect ?? 'read';
  const byEffect = grants.get(`effect:${effect}`);
  if (byEffect) return { decision: byEffect, reason: `grant effect:${effect}` };

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { autonomy: true, status: true },
  }).catch(() => null);
  if (!agent || agent.status !== 'active') {
    return { decision: 'deny', reason: 'agente inactivo' };
  }
  const auto = AUTONOMY_MATRIX[agent.autonomy] ?? AUTONOMY_MATRIX.approval;
  return auto.has(effect)
    ? { decision: 'allow', reason: `autonomía ${agent.autonomy}` }
    : { decision: 'require_approval', reason: `efecto ${effect} requiere aprobación con autonomía ${agent.autonomy}` };
}

/** Presupuesto del agente (USD por periodo) — null = sin límite. */
export async function agentBudgetExceeded(agentId: string): Promise<boolean> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { budgetUsd: true, budgetPeriod: true },
  }).catch(() => null);
  if (!agent?.budgetUsd) return false;
  const since = new Date();
  if (agent.budgetPeriod === 'day') since.setHours(0, 0, 0, 0);
  else if (agent.budgetPeriod === 'week') since.setDate(since.getDate() - 7);
  else since.setDate(1);
  const agg = await prisma.agentRun.aggregate({
    _sum: { modelCostUsd: true, toolsCostUsd: true, venueCostUsd: true },
    where: { agentId, startedAt: { gte: since } },
  }).catch(() => null);
  const spent =
    Number(agg?._sum.modelCostUsd ?? 0) +
    Number(agg?._sum.toolsCostUsd ?? 0) +
    Number(agg?._sum.venueCostUsd ?? 0);
  return spent > Number(agent.budgetUsd);
}
