import { z } from 'zod';
import { SALES_ORDER_FILTERABLE_FIELDS, SALES_ORDER_SORTABLE_FIELDS } from './sales-orders-columns';

/**
 * Filter model for the Sales Orders workspace.
 *
 * Filters are NEVER transformed directly into Prisma queries from the client.
 * The client sends a JSON array of filter rules; the server validates them
 * against this Zod schema (whitelist of fields, operators, and value types)
 * and then builds the Prisma where input in the service layer.
 */

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

type TextOperator = (typeof TEXT_OPERATORS)[number];
type SelectOperator = (typeof SELECT_OPERATORS)[number];
type NumberOperator = (typeof NUMBER_OPERATORS)[number];
type DateOperator = (typeof DATE_OPERATORS)[number];
type BooleanOperator = (typeof BOOLEAN_OPERATORS)[number];

export type FilterOperator =
  TextOperator | SelectOperator | NumberOperator | DateOperator | BooleanOperator;

export const FILTER_OPERATORS_BY_TYPE: Record<string, readonly string[]> = {
  text: TEXT_OPERATORS,
  status: SELECT_OPERATORS,
  select: SELECT_OPERATORS,
  number: NUMBER_OPERATORS,
  currency: NUMBER_OPERATORS,
  date: DATE_OPERATORS,
  boolean: BOOLEAN_OPERATORS,
};

export const FILTER_OPERATOR_LABELS: Record<string, string> = {
  contains: 'Contiene',
  not_contains: 'No contiene',
  equals: 'Es igual a',
  not_equals: 'No es igual a',
  starts_with: 'Comienza con',
  is_empty: 'Está vacío',
  is_not_empty: 'No está vacío',
  in: 'Es uno de',
  not_in: 'No es uno de',
  greater_than: 'Mayor que',
  greater_or_equal: 'Mayor o igual que',
  less_than: 'Menor que',
  less_or_equal: 'Menor o igual que',
  between: 'Entre',
  before: 'Antes de',
  after: 'Después de',
};

export const DATE_SHORTCUT_LABELS: Record<string, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  this_week: 'Esta semana',
  this_month: 'Este mes',
  last_7_days: 'Últimos 7 días',
  last_30_days: 'Últimos 30 días',
};

/** Date shortcut keys the UI can send instead of explicit dates. */
export const DATE_SHORTCUTS = [
  'today',
  'yesterday',
  'this_week',
  'this_month',
  'last_7_days',
  'last_30_days',
] as const;

export type DateShortcut = (typeof DATE_SHORTCUTS)[number];

const textFilterSchema = z.object({
  field: z.string().refine((f) => SALES_ORDER_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(TEXT_OPERATORS),
  value: z.string().optional(),
});

const selectFilterSchema = z.object({
  field: z.string().refine((f) => SALES_ORDER_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(SELECT_OPERATORS),
  value: z.union([z.string(), z.array(z.string())]).optional(),
});

const numberFilterSchema = z.object({
  field: z.string().refine((f) => SALES_ORDER_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(NUMBER_OPERATORS),
  value: z.union([z.number(), z.string()]).optional(),
  valueTo: z.union([z.number(), z.string()]).optional(),
});

const dateFilterSchema = z.object({
  field: z.string().refine((f) => SALES_ORDER_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(DATE_OPERATORS),
  value: z.union([z.string(), z.date()]).optional(),
  valueTo: z.union([z.string(), z.date()]).optional(),
  shortcut: z.enum(DATE_SHORTCUTS).optional(),
});

const booleanFilterSchema = z.object({
  field: z.string().refine((f) => SALES_ORDER_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(BOOLEAN_OPERATORS),
  value: z.boolean().optional(),
});

const salesOrderFilterRuleSchema = z.union([
  textFilterSchema,
  selectFilterSchema,
  numberFilterSchema,
  dateFilterSchema,
  booleanFilterSchema,
]);


export const salesOrderFilterGroupSchema = z.object({
  logic: z.enum(['AND', 'OR']).default('AND'),
  rules: z.array(salesOrderFilterRuleSchema).default([]),
});

export type SalesOrderFilterGroup = z.infer<typeof salesOrderFilterGroupSchema>;

/** Sort rule: field + direction. */
const salesOrderSortRuleSchema = z.object({
  field: z.string().refine((f) => SALES_ORDER_SORTABLE_FIELDS.has(f)),
  direction: z.enum(['asc', 'desc']),
});


const salesOrderSortSchema = z.array(salesOrderSortRuleSchema).default([]);

export type SalesOrderSort = z.infer<typeof salesOrderSortSchema>;

/** Full query state for the workspace (URL-serializable). */
export const salesOrderQueryStateSchema = z.object({
  search: z.string().optional(),
  filters: salesOrderFilterGroupSchema.default({ logic: 'AND', rules: [] }),
  sort: salesOrderSortSchema.default([]),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(50),
});

export type SalesOrderQueryState = z.output<typeof salesOrderQueryStateSchema>;

/** Presentation state (persisted in UserTablePreference, NOT in URL). */
const salesOrderPresentationStateSchema = z.object({
  version: z.literal(1).default(1),
  columnOrder: z.array(z.string()).default([]),
  columnVisibility: z.record(z.boolean()).default({}),
  columnWidths: z.record(z.number()).default({}),
  columnPinning: z
    .object({
      left: z.array(z.string()).default([]),
      right: z.array(z.string()).default([]),
    })
    .default({ left: [], right: [] }),
  density: z.enum(['compact', 'normal', 'comfortable']).default('normal'),
  pageSize: z.number().int().min(1).max(500).default(50),
});


/** Saved view config: combines query + presentation. */
export const salesOrderViewConfigSchema = z.object({
  version: z.literal(1).default(1),
  query: salesOrderQueryStateSchema.omit({ page: true }),
  presentation: salesOrderPresentationStateSchema,
});


/** Generic table preference config (same shape as presentation state). */
export const tablePreferenceConfigSchema = z.object({
  version: z.literal(1).default(1),
  columnOrder: z.array(z.string()).default([]),
  columnVisibility: z.record(z.boolean()).default({}),
  columnWidths: z.record(z.number()).default({}),
  columnPinning: z
    .object({
      left: z.array(z.string()).default([]),
      right: z.array(z.string()).default([]),
    })
    .default({ left: [], right: [] }),
  density: z.enum(['compact', 'normal', 'comfortable']).default('normal'),
  pageSize: z.number().int().min(1).max(500).default(50),
});

export type TablePreferenceConfig = z.output<typeof tablePreferenceConfigSchema>;

export const tableViewVisibilitySchema = z.enum(['private', 'shared']);

export type TableViewVisibility = z.infer<typeof tableViewVisibilitySchema>;
