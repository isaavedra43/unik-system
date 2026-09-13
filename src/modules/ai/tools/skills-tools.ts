import { z } from 'zod';
import { registerTool } from './registry';

/**
 * Skills (recetas) created in "Extensiones y skills" become usable from any AI
 * surface. Runs go through skill-runner (limits, approvals, audit).
 */

registerTool({
  name: 'listSkills',
  description:
    'Lista las skills (recetas) que el usuario puede ejecutar: personales y las publicadas para el equipo. Devuelve clave, nombre, propósito e inputs requeridos.',
  category: 'skill',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ search: z.string().max(100).optional() }),
  execute: async (actor, rawArgs) => {
    const { search } = rawArgs as { search?: string };
    const { listSkillsForUser } = await import('@/modules/extensions/skills-service');
    const skills = await listSkillsForUser(actor);
    const term = search?.trim().toLowerCase();
    const rows = skills
      .filter((s) => s.status !== 'suspended')
      .filter((s) => !term || s.name.toLowerCase().includes(term) || s.key.toLowerCase().includes(term) || s.purpose.toLowerCase().includes(term))
      .map((s) => ({
        key: s.key,
        name: s.name,
        purpose: s.purpose,
        scope: s.scope,
        status: s.status,
        inputs: (s.definition?.inputs ?? []).map((i) => ({ name: i.name, label: i.label, type: i.type, required: i.required ?? false, description: i.description ?? null })),
        steps: (s.definition?.steps ?? []).length,
      }));
    return { count: rows.length, skills: rows };
  },
});

registerTool({
  name: 'runSkill',
  description:
    'Ejecuta una skill (receta) del usuario por su clave con los inputs indicados. Los pasos con efectos generan tarjetas de aprobación; devuelve el estado de la corrida y su resumen.',
  category: 'skill',
  enabledByDefault: true,
  effect: 'internal_task',
  summarize: (args) => `Ejecutar skill "${(args as { key: string }).key}"`,
  parameters: z.object({
    key: z.string().min(1).describe('Clave de la skill (de listSkills)'),
    inputs: z.record(z.unknown()).default({}),
    conversationId: z.string().optional(),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { key: string; inputs: Record<string, unknown>; conversationId?: string };
    const { runSkillByKey } = await import('@/modules/extensions/skill-runner');
    const outcome = await runSkillByKey(actor, args.key, args.inputs, { conversationId: args.conversationId });
    return outcome;
  },
});

registerTool({
  name: 'getSkillRunStatus',
  description: 'Consulta el estado de las últimas corridas de skills del usuario (o de una skill concreta).',
  category: 'skill',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ skillKey: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { skillKey?: string; limit: number };
    const { listSkillRuns } = await import('@/modules/extensions/skill-runner');
    let skillId: string | undefined;
    if (args.skillKey) {
      const { getRunnableSkill } = await import('@/modules/extensions/skills-service');
      skillId = (await getRunnableSkill(actor, args.skillKey)).id;
    }
    const runs = await listSkillRuns(actor, { skillId, limit: args.limit });
    return { count: runs.length, runs };
  },
});
