import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { OperationsError } from '@/modules/operations/errors';
import { loadProcessBlueprint } from '@/modules/operations/process-blueprints/registry';
import { SALES_FULFILLMENT_BLUEPRINT } from '@/modules/operations/process-blueprints/sales-fulfillment';
import { AREA_LABELS, CASE_OPEN_STATUSES, isAreaKey } from '@/modules/operations/types';
import { assertControlTowerAccess } from './control-tower-service';

/**
 * Simulación de retrasos y capacidad (plan 7.8e).
 *
 * Pase hacia adelante tipo CPM sobre `dependsOn`, con la duración REAL medida
 * por las proyecciones (`CtStepMetricDaily`: p50 activo + p50 espera por paso) y
 * `slaMinutes` como respaldo cuando todavía no hay historia.
 *
 * Escenario: `{delays:[{stepKey, minutes}], capacity:[{areaKey, factor}]}`.
 * - `delays` suma minutos al paso indicado (y, por dependencias, a todo lo que
 *   viene después).
 * - `factor` es CAPACIDAD, no duración: 0.5 = la mitad de la gente ⇒ el doble
 *   de tiempo; 2 = el doble de capacidad ⇒ la mitad. Se acota a [0.1, 10].
 *
 * Lo ya terminado no se mueve: un paso `done` conserva su fecha real y sólo
 * empuja a los que dependen de él. Nada puede terminar antes de "ahora".
 */

const MINUTE = 60_000;

export const APPLY_CASE_LIMIT = 500;
const DURATION_WINDOW_DAYS = 90;

const TERMINAL_STATUSES = new Set(['done', 'skipped', 'cancelled']);
const IN_FLIGHT_STATUSES = new Set(['ready', 'active', 'waiting']);

// ---------------------------------------------------------------------------
// Puro
// ---------------------------------------------------------------------------

export interface SimulationStep {
  /** `stepKey:scopeKey`, el formato de `CaseStep.dependsOn`. */
  ref: string;
  stepKey: string;
  scopeKey: string;
  label: string;
  areaKey: string;
  dependsOn: string[];
  status: string;
  slaMinutes: number;
  startedAt: Date | null;
  completedAt: Date | null;
  dueAt: Date | null;
}

export interface StepDuration {
  activeMin: number | null;
  waitMin: number | null;
  samples?: number;
}

export interface SimulationScenario {
  delays?: Array<{ stepKey: string; minutes: number }>;
  capacity?: Array<{ areaKey: string; factor: number }>;
}

export interface SimulatedStep {
  ref: string;
  stepKey: string;
  scopeKey: string;
  label: string;
  areaKey: string;
  areaLabel: string;
  status: string;
  /** Duración usada por la simulación, ya con capacidad y retraso. */
  durationMin: number;
  baselineFinish: string;
  scenarioFinish: string;
  shiftMinutes: number;
  /** Holgura: minutos que puede retrasarse sin mover el final del expediente. */
  slackMin: number;
  critical: boolean;
}

export interface CaseSimulation {
  caseId: string | null;
  caseNumber: string | null;
  processKey: string;
  start: string;
  baselineFinish: string | null;
  scenarioFinish: string | null;
  shiftMinutes: number;
  promisedAt: string | null;
  lateBefore: boolean | null;
  lateAfter: boolean | null;
  steps: SimulatedStep[];
  criticalPath: string[];
  /** Pasos con duración medida (no del SLA). */
  measuredSteps: number;
  scenario: NormalizedScenario;
}

export interface NormalizedScenario {
  delays: Array<{ stepKey: string; minutes: number }>;
  capacity: Array<{ areaKey: string; factor: number }>;
}

/** Limpia el escenario: minutos ≥ 0 (≤ 30 días) y factores en [0.1, 10]. */
export function normalizeScenario(scenario: SimulationScenario = {}): NormalizedScenario {
  const delays = new Map<string, number>();
  for (const entry of scenario.delays ?? []) {
    const stepKey = typeof entry?.stepKey === 'string' ? entry.stepKey.trim() : '';
    const minutes =
      typeof entry?.minutes === 'number' && Number.isFinite(entry.minutes) ? entry.minutes : 0;
    if (!stepKey || minutes <= 0) continue;
    delays.set(stepKey, Math.min(Math.round(minutes), 43_200));
  }
  const capacity = new Map<string, number>();
  for (const entry of scenario.capacity ?? []) {
    const areaKey = typeof entry?.areaKey === 'string' ? entry.areaKey.trim() : '';
    const factor =
      typeof entry?.factor === 'number' && Number.isFinite(entry.factor) ? entry.factor : 1;
    if (!areaKey || factor === 1) continue;
    capacity.set(areaKey, Math.min(Math.max(factor, 0.1), 10));
  }
  return {
    delays: [...delays.entries()].map(([stepKey, minutes]) => ({ stepKey, minutes })),
    capacity: [...capacity.entries()].map(([areaKey, factor]) => ({ areaKey, factor })),
  };
}

/** Duración base de un paso: lo medido, o su SLA cuando aún no hay historia. */
export function baseDurationMinutes(
  step: SimulationStep,
  durations?: ReadonlyMap<string, StepDuration>
): { minutes: number; measured: boolean } {
  const measured = durations?.get(step.stepKey);
  const active = measured && measured.activeMin !== null ? measured.activeMin : null;
  const wait = measured && measured.waitMin !== null ? measured.waitMin : null;
  if (active === null && wait === null) {
    return { minutes: Math.max(0, step.slaMinutes), measured: false };
  }
  return { minutes: Math.max(0, (active ?? step.slaMinutes) + (wait ?? 0)), measured: true };
}

interface Projection {
  start: Map<string, number>;
  finish: Map<string, number>;
  duration: Map<string, number>;
  projectFinish: number | null;
}

function project(
  steps: readonly SimulationStep[],
  options: {
    now: Date;
    start: Date;
    durations?: ReadonlyMap<string, StepDuration>;
    scenario?: NormalizedScenario;
  }
): Projection {
  const byRef = new Map(steps.map((step) => [step.ref, step]));
  const startMs = options.start.getTime();
  const nowMs = Math.max(options.now.getTime(), startMs);
  const delayByStep = new Map((options.scenario?.delays ?? []).map((d) => [d.stepKey, d.minutes]));
  const factorByArea = new Map(
    (options.scenario?.capacity ?? []).map((c) => [c.areaKey, c.factor])
  );

  const startAt = new Map<string, number>();
  const finishAt = new Map<string, number>();
  const durationOf = new Map<string, number>();
  const visiting = new Set<string>();

  const durationFor = (step: SimulationStep): number => {
    const base = baseDurationMinutes(step, options.durations).minutes;
    const factor = factorByArea.get(step.areaKey) ?? 1;
    const delay = delayByStep.get(step.stepKey) ?? 0;
    return Math.max(0, base / factor + delay);
  };

  const finish = (ref: string): number => {
    const cached = finishAt.get(ref);
    if (cached !== undefined) return cached;
    const step = byRef.get(ref);
    if (!step || visiting.has(ref)) return startMs;
    visiting.add(ref);
    const dependencies = step.dependsOn.map(finish);
    const depsDone = dependencies.length > 0 ? Math.max(startMs, ...dependencies) : startMs;
    const minutes = durationFor(step);
    durationOf.set(ref, minutes);
    let begin: number;
    let end: number;
    if (TERMINAL_STATUSES.has(step.status)) {
      end = step.completedAt ? step.completedAt.getTime() : depsDone;
      begin = step.startedAt ? step.startedAt.getTime() : Math.min(end, depsDone);
    } else if (IN_FLIGHT_STATUSES.has(step.status)) {
      begin = step.startedAt ? step.startedAt.getTime() : Math.max(nowMs, depsDone);
      end = Math.max(nowMs, begin + minutes * MINUTE);
    } else {
      begin = Math.max(nowMs, depsDone);
      end = begin + minutes * MINUTE;
    }
    visiting.delete(ref);
    startAt.set(ref, begin);
    finishAt.set(ref, end);
    return end;
  };

  for (const step of steps) finish(step.ref);
  const values = steps.map((step) => finishAt.get(step.ref) ?? startMs);
  return {
    start: startAt,
    finish: finishAt,
    duration: durationOf,
    projectFinish: values.length > 0 ? Math.max(...values) : null,
  };
}

/** Holgura por paso (pase hacia atrás): minutos antes de mover el final del expediente. */
function slackByRef(steps: readonly SimulationStep[], projection: Projection): Map<string, number> {
  const successors = new Map<string, string[]>();
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      const list = successors.get(dependency) ?? [];
      list.push(step.ref);
      successors.set(dependency, list);
    }
  }
  const projectFinish = projection.projectFinish ?? 0;
  const latestFinish = new Map<string, number>();
  const visiting = new Set<string>();

  const latest = (ref: string): number => {
    const cached = latestFinish.get(ref);
    if (cached !== undefined) return cached;
    if (visiting.has(ref)) return projectFinish;
    visiting.add(ref);
    const next = successors.get(ref) ?? [];
    let value: number;
    if (next.length === 0) {
      value = projectFinish;
    } else {
      value = Math.min(
        ...next.map((successor) => {
          const duration = (projection.duration.get(successor) ?? 0) * MINUTE;
          return latest(successor) - duration;
        })
      );
    }
    visiting.delete(ref);
    latestFinish.set(ref, value);
    return value;
  };

  const slack = new Map<string, number>();
  for (const step of steps) {
    const finish = projection.finish.get(step.ref) ?? 0;
    slack.set(step.ref, Math.round((latest(step.ref) - finish) / MINUTE));
  }
  return slack;
}

export interface SimulateCaseInput {
  steps: readonly SimulationStep[];
  durations?: ReadonlyMap<string, StepDuration>;
  now: Date;
  start?: Date;
  promisedAt?: Date | null;
  caseId?: string | null;
  caseNumber?: string | null;
  processKey?: string;
}

/** Simula un expediente con y sin escenario y devuelve la diferencia paso a paso. */
export function simulateCase(
  input: SimulateCaseInput,
  scenario: SimulationScenario = {}
): CaseSimulation {
  const normalized = normalizeScenario(scenario);
  const start = input.start ?? input.now;
  const baseline = project(input.steps, { now: input.now, start, durations: input.durations });
  const withScenario = project(input.steps, {
    now: input.now,
    start,
    durations: input.durations,
    scenario: normalized,
  });
  const slack = slackByRef(input.steps, withScenario);
  const promised = input.promisedAt ? input.promisedAt.getTime() : null;

  const steps: SimulatedStep[] = input.steps.map((step) => {
    const before = baseline.finish.get(step.ref) ?? start.getTime();
    const after = withScenario.finish.get(step.ref) ?? start.getTime();
    const slackMin = slack.get(step.ref) ?? 0;
    return {
      ref: step.ref,
      stepKey: step.stepKey,
      scopeKey: step.scopeKey,
      label: step.label,
      areaKey: step.areaKey,
      areaLabel: isAreaKey(step.areaKey) ? AREA_LABELS[step.areaKey] : step.areaKey,
      status: step.status,
      durationMin: Math.round(withScenario.duration.get(step.ref) ?? 0),
      baselineFinish: new Date(before).toISOString(),
      scenarioFinish: new Date(after).toISOString(),
      shiftMinutes: Math.round((after - before) / MINUTE),
      slackMin,
      critical: slackMin <= 0 && !TERMINAL_STATUSES.has(step.status),
    };
  });
  steps.sort(
    (a, b) => a.scenarioFinish.localeCompare(b.scenarioFinish) || a.ref.localeCompare(b.ref)
  );

  const measuredSteps = input.steps.filter(
    (step) => baseDurationMinutes(step, input.durations).measured
  ).length;

  return {
    caseId: input.caseId ?? null,
    caseNumber: input.caseNumber ?? null,
    processKey: input.processKey ?? SALES_FULFILLMENT_BLUEPRINT.processKey,
    start: start.toISOString(),
    baselineFinish:
      baseline.projectFinish === null ? null : new Date(baseline.projectFinish).toISOString(),
    scenarioFinish:
      withScenario.projectFinish === null
        ? null
        : new Date(withScenario.projectFinish).toISOString(),
    shiftMinutes:
      baseline.projectFinish !== null && withScenario.projectFinish !== null
        ? Math.round((withScenario.projectFinish - baseline.projectFinish) / MINUTE)
        : 0,
    promisedAt: input.promisedAt ? input.promisedAt.toISOString() : null,
    lateBefore:
      promised !== null && baseline.projectFinish !== null
        ? baseline.projectFinish > promised
        : null,
    lateAfter:
      promised !== null && withScenario.projectFinish !== null
        ? withScenario.projectFinish > promised
        : null,
    steps,
    criticalPath: steps.filter((step) => step.critical).map((step) => step.ref),
    measuredSteps,
    scenario: normalized,
  };
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

/** Duración medida por paso desde `CtStepMetricDaily` (ponderada por pasos cerrados). */
export async function loadStepDurations(
  processKey: string = SALES_FULFILLMENT_BLUEPRINT.processKey,
  options: { days?: number; now?: Date } = {}
): Promise<Map<string, StepDuration>> {
  const now = options.now ?? new Date();
  const days = Math.min(Math.max(options.days ?? DURATION_WINDOW_DAYS, 1), 400);
  const from = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.ctStepMetricDaily.findMany({
    where: { processKey, day: { gte: from } },
    select: { stepKey: true, completed: true, p50ActiveMin: true, p50WaitMin: true },
    take: 20_000,
  });
  const acc = new Map<string, { active: number; wait: number; weight: number; samples: number }>();
  for (const row of rows) {
    const weight = Math.max(row.completed, 0);
    if (weight === 0) continue;
    const entry = acc.get(row.stepKey) ?? { active: 0, wait: 0, weight: 0, samples: 0 };
    entry.active += (row.p50ActiveMin ?? 0) * weight;
    entry.wait += (row.p50WaitMin ?? 0) * weight;
    entry.weight += weight;
    entry.samples += weight;
    acc.set(row.stepKey, entry);
  }
  const out = new Map<string, StepDuration>();
  for (const [stepKey, entry] of acc) {
    if (entry.weight === 0) continue;
    out.set(stepKey, {
      activeMin: Math.round((entry.active / entry.weight) * 10) / 10,
      waitMin: Math.round((entry.wait / entry.weight) * 10) / 10,
      samples: entry.samples,
    });
  }
  return out;
}

interface CaseStepRow {
  caseId: string;
  stepKey: string;
  scopeKey: string;
  areaKey: string;
  status: string;
  slaMinutes: number;
  dependsOn: string[];
  dueAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

function toSimulationSteps(
  rows: readonly CaseStepRow[],
  labels: ReadonlyMap<string, string>
): SimulationStep[] {
  return rows.map((row) => ({
    ref: `${row.stepKey}:${row.scopeKey}`,
    stepKey: row.stepKey,
    scopeKey: row.scopeKey,
    label: labels.get(row.stepKey) ?? row.stepKey,
    areaKey: row.areaKey,
    dependsOn: [...row.dependsOn],
    status: row.status,
    slaMinutes: row.slaMinutes,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    dueAt: row.dueAt,
  }));
}

async function blueprintLabels(processVersionId: string | null): Promise<Map<string, string>> {
  if (processVersionId) {
    try {
      const { blueprint } = await loadProcessBlueprint(prisma, processVersionId);
      return new Map(blueprint.steps.map((step) => [step.key, step.label]));
    } catch {
      // Versión corrupta o borrada: se usan las claves como etiqueta.
    }
  }
  return new Map(SALES_FULFILLMENT_BLUEPRINT.steps.map((step) => [step.key, step.label]));
}

/** Simulación de UN expediente por su id. */
export async function simulateCaseById(
  actor: CurrentUser,
  input: { caseId: string; scenario?: SimulationScenario; now?: Date }
): Promise<CaseSimulation> {
  assertControlTowerAccess(actor);
  const now = input.now ?? new Date();
  const opCase = await prisma.operationalCase.findUnique({
    where: { id: input.caseId },
    select: {
      id: true,
      caseNumber: true,
      promisedAt: true,
      openedAt: true,
      processVersionId: true,
    },
  });
  if (!opCase) throw new OperationsError('not_found', 'No encontramos ese expediente');
  const [steps, labels] = await Promise.all([
    prisma.caseStep.findMany({
      where: { caseId: opCase.id },
      select: {
        caseId: true,
        stepKey: true,
        scopeKey: true,
        areaKey: true,
        status: true,
        slaMinutes: true,
        dependsOn: true,
        dueAt: true,
        startedAt: true,
        completedAt: true,
      },
    }),
    blueprintLabels(opCase.processVersionId),
  ]);
  const durations = await loadStepDurations(SALES_FULFILLMENT_BLUEPRINT.processKey, { now });
  return simulateCase(
    {
      steps: toSimulationSteps(steps, labels),
      durations,
      now,
      start: opCase.openedAt,
      promisedAt: opCase.promisedAt,
      caseId: opCase.id,
      caseNumber: opCase.caseNumber,
    },
    input.scenario ?? {}
  );
}

/** Simulación sobre el blueprint (sin expediente): "qué pasaría en una venta nueva". */
export async function simulateBlueprint(
  actor: CurrentUser,
  input: { scenario?: SimulationScenario; now?: Date } = {}
): Promise<CaseSimulation> {
  assertControlTowerAccess(actor);
  const now = input.now ?? new Date();
  const durations = await loadStepDurations(SALES_FULFILLMENT_BLUEPRINT.processKey, { now });
  const steps: SimulationStep[] = SALES_FULFILLMENT_BLUEPRINT.steps.map((step) => ({
    ref: `${step.key}:`,
    stepKey: step.key,
    scopeKey: '',
    label: step.label,
    areaKey: step.areaKey,
    dependsOn: step.dependsOn.map((dependency) => `${dependency}:`),
    status: 'pending',
    slaMinutes: step.slaMinutes,
    startedAt: null,
    completedAt: null,
    dueAt: null,
  }));
  return simulateCase({ steps, durations, now, caseNumber: null }, input.scenario ?? {});
}

export interface ApplyToOpenCasesResult {
  evaluated: number;
  /** Expedientes que incumplirían `promisedAt` con el escenario. */
  breaching: Array<{
    caseId: string;
    caseNumber: string;
    customerName: string | null;
    promisedAt: string;
    baselineFinish: string | null;
    scenarioFinish: string | null;
    shiftMinutes: number;
    lateBefore: boolean;
    newlyLate: boolean;
    ownerUserId: string;
  }>;
  /** Había más expedientes abiertos de los que cabían en el tope. */
  truncated: boolean;
  scenario: NormalizedScenario;
  computedAt: string;
}

/**
 * Aplica el escenario a los expedientes abiertos con fecha prometida (≤500) y
 * lista los que incumplirían. Una sola consulta de pasos para todos.
 */
export async function applyToOpenCases(
  actor: CurrentUser,
  input: { scenario?: SimulationScenario; limit?: number; now?: Date } = {}
): Promise<ApplyToOpenCasesResult> {
  assertControlTowerAccess(actor);
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? APPLY_CASE_LIMIT, 1), APPLY_CASE_LIMIT);
  const where: Prisma.OperationalCaseWhereInput = {
    status: { in: [...CASE_OPEN_STATUSES] },
    promisedAt: { not: null },
  };
  const [cases, total] = await Promise.all([
    prisma.operationalCase.findMany({
      where,
      orderBy: [{ promisedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        caseNumber: true,
        customerName: true,
        promisedAt: true,
        openedAt: true,
        ownerUserId: true,
        processVersionId: true,
      },
    }),
    prisma.operationalCase.count({ where }),
  ]);
  if (cases.length === 0) {
    return {
      evaluated: 0,
      breaching: [],
      truncated: false,
      scenario: normalizeScenario(input.scenario ?? {}),
      computedAt: now.toISOString(),
    };
  }

  const caseIds = cases.map((row) => row.id);
  const [stepRows, durations, labels] = await Promise.all([
    prisma.caseStep.findMany({
      where: { caseId: { in: caseIds } },
      select: {
        caseId: true,
        stepKey: true,
        scopeKey: true,
        areaKey: true,
        status: true,
        slaMinutes: true,
        dependsOn: true,
        dueAt: true,
        startedAt: true,
        completedAt: true,
      },
      take: 20_000,
    }),
    loadStepDurations(SALES_FULFILLMENT_BLUEPRINT.processKey, { now }),
    blueprintLabels(cases[0].processVersionId),
  ]);

  const byCase = new Map<string, CaseStepRow[]>();
  for (const row of stepRows) {
    const list = byCase.get(row.caseId) ?? [];
    list.push(row);
    byCase.set(row.caseId, list);
  }

  const breaching: ApplyToOpenCasesResult['breaching'] = [];
  for (const row of cases) {
    const steps = byCase.get(row.id) ?? [];
    if (steps.length === 0) continue;
    const simulation = simulateCase(
      {
        steps: toSimulationSteps(steps, labels),
        durations,
        now,
        start: row.openedAt,
        promisedAt: row.promisedAt,
        caseId: row.id,
        caseNumber: row.caseNumber,
      },
      input.scenario ?? {}
    );
    if (simulation.lateAfter !== true) continue;
    breaching.push({
      caseId: row.id,
      caseNumber: row.caseNumber,
      customerName: row.customerName,
      promisedAt: row.promisedAt!.toISOString(),
      baselineFinish: simulation.baselineFinish,
      scenarioFinish: simulation.scenarioFinish,
      shiftMinutes: simulation.shiftMinutes,
      lateBefore: simulation.lateBefore === true,
      newlyLate: simulation.lateBefore !== true,
      ownerUserId: row.ownerUserId,
    });
  }
  breaching.sort(
    (a, b) =>
      Number(b.newlyLate) - Number(a.newlyLate) ||
      b.shiftMinutes - a.shiftMinutes ||
      a.promisedAt.localeCompare(b.promisedAt)
  );

  return {
    evaluated: cases.length,
    breaching,
    truncated: total > cases.length,
    scenario: normalizeScenario(input.scenario ?? {}),
    computedAt: now.toISOString(),
  };
}
