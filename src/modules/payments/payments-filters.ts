import { z } from 'zod';
import { PAYMENT_FILTERABLE_FIELDS, PAYMENT_SORTABLE_FIELDS } from './payments-columns';
import { DATE_SHORTCUTS } from '@/modules/shared/entity-workspace-types';

/**
 * Filter model for the Payments workspace.
 * Re-exports shared constants from the generic EntityWorkspace types so that
 * all modules stay in sync.
 */
export {
  type TablePreferenceConfig,
  FILTER_OPERATORS_BY_TYPE,
  FILTER_OPERATOR_LABELS,
  DATE_SHORTCUTS,
  DATE_SHORTCUT_LABELS,
} from '@/modules/shared/entity-workspace-types';

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

const textFilterSchema = z.object({
  field: z.string().refine((f) => PAYMENT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(TEXT_OPERATORS),
  value: z.string().optional(),
});

const selectFilterSchema = z.object({
  field: z.string().refine((f) => PAYMENT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(SELECT_OPERATORS),
  value: z.union([z.string(), z.array(z.string())]).optional(),
});

const numberFilterSchema = z.object({
  field: z.string().refine((f) => PAYMENT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(NUMBER_OPERATORS),
  value: z.union([z.number(), z.string()]).optional(),
  valueTo: z.union([z.number(), z.string()]).optional(),
});

const dateFilterSchema = z.object({
  field: z.string().refine((f) => PAYMENT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(DATE_OPERATORS),
  value: z.union([z.string(), z.date()]).optional(),
  valueTo: z.union([z.string(), z.date()]).optional(),
  shortcut: z.enum(DATE_SHORTCUTS).optional(),
});

const booleanFilterSchema = z.object({
  field: z.string().refine((f) => PAYMENT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(BOOLEAN_OPERATORS),
  value: z.boolean().optional(),
});

const paymentFilterRuleSchema = z.union([
  textFilterSchema,
  selectFilterSchema,
  numberFilterSchema,
  dateFilterSchema,
  booleanFilterSchema,
]);


export const paymentFilterGroupSchema = z.object({
  logic: z.enum(['AND', 'OR']).default('AND'),
  rules: z.array(paymentFilterRuleSchema).default([]),
});

export type PaymentFilterGroup = z.infer<typeof paymentFilterGroupSchema>;

const paymentSortRuleSchema = z.object({
  field: z.string().refine((f) => PAYMENT_SORTABLE_FIELDS.has(f)),
  direction: z.enum(['asc', 'desc']),
});


const paymentSortSchema = z.array(paymentSortRuleSchema).default([]);

export type PaymentSort = z.infer<typeof paymentSortSchema>;

export const paymentQueryStateSchema = z.object({
  search: z.string().optional(),
  filters: paymentFilterGroupSchema.default({ logic: 'AND', rules: [] }),
  sort: paymentSortSchema.default([]),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(50),
});

export type PaymentQueryState = z.output<typeof paymentQueryStateSchema>;

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

export const tableViewVisibilitySchema = z.enum(['private', 'shared']);

export type TableViewVisibility = z.infer<typeof tableViewVisibilitySchema>;
