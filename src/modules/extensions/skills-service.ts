import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';

/**
 * Skills = declarative recipes. A skill has inputs, instructions, approved
 * references, allowed tools, steps with dependencies, completion conditions,
 * approval points and execution limits. Steps are DATA (tool calls, conditions,
 * approvals, messages); there is no eval, shell or downloaded code.
 *
 * Personal skills can be saved and used by their owner with tools already
 * authorized for them. Sharing as a team capability requires `skills.manage`.
 */

const conditionSchema = z.object({
  path: z.string().min(1).max(200),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'empty', 'contains', 'in']),
  value: z.unknown().optional(),
});

const stepSchema = z.discriminatedUnion('type', [
  z.object({
    id: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    type: z.literal('tool'),
    tool: z.string().min(1).max(120),
    /** Arguments with {{templates}} referencing inputs and previous steps. */
    args: z.record(z.unknown()).default({}),
    dependsOn: z.array(z.string()).max(20).default([]),
    /** Skip the step when the condition is false. */
    when: conditionSchema.optional(),
    /** Optional pre-authorization: the user is asked before this step runs even for read tools. */
    requireApproval: z.boolean().default(false),
    description: z.string().max(500).optional(),
  }),
  z.object({
    id: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    type: z.literal('check'),
    /** Fails the run with `message` when the condition is false. */
    condition: conditionSchema,
    message: z.string().max(500),
    dependsOn: z.array(z.string()).max(20).default([]),
  }),
  z.object({
    id: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    type: z.literal('note'),
    /** Text presented to the user/assistant (templated). */
    text: z.string().max(4000),
    dependsOn: z.array(z.string()).max(20).default([]),
    when: conditionSchema.optional(),
  }),
]);

export const skillDefinitionSchema = z
  .object({
    inputs: z
      .array(
        z.object({
          name: z
            .string()
            .min(1)
            .max(60)
            .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          label: z.string().max(120),
          type: z.enum(['string', 'number', 'boolean', 'json']).default('string'),
          required: z.boolean().default(true),
          description: z.string().max(500).optional(),
        })
      )
      .max(30)
      .default([]),
    instructions: z.string().max(8000).default(''),
    references: z.array(z.string().max(300)).max(50).default([]),
    allowedTools: z.array(z.string().min(1).max(120)).min(0).max(50).default([]),
    steps: z.array(stepSchema).min(1).max(60),
    completion: z
      .object({
        conditions: z.array(conditionSchema).max(20).default([]),
        summaryTemplate: z.string().max(4000).optional(),
      })
      .default({ conditions: [] }),
    limits: z
      .object({
        maxToolCalls: z.number().int().min(1).max(200).default(40),
        maxDurationMs: z
          .number()
          .int()
          .min(1000)
          .max(30 * 60 * 1000)
          .default(5 * 60 * 1000),
      })
      .default({ maxToolCalls: 40, maxDurationMs: 5 * 60 * 1000 }),
  })
  .superRefine((def, ctx) => {
    const ids = new Set<string>();
    for (const step of def.steps) {
      if (ids.has(step.id))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Paso duplicado: ${step.id}` });
      ids.add(step.id);
    }
    for (const step of def.steps) {
      for (const dep of step.dependsOn) {
        if (!ids.has(dep))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `El paso ${step.id} depende de un paso inexistente: ${dep}`,
          });
      }
      if (step.type === 'tool' && !def.allowedTools.includes(step.tool)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `El paso ${step.id} usa la herramienta ${step.tool}, que no está en allowedTools`,
        });
      }
    }
    // Cycle detection (Kahn).
    const indegree = new Map<string, number>();
    for (const step of def.steps) indegree.set(step.id, step.dependsOn.length);
    const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited++;
      for (const step of def.steps) {
        if (step.dependsOn.includes(id)) {
          const n = (indegree.get(step.id) ?? 0) - 1;
          indegree.set(step.id, n);
          if (n === 0) queue.push(step.id);
        }
      }
    }
    if (visited !== def.steps.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Los pasos contienen dependencias circulares',
      });
  });

export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;
export type SkillStep = z.infer<typeof stepSchema>;

export const createSkillSchema = z.object({
  key: z
    .string()
    .min(3)
    .max(60)
    .regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().min(2).max(120),
  purpose: z.string().min(2).max(1000),
  scope: z.enum(['personal', 'team']).default('personal'),
  definition: skillDefinitionSchema,
});

export class SkillError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

export function toSkillDTO(s: {
  id: string;
  key: string;
  name: string;
  purpose: string;
  ownerUserId: string;
  scope: string;
  status: string;
  version: number;
  definition: unknown;
  extensionId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    purpose: s.purpose,
    ownerUserId: s.ownerUserId,
    scope: s.scope,
    status: s.status,
    version: s.version,
    definition: s.definition as SkillDefinition,
    extensionId: s.extensionId,
    publishedAt: s.publishedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function createSkill(actor: CurrentUser, input: z.infer<typeof createSkillSchema>) {
  if (input.scope === 'team' && !hasPermission(actor, 'skills.manage')) {
    throw new SkillError('Publicar skills de equipo requiere el permiso skills.manage', 403);
  }
  const existing = await prisma.skill.findUnique({ where: { key: input.key } });
  if (existing) throw new SkillError('Ya existe una skill con esa clave', 409);
  const skill = await prisma.skill.create({
    data: {
      key: input.key,
      name: input.name,
      purpose: input.purpose,
      ownerUserId: actor.id,
      scope: input.scope,
      status: input.scope === 'personal' ? 'published' : 'draft',
      definition: input.definition as unknown as Prisma.InputJsonValue,
      publishedAt: input.scope === 'personal' ? new Date() : null,
      publishedBy: input.scope === 'personal' ? actor.id : null,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'skill.created',
    targetType: 'skill',
    targetId: skill.id,
    metadata: { key: input.key, scope: input.scope },
  });
  return toSkillDTO(skill);
}

export async function updateSkill(
  actor: CurrentUser,
  id: string,
  patch: Partial<Pick<z.infer<typeof createSkillSchema>, 'name' | 'purpose' | 'definition'>>
) {
  const skill = await prisma.skill.findUnique({ where: { id } });
  if (!skill) throw new SkillError('Skill no encontrada', 404);
  const canEdit = skill.ownerUserId === actor.id || hasPermission(actor, 'skills.manage');
  if (!canEdit) throw new SkillError('Sin permiso para editar esta skill', 403);
  const updated = await prisma.skill.update({
    where: { id },
    data: {
      name: patch.name,
      purpose: patch.purpose,
      definition: patch.definition
        ? (patch.definition as unknown as Prisma.InputJsonValue)
        : undefined,
      version: patch.definition ? { increment: 1 } : undefined,
      // Editing a team skill sends it back to review.
      status: skill.scope === 'team' && patch.definition ? 'draft' : undefined,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'skill.updated',
    targetType: 'skill',
    targetId: id,
    metadata: { changedKeys: Object.keys(patch) },
  });
  return toSkillDTO(updated);
}

/** Publishing/suspending a TEAM skill is an administrative review step. */
export async function setSkillStatus(
  actor: CurrentUser,
  id: string,
  status: 'published' | 'suspended' | 'draft'
) {
  const skill = await prisma.skill.findUnique({ where: { id } });
  if (!skill) throw new SkillError('Skill no encontrada', 404);
  if (skill.scope === 'team' && !hasPermission(actor, 'skills.manage'))
    throw new SkillError('Sin permiso', 403);
  if (skill.scope === 'personal' && skill.ownerUserId !== actor.id && !actor.isSuperAdmin)
    throw new SkillError('Sin permiso', 403);
  const updated = await prisma.skill.update({
    where: { id },
    data: {
      status,
      publishedAt: status === 'published' ? new Date() : skill.publishedAt,
      publishedBy: status === 'published' ? actor.id : skill.publishedBy,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: `skill.${status}`,
    targetType: 'skill',
    targetId: id,
  });
  return toSkillDTO(updated);
}

export async function deleteSkill(actor: CurrentUser, id: string) {
  const skill = await prisma.skill.findUnique({ where: { id } });
  if (!skill) return;
  if (skill.ownerUserId !== actor.id && !hasPermission(actor, 'skills.manage'))
    throw new SkillError('Sin permiso', 403);
  await prisma.skill.delete({ where: { id } });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'skill.deleted',
    targetType: 'skill',
    targetId: id,
  });
}

/** Skills the actor may run: own personal ones + published team ones. */
export async function listSkillsForUser(actor: CurrentUser) {
  const rows = await prisma.skill.findMany({
    where: {
      OR: [
        { ownerUserId: actor.id, scope: 'personal' },
        { scope: 'team', status: 'published' },
      ],
    },
    orderBy: [{ scope: 'asc' }, { name: 'asc' }],
  });
  return rows.map(toSkillDTO);
}

export async function listAllSkills(filters: { scope?: string; status?: string } = {}) {
  const rows = await prisma.skill.findMany({
    where: {
      ...(filters.scope ? { scope: filters.scope } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(toSkillDTO);
}

export async function getRunnableSkill(actor: CurrentUser, key: string) {
  const skill = await prisma.skill.findUnique({ where: { key } });
  if (!skill) throw new SkillError('Skill no encontrada', 404);
  const allowed =
    (skill.scope === 'personal' &&
      skill.ownerUserId === actor.id &&
      skill.status !== 'suspended') ||
    (skill.scope === 'team' && skill.status === 'published');
  if (!allowed) throw new SkillError('No puedes ejecutar esta skill', 403);
  return skill;
}
