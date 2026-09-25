import { z } from 'zod';
import { registerTool } from '@/modules/ai/tools/registry';
import { proposeMission, listMissions, getMissionWithEvents, setMissionStatus } from './mission-service';

/**
 * Mission tools — the agent proposes persistent objectives; the user approves
 * them; the mission engine runs them step by step (each step = a full assistant
 * turn with tools, memory and verification).
 */

registerTool({
  name: 'proposeMission',
  description:
    'Propone una MISIÓN persistente: un objetivo que el agente ejecuta paso a paso hasta completarlo (o en horario, si es rutina). Úsala cuando el usuario delega trabajo que dura más que este turno: "investiga X y avísame", "vigila la plataforma cada hora", "todos los días mándame el corte". Para respuestas de un turno usa las tools normales. La misión NO corre hasta que el usuario la aprueba.',
  category: 'system',
  enabledByDefault: true,
  effect: 'internal_task',
  parameters: z.object({
    goal: z.string().min(5).max(500).describe('Objetivo claro en una frase: "Revisar cada mañana las unidades GPS y avisar si alguna sale de geocerca".'),
    steps: z
      .array(z.string().min(3).max(200))
      .max(24)
      .optional()
      .describe('Pasos concretos en orden. Para rutinas simples omítelo: la meta se ejecuta entera cada corrida.'),
    schedule: z
      .string()
      .max(40)
      .optional()
      .describe('Recurrencia: "daily:HH:mm" (hora CDMX, ej. "daily:20:00" = corte a las 8pm) o "every:N" (minutos, ej. "every:60"). Omite para misión de una sola vez.'),
    budgetUsd: z.number().min(0.01).max(100).optional().describe('Tope de gasto estimado de la misión en USD.'),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { goal: string; steps?: string[]; schedule?: string; budgetUsd?: number };
    const mission = await proposeMission(actor, {
      goal: args.goal,
      steps: args.steps,
      schedule: args.schedule ?? null,
      budgetUsd: args.budgetUsd ?? null,
    });
    return {
      missionId: mission.id,
      status: mission.status,
      note: 'Misión propuesta. Dile al usuario que la apruebe desde la tarjeta de misión; entonces empieza a correr paso a paso y le avisa al terminar.',
    };
  },
});

registerTool({
  name: 'listMissions',
  description: 'Lista las misiones del usuario (activas, en espera de aprobación, bloqueadas, completadas) con su progreso por pasos.',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    status: z.enum(['awaiting_approval', 'active', 'blocked', 'done', 'failed']).optional(),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { status?: string };
    const missions = await listMissions(actor.id, { status: args.status });
    return {
      total: missions.length,
      missions: missions.map((m) => ({
        id: m.id,
        goal: m.goal,
        status: m.status,
        schedule: m.schedule,
        nextRunAt: m.nextRunAt,
        steps: m.plan?.steps.map((s) => ({ title: s.title, status: s.status, result: s.result })) ?? [],
        createdAt: m.createdAt,
        completedAt: m.completedAt,
      })),
    };
  },
});

registerTool({
  name: 'missionStatus',
  description: 'Estado detallado de una misión: pasos, resultados y el journal de actividad completo (qué hizo el agente, en qué orden).',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    missionId: z.string().min(1),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { missionId: string };
    const data = await getMissionWithEvents(actor.id, args.missionId);
    if (!data) return { error: 'Misión no encontrada.' };
    return {
      mission: {
        id: data.mission.id,
        goal: data.mission.goal,
        status: data.mission.status,
        schedule: data.mission.schedule,
        nextRunAt: data.mission.nextRunAt,
        steps: data.mission.plan?.steps ?? [],
      },
      events: data.events.map((e) => ({ type: e.type, payload: e.payload, at: e.createdAt })),
    };
  },
});

registerTool({
  name: 'controlMission',
  description: 'Pausa (blocked), reanuda (active) o cancela (cancelled) una misión del usuario — solo cuando el usuario lo pide.',
  category: 'system',
  enabledByDefault: true,
  effect: 'internal_task',
  parameters: z.object({
    missionId: z.string().min(1),
    action: z.enum(['pause', 'resume', 'cancel']),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { missionId: string; action: 'pause' | 'resume' | 'cancel' };
    const status = args.action === 'cancel' ? 'cancelled' : args.action === 'pause' ? 'blocked' : 'active';
    const ok = await setMissionStatus(actor.id, args.missionId, status);
    return {
      ok,
      status,
      note: ok ? `Misión → ${status}.` : 'No se pudo cambiar (¿ya terminó o no existe?).',
    };
  },
});
