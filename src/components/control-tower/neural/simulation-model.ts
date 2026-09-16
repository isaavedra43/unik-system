/**
 * Panel de simulación: del formulario al escenario y del resultado a la tabla
 * de diferencias (plan 7.8e). Módulo PURO.
 *
 * El cálculo lo hace `simulation.ts` en el servidor (pase hacia adelante tipo
 * CPM sobre `dependsOn`); aquí sólo se arma el escenario que se le manda y se
 * ordena lo que responde. Ninguna regla de negocio vive en la pantalla.
 */

import type { CaseSimulation, SimulatedStep } from '@/modules/control-tower/simulation';
import type { StatTone } from '@/components/patterns/dashboard/dashboard-utils';
import { areaLabel, formatMinutes } from './neural-model';

/** Los mismos topes que valida el servidor (`/api/simulate`). */
export const MAX_DELAY_MINUTES = 43_200; // 30 días
export const MIN_CAPACITY_FACTOR = 0.1;
export const MAX_CAPACITY_FACTOR = 10;
export const MAX_DELAYS = 50;
export const MAX_CAPACITY_ENTRIES = 20;

export interface ScenarioDraft {
  /** Minutos extra por clave de paso. */
  delays: Record<string, number>;
  /** Factor de capacidad por área (1 = igual, >1 más rápido, <1 más lento). */
  capacity: Record<string, number>;
}

export interface ScenarioPayload {
  delays: Array<{ stepKey: string; minutes: number }>;
  capacity: Array<{ areaKey: string; factor: number }>;
}

export function emptyScenario(): ScenarioDraft {
  return { delays: {}, capacity: {} };
}

/** Error del campo de retraso, en español; `null` si es válido. */
export function delayError(minutes: number): string | null {
  if (!Number.isFinite(minutes)) return 'Escribe los minutos de retraso';
  if (minutes < 0) return 'El retraso no puede ser negativo';
  if (minutes > MAX_DELAY_MINUTES) return 'El retraso máximo es de 30 días';
  return null;
}

/** Error del factor de capacidad (se captura como porcentaje). */
export function capacityError(factor: number): string | null {
  if (!Number.isFinite(factor)) return 'Escribe la capacidad del área';
  if (factor < MIN_CAPACITY_FACTOR) return 'La capacidad mínima es 10 %';
  if (factor > MAX_CAPACITY_FACTOR) return 'La capacidad máxima es 1 000 %';
  return null;
}

/**
 * Escenario listo para el servidor: fuera los retrasos de cero y las
 * capacidades sin cambio (el servidor los descarta igual, pero así la pantalla
 * muestra exactamente lo que se va a calcular).
 */
export function toScenarioPayload(draft: ScenarioDraft): ScenarioPayload {
  const delays = Object.entries(draft.delays)
    .filter(([stepKey, minutes]) => stepKey.trim() && Number.isFinite(minutes) && minutes > 0)
    .slice(0, MAX_DELAYS)
    .map(([stepKey, minutes]) => ({
      stepKey,
      minutes: Math.min(Math.round(minutes), MAX_DELAY_MINUTES),
    }));
  const capacity = Object.entries(draft.capacity)
    .filter(([areaKey, factor]) => areaKey.trim() && Number.isFinite(factor) && factor !== 1)
    .slice(0, MAX_CAPACITY_ENTRIES)
    .map(([areaKey, factor]) => ({
      areaKey,
      factor: Math.min(Math.max(factor, MIN_CAPACITY_FACTOR), MAX_CAPACITY_FACTOR),
    }));
  return { delays, capacity };
}

export function scenarioIsEmpty(draft: ScenarioDraft): boolean {
  const payload = toScenarioPayload(draft);
  return payload.delays.length === 0 && payload.capacity.length === 0;
}

/** Porcentaje de capacidad que se muestra en el control (100 % = igual). */
export function factorToPercent(factor: number): number {
  return Math.round(factor * 100);
}

export function percentToFactor(percent: number): number {
  if (!Number.isFinite(percent)) return 1;
  return Math.round(percent) / 100;
}

/** "40 % más lento" / "el doble de rápido" / "igual que hoy". */
export function capacityLabel(factor: number): string {
  if (!Number.isFinite(factor) || factor === 1) return 'igual que hoy';
  if (factor > 1) {
    const faster = Math.round((1 - 1 / factor) * 100);
    return `${faster} % más rápido`;
  }
  const slower = Math.round((1 / factor - 1) * 100);
  return `${slower} % más lento`;
}

/** Frase del escenario para el encabezado y para el lector de pantalla. */
export function describeScenario(
  draft: ScenarioDraft,
  stepLabels: ReadonlyMap<string, string> = new Map()
): string {
  const payload = toScenarioPayload(draft);
  if (payload.delays.length === 0 && payload.capacity.length === 0) {
    return 'Sin cambios: se proyecta la operación tal como está hoy.';
  }
  const parts: string[] = [];
  for (const delay of payload.delays) {
    parts.push(
      `${stepLabels.get(delay.stepKey) ?? delay.stepKey} +${formatMinutes(delay.minutes)}`
    );
  }
  for (const entry of payload.capacity) {
    parts.push(`${areaLabel(entry.areaKey)} ${capacityLabel(entry.factor)}`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

export interface DiffRow extends SimulatedStep {
  /** El paso se movió con el escenario. */
  changed: boolean;
  tone: StatTone;
  slackLabel: string;
  shiftLabel: string;
}

/** Filas de la tabla de diferencias: primero lo que más se movió. */
export function diffRows(simulation: CaseSimulation | null): DiffRow[] {
  if (!simulation) return [];
  return simulation.steps
    .map((step) => {
      const changed = Math.round(step.shiftMinutes) !== 0;
      return {
        ...step,
        changed,
        tone: stepTone(step),
        slackLabel: step.critical ? 'Sin holgura' : formatMinutes(step.slackMin),
        shiftLabel: changed ? `+${formatMinutes(step.shiftMinutes)}` : 'Sin cambio',
      };
    })
    .sort(
      (a, b) =>
        b.shiftMinutes - a.shiftMinutes ||
        Number(b.critical) - Number(a.critical) ||
        a.label.localeCompare(b.label)
    );
}

function stepTone(step: SimulatedStep): StatTone {
  if (step.shiftMinutes > 0 && step.critical) return 'danger';
  if (step.shiftMinutes > 0) return 'warning';
  if (step.critical) return 'info';
  return 'default';
}

export interface SimulationTile {
  key: string;
  label: string;
  value: string;
  hint?: string;
  tone: StatTone;
}

/** Tiles del resultado: nueva fecha, desplazamiento, promesa y pasos medidos. */
export function simulationTiles(
  simulation: CaseSimulation | null,
  formatDate: (value: string | null) => string
): SimulationTile[] {
  if (!simulation) return [];
  const shift = Math.round(simulation.shiftMinutes);
  const promiseTone: StatTone = simulation.lateAfter
    ? 'danger'
    : simulation.lateBefore
      ? 'warning'
      : simulation.promisedAt
        ? 'success'
        : 'default';
  return [
    {
      key: 'finish',
      label: 'Nueva fecha de término',
      value: formatDate(simulation.scenarioFinish),
      ...(simulation.baselineFinish
        ? { hint: `Sin escenario: ${formatDate(simulation.baselineFinish)}` }
        : {}),
      tone: shift > 0 ? 'warning' : 'default',
    },
    {
      key: 'shift',
      label: 'Se recorre',
      value: shift === 0 ? 'Nada' : formatMinutes(shift),
      hint: shift === 0 ? 'El escenario no mueve el final' : 'Respecto de la proyección de hoy',
      tone: shift > 0 ? 'warning' : 'default',
    },
    {
      key: 'promise',
      label: 'Fecha prometida',
      value: simulation.promisedAt ? formatDate(simulation.promisedAt) : 'Sin promesa',
      hint: promiseHint(simulation),
      tone: promiseTone,
    },
    {
      key: 'measured',
      label: 'Pasos con historia',
      value: `${simulation.measuredSteps} de ${simulation.steps.length}`,
      hint: 'Los demás usan su SLA porque aún no hay mediciones',
      tone: simulation.measuredSteps === 0 ? 'warning' : 'default',
    },
  ];
}

function promiseHint(simulation: CaseSimulation): string {
  if (!simulation.promisedAt) return 'Este proceso no tiene fecha comprometida';
  if (simulation.lateAfter && !simulation.lateBefore) return 'El escenario la incumple';
  if (simulation.lateAfter) return 'Ya se incumplía antes del escenario';
  return 'Se cumple con el escenario';
}

/** Pasos del camino crítico, en orden, con su etiqueta. */
export function criticalPathLabels(simulation: CaseSimulation | null): string[] {
  if (!simulation) return [];
  const byRef = new Map(simulation.steps.map((step) => [step.ref, step.label]));
  return simulation.criticalPath.map((ref) => byRef.get(ref) ?? ref);
}

/** Pasos únicos para el selector de retrasos (una clave, aunque se repita por necesidad). */
export function delayOptions(
  simulation: CaseSimulation | null
): Array<{ stepKey: string; label: string; areaKey: string; areaLabel: string }> {
  if (!simulation) return [];
  const seen = new Map<
    string,
    { stepKey: string; label: string; areaKey: string; areaLabel: string }
  >();
  for (const step of simulation.steps) {
    if (seen.has(step.stepKey)) continue;
    seen.set(step.stepKey, {
      stepKey: step.stepKey,
      label: step.label,
      areaKey: step.areaKey,
      areaLabel: step.areaLabel,
    });
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Áreas que participan en el proceso, para los controles de capacidad. */
export function capacityOptions(
  simulation: CaseSimulation | null
): Array<{ areaKey: string; label: string; steps: number }> {
  if (!simulation) return [];
  const counts = new Map<string, { areaKey: string; label: string; steps: number }>();
  for (const step of simulation.steps) {
    const current = counts.get(step.areaKey);
    if (current) current.steps += 1;
    else counts.set(step.areaKey, { areaKey: step.areaKey, label: step.areaLabel, steps: 1 });
  }
  return [...counts.values()].sort((a, b) => b.steps - a.steps || a.label.localeCompare(b.label));
}
