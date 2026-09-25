import { prisma } from '@/lib/prisma';
import { publishRealtime } from '@/modules/realtime/realtime-service';
import { enqueueJob, registerJobHandler, cancelJobsByGroup } from '@/modules/jobs/job-queue';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { Prisma } from '@prisma/client';
import { DEFAULT_TENANT_ID } from './tenancy';

/**
 * Delegación UNIVERSO (B4-B5) — el contrato formal entre el agente principal y
 * los especialistas/subagentes. Nunca "volver a preguntarle al LLM": una
 * AgentTask durable + una AgentMessage + un job `agent.task.run` que ejecuta el
 * turno del worker en sesión fresca y reporta al padre.
 *
 * Reglas:
 * - La cápsula viaja con la tarea (≤ ~6k tokens) — NUNCA el historial entero.
 * - Permisos solo se ATENÚAN: el worker corre con el actor del dueño, pero su
 *   toolAllowlist = allowlist(agente) ∩ allowedTools(cápsula) ∩ enabled(admin).
 * - Fan-out y profundidad acotados (MAX_FANOUT / MAX_DEPTH).
 * - Todo emite a `user:{ownerId}` (SSE del front) y al journal del run.
 */

export const MAX_FANOUT = 4;
export const MAX_DEPTH = 2;
const WORKER_TIMEOUT_MS = 4 * 60 * 1000;
const CAPSULE_MAX_CHARS = 8000;

/** Contenido de la cápsula (Json) — autocontenida para el worker. */
export interface TaskCapsule {
  objective: string;
  why?: string;
  constraints?: string[];
  knownFacts?: string[];
  expectedOutput?: string;
  conversationId?: string;
  ownerUserId?: string;
  depth?: number;
  timeoutMin?: number;
  modelOverride?: string;
}

export interface DelegateInput {
  actor: CurrentUser;
  conversationId: string;
  parentRunId: string;
  parentAgentId?: string | null;
  missionId?: string | null;
  spec: {
    goal: string;
    /** Especialista persistente a reusar; omitir = subagente transitorio. */
    agentId?: string | null;
    capsule?: string | null;
    allowedTools?: string[];
    forbiddenTools?: string[];
    timeoutMin?: number;
    modelOverride?: string;
    dependsOn?: string[];
    outputHint?: string | null;
    depth?: number;
  };
}

async function emitAgentEvent(userId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await publishRealtime(`user:${userId}`, type, payload);
  } catch {
    /* feed best-effort */
  }
}

async function ownerOfRun(runId: string): Promise<string | null> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { userId: true } }).catch(() => null);
  return run?.userId ?? null;
}

/** Crea la tarea + mensaje de delegación + encola el worker. */
export async function delegateTask(input: DelegateInput): Promise<{ taskId: string } | { error: string }> {
  const depth = input.spec.depth ?? 0;
  if (depth > MAX_DEPTH) return { error: `Profundidad máxima de delegación (${MAX_DEPTH}) alcanzada` };

  const tenantId = input.actor.tenantId ?? DEFAULT_TENANT_ID;
  const goal = input.spec.goal.trim().slice(0, 500);
  if (!goal) return { error: 'La tarea necesita un objetivo' };

  const parentRun = await prisma.agentRun.findUnique({
    where: { id: input.parentRunId },
    select: { id: true, rootRunId: true },
  }).catch(() => null);
  const rootRunId = parentRun?.rootRunId ?? input.parentRunId;

  // B5: fan-out acotado — un run no puede tener más de MAX_FANOUT hijas vivas.
  const { fanoutAvailable } = await import('./task-graph');
  const fanout = await fanoutAvailable(rootRunId);
  if (!fanout.ok) {
    return { error: `Fan-out máximo alcanzado (${fanout.active}/${fanout.max} tareas activas)` };
  }

  const capsule: TaskCapsule = {
    objective: goal,
    expectedOutput: input.spec.outputHint ?? undefined,
    conversationId: input.conversationId,
    ownerUserId: input.actor.id,
    depth,
    timeoutMin: input.spec.timeoutMin,
    modelOverride: input.spec.modelOverride,
  };
  if (input.spec.capsule) {
    capsule.why = input.spec.capsule.slice(0, CAPSULE_MAX_CHARS);
  }

  try {
    const task = await prisma.agentTask.create({
      data: {
        tenantId,
        rootRunId,
        parentRunId: input.parentRunId,
        assignedAgentId: input.spec.agentId ?? null,
        objective: goal,
        capsule: capsule as unknown as Prisma.InputJsonValue,
        expectedOutput: input.spec.outputHint
          ? ({ format: input.spec.outputHint } as Prisma.InputJsonValue)
          : undefined,
        allowedTools: input.spec.allowedTools ?? [],
        forbiddenTools: input.spec.forbiddenTools ?? [],
        dependsOn: input.spec.dependsOn ?? [],
        status: (input.spec.dependsOn?.length ?? 0) > 0 ? 'pending' : 'ready',
        deadlineAt: input.spec.timeoutMin
          ? new Date(Date.now() + input.spec.timeoutMin * 60_000)
          : undefined,
      },
    });

    await prisma.agentMessage.create({
      data: {
        tenantId,
        kind: 'request',
        fromAgentId: input.parentAgentId ?? 'principal',
        toAgentId: input.spec.agentId ?? null,
        conversationId: input.conversationId,
        summary: `Delega: ${goal.slice(0, 140)}`,
        payload: {
          taskId: task.id,
          capsule: { objective: goal, why: input.spec.capsule?.slice(0, 2000) ?? null },
        } as Prisma.InputJsonValue,
      },
    }).catch(() => null);

    await enqueueJob({
      type: 'agent.task.run',
      payload: { taskId: task.id, userId: input.actor.id },
      dedupeKey: `agent-task:${task.id}`,
      groupKey: `run:${rootRunId}`,
    }).catch(() => null);

    await emitAgentEvent(input.actor.id, 'agent.task', {
      taskId: task.id,
      status: task.status,
      title: goal.slice(0, 120),
      agentId: input.spec.agentId ?? null,
      parentRunId: input.parentRunId,
      conversationId: input.conversationId,
    });
    return { taskId: task.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'No se pudo delegar' };
  }
}

/** Prompt del worker: cápsula autocontenida, sin historial del padre. */
function buildWorkerPrompt(task: { objective: string; capsule: unknown; expectedOutput: unknown }): string {
  const cap = (task.capsule ?? {}) as unknown as TaskCapsule;
  const parts = [`⟦worker⟧ Tarea delegada: ${task.objective}`];
  if (cap.why) parts.push(`\nContexto del agente principal:\n${cap.why}`);
  if (cap.constraints?.length) parts.push(`\nRestricciones:\n- ${cap.constraints.join('\n- ')}`);
  if (cap.knownFacts?.length) parts.push(`\nDatos ya verificados:\n- ${cap.knownFacts.join('\n- ')}`);
  const out = cap.expectedOutput ?? (task.expectedOutput as { format?: string } | null)?.format;
  if (out) parts.push(`\nFormato de entrega esperado: ${out}`);
  parts.push(
    '\nReglas: trabaja solo sobre esta tarea; usa las herramientas disponibles; ' +
    'al terminar, entrega un reporte breve y verificable (qué hiciste, qué encontraste, fuentes/datos usados). ' +
    'No inventes datos ni afirmes haber usado herramientas que no usaste.'
  );
  return parts.join('\n');
}

/**
 * Worker `agent.task.run` — ejecuta UNA AgentTask en sesión fresca.
 * Idempotente: solo corre si status='ready'; las dependencias (B5) se
 * re-encolan si aún no terminan.
 */
async function runAgentTask(taskId: string): Promise<{ status: string }> {
  const task = await prisma.agentTask.findUnique({ where: { id: taskId } }).catch(() => null);
  if (!task) return { status: 'missing' };
  if (!['ready', 'pending'].includes(task.status)) return { status: task.status };

  // B5: dependencias — pendientes → re-encolar; fallidas → cancelar.
  if (task.dependsOn.length > 0) {
    const pending = await prisma.agentTask.count({
      where: { id: { in: task.dependsOn }, status: { in: ['pending', 'ready', 'running'] } },
    }).catch(() => 0);
    if (pending > 0) {
      await enqueueJob({
        type: 'agent.task.run',
        payload: { taskId },
        dedupeKey: `agent-task-wait:${taskId}:${Date.now()}`,
        runAt: new Date(Date.now() + 15_000),
      });
      return { status: 'waiting-deps' };
    }
    const failed = await prisma.agentTask.count({
      where: { id: { in: task.dependsOn }, status: { in: ['failed', 'cancelled'] } },
    }).catch(() => 0);
    if (failed > 0) {
      await prisma.agentTask.update({
        where: { id: taskId },
        data: { status: 'cancelled', completedAt: new Date(), error: 'Dependencia falló' },
      }).catch(() => null);
      return { status: 'cancelled' };
    }
  }

  const capsule = (task.capsule ?? {}) as unknown as TaskCapsule;
  const ownerUserId = capsule.ownerUserId ?? (await ownerOfRun(task.parentRunId));
  if (!ownerUserId) {
    await prisma.agentTask.update({
      where: { id: taskId },
      data: { status: 'failed', error: 'owner missing', completedAt: new Date() },
    }).catch(() => null);
    return { status: 'failed' };
  }

  await prisma.agentTask.update({
    where: { id: taskId },
    data: { status: 'running' },
  });
  await emitAgentEvent(ownerUserId, 'agent.task', {
    taskId, status: 'running', title: task.objective.slice(0, 120),
    conversationId: capsule.conversationId ?? null,
  });

  const { loadUserActor } = await import('@/modules/auth/user-actor');
  const currentUser = await loadUserActor({ id: ownerUserId }).catch(() => null);
  if (!currentUser) {
    await prisma.agentTask.update({
      where: { id: taskId },
      data: { status: 'failed', error: 'actor build failed', completedAt: new Date() },
    }).catch(() => null);
    return { status: 'failed' };
  }

  // Sesión fresca: conversación propia del worker (no hereda el hilo del padre).
  const convo = await prisma.aiConversation.create({
    data: {
      userId: ownerUserId,
      agentId: task.assignedAgentId,
      title: `⚙ ${task.objective}`.slice(0, 120),
    },
  }).catch(() => null);

  const startedAt = Date.now();
  let report = '';
  let failed: string | null = null;
  const toolCalls: string[] = [];
  try {
    const { executeAgentTurn } = await import('./agent-runtime');
    const deadlineMs = Math.min(capsule.timeoutMin ?? 10, 60) * 60_000;
    const timer = setTimeout(() => { failed = 'timeout'; }, Math.max(30_000, Math.min(deadlineMs, WORKER_TIMEOUT_MS)));
    try {
      for await (const ev of executeAgentTurn({
        conversationId: convo?.id ?? capsule.conversationId ?? taskId,
        message: buildWorkerPrompt(task),
        actor: currentUser,
        agentId: task.assignedAgentId,
        parentRunId: task.parentRunId,
        taskId: task.id,
        missionId: null,
        model: capsule.modelOverride,
      })) {
        if (ev.type === 'done' || ev.type === 'message_done') {
          const d = ev.data as { content?: string } | undefined;
          if (d?.content) report = d.content;
        } else if (ev.type === 'tool_call' || ev.type === 'tool') {
          const d = ev.data as { name?: string } | undefined;
          if (d?.name) toolCalls.push(d.name);
        } else if (ev.type === 'error') {
          const d = ev.data as { message?: string } | undefined;
          failed = d?.message ?? 'error';
        }
        if (failed) break;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    failed = err instanceof Error ? err.message : 'error';
  }

  const ok = !failed && report.trim().length > 0;
  const status = ok ? 'done' : 'failed';
  await prisma.agentTask.update({
    where: { id: taskId },
    data: {
      status,
      completedAt: new Date(),
      result: ({ report: report.slice(0, 12_000), error: failed } as Prisma.InputJsonValue),
      evidence: ({ toolCalls: toolCalls.slice(0, 50), conversationId: convo?.id ?? null } as Prisma.InputJsonValue),
      error: failed,
    },
  }).catch(() => null);

  // Reporte al padre + SSE para la tarjeta del chat.
  await prisma.agentMessage.create({
    data: {
      tenantId: task.tenantId,
      kind: 'report',
      fromAgentId: task.assignedAgentId ?? 'worker',
      conversationId: capsule.conversationId ?? null,
      summary: `${status === 'done' ? 'Completó' : 'Falló'}: ${task.objective.slice(0, 120)}`,
      payload: {
        taskId, status,
        report: report.slice(0, 4000),
        error: failed,
        parentRunId: task.parentRunId,
      } as Prisma.InputJsonValue,
    },
  }).catch(() => null);

  // El reporte también queda en la conversación del padre como AiMessage con
  // meta.agentMessages — el front lo pliega en "Mensajes de X" (AgentMessageCard).
  if (capsule.conversationId) {
    const fromAgent = task.assignedAgentId
      ? await prisma.agent.findUnique({ where: { id: task.assignedAgentId }, select: { name: true } }).catch(() => null)
      : null;
    const agentName = fromAgent?.name ?? 'Subagente';
    await prisma.aiMessage.create({
      data: {
        conversationId: capsule.conversationId,
        role: 'assistant',
        content: null,
        meta: {
          agentMessages: {
            agents: [agentName],
            summary: `${status === 'done' ? 'Completó' : 'Falló'} «${task.objective.slice(0, 100)}»${report ? ` — ${report.slice(0, 160)}` : ''}`,
          },
        } as Prisma.InputJsonValue,
      },
    }).catch(() => null);
    await publishRealtime(`assistant:${capsule.conversationId}`, 'agent.message', {
      agents: [agentName],
      taskId,
      status,
      summary: task.objective.slice(0, 120),
    }).catch(() => null);
  }

  await emitAgentEvent(ownerUserId, 'agent.task', {
    taskId, status, title: task.objective.slice(0, 120),
    agentId: task.assignedAgentId,
    conversationId: capsule.conversationId ?? null,
    reportPreview: report.slice(0, 400), durationMs: Date.now() - startedAt,
  });
  return { status };
}

/** Cancela una tarea y (cascada B5) sus hijas pendientes. */
export async function cancelTask(taskId: string, userId: string): Promise<boolean> {
  const task = await prisma.agentTask.findUnique({ where: { id: taskId } }).catch(() => null);
  if (!task) return false;
  const owner = ((task.capsule ?? {}) as unknown as TaskCapsule).ownerUserId ?? (await ownerOfRun(task.parentRunId));
  if (owner !== userId) return false;

  const res = await prisma.agentTask.updateMany({
    where: { id: taskId, status: { in: ['pending', 'ready', 'running'] } },
    data: { status: 'cancelled', completedAt: new Date(), error: 'cancelada por el usuario' },
  }).catch(() => ({ count: 0 }));
  if (res.count > 0) {
    // Cascada: hijas (tasks delegadas por el run de esta task) se cancelan.
    const childRuns = await prisma.agentRun.findMany({
      where: { taskId }, select: { id: true },
    }).catch(() => [] as { id: string }[]);
    if (childRuns.length > 0) {
      await prisma.agentTask.updateMany({
        where: { parentRunId: { in: childRuns.map((r) => r.id) }, status: { in: ['pending', 'ready', 'running'] } },
        data: { status: 'cancelled', completedAt: new Date(), error: 'padre cancelada' },
      }).catch(() => null);
    }
    await cancelJobsByGroup(`run:${task.rootRunId}`).catch(() => 0);
    await emitAgentEvent(userId, 'agent.task', { taskId, status: 'cancelled' });
  }
  return res.count > 0;
}

registerJobHandler('agent.task.run', async (ctx) => {
  const { taskId } = ctx.payload as { taskId: string };
  return runAgentTask(taskId);
}, { timeoutMs: WORKER_TIMEOUT_MS });
