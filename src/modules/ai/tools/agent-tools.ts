import { z } from 'zod';
import { registerTool } from './registry';
import { delegateTask, MAX_FANOUT } from '@/modules/agents/delegation';

/**
 * UNIVERSO — herramientas de agente (B4).
 *
 * `delegateTask` entrega una subtarea a un especialista o subagente
 * transitorio: crea la AgentTask (cápsula ≤ ~6k, nunca el historial entero),
 * encola `agent.task.run` y avisa al front por SSE. La respuesta llega como
 * AgentMessage 'report' al terminar el worker.
 *
 * `listAgents` devuelve el equipo del usuario para que el modelo sepa a quién
 * delegar (nombres + propósitos, sin prompts internos).
 */

registerTool({
  name: 'delegateTask',
  description:
    'Delega una subtarea a un agente especialista o a un subagente transitorio que la ejecuta en segundo plano. ' +
    `Úsala cuando el trabajo sea especializado, largo o paralelizable (máx. ${MAX_FANOUT} en paralelo). ` +
    'Pasa el objetivo concreto y el contexto mínimo necesario en "capsule" — el agente NO ve esta conversación. ' +
    'La tarea corre sola y su reporte te llega como mensaje cuando termine; informa al usuario que quedó delegada.',
  category: 'system',
  enabledByDefault: true,
  effect: 'internal_task',
  parameters: z.object({
    goal: z.string().min(5).max(500).describe('Objetivo concreto y verificable de la subtarea'),
    agentId: z.string().max(80).optional().describe('Id del especialista del equipo (ver listAgents). Omitir = subagente transitorio'),
    capsule: z.string().max(6000).optional().describe('Contexto mínimo que el worker necesita: datos ya obtenidos, restricciones, por qué'),
    outputHint: z.string().max(200).optional().describe('Formato esperado del reporte (ej. "lista de clientes con monto")'),
    timeoutMin: z.number().int().min(1).max(60).optional().describe('Límite de minutos (default 10)'),
    dependsOn: z.array(z.string().max(80)).max(8).optional().describe('Ids de tareas que deben terminar antes de esta'),
    allowedTools: z.array(z.string().max(120)).max(40).optional().describe('Tools extra permitidas — solo acotan al agente'),
  }),
  execute: async (actor, rawArgs, ctx) => {
    const args = rawArgs as {
      goal: string; agentId?: string; capsule?: string; outputHint?: string;
      timeoutMin?: number; dependsOn?: string[]; allowedTools?: string[];
    };
    if (!ctx.runId) {
      return { error: 'Sin run activo — la delegación requiere el runtime de agentes' };
    }
    if (args.dependsOn && args.dependsOn.length > 0) {
      // El DAG es por run raíz: los ids deben pertenecer al mismo árbol.
      const { prisma } = await import('@/lib/prisma');
      const run = await prisma.agentRun.findUnique({
        where: { id: ctx.runId }, select: { rootRunId: true },
      }).catch(() => null);
      const valid = await prisma.agentTask.count({
        where: { id: { in: args.dependsOn }, rootRunId: run?.rootRunId ?? ctx.runId },
      }).catch(() => 0);
      if (valid !== args.dependsOn.length) {
        return { error: 'dependsOn contiene tareas que no pertenecen a este run' };
      }
    }
    const res = await delegateTask({
      actor,
      conversationId: ctx.conversationId ?? '',
      parentRunId: ctx.runId,
      parentAgentId: ctx.agentId,
      spec: {
        goal: args.goal,
        agentId: args.agentId,
        capsule: args.capsule,
        outputHint: args.outputHint,
        timeoutMin: args.timeoutMin,
        dependsOn: args.dependsOn,
        allowedTools: args.allowedTools,
        depth: ctx.taskId ? 1 : 0,
      },
    });
    if ('error' in res) return { error: res.error };
    return {
      taskId: res.taskId,
      status: 'delegada',
      note: 'La tarea corre en segundo plano; su reporte llegará como mensaje del agente.',
    };
  },
});

registerTool({
  name: 'listAgents',
  description:
    'Lista tu equipo de agentes (principal + especialistas) con su propósito — para decidir a quién delegar con delegateTask.',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({}),
  execute: async (actor) => {
    const { listAgents } = await import('@/modules/agents/agent-service');
    const agents = await listAgents(actor.tenantId ?? 'unik', actor.id);
    return {
      agents: agents.map((a) => ({
        id: a.id, name: a.name, kind: a.kind, purpose: a.purpose, status: a.status,
      })),
      note: agents.length <= 1 ? 'Solo está el principal — delega sin agentId para crear un subagente transitorio.' : undefined,
    };
  },
});
