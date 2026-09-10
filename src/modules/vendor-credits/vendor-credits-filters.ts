import { z } from 'zod';
import {
  VENDOR_CREDIT_FILTERABLE_FIELDS,
  VENDOR_CREDIT_SORTABLE_FIELDS,
} from './vendor-credits-columns';

/**
 * Filter model for the Vendor Credits workspace.
 *
 * Filters are NEVER transformed directly into Prisma queries from the client.
 * The client sends a JSON array of filter rules; the server validates them
 * against this Zod schema (whitelist of fields, operators, and value types)
 * and then builds the Prisma where input in the service layer.
 */

// Re-export shared types/constants so consumers can import everything from here.
export {
  type EntityColumnDefinition,
  type EntityFilterRule,
  type EntityFilterGroup,
  type EntitySort,
  type EntityPagination,
  type EntityListResult,
  type EntityQueryState,
  type FilterOperator,
  type DateShortcut,
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

import { DATE_SHORTCUTS } from '@/modules/shared/entity-workspace-types';

const textFilterSchema = z.object({
  field: z.string().refine((f) => VENDOR_CREDIT_FILTERABLE_FIELDS.has(f)),
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
  field: z.string().refine((f) => VENDOR_CREDIT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(['equals', 'not_equals', 'in', 'not_in', 'is_empty']),
  value: z.union([z.string(), z.array(z.string())]).optional(),
});

const numberFilterSchema = z.object({
  field: z.string().refine((f) => VENDOR_CREDIT_FILTERABLE_FIELDS.has(f)),
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
  field: z.string().refine((f) => VENDOR_CREDIT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(['equals', 'before', 'after', 'between']),
  value: z.union([z.string(), z.date()]).optional(),
  valueTo: z.union([z.string(), z.date()]).optional(),
  shortcut: z.enum(DATE_SHORTCUTS).optional(),
});

const booleanFilterSchema = z.object({
  field: z.string().refine((f) => VENDOR_CREDIT_FILTERABLE_FIELDS.has(f)),
  operator: z.enum(['equals']),
  value: z.boolean().optional(),
});

export const vendorCreditFilterRuleSchema = z.union([
  textFilterSchema,
  selectFilterSchema,
  numberFilterSchema,
  dateFilterSchema,
  booleanFilterSchema,
]);

export type VendorCreditFilterRule = z.infer<typeof vendorCreditFilterRuleSchema>;

export const vendorCreditFilterGroupSchema = z.object({
  logic: z.enum(['AND', 'OR']).default('AND'),
  rules: z.array(vendorCreditFilterRuleSchema).default([]),
});

export type VendorCreditFilterGroup = z.infer<typeof vendorCreditFilterGroupSchema>;

export const vendorCreditSortRuleSchema = z.object({
  field: z.string().refine((f) => VENDOR_CREDIT_SORTABLE_FIELDS.has(f)),
  direction: z.enum(['asc', 'desc']),
});

export const vendorCreditSortSchema = z.array(vendorCreditSortRuleSchema).default([]);

export type VendorCreditSort = z.infer<typeof vendorCreditSortSchema>;

export const vendorCreditQueryStateSchema = z.object({
  search: z.string().optional(),
  filters: vendorCreditFilterGroupSchema.default({ logic: 'AND', rules: [] }),
  sort: vendorCreditSortSchema.default([]),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(50),
});

export type VendorCreditQueryState = z.output<typeof vendorCreditQueryStateSchema>;

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
