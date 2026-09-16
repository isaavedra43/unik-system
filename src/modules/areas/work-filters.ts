import { z } from 'zod';
import type { AreaMeta } from './area-registry';
import { areaWorkFilterableFields, areaWorkSortableFields } from './work-columns';

/**
 * Query state of an area work centre (plan 7.4): the same shape the other
 * `EntityWorkspace` modules use (`search`, `filters`, `sort`, `page`,
 * `page_size`) plus the operational filters `kind`, `scope`, `caseId`,
 * `ownerUserId` and `overdueOnly`.
 *
 * Validation is a WHITE LIST: every filter and sort field must be a column of
 * the area and every row kind must belong to its work centre, so no text
 * written by a person can name a column or a branch.
 */

export class AreaWorkQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AreaWorkQueryError';
  }
}

export const AREA_WORK_SCOPES = ['open', 'closed', 'all'] as const;
export type AreaWorkScope = (typeof AREA_WORK_SCOPES)[number];

export const AREA_WORK_SCOPE_LABELS: Readonly<Record<AreaWorkScope, string>> = {
  open: 'Abiertos',
  closed: 'Cerrados',
  all: 'Todos',
};

export const TEXT_OPERATORS = [
  'contains',
  'not_contains',
  'equals',
  'not_equals',
  'starts_with',
  'is_empty',
  'is_not_empty',
] as const;
export const SELECT_OPERATORS = ['equals', 'not_equals', 'in', 'not_in', 'is_empty'] as const;
export const NUMBER_OPERATORS = [
  'equals',
  'greater_than',
  'greater_or_equal',
  'less_than',
  'less_or_equal',
  'between',
] as const;
export const DATE_OPERATORS = ['equals', 'before', 'after', 'between'] as const;
export const BOOLEAN_OPERATORS = ['equals'] as const;

/** Union of the operators above, without repeats (a literal tuple: Zod needs one). */
export const AREA_WORK_OPERATORS = [
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

export type AreaWorkOperator = (typeof AREA_WORK_OPERATORS)[number];

const filterValueSchema = z.union([
  z.string().max(300),
  z.number(),
  z.boolean(),
  z.array(z.string().max(120)).max(50),
]);

export const areaWorkFilterRuleSchema = z.object({
  field: z.string().min(1).max(80),
  operator: z.enum(AREA_WORK_OPERATORS),
  value: filterValueSchema.optional(),
  valueTo: z.union([z.string().max(300), z.number()]).optional(),
  shortcut: z.string().max(40).optional(),
});

export type AreaWorkFilterRule = z.output<typeof areaWorkFilterRuleSchema>;

export const areaWorkFilterGroupSchema = z.object({
  logic: z.enum(['AND', 'OR']).default('AND'),
  rules: z.array(areaWorkFilterRuleSchema).max(20).default([]),
});

export const areaWorkSortSchema = z
  .array(
    z.object({
      field: z.string().min(1).max(80),
      direction: z.enum(['asc', 'desc']),
    })
  )
  .max(4)
  .default([]);

export const areaWorkQueryStateSchema = z.object({
  search: z.string().max(200).optional(),
  filters: areaWorkFilterGroupSchema.default({ logic: 'AND', rules: [] }),
  sort: areaWorkSortSchema,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
  /** Row kinds shown; empty = every kind of the area's work centre. */
  kind: z.array(z.string().min(1).max(60)).max(30).default([]),
  scope: z.enum(AREA_WORK_SCOPES).default('open'),
  caseId: z.string().trim().min(1).max(120).optional(),
  /** Only rows owned (or covered as backup) by this user. */
  ownerUserId: z.string().trim().min(1).max(120).optional(),
  overdueOnly: z.coerce.boolean().default(false),
});

export type AreaWorkQueryState = z.output<typeof areaWorkQueryStateSchema>;

export const tablePreferenceConfigSchema = z.object({
  version: z.literal(1).default(1),
  columnOrder: z.array(z.string().max(80)).max(60).default([]),
  columnVisibility: z.record(z.boolean()).default({}),
  columnWidths: z.record(z.number()).default({}),
  columnPinning: z
    .object({
      left: z.array(z.string().max(80)).max(10).default([]),
      right: z.array(z.string().max(80)).max(10).default([]),
    })
    .default({ left: [], right: [] }),
  density: z.enum(['compact', 'normal', 'comfortable']).default('normal'),
  pageSize: z.number().int().min(1).max(200).default(50),
});

export type AreaTablePreferenceConfig = z.output<typeof tablePreferenceConfigSchema>;

export const tableViewVisibilitySchema = z.enum(['private', 'shared']);

/**
 * Config of a saved view of an area's work centre.
 *
 * `createTableView` validates whatever it is given, and its default schema is
 * the one of the sales orders table, whose `field` must be a sales-order field:
 * saving an area view with an area filter threw a raw ZodError. Areas must pass
 * THIS schema, which validates the query against the columns of that very area
 * (`parseAreaWorkQuery`), so an unknown field is refused in Spanish and a view
 * can never be stored with a filter its own table cannot run.
 */
export function areaViewConfigSchema(area: AreaMeta): { parse: (value: unknown) => unknown } {
  return {
    parse(value: unknown) {
      const shape = z
        .object({
          version: z.literal(1).default(1),
          query: z.unknown(),
          presentation: tablePreferenceConfigSchema,
        })
        .safeParse(value ?? {});
      if (!shape.success) {
        const detail = shape.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || 'vista'}: ${issue.message}`)
          .join('; ');
        throw new AreaWorkQueryError(`Vista inválida: ${detail}`);
      }
      const rawQuery = { ...((shape.data.query ?? {}) as Record<string, unknown>) };
      // A saved view keeps the filters, the sort and the chips — never the page it was saved on.
      delete rawQuery.page;
      return {
        version: 1 as const,
        query: parseAreaWorkQuery(rawQuery, area),
        presentation: shape.data.presentation,
      };
    },
  };
}

/**
 * Parses and validates a query against the area's own columns and row kinds.
 * Throws `AreaWorkQueryError` (Spanish) for an unknown field, operator or kind
 * instead of silently ignoring it, so a broken link never shows the wrong data.
 */
export function parseAreaWorkQuery(raw: unknown, area: AreaMeta): AreaWorkQueryState {
  const parsed = areaWorkQueryStateSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'consulta'}: ${issue.message}`)
      .join('; ');
    throw new AreaWorkQueryError(`Consulta inválida: ${detail}`);
  }
  const query = parsed.data;
  const filterable = areaWorkFilterableFields(area);
  const sortable = areaWorkSortableFields(area);
  const kinds = new Set(area.workCenter.rowKinds);

  for (const rule of query.filters.rules) {
    if (!filterable.has(rule.field)) {
      throw new AreaWorkQueryError(`No se puede filtrar por "${rule.field}" en ${area.label}`);
    }
  }
  for (const sort of query.sort) {
    if (!sortable.has(sort.field)) {
      throw new AreaWorkQueryError(`No se puede ordenar por "${sort.field}" en ${area.label}`);
    }
  }
  for (const kind of query.kind) {
    if (!kinds.has(kind)) {
      throw new AreaWorkQueryError(`${area.label} no tiene filas de tipo "${kind}"`);
    }
  }
  return query;
}

/** Default sort: what is due first, then the most recent activity. */
export const DEFAULT_AREA_WORK_SORT: AreaWorkQueryState['sort'] = [
  { field: 'dueAt', direction: 'asc' },
];

interface RawSearchParams {
  search?: string | string[];
  page?: string | string[];
  page_size?: string | string[];
  sort?: string | string[];
  filters?: string | string[];
  kind?: string | string[];
  scope?: string | string[];
  caso?: string | string[];
  mios?: string | string[];
  vencidos?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Query of a page from its search params. `kind` and `scope` are the chips of
 * the toolbar, `mios` restricts the list to the person's own work and
 * `vencidos` to the overdue rows.
 */
export function areaWorkQueryFromSearchParams(
  params: RawSearchParams,
  area: AreaMeta,
  options: { userId?: string; rowKinds?: readonly string[] } = {}
): AreaWorkQueryState {
  const kindParam = first(params.kind);
  const declared = options.rowKinds ?? [];
  const kinds =
    kindParam && kindParam !== 'all'
      ? [kindParam]
      : declared.length > 0 && declared.length < area.workCenter.rowKinds.length
        ? [...declared]
        : [];
  const mine = first(params.mios) === '1';
  return parseAreaWorkQuery(
    {
      search: first(params.search) ?? '',
      filters: parseJson(first(params.filters)) ?? { logic: 'AND', rules: [] },
      sort: parseJson(first(params.sort)) ?? DEFAULT_AREA_WORK_SORT,
      page: first(params.page) ?? 1,
      page_size: first(params.page_size) ?? 50,
      kind: kinds,
      scope: first(params.scope) ?? 'open',
      caseId: first(params.caso),
      ownerUserId: mine && options.userId ? options.userId : undefined,
      overdueOnly: first(params.vencidos) === '1',
    },
    area
  );
}

/**
 * Search params of a chip link, keeping the rest of the state readable in the URL.
 *
 * The implementation lives in `area-links.ts` (pure, zod-free) so the toolbar —
 * a client component — can build chip hrefs without pulling the schemas of this
 * module into the browser bundle. It is re-exported here because this is the
 * module the plan (§7.4) names as the query-state surface of the work centre,
 * and because `areaWorkQueryFromSearchParams` above is what reads these params
 * back: the writer and the reader stay next to each other.
 */
export { areaWorkChipParams, type AreaWorkChipState } from './area-links';
