import { z } from 'zod';
import { registerTool } from '@/modules/ai/tools/registry';
import { recallEpisodes, recallFacts, matchPlaybooks, proposeFact } from './memory-service';

/**
 * Memory tools — the agent can also search and write its own memory
 * deliberately (beyond the automatic recall injected every turn).
 */

registerTool({
  name: 'recallMemory',
  description:
    'Busca en TU memoria del usuario: episodios pasados ("qué investigamos la semana pasada"), hechos confirmados del negocio y patrones de consulta que funcionaron. Úsala cuando el usuario referencia algo anterior ("lo que vimos ayer", "como siempre hacemos") o antes de afirmar preferencias/hechos que quizá ya conoces.',
  category: 'knowledge',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    query: z.string().min(2).max(300).describe('Qué quieres recordar, en palabras naturales.'),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { query: string };
    const [episodes, facts, playbooks] = await Promise.all([
      recallEpisodes(actor.id, args.query, { limit: 6 }),
      recallFacts(actor.id, args.query, { limit: 10 }),
      matchPlaybooks(actor.id, args.query, { limit: 5 }),
    ]);
    return {
      episodes: episodes.map((e) => ({
        summary: e.summary,
        when: e.createdAt.toISOString(),
      })),
      facts,
      playbooks: playbooks.map((p) => ({
        trigger: p.trigger,
        tool: p.toolName,
        args: p.argsTemplate,
        note: p.note,
      })),
      note:
        episodes.length === 0 && facts.length === 0 && playbooks.length === 0
          ? 'No hay memoria sobre eso todavía. No lo afirmes como hecho — consulta datos vivos o pregunta.'
          : 'Memoria recuperada. Recuerda: orienta, pero los datos vivos se consultan con tools.',
    };
  },
});

registerTool({
  name: 'saveFact',
  description:
    'Guarda un hecho durable del negocio o del usuario (ej. "efectivo incluye EFECTIVO EN BODEGA", "Roberto es el contacto de logística"). Queda PENDIENTE hasta que el usuario lo confirme. Para preferencias de formato/estilo usa rememberForUser; para datos de un caso concreto no guardes nada.',
  category: 'knowledge',
  enabledByDefault: true,
  effect: 'internal_task',
  parameters: z.object({
    entity: z.string().min(1).max(120).describe('Sobre qué es el hecho: "efectivo", "Roberto", "corte de caja".'),
    attribute: z.string().min(1).max(80).describe('Propiedad: "incluye", "es", "horario", "prefiere".'),
    value: z.string().min(1).max(300).describe('El hecho: "EFECTIVO + EFECTIVO EN BODEGA", "contacto de logística".'),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { entity: string; attribute: string; value: string };
    const status = await proposeFact(actor.id, {
      entity: args.entity,
      attribute: args.attribute,
      value: args.value,
      source: 'observation',
    });
    return {
      status,
      note:
        status === 'duplicate'
          ? 'Ese hecho ya existe igual — no se duplicó.'
          : 'Hecho propuesto; queda pendiente de confirmación del usuario.',
    };
  },
});
