import { z } from 'zod';
import { registerTool } from '@/modules/ai/tools/registry';
import { savePlaybook, listPlaybooks, runPlaybook, sanitizeSteps, playbookEffect } from './venue-playbooks';

/**
 * Playbook tools — reusable automations on the virtual computer. A playbook is
 * approved once by the user; each run still classifies its effect (steps with
 * submits/credentials ask for approval again).
 */

registerTool({
  name: 'saveVenuePlaybook',
  description:
    'Guarda un flujo de la computadora virtual como playbook reutilizable (ej. "revisión diaria GPS": login → unidades → extraer tabla → comparar). Úsalo después de completar con éxito una secuencia de acciones del browser/exec que vale la pena repetir. Queda PENDIENTE hasta que el usuario lo apruebe.',
  category: 'venue',
  enabledByDefault: true,
  requiredPermission: 'venue.exec',
  effect: 'internal_task',
  parameters: z.object({
    name: z.string().min(3).max(120).describe('Nombre corto: "Revisión diaria GPS".'),
    steps: z
      .array(
        z.object({
          action: z.string().describe('Acción del browser (open/click/type/extract/screenshot/waitFor…) o "exec" para comando en el sandbox.'),
          url: z.string().optional(),
          selector: z.string().optional(),
          text: z.string().optional(),
          command: z.string().optional().describe('Comando shell (solo con action="exec").'),
          key: z.string().optional(),
          extractMode: z.string().optional(),
          expect: z.string().optional().describe('Texto que debe aparecer en el resultado para considerar el paso exitoso.'),
          note: z.string().optional(),
        })
      )
      .min(1)
      .max(40),
    params: z.record(z.string(), z.string()).optional().describe('Nombres de parámetros usados como {{nombre}} en los pasos.'),
    requiresHost: z.string().optional().describe('Host que necesita perfil guardado (ej. "fleet.unik-gps.mx").'),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { name: string; steps: unknown[]; params?: Record<string, string>; requiresHost?: string };
    const steps = sanitizeSteps(args.steps);
    if (steps.length === 0) return { error: 'El playbook no tiene pasos válidos.' };
    const row = await savePlaybook(actor, { name: args.name, steps, params: args.params, requiresHost: args.requiresHost });
    return {
      playbookId: row.id,
      status: row.status,
      stepCount: steps.length,
      note: 'Playbook propuesto. El usuario lo aprueba una vez; después corre con runVenuePlaybook o desde una rutina.',
    };
  },
});

registerTool({
  name: 'listVenuePlaybooks',
  description: 'Lista los playbooks de automatización de la computadora virtual (pendientes/aprobados) con su estado y última corrida.',
  category: 'venue',
  enabledByDefault: true,
  requiredPermission: 'venue.exec',
  effect: 'read',
  parameters: z.object({}),
  execute: async (actor) => {
    const rows = await listPlaybooks(actor.id);
    return {
      total: rows.length,
      playbooks: rows.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        requiresHost: p.requiresHost,
        runCount: p.runCount,
        lastRunAt: p.lastRunAt,
        stepCount: Array.isArray(p.steps) ? p.steps.length : 0,
        params: p.params,
      })),
    };
  },
});

registerTool({
  name: 'runVenuePlaybook',
  description:
    'Ejecuta un playbook aprobado en la computadora virtual: corre sus pasos en orden (navegar, extraer, comandos) y devuelve el reporte de cada paso. Los playbooks con envíos/credenciales/comandos piden aprobación por corrida.',
  category: 'venue',
  enabledByDefault: true,
  requiredPermission: 'venue.exec',
  effect: 'internal_task',
  resolveEffect: async (_actor, args) => {
    const a = args as { playbookId?: string };
    if (!a.playbookId) return 'internal_task';
    const { prisma } = await import('@/lib/prisma');
    const row = await prisma.venuePlaybook.findUnique({ where: { id: a.playbookId }, select: { steps: true } });
    return row ? playbookEffect(sanitizeSteps(row.steps)) : 'internal_task';
  },
  parameters: z.object({
    playbookId: z.string().min(1).describe('Id del playbook (de listVenuePlaybooks). Debe estar aprobado.'),
    params: z.record(z.string(), z.string()).optional().describe('Valores para los {{parámetros}} del playbook.'),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { playbookId: string; params?: Record<string, string> };
    const res = await runPlaybook(actor, args.playbookId, args.params ?? {});
    return {
      ok: res.ok,
      completedSteps: res.completedSteps,
      failedStep: res.failedStep,
      results: res.results,
      note: res.ok
        ? 'Playbook completado. Reporta los hallazgos relevantes al usuario.'
        : `Falló en el paso ${res.failedStep}. Revisa el error de ese paso y dilo claramente.`,
    };
  },
});
