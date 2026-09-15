/**
 * Pure helpers shared by the dashboard kit components (no React, no DOM).
 * Kept apart so they can be unit-tested and reused by server code.
 */

import type { ChartTone } from './chart-theme';

export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'info';

export type DeltaDirection = 'up' | 'down' | 'flat';

export interface StatDelta {
  value: string | number;
  direction: DeltaDirection;
  /**
   * Whether the movement is good or bad. Defaults to up = positive,
   * down = negative, flat = neutral. Use it for "lower is better" metrics.
   */
  intent?: 'positive' | 'negative' | 'neutral';
  /** Context appended to the value, e.g. "vs. semana anterior". */
  label?: string;
}

export function deltaIntent(delta: StatDelta): 'positive' | 'negative' | 'neutral' {
  if (delta.intent) return delta.intent;
  if (delta.direction === 'up') return 'positive';
  if (delta.direction === 'down') return 'negative';
  return 'neutral';
}

const DELTA_VERB: Record<DeltaDirection, string> = {
  up: 'Aumentó',
  down: 'Disminuyó',
  flat: 'Sin cambio',
};

/** Screen-reader text for a delta, e.g. "Aumentó 12% vs. semana anterior". */
export function describeDelta(delta: StatDelta): string {
  const parts = [DELTA_VERB[delta.direction]];
  const value = String(delta.value).trim();
  if (value) parts.push(value);
  if (delta.label) parts.push(delta.label);
  return parts.join(' ');
}

/**
 * Status tone for a success-rate KPI (percent, 0–100): > 95 success, > 80
 * warning, otherwise danger. Without data (`null`, NaN) the tile stays neutral
 * so an empty integration never shows a false "healthy" or "critical" signal.
 */
export function successRateTone(rate: number | null | undefined): StatTone {
  if (rate == null || !Number.isFinite(rate)) return 'default';
  if (rate > 95) return 'success';
  if (rate > 80) return 'warning';
  return 'danger';
}

export interface StatusSegment {
  key: string;
  label: string;
  count: number;
  tone: ChartTone;
}

/** Share of each segment over the total, rounded to one decimal (0 when total is 0). */
export function segmentShare(count: number, total: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0 || count <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

export function totalSegments(segments: StatusSegment[]): number {
  return segments.reduce(
    (sum, s) => sum + (Number.isFinite(s.count) && s.count > 0 ? s.count : 0),
    0
  );
}

/** Descriptive aria-label for a status strip, e.g. "Expedientes por fase: 10 en total. Abierto 6 (60%)…". */
export function describeStatusStrip(
  segments: StatusSegment[],
  label = 'Distribución por estado'
): string {
  const total = totalSegments(segments);
  if (total === 0) return `${label}: sin registros.`;
  const detail = segments
    .filter((s) => s.count > 0)
    .map(
      (s) =>
        `${s.label} ${s.count.toLocaleString('es-MX')} (${formatShare(segmentShare(s.count, total))})`
    )
    .join(', ');
  return `${label}: ${total.toLocaleString('es-MX')} en total. ${detail}.`;
}

export function formatShare(share: number): string {
  return `${share.toLocaleString('es-MX', { maximumFractionDigits: 1 })}%`;
}

export type AlertSeverity = 'info' | 'warning' | 'danger';

export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: 'Información',
  warning: 'Advertencia',
  danger: 'Crítica',
};

/** Splits a list into the visible part and the number of hidden items. */
export function limitItems<T>(items: T[], max?: number): { visible: T[]; hidden: number } {
  if (max == null || !Number.isFinite(max) || max < 0 || items.length <= max) {
    return { visible: items, hidden: 0 };
  }
  const limit = Math.floor(max);
  return { visible: items.slice(0, limit), hidden: items.length - limit };
}

/** Parses an ISO string or Date; returns null when invalid. */
export function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatAlertTime(date: Date): string {
  return date.toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
