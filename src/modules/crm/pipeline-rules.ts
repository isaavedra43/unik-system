import { STAGE_KINDS, STAGE_KIND_LABELS, type StageKind } from './types';

/**
 * Pure rules of the sales pipeline (plan 6.5): default stages, stage keys,
 * the invariants of the active stage set, reordering and probabilities.
 */

export interface DefaultPipelineStage {
  key: string;
  name: string;
  order: number;
  /** 0–1 */
  probabilityDefault: number;
  kind: StageKind;
  slaHours: number | null;
}

/** Seed of an empty pipeline (editable afterwards with `crm.manage_stages`). */
export const DEFAULT_PIPELINE_STAGES: readonly DefaultPipelineStage[] = [
  { key: 'nuevo', name: 'Nuevo', order: 1, probabilityDefault: 0.1, kind: 'open', slaHours: 24 },
  { key: 'contactado', name: 'Contactado', order: 2, probabilityDefault: 0.25, kind: 'open', slaHours: 72 },
  { key: 'cotizado', name: 'Cotizado', order: 3, probabilityDefault: 0.5, kind: 'open', slaHours: 120 },
  { key: 'negociacion', name: 'Negociación', order: 4, probabilityDefault: 0.7, kind: 'open', slaHours: 168 },
  { key: 'ganado', name: 'Ganado', order: 5, probabilityDefault: 1, kind: 'won', slaHours: null },
  { key: 'perdido', name: 'Perdido', order: 6, probabilityDefault: 0, kind: 'lost', slaHours: null },
];

/** Stage an opportunity advances to when a quote is linked (if it is still before it). */
export const QUOTED_STAGE_KEY = 'cotizado';

export interface StageLike {
  id: string;
  key: string;
  name: string;
  order: number;
  kind: string;
  active: boolean;
}

const STAGE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const STAGE_KEY_MAX = 40;

export function isStageKind(value: unknown): value is StageKind {
  return typeof value === 'string' && (STAGE_KINDS as readonly string[]).includes(value);
}

export function isValidStageKey(key: string): boolean {
  return STAGE_KEY_PATTERN.test(key);
}

/** "Negociación final" → "negociacion_final"; keys never start with a digit. */
export function stageKeyFromName(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, STAGE_KEY_MAX)
    .replace(/_+$/g, '');
  if (!base) return 'etapa';
  return /^[a-z]/.test(base) ? base : `etapa_${base}`.slice(0, STAGE_KEY_MAX).replace(/_+$/g, '');
}

/** `base`, `base_2`, `base_3`… not present in `taken`. */
export function uniqueStageKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, STAGE_KEY_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('No se pudo generar una clave de etapa única');
}

/** Stages sorted by order, then name (stable for equal orders). */
export function sortStages<T extends Pick<StageLike, 'order' | 'name'>>(stages: readonly T[]): T[] {
  return [...stages].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'es'));
}

export function nextStageOrder(stages: readonly Pick<StageLike, 'order'>[]): number {
  return stages.reduce((max, stage) => Math.max(max, stage.order), 0) + 1;
}

/**
 * The pipeline always needs at least one active stage of each kind (open, won,
 * lost) so opportunities can be created, won and lost. Returns the Spanish
 * reason when the set is invalid.
 */
export function validateActiveStageSet(stages: readonly Pick<StageLike, 'kind' | 'active'>[]): string | null {
  for (const kind of STAGE_KINDS) {
    if (!stages.some((stage) => stage.active && stage.kind === kind)) {
      return `El embudo necesita al menos una etapa activa de tipo «${STAGE_KIND_LABELS[kind]}»`;
    }
  }
  return null;
}

export interface StageInsertionPlan {
  order: number;
  /** Existing stages pushed one position down. */
  shifts: Array<{ id: string; order: number }>;
}

/**
 * Where a new stage goes: an open stage right before the first closing stage
 * (won/lost), pushing the closing stages down; a closing stage at the end.
 */
export function planStageInsertion(stages: readonly StageLike[], kind: StageKind): StageInsertionPlan {
  const closing = stages.filter((stage) => stage.kind !== 'open');
  if (kind !== 'open' || closing.length === 0) return { order: nextStageOrder(stages), shifts: [] };
  const at = Math.min(...closing.map((stage) => stage.order));
  const shifts = sortStages(stages.filter((stage) => stage.order >= at)).map((stage) => ({
    id: stage.id,
    order: stage.order + 1,
  }));
  return { order: at, shifts };
}

export type ReorderPlan = { ok: true; orders: Array<{ id: string; order: number }> } | { ok: false; message: string };

/**
 * New orders for a drag-and-drop reorder: `orderedIds` must list every active
 * stage exactly once (inactive stages may be omitted and keep their relative
 * order after the active ones).
 */
export function planStageReorder(stages: readonly StageLike[], orderedIds: readonly string[]): ReorderPlan {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (!byId.has(id)) return { ok: false, message: 'Una de las etapas no existe' };
    if (seen.has(id)) return { ok: false, message: 'Una etapa aparece dos veces en el nuevo orden' };
    seen.add(id);
  }
  const missing = stages.filter((stage) => stage.active && !seen.has(stage.id));
  if (missing.length > 0) {
    return { ok: false, message: `Falta ordenar la etapa «${missing[0].name}»` };
  }
  const rest = sortStages(stages.filter((stage) => !seen.has(stage.id)));
  const ids = [...orderedIds, ...rest.map((stage) => stage.id)];
  return { ok: true, orders: ids.map((id, index) => ({ id, order: index + 1 })) };
}

/** Lowest-order active stage of a kind. */
export function firstActiveStageOfKind<T extends StageLike>(stages: readonly T[], kind: StageKind): T | null {
  return sortStages(stages.filter((stage) => stage.active && stage.kind === kind))[0] ?? null;
}

/** Decimal | number | string → number in [0, 1], or null. */
export function toProbability(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/** Opportunity probability, or the default of its stage when it has none. */
export function effectiveProbability(opportunityProbability: unknown, stageDefault: unknown): number {
  return toProbability(opportunityProbability) ?? toProbability(stageDefault) ?? 0;
}
