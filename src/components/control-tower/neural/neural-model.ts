/**
 * UNIK Neural Operations: vocabulario, enlaces y formatos (plan 7.8).
 *
 * Módulo PURO (sin React, sin Prisma, sin DOM): lo importan el servidor para
 * armar las páginas y el cliente para pintar. Todo lo que se repite en las
 * cinco herramientas vive aquí una sola vez, con pruebas.
 */

import { AREA_LABELS, isAreaKey } from '@/modules/operations/types';
import type { ChartTone } from '@/components/patterns/dashboard/chart-theme';
import type { StatTone } from '@/components/patterns/dashboard/dashboard-utils';

// ---------------------------------------------------------------------------
// Herramientas y enlaces
// ---------------------------------------------------------------------------

export const NEURAL_BASE_PATH = '/app/admin/control-tower/neural';
export const CONTROL_TOWER_PATH = '/app/admin/control-tower';

export const NEURAL_TOOLS = ['procesos', 'variantes', 'grafo', 'replay', 'simulacion'] as const;

export type NeuralTool = (typeof NEURAL_TOOLS)[number];

export interface NeuralToolMeta {
  key: NeuralTool;
  label: string;
  /** Frase corta para el encabezado de la herramienta. */
  description: string;
  /** Nombre del icono de lucide-react que usa la pestaña (se resuelve en el TSX). */
  icon: 'workflow' | 'git-branch' | 'network' | 'history' | 'flask-conical';
}

export const NEURAL_TOOL_LIST: readonly NeuralToolMeta[] = [
  {
    key: 'procesos',
    label: 'Procesos',
    description: 'El proceso tal como está definido: pasos, dependencias y lo que tarda cada uno.',
    icon: 'workflow',
  },
  {
    key: 'variantes',
    label: 'Variantes',
    description: 'Los caminos que de verdad recorren los expedientes, y dónde se atoran.',
    icon: 'git-branch',
  },
  {
    key: 'grafo',
    label: 'Grafo',
    description: 'La red operativa: qué está conectado con qué, en el instante que elijas.',
    icon: 'network',
  },
  {
    key: 'replay',
    label: 'Replay',
    description: 'Rebobina un expediente y mira cómo estaba en cualquier momento.',
    icon: 'history',
  },
  {
    key: 'simulacion',
    label: 'Simulación',
    description: 'Qué pasaría con la fecha prometida si un paso se retrasa o un área rinde menos.',
    icon: 'flask-conical',
  },
];

const TOOL_BY_KEY = new Map<string, NeuralToolMeta>(NEURAL_TOOL_LIST.map((t) => [t.key, t]));

export function isNeuralTool(value: unknown): value is NeuralTool {
  return typeof value === 'string' && TOOL_BY_KEY.has(value);
}

export function neuralToolMeta(tool: NeuralTool): NeuralToolMeta {
  const meta = TOOL_BY_KEY.get(tool);
  if (!meta) throw new Error(`Herramienta desconocida: ${tool}`);
  return meta;
}

export type QueryValue = string | number | boolean | null | undefined;

/** Enlace a una herramienta con sus parámetros (los vacíos se omiten). */
export function neuralHref(tool: NeuralTool, params: Record<string, QueryValue> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    const text = typeof value === 'string' ? value.trim() : String(value);
    if (!text) continue;
    search.set(key, text);
  }
  const query = search.toString();
  return query ? `${NEURAL_BASE_PATH}/${tool}?${query}` : `${NEURAL_BASE_PATH}/${tool}`;
}

/** Ruta del expediente completo (la abre el Expediente 360, no esta superficie). */
export function caseHref(caseId: string): string {
  return `/app/operations/cases/${caseId}`;
}

// ---------------------------------------------------------------------------
// Áreas
// ---------------------------------------------------------------------------

/** Etiqueta del área; una clave desconocida se muestra tal cual. */
export function areaLabel(key: string | null | undefined): string {
  if (!key) return 'Sin área';
  return isAreaKey(key) ? AREA_LABELS[key] : key;
}

/**
 * Color de un área dentro del lienzo. Se reparte la paleta de gráficas
 * (`--unik-chart-1..6`) por posición fija, para que Compras sea del mismo color
 * en el visor, en el grafo y en la simulación.
 */
const AREA_TONES: Record<string, ChartTone> = {
  ventas: 'brand',
  compras: 'info',
  inventario: 'success',
  manufactura: 'warning',
  logistica: 'danger',
  contabilidad: 'muted',
};

export function areaTone(key: string | null | undefined): ChartTone {
  if (!key) return 'muted';
  return AREA_TONES[key] ?? 'muted';
}

/** Clase CSS del área (la hoja define `.neural-area-<tono>`). */
export function areaToneClass(key: string | null | undefined): string {
  return `neural-area-${areaTone(key)}`;
}

/** Leyenda de áreas: sólo las presentes, en el orden del proceso. */
export function areaLegend(keys: readonly (string | null | undefined)[]): Array<{
  key: string;
  label: string;
  tone: ChartTone;
}> {
  const seen = new Set<string>();
  const out: Array<{ key: string; label: string; tone: ChartTone }> = [];
  for (const raw of keys) {
    const key = raw ?? 'sin_area';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: areaLabel(raw), tone: areaTone(raw) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatos
// ---------------------------------------------------------------------------

const MISSING = '—';

/** Número con separador de miles en es-MX. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return value.toLocaleString('es-MX');
}

/**
 * Minutos en lenguaje de operación: `45 min`, `2 h 30 min`, `3 d 4 h`.
 * `null` (aún sin medición) NO se muestra como cero: se muestra como raya.
 */
export function formatMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  const total = Math.max(0, Math.round(value));
  if (total === 0) return '0 min';
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours < 24) return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

/** Porcentaje 0–100 con un decimal como máximo. */
export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return `${value.toLocaleString('es-MX', { maximumFractionDigits: decimals })}%`;
}

/** Proporción (0–1) a porcentaje. */
export function formatRatio(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return formatPercent(value * 100, decimals);
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Día y hora (`12 mar 2026, 14:05`). */
export function formatDateTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return MISSING;
  return date.toLocaleString('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Sólo el día (`12 mar 2026`). */
export function formatDay(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return MISSING;
  return date.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Sólo el reloj (`14:05`). */
export function formatClock(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return MISSING;
  return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

/** `YYYY-MM-DD` en UTC, que es el calendario de las proyecciones. */
export function toDayKey(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  return date.toISOString().slice(0, 10);
}

/** "hace 3 min" / "hace 2 h" / "hace 4 d"; `null` = nunca. */
export function formatMinutesAgo(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return 'nunca';
  if (minutes < 1) return 'hace unos segundos';
  return `hace ${formatMinutes(minutes)}`;
}

// ---------------------------------------------------------------------------
// Rangos de fecha
// ---------------------------------------------------------------------------

export interface RangePreset {
  key: string;
  label: string;
  days: number;
}

export const RANGE_PRESETS: readonly RangePreset[] = [
  { key: '7d', label: 'Últimos 7 días', days: 7 },
  { key: '14d', label: 'Últimos 14 días', days: 14 },
  { key: '30d', label: 'Últimos 30 días', days: 30 },
  { key: '90d', label: 'Últimos 90 días', days: 90 },
];

export const DEFAULT_RANGE_KEY = '30d';

export interface DayRange {
  /** `YYYY-MM-DD` inclusivo. */
  from: string;
  /** `YYYY-MM-DD` inclusivo. */
  to: string;
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Rango de un preajuste terminando hoy (calendario UTC, el de las proyecciones). */
export function rangeFromPreset(key: string, now: Date): DayRange {
  const preset = RANGE_PRESETS.find((entry) => entry.key === key) ?? RANGE_PRESETS[2];
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = addUtcDays(to, -(preset.days - 1));
  return { from: toDayKey(from), to: toDayKey(to) };
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDay(value: string | null | undefined): string | null {
  if (!value || !DAY_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

/**
 * Lee el rango de la URL: `?desde`/`?hasta` explícitos, o el preajuste `?rango`.
 * Un valor inválido no rompe la página: cae al preajuste por omisión, y un
 * rango al revés se endereza.
 */
export function parseRange(
  params: { desde?: string | null; hasta?: string | null; rango?: string | null },
  now: Date
): DayRange & { presetKey: string | null } {
  const from = validDay(params.desde);
  const to = validDay(params.hasta);
  if (from && to) {
    const ordered = from <= to ? { from, to } : { from: to, to: from };
    return { ...ordered, presetKey: null };
  }
  const presetKey = RANGE_PRESETS.some((entry) => entry.key === params.rango)
    ? (params.rango as string)
    : DEFAULT_RANGE_KEY;
  return { ...rangeFromPreset(presetKey, now), presetKey };
}

/** Frase del rango para el encabezado ("del 1 al 30 de marzo"). */
export function describeRange(range: DayRange): string {
  return `${formatDay(`${range.from}T00:00:00.000Z`)} — ${formatDay(`${range.to}T00:00:00.000Z`)}`;
}

// ---------------------------------------------------------------------------
// Tonos por métrica
// ---------------------------------------------------------------------------

/**
 * Tono del porcentaje de incumplimiento de SLA: ≤5 % bien, ≤20 % advertencia,
 * arriba de eso rojo. Sin datos se queda neutro (nunca verde falso).
 */
export function breachTone(pct: number | null | undefined): StatTone {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'default';
  if (pct <= 5) return 'success';
  if (pct <= 20) return 'warning';
  return 'danger';
}

/** Tono de la conformidad (porcentaje de expedientes que siguieron el proceso). */
export function conformanceTone(pct: number | null | undefined): StatTone {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'default';
  if (pct >= 95) return 'success';
  if (pct >= 80) return 'warning';
  return 'danger';
}

/** Ancho de una barra proporcional (0–100), acotado para que siempre se vea. */
export function barWidth(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return 0;
  return Math.min(100, Math.max(2, Math.round((value / max) * 100)));
}

/** Frescura de una proyección, para el pie de página de cada herramienta. */
export function freshnessLabel(
  rows: readonly { label: string; minutesAgo: number | null; stale: boolean }[]
): string {
  if (rows.length === 0) return 'Sin proyecciones calculadas todavía.';
  const worst = rows.reduce(
    (acc, row) => {
      if (row.minutesAgo === null) return acc;
      if (acc === null || row.minutesAgo > acc) return row.minutesAgo;
      return acc;
    },
    null as number | null
  );
  const never = rows.filter((row) => row.minutesAgo === null);
  if (never.length === rows.length) return 'Sin proyecciones calculadas todavía.';
  const base = `Proyecciones actualizadas ${formatMinutesAgo(worst)}`;
  if (never.length > 0) return `${base} · ${never.length} sin calcular`;
  return rows.some((row) => row.stale) ? `${base} · atrasadas` : base;
}
