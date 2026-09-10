import { z } from 'zod';
import {
  PURCHASE_ORDER_FILTERABLE_FIELDS,
  PURCHASE_ORDER_SORTABLE_FIELDS,
} from './purchase-orders-columns';

// Re-export shared types and constants so consumers can import from a single module.
export {
  type EntityColumnDefinition,
  type EntityQueryState,
  type EntityListResult,
  type EntityFilterGroup,
  type EntityFilterRule,
  type EntitySort,
  type EntityPagination,
  type SyncStatus,
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
  type FilterOperator,
  FILTER_OPERATORS_BY_TYPE,
  FILTER_OPERATOR_LABELS,
  DATE_SHORTCUTS,
  type DateShortcut,
  DATE_SHORTCUT_LABELS,
} from '@/modules/shared/entity-workspace-types';

// ---------------------------------------------------------------------------
// Zod schemas for purchase order filters / query state
// ---------------------------------------------------------------------------

const textFilterSchema = z.object({
  field: z.string().refine((f) => PURCHASE_ORDER_FILTERABLE_FIELDS.has(f)),
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
  field: z.string().refine((f) => PURCHASE_ORDER_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(['equals', 'not_equals', 'in', 'not_in', 'is_empty']),
  value: z.union([z.string(), z.array(z.string())]).optional(),
});

const numberFilterSchema = z.object({
  field: z.string().refine((f) => PURCHASE_ORDER_FILTERABLE_FIELDS.has(f)),
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
  field: z.string().refine((f) => PURCHASE_ORDER_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(['equals', 'before', 'after', 'between']),
  value: z.union([z.string(), z.date()]).optional(),
  valueTo: z.union([z.string(), z.date()]).optional(),
  shortcut: z
    .enum(['today', 'yesterday', 'this_week', 'this_month', 'last_7_days', 'last_30_days'])
    .optional(),
});

const booleanFilterSchema = z.object({
  field: z.string().refine((f) => PURCHASE_ORDER_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(['equals']),
  value: z.boolean().optional(),
});

export const purchaseOrderFilterRuleSchema = z.union([
  textFilterSchema,
  selectFilterSchema,
  numberFilterSchema,
  dateFilterSchema,
  booleanFilterSchema,
]);

export type PurchaseOrderFilterRule = z.infer<typeof purchaseOrderFilterRuleSchema>;

export const purchaseOrderFilterGroupSchema = z.object({
  logic: z.enum(['AND', 'OR']).default('AND'),
  rules: z.array(purchaseOrderFilterRuleSchema).default([]),
});

export type PurchaseOrderFilterGroup = z.infer<typeof purchaseOrderFilterGroupSchema>;

export const purchaseOrderSortRuleSchema = z.object({
  field: z.string().refine((f) => PURCHASE_ORDER_SORTABLE_FIELDS.has(f)),
  direction: z.enum(['asc', 'desc']),
});

export type PurchaseOrderSortRule = z.infer<typeof purchaseOrderSortRuleSchema>;

export const purchaseOrderSortSchema = z.array(purchaseOrderSortRuleSchema).default([]);

export type PurchaseOrderSort = z.infer<typeof purchaseOrderSortSchema>;

export const purchaseOrderQueryStateSchema = z.object({
  search: z.string().optional(),
  filters: purchaseOrderFilterGroupSchema.default({ logic: 'AND', rules: [] }),
  sort: purchaseOrderSortSchema.default([]),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(50),
});

export type PurchaseOrderQueryState = z.output<typeof purchaseOrderQueryStateSchema>;

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
