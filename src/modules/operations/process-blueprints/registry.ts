import { createHash } from 'crypto';
import type { Prisma, ProcessVersion } from '@prisma/client';
import { z } from 'zod';
import { canonicalJson } from '@/modules/extensions/json-schema-to-zod';
import { OperationsError } from '../errors';
import { toOperationalJson } from '../events-service';
import {
  ALLOCATION_SOURCES,
  AREA_KEYS,
  CASE_PHASES,
  ESCALATION_RUNGS,
  STEP_KINDS,
  STEP_SCOPES,
} from '../types';
import { CONDITION_KEYS, isConditionKey } from './conditions';
import { SALES_FULFILLMENT_BLUEPRINT } from './sales-fulfillment';
import type { ProcessBlueprint, StepDef } from './types';

/**
 * Registry of published process versions (plan section 2.3).
 *
 * `ensureProcessVersion(db, blueprint)` stores the definition and its checksum
 * in `ProcessVersion` the first time a version is used and returns the row
 * afterwards. A different definition under an already published
 * `(processKey, version)` is refused with `process_version_mismatch`: changing
 * a blueprint means publishing a new version, while open cases keep theirs.
 *
 * `loadProcessBlueprint(db, processVersionId)` reads the definition a case was
 * instantiated with, validates it and checks its checksum.
 */

type Db = Prisma.TransactionClient;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-process-registry', event, ...extra }));

const conditionKeySchema = z
  .string()
  .refine(isConditionKey, { message: 'Condición desconocida' }) as unknown as z.ZodType<
  (typeof CONDITION_KEYS)[number]
>;

const stepDefSchema: z.ZodType<StepDef> = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/),
    label: z.string().trim().min(1).max(120),
    areaKey: z.enum(AREA_KEYS),
    kind: z.enum(STEP_KINDS),
    scope: z.enum(STEP_SCOPES),
    appliesTo: z.array(z.enum(ALLOCATION_SOURCES)).min(1).optional(),
    dependsOn: z.array(z.string()).max(20),
    entryCondition: conditionKeySchema.optional(),
    exit: z.object({
      evidence: z.array(z.string().min(1).max(60)).max(10),
      eventType: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
      alternateEventTypes: z
        .array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/))
        .max(5)
        .optional(),
    }),
    slaMinutes: z.number().int().min(0).max(525_600),
    slaAnchor: z.enum(['expectedAt', 'plannedDate']).optional(),
    slaFallbackMinutes: z.number().int().min(0).max(525_600).optional(),
    ownerResolution: z.union([
      z.object({ area: z.enum(AREA_KEYS), byLocation: z.boolean().optional() }).strict(),
      z.object({ role: z.literal('case_owner') }).strict(),
    ]),
    escalation: z.object({
      afterMinutes: z.array(z.number().int().min(0)).min(1).max(10),
      ladder: z.array(z.enum(ESCALATION_RUNGS)).min(1).max(10),
    }),
    autoComplete: conditionKeySchema.optional(),
    engine: z
      .enum([
        'reserve_stock',
        'request_purchase',
        'request_production',
        'request_direct_delivery',
        'plan_delivery',
      ])
      .optional(),
    completion: z.enum(['manual', 'condition']),
    uiAction: z
      .enum([
        'count_stock',
        'plan_allocations',
        'reserve_stock',
        'prepare_order',
        'assign_transport',
        'record_delivery',
        'close_case',
      ])
      .optional(),
    phase: z.enum(CASE_PHASES),
  })
  .strict();

export const processBlueprintSchema: z.ZodType<ProcessBlueprint> = z
  .object({
    processKey: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/),
    version: z.number().int().min(1).max(10_000),
    label: z.string().trim().min(1).max(120),
    steps: z.array(stepDefSchema).min(1).max(100),
  })
  .strict();

const SCOPE_RANK: Record<string, number> = { case: 0, demand: 1, allocation: 2 };

/** Pure structural rules a blueprint must satisfy; returns Spanish problems (empty when valid). */
export function validateBlueprint(blueprint: ProcessBlueprint): string[] {
  const parsed = processBlueprintSchema.safeParse(blueprint);
  if (!parsed.success) {
    return parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join('.') || 'definición'}: ${issue.message}`);
  }
  const problems: string[] = [];
  const byKey = new Map<string, StepDef>();
  for (const step of blueprint.steps) {
    if (byKey.has(step.key)) problems.push(`Paso duplicado: ${step.key}`);
    byKey.set(step.key, step);
  }
  for (const step of blueprint.steps) {
    if (step.appliesTo && step.scope !== 'allocation') {
      problems.push(`${step.key}: appliesTo sólo aplica a pasos por asignación`);
    }
    if (step.engine && !step.autoComplete) {
      problems.push(`${step.key}: un paso del motor necesita condición de cierre`);
    }
    if (step.completion === 'condition' && !step.autoComplete) {
      problems.push(`${step.key}: completion=condition necesita autoComplete`);
    }
    for (const dependency of step.dependsOn) {
      const target = byKey.get(dependency);
      if (!target) {
        problems.push(`${step.key}: depende de un paso inexistente (${dependency})`);
        continue;
      }
      if (dependency === step.key) problems.push(`${step.key}: depende de sí mismo`);
      if (
        SCOPE_RANK[target.scope] === SCOPE_RANK[step.scope] &&
        step.scope === 'allocation' &&
        target.appliesTo &&
        step.appliesTo &&
        !step.appliesTo.every((source) => target.appliesTo!.includes(source))
      ) {
        problems.push(
          `${step.key}: depende de ${dependency}, que no existe para todas sus fuentes`
        );
      }
    }
  }
  // Cycles (depth-first).
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string, path: string[]): void => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') {
      problems.push(`Dependencia circular: ${[...path, key].join(' → ')}`);
      return;
    }
    state.set(key, 'visiting');
    for (const dependency of byKey.get(key)?.dependsOn ?? []) {
      if (byKey.has(dependency)) visit(dependency, [...path, key]);
    }
    state.set(key, 'done');
  };
  for (const step of blueprint.steps) visit(step.key, []);
  return problems;
}

/** Canonical JSON of a blueprint (stable key order). */
export function canonicalBlueprint(blueprint: ProcessBlueprint): string {
  return canonicalJson(toOperationalJson(blueprint));
}

export function blueprintChecksum(blueprint: ProcessBlueprint): string {
  return createHash('sha256').update(canonicalBlueprint(blueprint), 'utf8').digest('hex');
}

function assertValid(blueprint: ProcessBlueprint): void {
  const problems = validateBlueprint(blueprint);
  if (problems.length > 0) {
    throw new OperationsError(
      'invalid_blueprint',
      `La definición de ${blueprint.processKey}@${blueprint.version} es inválida: ${problems
        .slice(0, 3)
        .join('; ')}`,
      { httpStatus: 500, details: { problems } }
    );
  }
}

function mismatch(blueprint: ProcessBlueprint, stored: ProcessVersion): OperationsError {
  return new OperationsError(
    'process_version_mismatch',
    `La definición de ${blueprint.processKey}@${blueprint.version} cambió respecto a la publicada; publica la versión ${
      blueprint.version + 1
    } en lugar de modificar la ${blueprint.version}`,
    {
      httpStatus: 409,
      details: {
        processKey: blueprint.processKey,
        version: blueprint.version,
        storedChecksum: stored.checksum,
        codeChecksum: blueprintChecksum(blueprint),
      },
    }
  );
}

const blueprintCache = new Map<string, ProcessBlueprint>();
const CACHE_LIMIT = 50;

function remember(id: string, blueprint: ProcessBlueprint): void {
  if (blueprintCache.size >= CACHE_LIMIT) {
    const oldest = blueprintCache.keys().next().value;
    if (oldest !== undefined) blueprintCache.delete(oldest);
  }
  blueprintCache.set(id, blueprint);
}

/**
 * Returns the published `ProcessVersion` of a blueprint, creating it the first
 * time (`INSERT … ON CONFLICT DO NOTHING`, safe inside a transaction). Throws
 * `process_version_mismatch` when the stored definition of that version is
 * different.
 */
export async function ensureProcessVersion(
  db: Db,
  blueprint: ProcessBlueprint = SALES_FULFILLMENT_BLUEPRINT
): Promise<ProcessVersion> {
  assertValid(blueprint);
  const checksum = blueprintChecksum(blueprint);
  const where = {
    processKey_version: { processKey: blueprint.processKey, version: blueprint.version },
  };
  const existing = await db.processVersion.findUnique({ where });
  if (existing) {
    if (existing.checksum !== checksum) throw mismatch(blueprint, existing);
    remember(existing.id, blueprint);
    return existing;
  }
  const [created] = await db.processVersion.createManyAndReturn({
    data: [
      {
        processKey: blueprint.processKey,
        version: blueprint.version,
        definition: toOperationalJson(blueprint),
        checksum,
        active: true,
      },
    ],
    skipDuplicates: true,
  });
  if (!created) {
    const winner = await db.processVersion.findUnique({ where });
    if (!winner)
      throw new Error(
        `ProcessVersion ${blueprint.processKey}@${blueprint.version} conflicted but could not be read`
      );
    if (winner.checksum !== checksum) throw mismatch(blueprint, winner);
    remember(winner.id, blueprint);
    return winner;
  }
  // Only the newest published version stays active for new cases.
  await db.processVersion.updateMany({
    where: { processKey: blueprint.processKey, version: { lt: blueprint.version }, active: true },
    data: { active: false },
  });
  log('process_version_published', {
    processKey: blueprint.processKey,
    version: blueprint.version,
    checksum,
  });
  remember(created.id, blueprint);
  return created;
}

/** Definition a case was instantiated with (validated; checksum verified). */
export async function loadProcessBlueprint(
  db: Db,
  processVersionId: string
): Promise<{
  version: Pick<ProcessVersion, 'id' | 'processKey' | 'version'>;
  blueprint: ProcessBlueprint;
}> {
  const cached = blueprintCache.get(processVersionId);
  if (cached) {
    return {
      version: { id: processVersionId, processKey: cached.processKey, version: cached.version },
      blueprint: cached,
    };
  }
  const row = await db.processVersion.findUnique({ where: { id: processVersionId } });
  if (!row) {
    throw new OperationsError('not_found', 'No se encontró la versión del proceso del expediente');
  }
  const parsed = processBlueprintSchema.safeParse(row.definition);
  if (!parsed.success) {
    throw new OperationsError(
      'process_version_corrupt',
      `La definición guardada de ${row.processKey}@${row.version} no es válida`,
      { httpStatus: 500 }
    );
  }
  if (blueprintChecksum(parsed.data) !== row.checksum) {
    throw new OperationsError(
      'process_version_corrupt',
      `La definición guardada de ${row.processKey}@${row.version} no coincide con su checksum`,
      { httpStatus: 500 }
    );
  }
  remember(row.id, parsed.data);
  return {
    version: { id: row.id, processKey: row.processKey, version: row.version },
    blueprint: parsed.data,
  };
}

/** Test helper: forget cached definitions. */
export function clearProcessBlueprintCache(): void {
  blueprintCache.clear();
}

export function findStepDef(blueprint: ProcessBlueprint, stepKey: string): StepDef | null {
  return blueprint.steps.find((step) => step.key === stepKey) ?? null;
}
