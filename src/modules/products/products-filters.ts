import { z } from 'zod';
import { PRODUCT_FILTERABLE_FIELDS, PRODUCT_SORTABLE_FIELDS } from './products-columns';

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

export type FilterOperator =
  | (typeof TEXT_OPERATORS)[number]
  | (typeof SELECT_OPERATORS)[number]
  | (typeof NUMBER_OPERATORS)[number]
  | (typeof DATE_OPERATORS)[number]
  | (typeof BOOLEAN_OPERATORS)[number];

export const FILTER_OPERATORS_BY_TYPE: Record<string, readonly string[]> = {
  text: TEXT_OPERATORS,
  status: SELECT_OPERATORS,
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

export const DATE_SHORTCUTS = [
  'today',
  'yesterday',
  'this_week',
  'this_month',
  'last_7_days',
  'last_30_days',
] as const;

export type DateShortcut = (typeof DATE_SHORTCUTS)[number];

export const DATE_SHORTCUT_LABELS: Record<string, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  this_week: 'Esta semana',
  this_month: 'Este mes',
  last_7_days: 'Últimos 7 días',
  last_30_days: 'Últimos 30 días',
};

const textFilterSchema = z.object({
  field: z.string().refine((f) => PRODUCT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(TEXT_OPERATORS),
  value: z.string().optional(),
});

const selectFilterSchema = z.object({
  field: z.string().refine((f) => PRODUCT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(SELECT_OPERATORS),
  value: z.union([z.string(), z.array(z.string())]).optional(),
});

const numberFilterSchema = z.object({
  field: z.string().refine((f) => PRODUCT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(NUMBER_OPERATORS),
  value: z.union([z.number(), z.string()]).optional(),
  valueTo: z.union([z.number(), z.string()]).optional(),
});

const dateFilterSchema = z.object({
  field: z.string().refine((f) => PRODUCT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(DATE_OPERATORS),
  value: z.union([z.string(), z.date()]).optional(),
  valueTo: z.union([z.string(), z.date()]).optional(),
  shortcut: z.enum(DATE_SHORTCUTS).optional(),
});

const booleanFilterSchema = z.object({
  field: z.string().refine((f) => PRODUCT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(BOOLEAN_OPERATORS),
  value: z.boolean().optional(),
});

export const productFilterRuleSchema = z.union([
  textFilterSchema,
  selectFilterSchema,
  numberFilterSchema,
  dateFilterSchema,
  booleanFilterSchema,
]);

export type ProductFilterRule = z.infer<typeof productFilterRuleSchema>;

export const productFilterGroupSchema = z.object({
  logic: z.enum(['AND', 'OR']).default('AND'),
  rules: z.array(productFilterRuleSchema).default([]),
});

export type ProductFilterGroup = z.infer<typeof productFilterGroupSchema>;

export const productSortRuleSchema = z.object({
  field: z.string().refine((f) => PRODUCT_SORTABLE_FIELDS.has(f)),
  direction: z.enum(['asc', 'desc']),
});

export type ProductSortRule = z.infer<typeof productSortRuleSchema>;

export const productSortSchema = z.array(productSortRuleSchema).default([]);

export type ProductSort = z.infer<typeof productSortSchema>;

export const productQueryStateSchema = z.object({
  search: z.string().optional(),
  filters: productFilterGroupSchema.default({ logic: 'AND', rules: [] }),
  sort: productSortSchema.default([]),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(50),
});

export type ProductQueryState = z.output<typeof productQueryStateSchema>;

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
