/**
 * Reproducción de un expediente: deslizador, reproducción y estado en el tiempo
 * (plan 7.8d). Módulo PURO.
 *
 * El estado lo calcula `foldCaseState` (también puro) a partir de los hechos, y
 * por eso el deslizador puede moverse sin ir al servidor: la página trae la
 * bitácora una vez y aquí se decide qué se ve en cada posición.
 */

import type { ReplayCaseState, ReplayStep, ReplayWorkItem } from '@/modules/control-tower/replay';
import type { StatTone } from '@/components/patterns/dashboard/dashboard-utils';
import type { ChartTone } from '@/components/patterns/dashboard/chart-theme';
import { areaLabel, formatClock, formatDateTime } from './neural-model';

/** Un evento por segundo, como pide el plan. */
export const PLAYBACK_INTERVAL_MS = 1_000;

export interface ReplayTimelineEntry {
  id: string;
  type: string;
  occurredAt: string;
  areaKey: string | null;
  actorType: string | null;
  /** Frase ya formateada por `formatTimelineLine` (agents/templates). */
  line: string;
}

export interface TimelineRow extends ReplayTimelineEntry {
  /** Ocurrió después del instante reproducido: se muestra atenuado. */
  future: boolean;
  /** Es el último evento aplicado en este instante. */
  current: boolean;
  areaLabel: string;
  clock: string;
}

/** Posición válida del deslizador (0…n-1); sin eventos, 0. */
export function clampIndex(index: number, total: number): number {
  if (!Number.isFinite(index) || total <= 0) return 0;
  return Math.min(Math.max(Math.round(index), 0), total - 1);
}

/** Instante de una posición del deslizador. */
export function atForIndex(timestamps: readonly string[], index: number): string | null {
  if (timestamps.length === 0) return null;
  return timestamps[clampIndex(index, timestamps.length)] ?? null;
}

/** Posición inicial: la que pide la URL (`?at=`), o el final de la historia. */
export function initialIndex(timestamps: readonly string[], at: string | null | undefined): number {
  if (timestamps.length === 0) return 0;
  if (!at) return timestamps.length - 1;
  const exact = timestamps.indexOf(at);
  if (exact >= 0) return exact;
  const target = Date.parse(at);
  if (Number.isNaN(target)) return timestamps.length - 1;
  let index = 0;
  for (let i = 0; i < timestamps.length; i += 1) {
    const value = Date.parse(timestamps[i] ?? '');
    if (Number.isNaN(value) || value > target) break;
    index = i;
  }
  return index;
}

/** Siguiente posición al reproducir; `null` cuando llegó al final. */
export function nextIndex(index: number, total: number): number | null {
  if (total <= 0) return null;
  const current = clampIndex(index, total);
  return current >= total - 1 ? null : current + 1;
}

/** Marca cada línea como pasada, actual o futura respecto del instante. */
export function timelineRows(
  entries: readonly ReplayTimelineEntry[],
  at: string | null
): TimelineRow[] {
  const cutoff = at ? Date.parse(at) : Number.POSITIVE_INFINITY;
  const ordered = [...entries].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id)
  );
  let lastApplied = -1;
  const rows = ordered.map((entry, position) => {
    const occurred = Date.parse(entry.occurredAt);
    const future = Number.isNaN(occurred) ? false : occurred > cutoff;
    if (!future) lastApplied = position;
    return {
      ...entry,
      future,
      current: false,
      areaLabel: areaLabel(entry.areaKey),
      clock: formatClock(entry.occurredAt),
    };
  });
  if (lastApplied >= 0 && rows[lastApplied]) rows[lastApplied].current = true;
  return rows;
}

// ---------------------------------------------------------------------------
// Estado en el tiempo
// ---------------------------------------------------------------------------

const STEP_TONES: Record<ReplayStep['status'], ChartTone> = {
  pending: 'muted',
  ready: 'info',
  active: 'brand',
  waiting: 'warning',
  done: 'success',
  skipped: 'muted',
  cancelled: 'muted',
  failed: 'danger',
};

const STEP_LABELS: Record<ReplayStep['status'], string> = {
  pending: 'Pendiente',
  ready: 'Listo para empezar',
  active: 'En curso',
  waiting: 'En espera',
  done: 'Completado',
  skipped: 'Saltado',
  cancelled: 'Cancelado',
  failed: 'Falló',
};

export function stepStatusTone(status: ReplayStep['status']): ChartTone {
  return STEP_TONES[status] ?? 'muted';
}

export function stepStatusLabel(status: ReplayStep['status']): string {
  return STEP_LABELS[status] ?? status;
}

const WORK_LABELS: Record<ReplayWorkItem['status'], string> = {
  open: 'Abierto',
  in_progress: 'En curso',
  waiting: 'En espera',
  escalated: 'Escalado',
  done: 'Cerrado',
  cancelled: 'Cancelado',
};

export function workItemStatusLabel(status: ReplayWorkItem['status']): string {
  return WORK_LABELS[status] ?? status;
}

export interface MiniStepView {
  ref: string;
  stepKey: string;
  scopeKey: string;
  label: string;
  areaKey: string | null;
  areaLabel: string;
  status: ReplayStep['status'];
  statusLabel: string;
  tone: ChartTone;
  dueAt: string | null;
  waitReason: string | null;
}

/**
 * Mini visor: los pasos del expediente en ese instante, coloreados por estado y
 * ordenados por área para que se lea como el proceso, no como una lista suelta.
 */
export function miniStepViews(
  state: ReplayCaseState,
  labels: ReadonlyMap<string, string> = new Map()
): MiniStepView[] {
  return [...state.steps]
    .map((step) => ({
      ref: step.ref,
      stepKey: step.stepKey,
      scopeKey: step.scopeKey,
      label: labels.get(step.stepKey) ?? step.stepKey,
      areaKey: step.areaKey,
      areaLabel: areaLabel(step.areaKey),
      status: step.status,
      statusLabel: stepStatusLabel(step.status),
      tone: stepStatusTone(step.status),
      dueAt: step.dueAt,
      waitReason: step.waitReason,
    }))
    .sort(
      (a, b) =>
        a.areaLabel.localeCompare(b.areaLabel) ||
        a.label.localeCompare(b.label) ||
        a.scopeKey.localeCompare(b.scopeKey)
    );
}

export interface ReplayCounterTile {
  key: string;
  label: string;
  value: number;
  tone: StatTone;
  hint?: string;
}

/** Los contadores del instante: lo que estaba abierto, esperando o vencido. */
export function replayCounters(state: ReplayCaseState): ReplayCounterTile[] {
  const counters = state.counters;
  return [
    { key: 'steps', label: 'Pasos abiertos', value: counters.openSteps, tone: 'default' },
    {
      key: 'work',
      label: 'Trabajos abiertos',
      value: counters.openWorkItems,
      tone: counters.overdueWorkItems > 0 ? 'warning' : 'default',
      ...(counters.overdueWorkItems > 0
        ? { hint: `${counters.overdueWorkItems} vencidos en ese momento` }
        : {}),
    },
    {
      key: 'requests',
      label: 'Solicitudes abiertas',
      value: counters.openRequests,
      tone: counters.blockingRequests > 0 ? 'danger' : 'default',
      ...(counters.blockingRequests > 0
        ? { hint: `${counters.blockingRequests} bloquean la entrega` }
        : {}),
    },
    {
      key: 'incidents',
      label: 'Incidencias abiertas',
      value: counters.openIncidents,
      tone: counters.openIncidents > 0 ? 'danger' : 'default',
    },
  ];
}

/** Frase del encabezado del reproductor ("12 mar 2026, 14:05 · 24 de 58 eventos"). */
export function describeFrame(state: ReplayCaseState, index: number, total: number): string {
  const when = formatDateTime(state.at);
  if (total === 0) return `${when} · sin eventos`;
  return `${when} · evento ${Math.min(index + 1, total)} de ${total}`;
}

/** Estado del expediente en ese instante, en una palabra y con tono. */
export function caseStatusTone(state: ReplayCaseState): StatTone {
  if (state.status === 'cancelled') return 'danger';
  if (state.status === 'closed') return 'success';
  if (state.counters.openIncidents > 0 || state.counters.blockingRequests > 0) return 'warning';
  return 'info';
}
