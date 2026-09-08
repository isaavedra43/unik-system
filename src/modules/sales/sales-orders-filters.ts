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

export type TextOperator = (typeof TEXT_OPERATORS)[number];
export type SelectOperator = (typeof SELECT_OPERATORS)[number];
export type NumberOperator = (typeof NUMBER_OPERATORS)[number];
export type DateOperator = (typeof DATE_OPERATORS)[number];
export type BooleanOperator = (typeof BOOLEAN_OPERATORS)[number];

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

export const salesOrderFilterRuleSchema = z.union([
  textFilterSchema,
  selectFilterSchema,
  numberFilterSchema,
  dateFilterSchema,
  booleanFilterSchema,
]);

export type SalesOrderFilterRule = z.infer<typeof salesOrderFilterRuleSchema>;

export const salesOrderFilterGroupSchema = z.object({
  logic: z.enum(['AND', 'OR']).default('AND'),
  rules: z.array(salesOrderFilterRuleSchema).default([]),
});

export type SalesOrderFilterGroup = z.infer<typeof salesOrderFilterGroupSchema>;

/** Sort rule: field + direction. */
export const salesOrderSortRuleSchema = z.object({
  field: z.string().refine((f) => SALES_ORDER_SORTABLE_FIELDS.has(f)),
  direction: z.enum(['asc', 'desc']),
});

export type SalesOrderSortRule = z.infer<typeof salesOrderSortRuleSchema>;

export const salesOrderSortSchema = z.array(salesOrderSortRuleSchema).default([]);

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
export const salesOrderPresentationStateSchema = z.object({
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

export type SalesOrderPresentationState = z.output<typeof salesOrderPresentationStateSchema>;

/** Saved view config: combines query + presentation. */
export const salesOrderViewConfigSchema = z.object({
  version: z.literal(1).default(1),
  query: salesOrderQueryStateSchema.omit({ page: true }),
  presentation: salesOrderPresentationStateSchema,
});

export type SalesOrderViewConfig = z.output<typeof salesOrderViewConfigSchema>;

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
