import { z } from 'zod';
import type { EntityColumnDefinition, EntityColumnType } from './entity-columns';

/**
 * Generic filter model for entity workspaces.
 *
 * Filters are NEVER transformed directly into Prisma queries from the client.
 * The client sends a JSON array of filter rules; the server validates them
 * against a Zod schema (whitelist of fields, operators, and value types)
 * and then builds the Prisma where input in the service layer.
 *
 * This module provides the shared operator definitions and the factory
 * function to create a per-entity filter schema from a column registry.
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
  | TextOperator
  | SelectOperator
  | NumberOperator
  | DateOperator
  | BooleanOperator;

export const FILTER_OPERATORS_BY_TYPE: Record<EntityColumnType, readonly string[]> = {
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
  starts_with: 'Empieza con',
  is_empty: 'Está vacío',
  is_not_empty: 'No está vacío',
  in: 'En',
  not_in: 'No en',
  greater_than: 'Mayor que',
  greater_or_equal: 'Mayor o igual que',
  less_than: 'Menor que',
  less_or_equal: 'Menor o igual que',
  between: 'Entre',
  before: 'Antes de',
  after: 'Después de',
};

/**
 * A single filter rule.
 */
export interface FilterRule {
  field: string;
  operator: FilterOperator;
  value: string | number | boolean | null | string[];
  /** Optional second value for 'between' operator. */
  value2?: string | number | null;
}

/**
 * A group of filter rules combined with AND or OR.
 */
export interface FilterGroup {
  combinator: 'and' | 'or';
  rules: (FilterRule | FilterGroup)[];
}

/**
 * Date shortcut presets understood by the filter UI.
 */
export const DATE_SHORTCUTS = [
  { id: 'today', label: 'Hoy' },
  { id: 'yesterday', label: 'Ayer' },
  { id: 'last7days', label: 'Últimos 7 días' },
  { id: 'last30days', label: 'Últimos 30 días' },
  { id: 'thisMonth', label: 'Este mes' },
  { id: 'lastMonth', label: 'Mes anterior' },
  { id: 'thisYear', label: 'Este año' },
] as const;

export type DateShortcutId = (typeof DATE_SHORTCUTS)[number]['id'];

/**
 * Creates a Zod schema for validating filter rules against a column registry.
 * Only fields that exist in the registry and are filterable are allowed.
 */
export function createFilterSchema(columns: EntityColumnDefinition[]) {
  const filterableFields = new Set(
    columns.filter((c) => c.filterable).map((c) => c.field)
  );

  const fieldToType = new Map(
    columns.filter((c) => c.filterable).map((c) => [c.field, c.type] as const)
  );

  const allOperators = [
    ...TEXT_OPERATORS,
    ...SELECT_OPERATORS,
    ...NUMBER_OPERATORS,
    ...DATE_OPERATORS,
    ...BOOLEAN_OPERATORS,
  ] as const;

  const ruleSchema = z.object({
    field: z.string().refine((f) => filterableFields.has(f), 'Field is not filterable'),
    operator: z.enum(allOperators),
    value: z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.string()),
    ]),
    value2: z.union([z.string(), z.number(), z.null()]).optional(),
  }).refine(
    (rule) => {
      const type = fieldToType.get(rule.field);
      if (!type) return false;
      const allowed = FILTER_OPERATORS_BY_TYPE[type];
      return allowed.includes(rule.operator);
    },
    { message: 'Operator is not valid for this field type' }
  );

  const groupSchema: z.ZodType<FilterGroup> = z.lazy((): z.ZodType<FilterGroup> =>
    z.object({
      combinator: z.enum(['and', 'or']),
      rules: z.array(z.union([ruleSchema, groupSchema])),
    })
  );

  return z.object({
    groups: z.array(groupSchema).default([]),
  });
}

/**
 * Resolves a date shortcut ID to a [from, to] date range.
 */
export function resolveDateShortcut(
  shortcutId: DateShortcutId,
  now: Date = new Date()
): { from: Date; to: Date } | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (shortcutId) {
    case 'today':
      return { from: today, to: new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1) };
    case 'yesterday': {
      const from = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1) };
    }
    case 'last7days':
      return { from: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000), to: today };
    case 'last30days':
      return { from: new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000), to: today };
    case 'thisMonth':
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1),
        to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59),
      };
    case 'lastMonth':
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59),
      };
    case 'thisYear':
      return {
        from: new Date(now.getFullYear(), 0, 1),
        to: new Date(now.getFullYear(), 11, 31, 23, 59, 59),
      };
    default:
      return null;
  }
}
