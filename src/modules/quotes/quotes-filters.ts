import { z } from 'zod';
import { QUOTE_FILTERABLE_FIELDS, QUOTE_SORTABLE_FIELDS } from './quotes-columns';

export const TEXT_OPERATORS = ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'is_empty', 'is_not_empty'] as const;
export const SELECT_OPERATORS = ['equals', 'not_equals', 'in', 'not_in', 'is_empty'] as const;
export const NUMBER_OPERATORS = ['equals', 'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal', 'between'] as const;
export const DATE_OPERATORS = ['equals', 'before', 'after', 'between'] as const;

export type FilterOperator = (typeof TEXT_OPERATORS)[number] | (typeof SELECT_OPERATORS)[number] | (typeof NUMBER_OPERATORS)[number] | (typeof DATE_OPERATORS)[number];

export const FILTER_OPERATORS_BY_TYPE: Record<string, readonly string[]> = {
  text: TEXT_OPERATORS, status: SELECT_OPERATORS, number: NUMBER_OPERATORS, currency: NUMBER_OPERATORS, date: DATE_OPERATORS,
};

export const FILTER_OPERATOR_LABELS: Record<string, string> = {
  contains: 'Contiene', not_contains: 'No contiene', equals: 'Es igual a', not_equals: 'No es igual a',
  starts_with: 'Comienza con', is_empty: 'Está vacío', is_not_empty: 'No está vacío',
  in: 'Es uno de', not_in: 'No es uno de',
  greater_than: 'Mayor que', greater_or_equal: 'Mayor o igual que',
  less_than: 'Menor que', less_or_equal: 'Menor o igual que', between: 'Entre',
  before: 'Antes de', after: 'Después de',
};

export const DATE_SHORTCUTS = ['today', 'yesterday', 'this_week', 'this_month', 'last_7_days', 'last_30_days', 'next_7_days', 'next_30_days'] as const;
export type DateShortcut = (typeof DATE_SHORTCUTS)[number];
export const DATE_SHORTCUT_LABELS: Record<string, string> = {
  today: 'Hoy', yesterday: 'Ayer', this_week: 'Esta semana', this_month: 'Este mes',
  last_7_days: 'Últimos 7 días', last_30_days: 'Últimos 30 días',
  next_7_days: 'Próximos 7 días', next_30_days: 'Próximos 30 días',
};

const fieldSchema = z.string().refine((f) => QUOTE_FILTERABLE_FIELDS.has(f));
const textFilterSchema = z.object({ field: fieldSchema, operator: z.enum(TEXT_OPERATORS), value: z.string().optional() });
const selectFilterSchema = z.object({ field: fieldSchema, operator: z.enum(SELECT_OPERATORS), value: z.union([z.string(), z.array(z.string())]).optional() });
const numberFilterSchema = z.object({ field: fieldSchema, operator: z.enum(NUMBER_OPERATORS), value: z.union([z.number(), z.string()]).optional(), valueTo: z.union([z.number(), z.string()]).optional() });
const dateFilterSchema = z.object({ field: fieldSchema, operator: z.enum(DATE_OPERATORS), value: z.union([z.string(), z.date()]).optional(), valueTo: z.union([z.string(), z.date()]).optional(), shortcut: z.enum(DATE_SHORTCUTS).optional() });

const quoteFilterRuleSchema = z.union([textFilterSchema, selectFilterSchema, numberFilterSchema, dateFilterSchema]);
export const quoteFilterGroupSchema = z.object({ logic: z.enum(['AND', 'OR']).default('AND'), rules: z.array(quoteFilterRuleSchema).default([]) });
export type QuoteFilterGroup = z.infer<typeof quoteFilterGroupSchema>;
const quoteSortRuleSchema = z.object({ field: z.string().refine((f) => QUOTE_SORTABLE_FIELDS.has(f)), direction: z.enum(['asc', 'desc']) });
const quoteSortSchema = z.array(quoteSortRuleSchema).default([]);
export type QuoteSort = z.infer<typeof quoteSortSchema>;

/**
 * Quick lifecycle segment, in addition to the free-form filter group.
 * - open: draft + sent (still negotiable)
 * - expiring: open and expires within 7 days
 * - expired: past expiry date and not accepted/invoiced/declined
 * - mine: created or last edited in UNIK by the current user
 */
export const QUOTE_SEGMENTS = ['all', 'open', 'expiring', 'expired', 'accepted', 'declined', 'invoiced', 'mine'] as const;
export type QuoteSegment = (typeof QUOTE_SEGMENTS)[number];
export const QUOTE_SEGMENT_LABELS: Record<QuoteSegment, string> = {
  all: 'Todas', open: 'Abiertas', expiring: 'Por vencer', expired: 'Vencidas',
  accepted: 'Aceptadas', declined: 'Rechazadas', invoiced: 'Facturadas', mine: 'Creadas en UNIK',
};

export const quoteQueryStateSchema = z.object({
  search: z.string().optional(),
  segment: z.enum(QUOTE_SEGMENTS).default('all'),
  filters: quoteFilterGroupSchema.default({ logic: 'AND', rules: [] }),
  sort: quoteSortSchema.default([]),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(50),
});
export type QuoteQueryState = z.output<typeof quoteQueryStateSchema>;

export const tablePreferenceConfigSchema = z.object({
  version: z.literal(1).default(1),
  columnOrder: z.array(z.string()).default([]),
  columnVisibility: z.record(z.boolean()).default({}),
  columnWidths: z.record(z.number()).default({}),
  columnPinning: z.object({ left: z.array(z.string()).default([]), right: z.array(z.string()).default([]) }).default({ left: [], right: [] }),
  density: z.enum(['compact', 'normal', 'comfortable']).default('normal'),
  pageSize: z.number().int().min(1).max(500).default(50),
});
export type TablePreferenceConfig = z.output<typeof tablePreferenceConfigSchema>;
export const tableViewVisibilitySchema = z.enum(['private', 'shared']);
export type TableViewVisibility = z.infer<typeof tableViewVisibilitySchema>;
