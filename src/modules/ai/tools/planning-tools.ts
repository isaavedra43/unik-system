import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getAllTools, loadAvailableTools, registerTool } from './registry';
import { findToolsByTopic } from '../tool-selector';

/**
 * Orchestration tools.
 *
 * - loadMoreTools: the model only sees the most relevant ~100 tools per turn
 *   (API limit is 128). With this tool it can pull any other tool by topic; the
 *   orchestrator intercepts the call and adds the matches to the next request.
 *   The execute() below is the fallback used outside the orchestrator (MCP).
 * - proposePlan: plan-then-execute. The model writes the steps, the user sees a
 *   card with "Ejecutar plan" and nothing runs until they confirm.
 */

registerTool({
  name: 'loadMoreTools',
  description:
    'Carga herramientas adicionales por tema cuando no ves la que necesitas (ej. "cotizaciones", "llamadas", "campañas", "skills", "compras", "paquetes"). Devuelve los nombres y descripciones de las tools que quedan disponibles en el siguiente paso. Úsala ANTES de decir que no puedes hacer algo.',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    topic: z.string().min(2).max(200).describe('Tema o acción en español, ej. "cotizar", "llamar por teléfono", "campañas de WhatsApp"'),
  }),
  execute: async (actor, rawArgs, ctx) => {
    const args = rawArgs as { topic: string };
    const enabled = ctx.enabledToolNames ?? getAllTools().map((t) => t.name);
    const all = await loadAvailableTools(actor, enabled, {});
    const matches = findToolsByTopic(all, args.topic, 30);
    return {
      topic: args.topic,
      tools: matches.map((t) => ({ name: t.name, description: t.description.slice(0, 220), effect: t.effect ?? 'read' })),
      note: matches.length === 0 ? 'Ninguna herramienta coincide con ese tema.' : 'Estas herramientas ya están disponibles: llámalas directamente.',
    };
  },
});

const planStepSchema = z.object({
  title: z.string().min(3).max(160).describe('Qué se hará en este paso, en lenguaje del usuario'),
  tool: z.string().max(80).optional().describe('Tool que se usará (si aplica)'),
  detail: z.string().max(400).optional().describe('Filtros, periodo, destinatarios o formato previstos'),
  needsApproval: z.boolean().optional().describe('true si el paso envía, crea, edita o elimina algo (pasará por tarjeta de aprobación)'),
});

registerTool({
  name: 'proposePlan',
  description:
    'Propone un plan de pasos ANTES de ejecutar una tarea compleja (3+ pasos, varias fuentes, envíos o cambios). El usuario ve el plan con un botón "Ejecutar plan". Después de llamarla DETENTE y no ejecutes nada hasta que el usuario confirme. Si el usuario pide ajustes, vuelve a proponer el plan corregido.',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    goal: z.string().min(3).max(300).describe('Objetivo en una frase'),
    steps: z.array(planStepSchema).min(1).max(12),
    assumptions: z.array(z.string().max(200)).max(8).optional().describe('Supuestos que el usuario debería confirmar'),
    deliverable: z.string().max(200).optional().describe('Qué recibirá el usuario al final (reporte, mensajes enviados, cotización…)'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as z.infer<typeof planStepSchema> extends never ? never : { goal: string; steps: Array<z.infer<typeof planStepSchema>>; assumptions?: string[]; deliverable?: string };
    return {
      planId: randomUUID(),
      goal: args.goal,
      steps: args.steps.map((s, i) => ({ n: i + 1, ...s })),
      assumptions: args.assumptions ?? [],
      deliverable: args.deliverable ?? null,
      awaitingConfirmation: true,
      instruction:
        'Plan registrado. Resume el plan al usuario en 2-3 líneas y DETENTE: no ejecutes ningún paso hasta que el usuario confirme (verá el botón "Ejecutar plan"). Cuando confirme, ejecuta los pasos en orden e informa el avance.',
    };
  },
});
