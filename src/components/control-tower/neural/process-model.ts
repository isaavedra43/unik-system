/**
 * Visor de procesos: acomodo + métricas + camino resaltado (plan 7.8a/7.8b).
 *
 * Módulo PURO. El acomodo lo calcula `process-layout.ts` (capas por camino más
 * largo, sin dagre) y aquí se le pega lo medido (`CtStepMetricDaily` agregado)
 * y el camino de la variante que la persona seleccionó, para que el lienzo y la
 * lista móvil pinten exactamente lo mismo.
 */

import type { LayoutNode, ProcessLayout } from '@/modules/control-tower/process-layout';
import type { StepMetricRow } from '@/modules/control-tower/variants';
import type { StatTone } from '@/components/patterns/dashboard/dashboard-utils';
import { areaLabel, areaTone, breachTone } from './neural-model';
import type { ChartTone } from '@/components/patterns/dashboard/chart-theme';

export interface StepMetricView {
  started: number;
  completed: number;
  p50ActiveMin: number | null;
  p90ActiveMin: number | null;
  p50WaitMin: number | null;
  p90WaitMin: number | null;
  breached: number;
  /** Porcentaje de incumplimiento sobre lo iniciado; `null` si nada inició. */
  breachPct: number | null;
  reworked: number;
  reworkPct: number | null;
  tone: StatTone;
}

export interface ProcessStepView {
  key: string;
  label: string;
  areaKey: string | null;
  areaLabel: string;
  areaTone: ChartTone;
  layer: number;
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
  metrics: StepMetricView | null;
  /** Está en el camino de la variante seleccionada. */
  highlighted: boolean;
  /** Hay una variante seleccionada y este paso NO está en ella. */
  dimmed: boolean;
  /** Posición (1…n) dentro de la variante seleccionada. */
  sequenceIndex: number | null;
}

export interface ProcessEdgeView {
  id: string;
  source: string;
  target: string;
  /** Los dos extremos están en la variante seleccionada. */
  onPath: boolean;
  dimmed: boolean;
}

export interface ProcessGraphView {
  steps: ProcessStepView[];
  edges: ProcessEdgeView[];
  layers: number;
  width: number;
  height: number;
  missingDependencies: Array<{ step: string; dependsOn: string }>;
  /** Áreas presentes, en el orden en que aparecen (para la leyenda). */
  areaKeys: string[];
  /** Pasos de la variante que el proceso no define (se listan aparte). */
  unknownPathSteps: string[];
}

function pct(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((part / total) * 1000) / 10;
}

/** Métricas por clave de paso, ya agregadas por el servicio de proyecciones. */
export function stepMetricMap(rows: readonly StepMetricRow[]): Map<string, StepMetricView> {
  const map = new Map<string, StepMetricView>();
  for (const row of rows) {
    const breachPct = pct(row.breached, row.started);
    map.set(row.stepKey, {
      started: row.started,
      completed: row.completed,
      p50ActiveMin: row.p50ActiveMin,
      p90ActiveMin: row.p90ActiveMin,
      p50WaitMin: row.p50WaitMin,
      p90WaitMin: row.p90WaitMin,
      breached: row.breached,
      breachPct,
      reworked: row.reworked,
      reworkPct: pct(row.reworked, row.started),
      tone: breachTone(breachPct),
    });
  }
  return map;
}

export interface BuildProcessViewInput {
  layout: ProcessLayout;
  metrics?: readonly StepMetricRow[];
  /** Secuencia de la variante seleccionada (claves de paso, en orden). */
  path?: readonly string[];
}

/**
 * Une acomodo, métricas y camino. Cuando hay variante seleccionada, los pasos
 * fuera de ella se atenúan (nunca se esconden: el proceso completo sigue ahí).
 */
export function buildProcessView(input: BuildProcessViewInput): ProcessGraphView {
  const metrics = stepMetricMap(input.metrics ?? []);
  const path = (input.path ?? []).filter((key) => typeof key === 'string' && key.trim());
  const hasPath = path.length > 0;
  const pathIndex = new Map<string, number>();
  path.forEach((key, index) => {
    if (!pathIndex.has(key)) pathIndex.set(key, index + 1);
  });

  const byKey = new Map<string, LayoutNode>(input.layout.nodes.map((node) => [node.key, node]));
  const steps: ProcessStepView[] = input.layout.nodes.map((node) => {
    const highlighted = hasPath && pathIndex.has(node.key);
    return {
      key: node.key,
      label: node.label,
      areaKey: node.areaKey,
      areaLabel: areaLabel(node.areaKey),
      areaTone: areaTone(node.areaKey),
      layer: node.layer,
      order: node.order,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      metrics: metrics.get(node.key) ?? null,
      highlighted,
      dimmed: hasPath && !highlighted,
      sequenceIndex: pathIndex.get(node.key) ?? null,
    };
  });

  const edges: ProcessEdgeView[] = input.layout.edges.map((edge) => {
    const onPath = hasPath && pathIndex.has(edge.from) && pathIndex.has(edge.to);
    return {
      id: `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      onPath,
      dimmed: hasPath && !onPath,
    };
  });

  const areaKeys: string[] = [];
  for (const step of steps) {
    const key = step.areaKey ?? 'sin_area';
    if (!areaKeys.includes(key)) areaKeys.push(key);
  }

  return {
    steps,
    edges,
    layers: input.layout.layers,
    width: input.layout.width,
    height: input.layout.height,
    missingDependencies: input.layout.missingDependencies,
    areaKeys,
    unknownPathSteps: path.filter((key) => !byKey.has(key)),
  };
}

/** Pasos en orden de lectura (capa, luego posición): la lista de móvil y la tabla. */
export function processStepRows(view: ProcessGraphView): ProcessStepView[] {
  return [...view.steps].sort((a, b) => a.layer - b.layer || a.order - b.order);
}

/** Insignias del nodo: sólo las que tienen dato (nunca un cero inventado). */
export function stepBadges(metrics: StepMetricView | null): Array<{
  key: string;
  label: string;
  value: string;
  tone: StatTone;
}> {
  if (!metrics) return [];
  const out: Array<{ key: string; label: string; value: string; tone: StatTone }> = [];
  if (metrics.p50ActiveMin !== null) {
    out.push({
      key: 'active',
      label: 'p50 activo',
      value: formatShortMinutes(metrics.p50ActiveMin),
      tone: 'default',
    });
  }
  if (metrics.p90WaitMin !== null) {
    out.push({
      key: 'wait',
      label: 'p90 espera',
      value: formatShortMinutes(metrics.p90WaitMin),
      tone: metrics.p90WaitMin > 0 ? 'info' : 'default',
    });
  }
  if (metrics.breachPct !== null) {
    out.push({
      key: 'breach',
      label: 'incumple',
      value: `${metrics.breachPct.toLocaleString('es-MX', { maximumFractionDigits: 1 })}%`,
      tone: metrics.tone,
    });
  }
  return out;
}

/** Minutos compactos para una insignia (`45m`, `2.5h`, `3d`). */
export function formatShortMinutes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const total = Math.max(0, value);
  if (total < 60) return `${Math.round(total)}m`;
  const hours = total / 60;
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

/** Texto accesible del nodo: lo que lee un lector de pantalla en el lienzo. */
export function describeStep(step: ProcessStepView): string {
  const parts = [`${step.label}, ${step.areaLabel}`];
  if (step.sequenceIndex !== null) parts.push(`paso ${step.sequenceIndex} de la variante`);
  const metrics = step.metrics;
  if (!metrics) {
    parts.push('sin mediciones en el periodo');
    return `${parts.join('. ')}.`;
  }
  parts.push(`${metrics.started.toLocaleString('es-MX')} iniciados`);
  if (metrics.p50ActiveMin !== null) {
    parts.push(`mediana activa ${Math.round(metrics.p50ActiveMin)} minutos`);
  }
  if (metrics.p90WaitMin !== null) {
    parts.push(`espera p90 ${Math.round(metrics.p90WaitMin)} minutos`);
  }
  if (metrics.breachPct !== null) parts.push(`incumplimiento ${metrics.breachPct}%`);
  return `${parts.join('. ')}.`;
}
