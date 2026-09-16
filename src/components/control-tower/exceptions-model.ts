import { z } from 'zod';
import type { BadgeVariant } from '@/components/ui/primitives';
import type { EntityQueryState } from '@/modules/shared/entity-workspace-types';
import {
  CT_EXCEPTIONS_BASE_PATH,
  CT_EXCEPTION_DEFAULT_PAGE_SIZE,
  CT_EXCEPTION_FILTERABLE_FIELDS,
  CT_EXCEPTION_SORTABLE_FIELDS,
} from './exceptions-columns';

/**
 * Query state and vocabulary of the exceptions table (plan 7.7 `excepciones`).
 *
 * PURE and isomorphic: it travels to the browser, so it may NOT import
 * `exceptions-service` (that module loads Prisma). The kinds and severities are
 * mirrored here and `exceptions-model.test.ts` compares them against the
 * service's own constants, so the two can never drift apart silently.
 *
 * Validation is a WHITE LIST: an unknown sort field or an unknown filter field
 * throws `CtExceptionQueryError` (the route answers 422) instead of being
 * dropped, so nobody believes they filtered by something the server ignored.
 */

export class CtExceptionQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CtExceptionQueryError';
  }
}

/** Mirror of `EXCEPTION_KINDS` (exceptions-service). Verified by the test. */
export const CT_EXCEPTION_KINDS = [
  'work_overdue',
  'work_escalated',
  'incident',
  'request_overdue',
  'request_blocked',
  'delivery_conflict',
  'case_blocked',
  'case_stuck',
] as const;

export type CtExceptionKind = (typeof CT_EXCEPTION_KINDS)[number];

/** Mirror of `EXCEPTION_KIND_LABELS`. Verified by the test. */
export const CT_EXCEPTION_KIND_LABELS: Record<CtExceptionKind, string> = {
  work_overdue: 'Trabajo vencido',
  work_escalated: 'Trabajo escalado',
  incident: 'Incidencia abierta',
  request_overdue: 'Solicitud vencida',
  request_blocked: 'Solicitud bloqueada',
  delivery_conflict: 'Entrega en conflicto',
  case_blocked: 'Expediente bloqueado',
  case_stuck: 'Expediente sin movimiento',
};

export const CT_EXCEPTION_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type CtExceptionSeverity = (typeof CT_EXCEPTION_SEVERITIES)[number];

export const CT_EXCEPTION_SEVERITY_LABELS: Record<CtExceptionSeverity, string> = {
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

export const CT_EXCEPTION_SEVERITY_TONES: Record<CtExceptionSeverity, BadgeVariant> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'weak',
};

export function exceptionSeverityTone(severity: string): BadgeVariant {
  return (
    CT_EXCEPTION_SEVERITY_TONES[severity as CtExceptionSeverity] ?? ('default' as BadgeVariant)
  );
}

export function exceptionKindLabel(kind: string): string {
  return CT_EXCEPTION_KIND_LABELS[kind as CtExceptionKind] ?? kind;
}

// ---------------------------------------------------------------------------
// Query state
// ---------------------------------------------------------------------------

const filterValueSchema = z.union([
  z.string().max(300),
  z.number(),
  z.boolean(),
  z.array(z.string().max(120)).max(50),
]);

export const ctExceptionFilterRuleSchema = z.object({
  field: z.string().min(1).max(80),
  operator: z.string().min(1).max(40),
  value: filterValueSchema.optional(),
  valueTo: z.union([z.string().max(300), z.number()]).optional(),
  shortcut: z.string().max(40).optional(),
});

export const ctExceptionQueryStateSchema = z.object({
  search: z.string().max(200).optional(),
  filters: z
    .object({
      logic: z.enum(['AND', 'OR']).default('AND'),
      rules: z.array(ctExceptionFilterRuleSchema).max(20).default([]),
    })
    .default({ logic: 'AND', rules: [] }),
  sort: z
    .array(z.object({ field: z.string().min(1).max(80), direction: z.enum(['asc', 'desc']) }))
    .max(4)
    .default([]),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  page_size: z.coerce.number().int().min(5).max(200).default(CT_EXCEPTION_DEFAULT_PAGE_SIZE),
  kind: z.array(z.enum(CT_EXCEPTION_KINDS)).max(CT_EXCEPTION_KINDS.length).default([]),
  areaKey: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  severity: z.array(z.enum(CT_EXCEPTION_SEVERITIES)).max(4).default([]),
});

export type CtExceptionQueryState = z.output<typeof ctExceptionQueryStateSchema> & EntityQueryState;

export const EMPTY_CT_EXCEPTION_QUERY: CtExceptionQueryState = {
  search: '',
  filters: { logic: 'AND', rules: [] },
  sort: [],
  page: 1,
  page_size: CT_EXCEPTION_DEFAULT_PAGE_SIZE,
  kind: [],
  areaKey: [],
  severity: [],
};

/** Parses whatever the table posted; unknown fields are refused, not ignored. */
export function parseCtExceptionQuery(raw: unknown): CtExceptionQueryState {
  const parsed = ctExceptionQueryStateSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CtExceptionQueryError(
      `Consulta inválida${issue ? `: ${issue.path.join('.') || 'consulta'} ${issue.message}` : ''}`
    );
  }
  const state = parsed.data;
  for (const entry of state.sort) {
    if (!CT_EXCEPTION_SORTABLE_FIELDS.includes(entry.field)) {
      throw new CtExceptionQueryError(`No se puede ordenar por «${entry.field}»`);
    }
  }
  for (const rule of state.filters.rules) {
    if (!CT_EXCEPTION_FILTERABLE_FIELDS.includes(rule.field)) {
      throw new CtExceptionQueryError(`No se puede filtrar por «${rule.field}»`);
    }
  }
  return state as CtExceptionQueryState;
}

function ruleValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

/**
 * Query state (table) → input of `listControlTowerExceptions`. Chips and the
 * filter builder end in the same arrays; both are intersected so a chip never
 * widens what a filter narrowed.
 */
export interface CtExceptionServiceQuery {
  kind: CtExceptionKind[];
  areaKey: string[];
  severity: CtExceptionSeverity[];
  search: string;
  page: number;
  page_size: number;
  sort: 'since' | 'dueAt' | 'severity' | 'caseNumber' | 'areaKey';
  direction: 'asc' | 'desc';
}

const SORT_FIELD_BY_COLUMN: Record<string, CtExceptionServiceQuery['sort']> = {
  since: 'since',
  dueAt: 'dueAt',
  severity: 'severity',
  caseNumber: 'caseNumber',
  areaKey: 'areaKey',
};

function intersect<T extends string>(chips: readonly T[], rules: readonly string[]): T[] {
  if (rules.length === 0) return [...chips];
  const fromRules = rules as readonly T[];
  if (chips.length === 0) return [...fromRules];
  return chips.filter((entry) => fromRules.includes(entry));
}

export function toExceptionServiceQuery(state: CtExceptionQueryState): CtExceptionServiceQuery {
  const ruleKinds: string[] = [];
  const ruleAreas: string[] = [];
  const ruleSeverities: string[] = [];
  for (const rule of state.filters.rules) {
    const values = ruleValues(rule.value);
    if (values.length === 0) continue;
    if (rule.field === 'kind') ruleKinds.push(...values);
    else if (rule.field === 'areaKey') ruleAreas.push(...values);
    else if (rule.field === 'severity') ruleSeverities.push(...values);
  }

  const sortEntry = state.sort[0];
  const sort = sortEntry ? SORT_FIELD_BY_COLUMN[sortEntry.field] : undefined;

  return {
    kind: intersect(
      state.kind,
      ruleKinds.filter((value): value is CtExceptionKind =>
        (CT_EXCEPTION_KINDS as readonly string[]).includes(value)
      )
    ),
    areaKey: intersect(state.areaKey, ruleAreas),
    severity: intersect(
      state.severity,
      ruleSeverities.filter((value): value is CtExceptionSeverity =>
        (CT_EXCEPTION_SEVERITIES as readonly string[]).includes(value)
      )
    ),
    search: state.search ?? '',
    page: state.page,
    page_size: state.page_size,
    sort: sort ?? 'severity',
    direction: sortEntry?.direction ?? 'desc',
  };
}

// ---------------------------------------------------------------------------
// Chips (URL state)
// ---------------------------------------------------------------------------

export interface CtExceptionChip {
  id: string;
  label: string;
  href: string;
  active: boolean;
  title?: string;
}

export interface CtExceptionChipState {
  kind: CtExceptionKind | null;
  severity: CtExceptionSeverity | null;
  areaKey: string | null;
}

export const EMPTY_CT_EXCEPTION_CHIPS: CtExceptionChipState = {
  kind: null,
  severity: null,
  areaKey: null,
};

function chipHref(current: CtExceptionChipState, patch: Partial<CtExceptionChipState>): string {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();
  if (next.kind) params.set('tipo', next.kind);
  if (next.severity) params.set('severidad', next.severity);
  if (next.areaKey) params.set('area', next.areaKey);
  const query = params.toString();
  return query ? `${CT_EXCEPTIONS_BASE_PATH}?${query}` : CT_EXCEPTIONS_BASE_PATH;
}

/** Chips of exception kind, with the count the service returned for each one. */
export function exceptionKindChips(
  current: CtExceptionChipState,
  counts: ReadonlyArray<{ kind: string; count: number }> = []
): CtExceptionChip[] {
  const countOf = (kind: string) => counts.find((row) => row.kind === kind)?.count ?? 0;
  const total = counts.reduce((sum, row) => sum + row.count, 0);
  const chips: CtExceptionChip[] = [
    {
      id: 'all',
      label: counts.length > 0 ? `Todas (${total})` : 'Todas',
      href: chipHref(current, { kind: null }),
      active: current.kind === null,
    },
  ];
  for (const kind of CT_EXCEPTION_KINDS) {
    const count = countOf(kind);
    if (count === 0 && current.kind !== kind) continue;
    chips.push({
      id: kind,
      label: `${CT_EXCEPTION_KIND_LABELS[kind]}${count > 0 ? ` (${count})` : ''}`,
      href: chipHref(current, { kind }),
      active: current.kind === kind,
    });
  }
  return chips;
}

export function exceptionSeverityChips(current: CtExceptionChipState): CtExceptionChip[] {
  return [
    {
      id: 'all',
      label: 'Cualquiera',
      href: chipHref(current, { severity: null }),
      active: current.severity === null,
    },
    ...CT_EXCEPTION_SEVERITIES.map((severity) => ({
      id: severity,
      label: CT_EXCEPTION_SEVERITY_LABELS[severity],
      href: chipHref(current, { severity }),
      active: current.severity === severity,
    })),
  ];
}

/** Chip state from the URL of the page (`?tipo=&severidad=&area=`). */
export function exceptionChipsFromParams(
  params: Record<string, string | undefined>
): CtExceptionChipState {
  const kind = params.tipo;
  const severity = params.severidad;
  const area = params.area;
  return {
    kind:
      kind && (CT_EXCEPTION_KINDS as readonly string[]).includes(kind)
        ? (kind as CtExceptionKind)
        : null,
    severity:
      severity && (CT_EXCEPTION_SEVERITIES as readonly string[]).includes(severity)
        ? (severity as CtExceptionSeverity)
        : null,
    areaKey: area && area.trim() ? area.trim().slice(0, 40) : null,
  };
}

/** Query state seeded from the chips, so the first render and the table agree. */
export function queryFromChips(chips: CtExceptionChipState): CtExceptionQueryState {
  return {
    ...EMPTY_CT_EXCEPTION_QUERY,
    kind: chips.kind ? [chips.kind] : [],
    severity: chips.severity ? [chips.severity] : [],
    areaKey: chips.areaKey ? [chips.areaKey] : [],
  };
}

function safeJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Query state of a FULL page load. `EntityWorkspace` keeps `search`, `page`,
 * `page_size`, `sort` and `filters` in the address bar, so reloading a link
 * (or sharing it) must land on the very same rows — not on page 1 with the
 * search box empty.
 *
 * A malformed parameter is dropped, never thrown at the person: the page still
 * opens with the chips they can see. A field that is not sortable or filterable
 * DOES throw (through `parseCtExceptionQuery`), because silently ignoring it
 * would show different rows than the URL promises.
 */
export function exceptionQueryFromSearchParams(
  params: Record<string, string | undefined>,
  chips: CtExceptionChipState
): CtExceptionQueryState {
  const base = queryFromChips(chips);
  const sort = safeJson(params.sort);
  const filters = safeJson(params.filters);
  return parseCtExceptionQuery({
    ...base,
    ...(params.search ? { search: params.search.slice(0, 200) } : {}),
    ...(params.page ? { page: params.page } : {}),
    ...(params.page_size ? { page_size: params.page_size } : {}),
    ...(Array.isArray(sort) ? { sort } : {}),
    ...(filters && typeof filters === 'object' ? { filters } : {}),
  });
}

/** URL parameters the workspace must keep when it rewrites the address bar. */
export function exceptionExtraUrlParams(chips: CtExceptionChipState): Record<string, string> {
  const params: Record<string, string> = {};
  if (chips.kind) params.tipo = chips.kind;
  if (chips.severity) params.severidad = chips.severity;
  if (chips.areaKey) params.area = chips.areaKey;
  return params;
}
