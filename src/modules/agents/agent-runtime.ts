import type { CurrentUser } from '@/modules/auth/authorization';
import { runAssistant } from '@/modules/ai/ai-orchestrator';
import { routeTurn } from '@/modules/ai/decisions/routing-envelope';
import type { EffortLevel } from '@/modules/ai/effort-policy';
import { ensurePrincipal, getAgent, type AgentRecord } from './agent-service';
import { DEFAULT_TENANT_ID } from './tenancy';

/**
 * Agent Runtime V2 — punto único de entrada para ejecutar un turno CON
 * identidad de agente (UNIVERSO, fase B2).
 *
 * Hoy delega al pipeline existente (`runAssistant`): el runtime añade la
 * resolución del agente (persona → system prompt, toolAllowlist → menú,
 * modelDefault → routing) y el linaje del run (parentRunId/taskId/missionId).
 * El comportamiento cuando `agentId` no se pasa — o el agente no existe — es
 * idéntico al asistente actual (principal implícito).
 */

export interface AgentTurnInput {
  conversationId: string;
  message: string;
  actor: CurrentUser;
  agentId?: string | null;
  parentRunId?: string | null;
  taskId?: string | null;
  missionId?: string | null;
  model?: string;
  /** Effort picked in the composer; background work runs at the balanced level. */
  effort?: EffortLevel;
  /** Capability ids the user picked for this message. */
  capabilities?: string[];
  planFirst?: boolean;
  notifyWhenDone?: boolean;
  attachmentIds?: string[];
  context?: { page?: string; voice?: boolean };
}

export interface OrchestratorEventLike {
  type: string;
  data?: unknown;
}

async function resolveAgent(actor: CurrentUser, agentId?: string | null): Promise<AgentRecord | null> {
  const tenantId = actor.tenantId ?? DEFAULT_TENANT_ID;
  if (agentId) {
    const agent = await getAgent(agentId, actor.id);
    // No confiar en ids ajenos: si no es del usuario, cae al principal.
    if (agent && agent.status === 'active') return agent;
  }
  return ensurePrincipal(tenantId, actor.id, actor.name);
}

/** Ejecuta un turno del asistente bajo la identidad del agente indicado. */
export async function* executeAgentTurn(input: AgentTurnInput): AsyncGenerator<OrchestratorEventLike> {
  const agent = await resolveAgent(input.actor, input.agentId);

  // B3 — Routing Envelope: una decisión Jev batch por turno (fallback
  // heurístico incluido en routeTurn; nunca lanza). Se emite al stream y se
  // persiste en el journal del run.
  const route = await routeTurn({
    message: input.message,
    page: input.context?.page,
    planFirst: input.planFirst,
    autoTrigger: input.message.startsWith('⟦auto:'),
    userId: input.actor.id,
    conversationId: input.conversationId,
  });
  yield { type: 'routing', data: route };

  yield* runAssistant({
    conversationId: input.conversationId,
    message: input.message,
    actor: input.actor,
    context: input.context,
    model: input.model,
    effort: input.effort,
    capabilities: input.capabilities,
    planFirst: input.planFirst,
    notifyWhenDone: input.notifyWhenDone,
    attachmentIds: input.attachmentIds,
    parentRunId: input.parentRunId ?? undefined,
    taskId: input.taskId ?? undefined,
    missionId: input.missionId ?? undefined,
    route,
    agent: agent
      ? {
          id: agent.id,
          name: agent.name,
          persona: agent.persona,
          toolAllowlist: agent.toolAllowlist,
          modelDefault: agent.modelDefault,
          color: agent.color,
          icon: agent.icon,
          // Una task delegada corre como worker aunque el assignee sea el
          // principal — modo lean (memoria on_demand, sin superficie de chat).
          mode: input.taskId ? 'worker' : agent.kind === 'principal' ? 'principal' : 'worker',
        }
      : undefined,
  });
}
