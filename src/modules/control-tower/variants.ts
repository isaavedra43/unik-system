import { createHash } from 'node:crypto';

/**
 * Variantes de proceso y retrabajo (plan 7.9). Módulo PURO.
 *
 * Una variante es la secuencia de pasos completados de un expediente. Dos
 * expedientes que recorrieron el mismo camino comparten `variantHash`, así la
 * tabla de variantes agrupa cientos de expedientes en unas pocas filas.
 *
 * El hash se calcula en TypeScript (no en SQL) para que sea estable entre
 * motores y versiones: SHA-1 de las claves unidas por `>` recortado a 16
 * caracteres. Mismo orden ⇒ mismo hash; distinto orden ⇒ distinto hash.
 */

/** Tope de pasos que entran en la firma de una variante (un expediente sano tiene ~15). */
export const VARIANT_SEQUENCE_LIMIT = 200;

/** Secuencia normalizada: sin vacíos, recortada y con tope. */
export function normalizeSequence(sequence: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const entry of sequence) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim();
    if (!key) continue;
    out.push(key);
    if (out.length >= VARIANT_SEQUENCE_LIMIT) break;
  }
  return out;
}

/** Hash estable de una secuencia de pasos (16 hex). Una secuencia vacía tiene su propio hash. */
export function variantHash(sequence: readonly string[]): string {
  return createHash('sha1')
    .update(normalizeSequence(sequence).join('>'))
    .digest('hex')
    .slice(0, 16);
}

/** Texto legible de la variante: `Verificar disponibilidad → Reservar existencia → …`. */
export function describeVariant(
  sequence: readonly string[],
  labels?: ReadonlyMap<string, string>,
  maxSteps = 8
): string {
  const steps = normalizeSequence(sequence);
  if (steps.length === 0) return 'Sin pasos completados';
  const shown = steps
    .slice(0, maxSteps)
    .map((key) => labels?.get(key) ?? key)
    .join(' → ');
  return steps.length > maxSteps ? `${shown} → … (${steps.length} pasos)` : shown;
}

// ---------------------------------------------------------------------------
// Retrabajo
// ---------------------------------------------------------------------------

export interface StepActivation {
  stepKey: string;
  scopeKey?: string;
}

export interface ReworkResult {
  /** Activaciones extra: un paso activado 3 veces suma 2. */
  count: number;
  /** Claves de paso que se repitieron, de mayor a menor. */
  steps: Array<{ stepKey: string; activations: number }>;
}

/**
 * Cuenta el retrabajo: cada (paso, alcance) activado más de una vez. Recibe las
 * activaciones (`step.started` y `step.reopened`) del expediente.
 */
export function countRework(activations: readonly StepActivation[]): ReworkResult {
  const byRef = new Map<string, number>();
  const byStep = new Map<string, number>();
  for (const activation of activations) {
    const stepKey = typeof activation?.stepKey === 'string' ? activation.stepKey.trim() : '';
    if (!stepKey) continue;
    const scopeKey = typeof activation.scopeKey === 'string' ? activation.scopeKey : '';
    const ref = `${stepKey}\x00${scopeKey}`;
    byRef.set(ref, (byRef.get(ref) ?? 0) + 1);
  }
  let count = 0;
  for (const [ref, times] of byRef) {
    if (times <= 1) continue;
    const stepKey = ref.split('\x00')[0];
    count += times - 1;
    byStep.set(stepKey, (byStep.get(stepKey) ?? 0) + times - 1);
  }
  return {
    count,
    steps: [...byStep.entries()]
      .map(([stepKey, activations_]) => ({ stepKey, activations: activations_ }))
      .sort((a, b) => b.activations - a.activations || a.stepKey.localeCompare(b.stepKey)),
  };
}

// ---------------------------------------------------------------------------
// Resumen de variantes
// ---------------------------------------------------------------------------

/** Percentil lineal (p ∈ [0,1]) de una lista de números. Null si no hay datos. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.min(Math.max(p, 0), 1);
  const position = clamped * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export interface VariantCaseRow {
  caseId: string;
  variantHash: string;
  sequence: string[];
  durationMin: number | null;
  conformant: boolean;
  reworkCount: number;
}

export interface VariantSummary {
  variantHash: string;
  sequence: string[];
  label: string;
  cases: number;
  /** 0–100 con un decimal. */
  sharePct: number;
  p50DurationMin: number | null;
  p90DurationMin: number | null;
  conformantCases: number;
  conformancePct: number;
  reworkCases: number;
  exampleCaseIds: string[];
}

/** Agrupa expedientes por variante, de la más frecuente a la menos. */
export function summarizeVariants(
  rows: readonly VariantCaseRow[],
  labels?: ReadonlyMap<string, string>
): VariantSummary[] {
  const groups = new Map<
    string,
    { sequence: string[]; durations: number[]; conformant: number; rework: number; cases: string[] }
  >();
  for (const row of rows) {
    const key = row.variantHash;
    let group = groups.get(key);
    if (!group) {
      group = { sequence: row.sequence ?? [], durations: [], conformant: 0, rework: 0, cases: [] };
      groups.set(key, group);
    }
    if (typeof row.durationMin === 'number' && Number.isFinite(row.durationMin)) {
      group.durations.push(row.durationMin);
    }
    if (row.conformant) group.conformant += 1;
    if (row.reworkCount > 0) group.rework += 1;
    if (group.cases.length < 5) group.cases.push(row.caseId);
  }
  const total = rows.length;
  return [...groups.entries()]
    .map(([variantHash, group]) => {
      const cases = rows.filter((row) => row.variantHash === variantHash).length;
      return {
        variantHash,
        sequence: group.sequence,
        label: describeVariant(group.sequence, labels),
        cases,
        sharePct: total === 0 ? 0 : Math.round((cases / total) * 1000) / 10,
        p50DurationMin: round1(percentile(group.durations, 0.5)),
        p90DurationMin: round1(percentile(group.durations, 0.9)),
        conformantCases: group.conformant,
        conformancePct: cases === 0 ? 0 : Math.round((group.conformant / cases) * 1000) / 10,
        reworkCases: group.rework,
        exampleCaseIds: group.cases,
      };
    })
    .sort((a, b) => b.cases - a.cases || a.variantHash.localeCompare(b.variantHash));
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Cuellos de botella
// ---------------------------------------------------------------------------

export interface StepMetricRow {
  stepKey: string;
  areaKey: string;
  started: number;
  completed: number;
  p50ActiveMin: number | null;
  p90ActiveMin: number | null;
  p50WaitMin: number | null;
  p90WaitMin: number | null;
  breached: number;
  reworked: number;
}

export interface BottleneckRow extends StepMetricRow {
  label: string;
  /** Minutos de espera acumulados que explica el paso (`p90WaitMin × started`). */
  impactMin: number;
  breachPct: number;
}

/**
 * Ranking de cuellos de botella: el paso que acumula más espera en el total de
 * expedientes, no el que tarda más en un caso suelto (plan 7.9:
 * `ORDER BY SUM(p90WaitMin*started) DESC`).
 */
export function rankBottlenecks(
  rows: readonly StepMetricRow[],
  labels?: ReadonlyMap<string, string>,
  limit = 10
): BottleneckRow[] {
  const merged = new Map<string, StepMetricRow>();
  for (const row of rows) {
    const current = merged.get(row.stepKey);
    if (!current) {
      merged.set(row.stepKey, { ...row });
      continue;
    }
    merged.set(row.stepKey, {
      ...current,
      started: current.started + row.started,
      completed: current.completed + row.completed,
      breached: current.breached + row.breached,
      reworked: current.reworked + row.reworked,
      p50ActiveMin: maxOf(current.p50ActiveMin, row.p50ActiveMin),
      p90ActiveMin: maxOf(current.p90ActiveMin, row.p90ActiveMin),
      p50WaitMin: maxOf(current.p50WaitMin, row.p50WaitMin),
      p90WaitMin: maxOf(current.p90WaitMin, row.p90WaitMin),
    });
  }
  return [...merged.values()]
    .map((row) => ({
      ...row,
      label: labels?.get(row.stepKey) ?? row.stepKey,
      impactMin: Math.round((row.p90WaitMin ?? row.p90ActiveMin ?? 0) * Math.max(row.started, 0)),
      breachPct: row.completed === 0 ? 0 : Math.round((row.breached / row.completed) * 1000) / 10,
    }))
    .sort((a, b) => b.impactMin - a.impactMin || b.breached - a.breached)
    .slice(0, Math.max(1, limit));
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
