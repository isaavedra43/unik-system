import type { AreaKey, StepKind, StepScope } from '../types';
import type { ProcessBlueprint, StepDef } from './types';

/**
 * Pure instantiation of a blueprint for a case (plan section 2.3).
 *
 * One `CaseStep` per case-scoped step, per active demand for demand-scoped
 * steps and per active allocation (whose source is in `appliesTo`) for
 * allocation-scoped steps. `scopeKey` is `''`, the demand id or the
 * allocation id. Dependencies are resolved to concrete step references
 * (`stepKey:scopeKey`) by scope:
 *
 * - same scope → the instance of the same case / demand / allocation;
 * - coarser dependency (e.g. an allocation step depending on a demand step) →
 *   the ancestor instance;
 * - finer dependency (a case step depending on allocation steps) → every
 *   instance inside its scope, plus every demand-level ancestor of those
 *   steps, so the case step also waits until every demand has been planned.
 *
 * Cancelled demands and allocations produce no instances. The function is
 * idempotent: the engine compares its output with the stored steps to create
 * missing ones and refresh the dependencies of steps not started yet.
 */

export interface InstantiateDemand {
  id: string;
  status: string;
}

export interface InstantiateAllocation {
  id: string;
  demandId: string;
  source: string;
  status: string;
}

export interface InstantiateInput {
  demands: InstantiateDemand[];
  allocations: InstantiateAllocation[];
}

export interface StepInstance {
  stepKey: string;
  scope: StepScope;
  scopeKey: string;
  demandId: string | null;
  allocationId: string | null;
  areaKey: AreaKey;
  kind: StepKind;
  slaMinutes: number;
  /** Resolved references `stepKey:scopeKey`, sorted. */
  dependsOn: string[];
  /** Position of the step in the blueprint (for deterministic ordering). */
  order: number;
}

const SCOPE_RANK: Record<StepScope, number> = { case: 0, demand: 1, allocation: 2 };

export function stepRef(stepKey: string, scopeKey: string): string {
  return `${stepKey}:${scopeKey}`;
}

export function parseStepRef(ref: string): { stepKey: string; scopeKey: string } {
  const index = ref.indexOf(':');
  return index < 0
    ? { stepKey: ref, scopeKey: '' }
    : { stepKey: ref.slice(0, index), scopeKey: ref.slice(index + 1) };
}

function activeDemands(input: InstantiateInput): InstantiateDemand[] {
  return input.demands.filter((demand) => demand.status !== 'cancelled');
}

function activeAllocations(input: InstantiateInput): InstantiateAllocation[] {
  const demandIds = new Set(activeDemands(input).map((demand) => demand.id));
  return input.allocations.filter(
    (allocation) => allocation.status !== 'cancelled' && demandIds.has(allocation.demandId)
  );
}

function appliesTo(step: StepDef, allocation: InstantiateAllocation): boolean {
  return !step.appliesTo || (step.appliesTo as readonly string[]).includes(allocation.source);
}

interface ScopeTarget {
  scope: StepScope;
  scopeKey: string;
  demandId: string | null;
  allocationId: string | null;
}

function targetsOf(step: StepDef, input: InstantiateInput): ScopeTarget[] {
  switch (step.scope) {
    case 'case':
      return [{ scope: 'case', scopeKey: '', demandId: null, allocationId: null }];
    case 'demand':
      return activeDemands(input).map((demand) => ({
        scope: 'demand',
        scopeKey: demand.id,
        demandId: demand.id,
        allocationId: null,
      }));
    case 'allocation':
      return activeAllocations(input)
        .filter((allocation) => appliesTo(step, allocation))
        .map((allocation) => ({
          scope: 'allocation',
          scopeKey: allocation.id,
          demandId: allocation.demandId,
          allocationId: allocation.id,
        }));
  }
}

/** Demand-scoped (or finer) steps a step transitively depends on. */
function ancestorsFinerThan(
  blueprint: ProcessBlueprint,
  stepKey: string,
  rank: number,
  seen = new Set<string>()
): StepDef[] {
  const step = blueprint.steps.find((candidate) => candidate.key === stepKey);
  if (!step) return [];
  const result: StepDef[] = [];
  for (const dependencyKey of step.dependsOn) {
    if (seen.has(dependencyKey)) continue;
    seen.add(dependencyKey);
    const dependency = blueprint.steps.find((candidate) => candidate.key === dependencyKey);
    if (!dependency) continue;
    if (SCOPE_RANK[dependency.scope] > rank) result.push(dependency);
    result.push(...ancestorsFinerThan(blueprint, dependencyKey, rank, seen));
  }
  return result;
}

function resolveDependencies(
  blueprint: ProcessBlueprint,
  step: StepDef,
  target: ScopeTarget,
  input: InstantiateInput,
  instancesByKey: Map<string, ScopeTarget[]>
): string[] {
  const refs = new Set<string>();
  const allocations = activeAllocations(input);
  const withinTarget = (candidate: ScopeTarget): boolean => {
    if (target.scope === 'case') return true;
    if (target.scope === 'demand') return candidate.demandId === target.demandId;
    return candidate.allocationId === target.allocationId;
  };

  for (const dependencyKey of step.dependsOn) {
    const dependency = blueprint.steps.find((candidate) => candidate.key === dependencyKey);
    if (!dependency) continue;
    const dependencyRank = SCOPE_RANK[dependency.scope];
    const ownRank = SCOPE_RANK[step.scope];
    const instances = instancesByKey.get(dependencyKey) ?? [];

    if (dependencyRank === ownRank) {
      const same = instances.find((candidate) => candidate.scopeKey === target.scopeKey);
      if (same) refs.add(stepRef(dependencyKey, same.scopeKey));
      continue;
    }

    if (dependencyRank < ownRank) {
      // Ancestor instance: the demand of this allocation, or the case.
      let scopeKey = '';
      if (dependency.scope === 'demand') {
        const demandId =
          target.demandId ??
          allocations.find((allocation) => allocation.id === target.allocationId)?.demandId ??
          null;
        if (!demandId) continue;
        scopeKey = demandId;
      }
      if (instances.some((candidate) => candidate.scopeKey === scopeKey)) {
        refs.add(stepRef(dependencyKey, scopeKey));
      }
      continue;
    }

    // Finer dependency: fan-in of every instance inside this scope…
    for (const candidate of instances) {
      if (withinTarget(candidate)) refs.add(stepRef(dependencyKey, candidate.scopeKey));
    }
    // …plus the finer ancestors of that dependency (every demand must be planned first).
    for (const ancestor of ancestorsFinerThan(blueprint, dependencyKey, ownRank)) {
      for (const candidate of instancesByKey.get(ancestor.key) ?? []) {
        if (withinTarget(candidate)) refs.add(stepRef(ancestor.key, candidate.scopeKey));
      }
    }
  }
  return [...refs].sort();
}

export function instantiateSteps(
  blueprint: ProcessBlueprint,
  input: InstantiateInput
): StepInstance[] {
  const instancesByKey = new Map<string, ScopeTarget[]>();
  for (const step of blueprint.steps) instancesByKey.set(step.key, targetsOf(step, input));

  const result: StepInstance[] = [];
  blueprint.steps.forEach((step, order) => {
    for (const target of instancesByKey.get(step.key) ?? []) {
      result.push({
        stepKey: step.key,
        scope: target.scope,
        scopeKey: target.scopeKey,
        demandId: target.demandId,
        allocationId: target.allocationId,
        areaKey: step.areaKey,
        kind: step.kind,
        slaMinutes: step.slaMinutes,
        dependsOn: resolveDependencies(blueprint, step, target, input, instancesByKey),
        order,
      });
    }
  });
  return result;
}

/** A dependency is satisfied when its step is done or skipped (or no longer exists). */
export function dependenciesSatisfied(
  dependsOn: readonly string[],
  statusByRef: ReadonlyMap<string, string>
): boolean {
  return dependsOn.every((ref) => {
    const status = statusByRef.get(ref);
    return (
      status === undefined || status === 'done' || status === 'skipped' || status === 'cancelled'
    );
  });
}

export function sameDependencies(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}
