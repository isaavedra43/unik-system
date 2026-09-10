import { z } from 'zod';
import { BILL_FILTERABLE_FIELDS, BILL_SORTABLE_FIELDS } from './bills-columns';

// Re-export shared types/constants so consumers can import everything from one place.
export {
  type EntityColumnDefinition,
  type TablePreferenceConfig,
  type EntityFilterRule,
  type EntityFilterGroup,
  type EntitySort,
  type EntityPagination,
  type EntityListResult,
  type EntityQueryState,
  type FilterOperator,
  type DateShortcut,
  type StatusConfig,
  type StatusOption,
  type SavePreferenceAction,
  type ResetPreferenceAction,
  type CreateViewAction,
  type WatchAction,
  type BulkWatchAction,
  type ExportAction,
  type TableViewRow,
  TEXT_OPERATORS,
  SELECT_OPERATORS,
  NUMBER_OPERATORS,
  DATE_OPERATORS,
  BOOLEAN_OPERATORS,
  FILTER_OPERATORS_BY_TYPE,
  FILTER_OPERATOR_LABELS,
  DATE_SHORTCUTS,
  DATE_SHORTCUT_LABELS,
} from '@/modules/shared/entity-workspace-types';

const textFilterSchema = z.object({
  field: z.string().refine((f) => BILL_FILTERABLE_FIELDS.has(f)),
  operator: z.enum([
    'contains',
    'not_contains',
    'equals',
    'not_equals',
    'starts_with',
    'is_empty',
    'is_not_empty',
  ]),
  value: z.string().optional(),
});

const selectFilterSchema = z.object({
  field: z.string().refine((f) => BILL_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(['equals', 'not_equals', 'in', 'not_in', 'is_empty']),
  value: z.union([z.string(), z.array(z.string())]).optional(),
});

const numberFilterSchema = z.object({
  field: z.string().refine((f) => BILL_FILTERABLE_FIELDS.has(f)),
  operator: z.enum([
    'equals',
    'greater_than',
    'greater_or_equal',
    'less_than',
    'less_or_equal',
    'between',
  ]),
  value: z.union([z.number(), z.string()]).optional(),
  valueTo: z.union([z.number(), z.string()]).optional(),
});

const dateFilterSchema = z.object({
  field: z.string().refine((f) => BILL_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(['equals', 'before', 'after', 'between']),
  value: z.union([z.string(), z.date()]).optional(),
  valueTo: z.union([z.string(), z.date()]).optional(),
  shortcut: z
    .enum(['today', 'yesterday', 'this_week', 'this_month', 'last_7_days', 'last_30_days'])
    .optional(),
});

export const billFilterRuleSchema = z.union([
  textFilterSchema,
  selectFilterSchema,
  numberFilterSchema,
  dateFilterSchema,
]);

export type BillFilterRule = z.infer<typeof billFilterRuleSchema>;

export const billFilterGroupSchema = z.object({
  logic: z.enum(['AND', 'OR']).default('AND'),
  rules: z.array(billFilterRuleSchema).default([]),
});

export type BillFilterGroup = z.infer<typeof billFilterGroupSchema>;

export const billSortRuleSchema = z.object({
  field: z.string().refine((f) => BILL_SORTABLE_FIELDS.has(f)),
  direction: z.enum(['asc', 'desc']),
});

export type BillSortRule = z.infer<typeof billSortRuleSchema>;

export const billSortSchema = z.array(billSortRuleSchema).default([]);

export type BillSort = z.infer<typeof billSortSchema>;

export const billQueryStateSchema = z.object({
  search: z.string().optional(),
  filters: billFilterGroupSchema.default({ logic: 'AND', rules: [] }),
  sort: billSortSchema.default([]),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(50),
});

export type BillQueryState = z.output<typeof billQueryStateSchema>;

export const billTablePreferenceConfigSchema = z.object({
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

export type BillTablePreferenceConfig = z.output<typeof billTablePreferenceConfigSchema>;

export const billTableViewVisibilitySchema = z.enum(['private', 'shared']);

export type BillTableViewVisibility = z.infer<typeof billTableViewVisibilitySchema>;
