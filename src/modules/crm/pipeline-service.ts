import { Prisma, type PipelineStage } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { OperationsError, registerCommand } from '@/modules/operations/commands';
import { toStageDTO, type PipelineStageDTO } from './crm-dto';
import { assertCrmPermission, runCrmCommand, type CrmCommandOptions } from './crm-helpers';
import {
  DEFAULT_PIPELINE_STAGES,
  planStageInsertion,
  planStageReorder,
  sortStages,
  stageKeyFromName,
  uniqueStageKey,
  validateActiveStageSet,
} from './pipeline-rules';
import { CRM_AREA_KEY, CRM_COMMANDS, CRM_EVENTS, CRM_OBJECT_TYPES, STAGE_KINDS, type StageKind } from './types';

/**
 * Sales pipeline stages (plan 6.5).
 *
 * - `ensurePipelineSeed(db)` creates the default stages when the table is
 *   empty (`INSERT … ON CONFLICT DO NOTHING`, safe inside a transaction and
 *   between concurrent callers). Every CRM read and command calls it, so the
 *   pipeline exists from the first use without a migration seed.
 * - `crm.stage.create | update | reorder` (permission `crm.manage_stages`,
 *   people only). Stages are never deleted: deactivation keeps the history of
 *   the opportunities that went through them. The active set always keeps one
 *   open, one won and one lost stage, and a stage with live (open or dormant)
 *   opportunities cannot be deactivated.
 */

type StageDb = Pick<Prisma.TransactionClient, 'pipelineStage'>;

const STAGE = CRM_OBJECT_TYPES.pipelineStage;
const PIPELINE_AGGREGATE = { type: STAGE, id: 'pipeline' } as const;
const PEOPLE_ONLY = ['user'] as const;

const DEFAULT_PROBABILITY_BY_KIND: Record<StageKind, number> = { open: 0.5, won: 1, lost: 0 };

/** Seeds the default pipeline when there are no stages. Returns how many stages were created. */
export async function ensurePipelineSeed(db: StageDb = prisma): Promise<number> {
  const count = await db.pipelineStage.count();
  if (count > 0) return 0;
  const result = await db.pipelineStage.createMany({
    data: DEFAULT_PIPELINE_STAGES.map((stage) => ({
      key: stage.key,
      name: stage.name,
      order: stage.order,
      probabilityDefault: new Prisma.Decimal(stage.probabilityDefault),
      kind: stage.kind,
      slaHours: stage.slaHours,
      active: true,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/** Every stage (seeded), sorted by order. */
export async function loadPipelineStages(db: StageDb = prisma): Promise<PipelineStage[]> {
  await ensurePipelineSeed(db);
  return sortStages(await db.pipelineStage.findMany());
}

export async function listPipelineStages(
  actor: CurrentUser,
  options: { includeInactive?: boolean } = {}
): Promise<PipelineStageDTO[]> {
  assertCrmPermission(actor, 'crm.view');
  const stages = await loadPipelineStages();
  return stages.filter((stage) => options.includeInactive || stage.active).map(toStageDTO);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const stageIdSchema = z.string().trim().min(1).max(64);
const stageNameSchema = z.string().trim().min(2).max(60);
const slaHoursSchema = z.number().int().min(1).max(8760);

export const createStageSchema = z.object({
  name: stageNameSchema,
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Clave inválida: minúsculas, números y guion bajo, empezando con letra')
    .optional(),
  kind: z.enum(STAGE_KINDS).default('open'),
  probabilityDefault: z.number().min(0).max(1).optional(),
  slaHours: slaHoursSchema.nullish(),
});
export type CreateStageInput = z.input<typeof createStageSchema>;

export const updateStageSchema = z
  .object({
    stageId: stageIdSchema,
    name: stageNameSchema.optional(),
    probabilityDefault: z.number().min(0).max(1).optional(),
    slaHours: slaHoursSchema.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.probabilityDefault !== undefined ||
      value.slaHours !== undefined ||
      value.active !== undefined,
    { message: 'Indica al menos un cambio' }
  );
export type UpdateStageInput = z.input<typeof updateStageSchema>;

export const reorderStagesSchema = z.object({
  stageIds: z.array(stageIdSchema).min(1).max(50),
});
export type ReorderStagesInput = z.input<typeof reorderStagesSchema>;

function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('es') === b.trim().toLocaleLowerCase('es');
}

registerCommand<z.output<typeof createStageSchema>, { stage: PipelineStageDTO }>(CRM_COMMANDS.stageCreate, {
  schema: createStageSchema,
  permission: 'crm.manage_stages',
  aggregate: 'none',
  actorTypes: PEOPLE_ONLY,
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    const stages = await loadPipelineStages(tx);
    if (stages.some((stage) => stage.active && sameName(stage.name, input.name))) {
      throw new OperationsError('duplicate', `Ya existe una etapa activa llamada «${input.name}»`);
    }
    const taken = new Set(stages.map((stage) => stage.key));
    if (input.key && taken.has(input.key)) {
      throw new OperationsError('duplicate', `Ya existe una etapa con la clave «${input.key}»`);
    }
    const key = input.key ?? uniqueStageKey(stageKeyFromName(input.name), taken);
    const plan = planStageInsertion(stages, input.kind);
    for (const shift of plan.shifts) {
      await tx.pipelineStage.update({ where: { id: shift.id }, data: { order: shift.order } });
    }
    const stage = await tx.pipelineStage.create({
      data: {
        key,
        name: input.name,
        order: plan.order,
        kind: input.kind,
        probabilityDefault: new Prisma.Decimal(input.probabilityDefault ?? DEFAULT_PROBABILITY_BY_KIND[input.kind]),
        slaHours: input.slaHours ?? null,
        active: true,
      },
    });
    ctx.emit(
      CRM_EVENTS.stageCreated,
      { stageId: stage.id, key, name: stage.name, kind: stage.kind, order: stage.order },
      { areaKey: CRM_AREA_KEY, objectType: STAGE, objectId: stage.id }
    );
    return { data: { stage: toStageDTO(stage) } };
  },
});

registerCommand<z.output<typeof updateStageSchema>, { stage: PipelineStageDTO; changed: string[] }>(
  CRM_COMMANDS.stageUpdate,
  {
    schema: updateStageSchema,
    permission: 'crm.manage_stages',
    aggregate: 'none',
    actorTypes: PEOPLE_ONLY,
    async handler(tx, cmd, ctx) {
      const input = cmd.payload;
      const stages = await loadPipelineStages(tx);
      const stage = stages.find((row) => row.id === input.stageId);
      if (!stage) throw new OperationsError('not_found', 'No se encontró la etapa del embudo');

      const data: Prisma.PipelineStageUpdateInput = {};
      const changed: string[] = [];
      if (input.name !== undefined && input.name !== stage.name) {
        if (stages.some((row) => row.id !== stage.id && row.active && sameName(row.name, input.name!))) {
          throw new OperationsError('duplicate', `Ya existe una etapa activa llamada «${input.name}»`);
        }
        data.name = input.name;
        changed.push('name');
      }
      if (input.probabilityDefault !== undefined && Number(stage.probabilityDefault) !== input.probabilityDefault) {
        data.probabilityDefault = new Prisma.Decimal(input.probabilityDefault);
        changed.push('probabilityDefault');
      }
      if (input.slaHours !== undefined && input.slaHours !== stage.slaHours) {
        data.slaHours = input.slaHours;
        changed.push('slaHours');
      }
      if (input.active !== undefined && input.active !== stage.active) {
        const after = stages.map((row) => (row.id === stage.id ? { ...row, active: input.active! } : row));
        const reason = validateActiveStageSet(after);
        if (reason) throw new OperationsError('invalid_state', reason);
        if (!input.active) {
          const live = await tx.opportunity.count({
            where: { stageId: stage.id, status: { in: ['open', 'dormant'] } },
          });
          if (live > 0) {
            throw new OperationsError(
              'invalid_state',
              `Mueve primero ${live === 1 ? 'la oportunidad abierta' : `las ${live} oportunidades abiertas`} de «${stage.name}» a otra etapa`
            );
          }
        }
        data.active = input.active;
        changed.push('active');
      }
      const updated = changed.length > 0 ? await tx.pipelineStage.update({ where: { id: stage.id }, data }) : stage;
      if (changed.length > 0) {
        ctx.emit(
          CRM_EVENTS.stageUpdated,
          { stageId: stage.id, key: stage.key, changed },
          { areaKey: CRM_AREA_KEY, objectType: STAGE, objectId: stage.id }
        );
      }
      return { data: { stage: toStageDTO(updated), changed } };
    },
  }
);

registerCommand<z.output<typeof reorderStagesSchema>, { stages: PipelineStageDTO[] }>(CRM_COMMANDS.stageReorder, {
  schema: reorderStagesSchema,
  permission: 'crm.manage_stages',
  aggregate: 'none',
  actorTypes: PEOPLE_ONLY,
  async handler(tx, cmd, ctx) {
    const stages = await loadPipelineStages(tx);
    const plan = planStageReorder(stages, cmd.payload.stageIds);
    if (!plan.ok) throw new OperationsError('invalid_payload', plan.message);
    const byId = new Map(stages.map((stage) => [stage.id, stage]));
    for (const { id, order } of plan.orders) {
      if (byId.get(id)?.order !== order) {
        await tx.pipelineStage.update({ where: { id }, data: { order } });
      }
    }
    const reordered = sortStages(
      stages.map((stage) => ({ ...stage, order: plan.orders.find((o) => o.id === stage.id)?.order ?? stage.order }))
    );
    ctx.emit(
      CRM_EVENTS.stagesReordered,
      { stageIds: reordered.map((stage) => stage.id) },
      { areaKey: CRM_AREA_KEY, objectType: STAGE, objectId: PIPELINE_AGGREGATE.id }
    );
    return { data: { stages: reordered.map(toStageDTO) } };
  },
});

// ---------------------------------------------------------------------------
// Service signatures (routes, server actions, tools)
// ---------------------------------------------------------------------------

export const createStage = (actor: CurrentUser, input: CreateStageInput, options?: CrmCommandOptions) =>
  runCrmCommand<{ stage: PipelineStageDTO }>(actor, CRM_COMMANDS.stageCreate, PIPELINE_AGGREGATE, input, options);

export const updateStage = (actor: CurrentUser, input: UpdateStageInput, options?: CrmCommandOptions) =>
  runCrmCommand<{ stage: PipelineStageDTO; changed: string[] }>(
    actor,
    CRM_COMMANDS.stageUpdate,
    PIPELINE_AGGREGATE,
    input,
    options
  );

export const reorderStages = (actor: CurrentUser, input: ReorderStagesInput, options?: CrmCommandOptions) =>
  runCrmCommand<{ stages: PipelineStageDTO[] }>(actor, CRM_COMMANDS.stageReorder, PIPELINE_AGGREGATE, input, options);
