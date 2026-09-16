/**
 * Conformidad de un expediente contra su blueprint (plan 7.9).
 *
 * Módulo PURO (sin Prisma, sin servidor): recibe la definición guardada en
 * `ProcessVersion.definition` y la secuencia observada de pasos completados
 * (`step.completed`, en orden de `occurredAt, id`) y responde qué se salió del
 * proceso. Lo usan la proyección `CtCaseVariant`, el explorador de variantes y
 * las pruebas.
 *
 * Qué SÍ es una desviación:
 * - `unknown_step`: se completó un paso que la versión del proceso no define
 *   (blueprint cambiado a mano, migración a medias, dato corrupto).
 * - `out_of_order`: un paso se completó ANTES que una dependencia que también
 *   se completó (el motor nunca lo hace; si aparece, alguien forzó el estado).
 * - `missing_final` (sólo en expedientes cerrados): el proceso terminó sin
 *   completar un paso final obligatorio.
 *
 * Qué NO es una desviación:
 * - Que falte una dependencia que nunca ocurrió: los pasos por asignación
 *   (`appliesTo`) y los condicionados (`entryCondition`) se saltan a propósito.
 * - Repetir un paso: eso es RETRABAJO y se cuenta aparte (`variants.ts`), tal
 *   como el esquema separa `conformant` de `reworkCount`.
 */

export type ConformanceViolationKind = 'unknown_step' | 'out_of_order' | 'missing_final';

export interface ConformanceViolation {
  kind: ConformanceViolationKind;
  stepKey: string;
  /** Frase en español lista para mostrar. */
  detail: string;
}

/** Paso del proceso como lo necesita la conformidad (subconjunto de `StepDef`). */
export interface ConformanceStep {
  key: string;
  label?: string;
  areaKey?: string;
  dependsOn: readonly string[];
  /** Sólo existe para ciertas fuentes de asignación ⇒ saltarlo es normal. */
  appliesTo?: readonly string[];
  /** Se evalúa al entrar ⇒ saltarlo es normal. */
  entryCondition?: string | null;
  scope?: string;
}

export interface ConformanceDefinition {
  processKey: string;
  version: number;
  steps: ConformanceStep[];
}

/** Paso observado; `scopeKey` distingue la misma clave en necesidades distintas. */
export interface ObservedStep {
  stepKey: string;
  scopeKey?: string;
  at?: string | Date | number | null;
}

export interface ConformanceResult {
  conformant: boolean;
  violations: ConformanceViolation[];
  /** Pasos observados (con repeticiones). */
  observed: number;
  /** Claves distintas observadas que el proceso define. */
  covered: number;
  /** Pasos que la definición declara. */
  defined: number;
  /** 0–1: proporción de pasos definidos que se completaron al menos una vez. */
  coverage: number;
}

export interface CheckConformanceOptions {
  /** El expediente ya cerró: se exige haber completado los pasos finales obligatorios. */
  closed?: boolean;
}

const MAX_VIOLATIONS = 50;

/** Un paso es opcional cuando el proceso puede saltarlo legítimamente. */
export function isOptionalStep(step: ConformanceStep): boolean {
  return Boolean((step.appliesTo && step.appliesTo.length > 0) || step.entryCondition);
}

/** Pasos que nadie declara como dependencia: el final del proceso. */
export function finalSteps(steps: readonly ConformanceStep[]): ConformanceStep[] {
  const referenced = new Set<string>();
  for (const step of steps) for (const dep of step.dependsOn) referenced.add(dep);
  return steps.filter((step) => !referenced.has(step.key));
}

function normalizeObserved(
  observed: readonly (string | ObservedStep)[]
): Array<{ stepKey: string; scopeKey: string }> {
  const out: Array<{ stepKey: string; scopeKey: string }> = [];
  for (const entry of observed) {
    if (typeof entry === 'string') {
      const key = entry.trim();
      if (key) out.push({ stepKey: key, scopeKey: '' });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const key = typeof entry.stepKey === 'string' ? entry.stepKey.trim() : '';
    if (!key) continue;
    out.push({ stepKey: key, scopeKey: typeof entry.scopeKey === 'string' ? entry.scopeKey : '' });
  }
  return out;
}

/**
 * Compara la secuencia observada contra la definición. El orden de la lista ES
 * el orden en que ocurrieron los pasos (la consulta los trae por `occurredAt, id`).
 */
export function checkConformance(
  definition: ConformanceDefinition,
  observed: readonly (string | ObservedStep)[],
  options: CheckConformanceOptions = {}
): ConformanceResult {
  const steps = definition.steps ?? [];
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const entries = normalizeObserved(observed);
  const violations: ConformanceViolation[] = [];
  const push = (violation: ConformanceViolation) => {
    if (violations.length < MAX_VIOLATIONS) violations.push(violation);
  };

  /** Primera posición en que se completó cada (paso, alcance) y cada paso. */
  const firstByRef = new Map<string, number>();
  const firstByKey = new Map<string, number>();
  const unknownReported = new Set<string>();

  entries.forEach((entry, index) => {
    const ref = `${entry.stepKey}\x00${entry.scopeKey}`;
    if (!firstByRef.has(ref)) firstByRef.set(ref, index);
    if (!firstByKey.has(entry.stepKey)) firstByKey.set(entry.stepKey, index);
    if (!byKey.has(entry.stepKey) && !unknownReported.has(entry.stepKey)) {
      unknownReported.add(entry.stepKey);
      push({
        kind: 'unknown_step',
        stepKey: entry.stepKey,
        detail: `El paso «${entry.stepKey}» no existe en ${definition.processKey}@${definition.version}`,
      });
    }
  });

  for (const [stepKey, position] of firstByKey) {
    const step = byKey.get(stepKey);
    if (!step) continue;
    for (const dependency of step.dependsOn) {
      const dependencyPosition = firstByKey.get(dependency);
      if (dependencyPosition === undefined) continue; // nunca ocurrió: paso saltado, no es desviación
      if (dependencyPosition > position) {
        const depStep = byKey.get(dependency);
        push({
          kind: 'out_of_order',
          stepKey,
          detail: `«${step.label ?? stepKey}» se completó antes que «${depStep?.label ?? dependency}», del que depende`,
        });
      }
    }
  }

  if (options.closed) {
    for (const step of finalSteps(steps)) {
      if (isOptionalStep(step)) continue;
      if (firstByKey.has(step.key)) continue;
      push({
        kind: 'missing_final',
        stepKey: step.key,
        detail: `El expediente cerró sin completar «${step.label ?? step.key}»`,
      });
    }
  }

  const covered = [...firstByKey.keys()].filter((key) => byKey.has(key)).length;
  const defined = steps.length;
  return {
    conformant: violations.length === 0,
    violations,
    observed: entries.length,
    covered,
    defined,
    coverage: defined === 0 ? 0 : Math.round((covered / defined) * 1000) / 1000,
  };
}

/**
 * Lee una definición guardada (`ProcessVersion.definition`, JSON) y la deja en
 * la forma que necesita la conformidad. Devuelve null si el JSON no tiene la
 * forma esperada: la proyección salta ese expediente en vez de romperse.
 */
export function toConformanceDefinition(value: unknown): ConformanceDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const processKey = typeof raw.processKey === 'string' ? raw.processKey : '';
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (!processKey || !Array.isArray(raw.steps)) return null;
  const steps: ConformanceStep[] = [];
  for (const item of raw.steps) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const step = item as Record<string, unknown>;
    const key = typeof step.key === 'string' ? step.key : '';
    if (!key) continue;
    steps.push({
      key,
      ...(typeof step.label === 'string' ? { label: step.label } : {}),
      ...(typeof step.areaKey === 'string' ? { areaKey: step.areaKey } : {}),
      dependsOn: Array.isArray(step.dependsOn)
        ? step.dependsOn.filter((dep): dep is string => typeof dep === 'string')
        : [],
      ...(Array.isArray(step.appliesTo)
        ? { appliesTo: step.appliesTo.filter((s): s is string => typeof s === 'string') }
        : {}),
      ...(typeof step.entryCondition === 'string' ? { entryCondition: step.entryCondition } : {}),
      ...(typeof step.scope === 'string' ? { scope: step.scope } : {}),
    });
  }
  return steps.length > 0 ? { processKey, version, steps } : null;
}

/** Etiquetas por clave de paso (para el visor y las tablas). */
export function stepLabels(definition: ConformanceDefinition): Map<string, string> {
  return new Map(definition.steps.map((step) => [step.key, step.label ?? step.key]));
}
