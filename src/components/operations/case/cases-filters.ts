import { z } from 'zod';
import { AREA_LABELS, CASE_PHASES, CASE_PHASE_LABELS, isAreaKey } from '@/modules/operations/types';
// Generic table presentation schema shared by every workspace (no sales logic).
import { tablePreferenceConfigSchema } from '@/modules/sales/sales-orders-filters';
import { CASE_FILTERABLE_FIELDS, CASE_SORTABLE_FIELDS, CASES_BASE_PATH } from './cases-columns';
import { CASE_RISK_LABELS, type CaseRiskLevel } from './case-model';

/**
 * Query state of the case list (plan 2.7 / 7.4): the same shape every other
 * `EntityWorkspace` module uses (`search`, `filters`, `sort`, `page`,
 * `page_size`) plus the operational filters `scope`, `phase`, `risk`,
 * `areaKey` (blocking area) and `ownerUserId`.
 *
 * Validation is a WHITE LIST: every filter and sort field must be a column of
 * `cases-columns.ts` and every operator must fit its type, so no text written
 * by a person can name a database column. An unknown field is REJECTED (422),
 * never ignored.
 */

export class CasesQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CasesQueryError';
  }
}

export const CASE_SCOPES = ['open', 'closed', 'all'] as const;
export type CaseScope = (typeof CASE_SCOPES)[number];

export const CASE_SCOPE_LABELS: Readonly<Record<CaseScope, string>> = {
  open: 'Abiertos',
  closed: 'Cerrados',
  all: 'Todos',
};

export const CASE_RISK_FILTERS: readonly CaseRiskLevel[] = ['late', 'risk', 'watch'];

const TEXT_OPERATORS = [
  'contains',
  'not_contains',
  'equals',
  'not_equals',
  'starts_with',
  'is_empty',
  'is_not_empty',
] as const;
const STATUS_OPERATORS = ['equals', 'not_equals', 'in', 'not_in', 'is_empty'] as const;
const NUMBER_OPERATORS = [
  'equals',
  'greater_than',
  'greater_or_equal',
  'less_than',
  'less_or_equal',
  'between',
] as const;
const DATE_OPERATORS = ['equals', 'before', 'after', 'between'] as const;
const BOOLEAN_OPERATORS = ['equals'] as const;

/** Operators allowed per column type. */
export const CASE_OPERATORS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  text: TEXT_OPERATORS,
  status: STATUS_OPERATORS,
  number: NUMBER_OPERATORS,
  currency: NUMBER_OPERATORS,
  date: DATE_OPERATORS,
  boolean: BOOLEAN_OPERATORS,
};

/** Every operator above, without repeats (Zod needs a literal tuple). */
export const CASE_OPERATORS = [
  'contains',
  'not_contains',
  'equals',
  'not_equals',
  'starts_with',
  'is_empty',
  'is_not_empty',
  'in',
  'not_in',
  'greater_than',
  'greater_or_equal',
  'less_than',
  'less_or_equal',
  'between',
  'before',
  'after',
] as const;

const filterValueSchema = z.union([
  z.string().max(300),
  z.number(),
  z.boolean(),
  z.array(z.string().max(120)).max(50),
]);

export const caseFilterRuleSchema = z.object({
  field: z.string().min(1).max(80),
  operator: z.enum(CASE_OPERATORS),
  value: filterValueSchema.optional(),
  valueTo: z.union([z.string().max(300), z.number()]).optional(),
  shortcut: z.string().max(40).optional(),
});

export type CaseFilterRule = z.output<typeof caseFilterRuleSchema>;

export const caseFilterGroupSchema = z.object({
  logic: z.enum(['AND', 'OR']).default('AND'),
  rules: z.array(caseFilterRuleSchema).max(20).default([]),
});

export const caseSortSchema = z
  .array(z.object({ field: z.string().min(1).max(80), direction: z.enum(['asc', 'desc']) }))
  .max(3)
  .default([]);

export const caseQueryStateSchema = z.object({
  search: z.string().max(200).optional(),
  filters: caseFilterGroupSchema.default({ logic: 'AND', rules: [] }),
  sort: caseSortSchema,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
  scope: z.enum(CASE_SCOPES).default('open'),
  /** Process phase (`planning`…`closing`). */
  phase: z.enum(CASE_PHASES).optional(),
  /** Area holding the case up: it has open work or an open request there. */
  areaKey: z.string().trim().min(1).max(40).optional(),
  risk: z.enum(['late', 'risk', 'watch']).optional(),
  /** Only the cases this person owns. */
  ownerUserId: z.string().trim().min(1).max(120).optional(),
});

export type CaseQueryState = z.output<typeof caseQueryStateSchema>;

/**
 * Saved view of the case list: the query without its page plus the column
 * presentation (the same generic shape every other table stores). The page is
 * left out on purpose — reopening a view always starts on the first page.
 */
export const caseViewConfigSchema = z.object({
  version: z.literal(1).default(1),
  query: caseQueryStateSchema.omit({ page: true }),
  presentation: tablePreferenceConfigSchema,
});

export type CaseViewConfig = z.output<typeof caseViewConfigSchema>;

function assertRule(rule: CaseFilterRule): void {
  const type = CASE_FILTERABLE_FIELDS[rule.field];
  if (!type) {
    throw new CasesQueryError(`No se puede filtrar por "${rule.field}" en los expedientes`);
  }
  const allowed = CASE_OPERATORS_BY_TYPE[type] ?? [];
  if (!allowed.includes(rule.operator)) {
    throw new CasesQueryError(`El filtro "${rule.field}" no admite esa condición`);
  }
}

/** Parses and validates a raw query against the white list. Throws `CasesQueryError`. */
export function parseCasesQuery(raw: unknown): CaseQueryState {
  const parsed = caseQueryStateSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new CasesQueryError(parsed.error.issues[0]?.message ?? 'Consulta inválida');
  }
  const query = parsed.data;
  for (const rule of query.filters.rules) assertRule(rule);
  for (const sort of query.sort) {
    if (!CASE_SORTABLE_FIELDS[sort.field]) {
      throw new CasesQueryError(`No se puede ordenar por "${sort.field}" en los expedientes`);
    }
  }
  if (query.areaKey && !isAreaKey(query.areaKey)) {
    throw new CasesQueryError('Área desconocida');
  }
  return query;
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new CasesQueryError('Los filtros del enlace no son válidos');
  }
}

/** Query of a deep link (`/app/operations?fase=sourcing&riesgo=late&mios=1`). */
export function casesQueryFromSearchParams(
  params: Record<string, string | undefined>,
  options: { userId: string }
): CaseQueryState {
  return parseCasesQuery({
    search: params.search || undefined,
    filters: parseJson(params.filters) ?? { logic: 'AND', rules: [] },
    sort: parseJson(params.sort) ?? [],
    page: params.page ?? 1,
    page_size: params.page_size ?? 50,
    scope: params.scope && CASE_SCOPES.includes(params.scope as CaseScope) ? params.scope : 'open',
    ...(params.fase ? { phase: params.fase } : {}),
    ...(params.area ? { areaKey: params.area } : {}),
    ...(params.riesgo ? { risk: params.riesgo } : {}),
    ...(params.mios === '1' ? { ownerUserId: options.userId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Toolbar chips
// ---------------------------------------------------------------------------

export interface CaseChip {
  id: string;
  label: string;
  href: string;
  active: boolean;
  /** Assistive description when the label alone is not enough. */
  title?: string;
}

export interface CaseChipsState {
  scope: CaseScope;
  phase: string | null;
  risk: CaseRiskLevel | null;
  areaKey: string | null;
  mine: boolean;
}

export function caseChipsStateFromParams(
  params: Record<string, string | undefined>
): CaseChipsState {
  const scope = params.scope as CaseScope | undefined;
  const risk = params.riesgo as CaseRiskLevel | undefined;
  return {
    scope: scope && CASE_SCOPES.includes(scope) ? scope : 'open',
    phase:
      params.fase && (CASE_PHASES as readonly string[]).includes(params.fase) ? params.fase : null,
    risk: risk && CASE_RISK_FILTERS.includes(risk) ? risk : null,
    areaKey: params.area && isAreaKey(params.area) ? params.area : null,
    mine: params.mios === '1',
  };
}

/** Extra URL params the workspace keeps when it rewrites the URL. */
export function caseExtraUrlParams(state: CaseChipsState): Record<string, string> {
  const params: Record<string, string> = {};
  if (state.scope !== 'open') params.scope = state.scope;
  if (state.phase) params.fase = state.phase;
  if (state.risk) params.riesgo = state.risk;
  if (state.areaKey) params.area = state.areaKey;
  if (state.mine) params.mios = '1';
  return params;
}

function chipHref(state: CaseChipsState, patch: Partial<CaseChipsState>): string {
  const query = new URLSearchParams(caseExtraUrlParams({ ...state, ...patch })).toString();
  return query ? `${CASES_BASE_PATH}?${query}` : CASES_BASE_PATH;
}

export function caseScopeChips(state: CaseChipsState): CaseChip[] {
  return CASE_SCOPES.map((scope) => ({
    id: `scope-${scope}`,
    label: CASE_SCOPE_LABELS[scope],
    href: chipHref(state, { scope }),
    active: state.scope === scope,
  }));
}

export function casePhaseChips(state: CaseChipsState): CaseChip[] {
  return [
    {
      id: 'phase-all',
      label: 'Todas las fases',
      href: chipHref(state, { phase: null }),
      active: state.phase === null,
    },
    ...CASE_PHASES.map((phase) => ({
      id: `phase-${phase}`,
      label: CASE_PHASE_LABELS[phase],
      href: chipHref(state, { phase }),
      active: state.phase === phase,
    })),
  ];
}

export function caseRiskChips(state: CaseChipsState): CaseChip[] {
  return [
    {
      id: 'risk-all',
      label: 'Cualquier riesgo',
      href: chipHref(state, { risk: null }),
      active: state.risk === null,
    },
    ...CASE_RISK_FILTERS.map((risk) => ({
      id: `risk-${risk}`,
      label: CASE_RISK_LABELS[risk],
      href: chipHref(state, { risk }),
      active: state.risk === risk,
      title:
        risk === 'late'
          ? 'La fecha prometida ya pasó'
          : risk === 'risk'
            ? 'Bloqueado, con trabajo vencido o con incidencias abiertas'
            : 'La fecha prometida es en menos de 48 horas',
    })),
  ];
}

/** Blocking-area chips: only the areas that actually hold up a case right now. */
export function caseAreaChips(state: CaseChipsState, areaKeys: readonly string[]): CaseChip[] {
  if (areaKeys.length === 0) return [];
  return [
    {
      id: 'area-all',
      label: 'Todas las áreas',
      href: chipHref(state, { areaKey: null }),
      active: state.areaKey === null,
    },
    ...areaKeys.filter(isAreaKey).map((areaKey) => ({
      id: `area-${areaKey}`,
      label: AREA_LABELS[areaKey],
      href: chipHref(state, { areaKey }),
      active: state.areaKey === areaKey,
      title: `Expedientes con trabajo o solicitudes abiertas en ${AREA_LABELS[areaKey]}`,
    })),
  ];
}

export function caseMineChip(state: CaseChipsState): CaseChip {
  return {
    id: 'mine',
    label: 'Míos',
    href: chipHref(state, { mine: !state.mine }),
    active: state.mine,
    title: 'Sólo los expedientes de los que soy responsable',
  };
}
