/**
 * Effort levels — shared by the server policy (effort-policy.ts) and the
 * composer's picker. Pure data, safe for the client bundle.
 */

export type EffortLevel = 'instant' | 'light' | 'medium' | 'high' | 'ultra';

export const DEFAULT_EFFORT: EffortLevel = 'medium';

export interface EffortLevelInfo {
  id: EffortLevel;
  label: string;
  description: string;
  /** What the user should expect, shown in the picker. */
  expect: string;
}

export const EFFORT_LEVELS: EffortLevelInfo[] = [
  {
    id: 'instant',
    label: 'Ultra-rápido',
    description: 'Respuesta inmediata con el modelo más veloz. Sin revisiones.',
    expect: 'Segundos · el más económico',
  },
  {
    id: 'light',
    label: 'Ligero',
    description: 'Rápido y económico para el día a día: consultas y acciones directas.',
    expect: 'Muy rápido · económico',
  },
  {
    id: 'medium',
    label: 'Medio',
    description: 'Equilibrado: JEV decide en cada mensaje cuánto pensar y qué modelo usar.',
    expect: 'Rápido en lo simple, a fondo en lo complejo',
  },
  {
    id: 'high',
    label: 'Alto',
    description: 'Razonamiento profundo con el modelo potente y verificación de cifras.',
    expect: 'Más lento · más preciso',
  },
  {
    id: 'ultra',
    label: 'Ultra',
    description:
      'El modelo más potente disponible, pensamiento máximo, más pasos y revisión independiente (si tu empresa la tiene activa).',
    expect: 'El más lento y costoso · máxima calidad',
  },
];

const LEVEL_IDS = new Set<EffortLevel>(EFFORT_LEVELS.map((l) => l.id));

/** Accepts the level ids; the legacy "auto" means the balanced level. */
export function parseEffort(value: unknown): EffortLevel | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'auto') return DEFAULT_EFFORT;
  return LEVEL_IDS.has(v as EffortLevel) ? (v as EffortLevel) : null;
}

export function effortLabel(level: EffortLevel): string {
  return EFFORT_LEVELS.find((l) => l.id === level)?.label ?? level;
}
