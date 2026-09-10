/**
 * Shared types and constants for the EntityWorkspace component.
 * These are used by all module workspaces that share the same table/filter/export pattern.
 */

// ---------------------------------------------------------------------------
// Column definition
// ---------------------------------------------------------------------------

export interface EntityColumnDefinition {
  id: string;
  label: string;
  field: string;
  type: 'text' | 'date' | 'number' | 'currency' | 'status' | 'boolean';
  sortable: boolean;
  filterable: boolean;
  defaultVisible: boolean;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  align: 'left' | 'right' | 'center';
  priority: number;
  formatter?: 'date' | 'currency' | 'statusDot' | 'boolean';
  statusCategory?: string;
}

// ---------------------------------------------------------------------------
// Table preference
// ---------------------------------------------------------------------------

export interface TablePreferenceConfig {
  version: 1;
  columnOrder: string[];
  columnVisibility: Record<string, boolean>;
  columnWidths: Record<string, number>;
  columnPinning: { left: string[]; right: string[] };
  density: 'compact' | 'normal' | 'comfortable';
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Filter operators
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Date shortcuts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Filter rule / group
// ---------------------------------------------------------------------------

export interface EntityFilterRule {
  field: string;
  operator: string;
  value?: string | number | boolean | Date | null | string[];
  valueTo?: string | number | Date | null;
  shortcut?: string;
}

export interface EntityFilterGroup {
  logic: 'AND' | 'OR';
  rules: EntityFilterRule[];
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

export interface EntitySort {
  field: string;
  direction: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface EntityPagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

// ---------------------------------------------------------------------------
// List result (generic)
// ---------------------------------------------------------------------------

export interface EntityListResult<TRow> {
  data: TRow[];
  pagination: EntityPagination;
}

// ---------------------------------------------------------------------------
// Query state (generic)
// ---------------------------------------------------------------------------

export interface EntityQueryState {
  search?: string;
  filters: EntityFilterGroup;
  sort: EntitySort[];
  page: number;
  page_size: number;
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

export interface SyncRunInfo {
  run_id: string;
  mode: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  pages_scanned?: number;
  records_seen?: number;
  records_pending?: number;
  details_fetched?: number;
  details_failed?: number;
  error_code?: string | null;
}

export interface SyncStatus {
  active_run: SyncRunInfo | null;
  latest_run: SyncRunInfo | null;
}

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

export interface StatusConfig {
  label: string;
  tone: string;
}

export interface StatusOption {
  value: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Action signatures
// ---------------------------------------------------------------------------

export type SavePreferenceAction = (
  config: TablePreferenceConfig
) => Promise<{ error: string | null; success: boolean }>;

export type ResetPreferenceAction = () => Promise<{ error: string | null; success: boolean }>;

export type CreateViewAction = (
  prevState: { error: string | null; success: boolean; viewId: string | null },
  formData: FormData
) => Promise<{ error: string | null; success: boolean; viewId: string | null }>;

export type WatchAction = (
  prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;

export type BulkWatchAction = (
  prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;

export type ExportAction = (
  prevState: {
    error: string | null;
    success: boolean;
    content: string | null;
    filename: string | null;
    format: string | null;
  },
  formData: FormData
) => Promise<{
  error: string | null;
  success: boolean;
  content: string | null;
  filename: string | null;
  format: string | null;
}>;

// ---------------------------------------------------------------------------
// Saved view
// ---------------------------------------------------------------------------

export interface TableViewRow {
  id: string;
  name: string;
  visibility: 'private' | 'shared';
  isDefault: boolean;
  config: unknown;
}
