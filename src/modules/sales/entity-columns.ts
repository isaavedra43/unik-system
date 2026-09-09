/**
 * Generic column registry interface for entity workspaces.
 *
 * Each module (Contacts, Products, Packages, Invoices) defines its own
 * column registry using this shared interface. The UI reads the registry
 * to build column definitions, the filter builder, the column manager,
 * and exports. Never define columns ad-hoc in components.
 */

export type EntityColumnType = 'text' | 'date' | 'number' | 'currency' | 'status' | 'boolean';

export type EntityColumnAlign = 'left' | 'right' | 'center';

export interface EntityColumnDefinition {
  id: string;
  label: string;
  /** Prisma field key used for sorting and filtering. */
  field: string;
  type: EntityColumnType;
  sortable: boolean;
  filterable: boolean;
  defaultVisible: boolean;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  align: EntityColumnAlign;
  /** Lower = higher priority. Used for default ordering and mobile compact. */
  priority: number;
  /** Optional formatter key for client-side rendering. */
  formatter?: 'date' | 'currency' | 'statusDot' | 'boolean';
  /** Optional status category for label/tone mapping. */
  statusCategory?: string;
}

/**
 * Extracts the list of sortable field keys from a column registry.
 */
export function getSortableFields(columns: EntityColumnDefinition[]): string[] {
  return columns.filter((c) => c.sortable).map((c) => c.field);
}

/**
 * Extracts the list of filterable field keys from a column registry.
 */
export function getFilterableFields(columns: EntityColumnDefinition[]): string[] {
  return columns.filter((c) => c.filterable).map((c) => c.field);
}

/**
 * Returns the default visible columns sorted by priority.
 */
export function getDefaultVisibleColumns(columns: EntityColumnDefinition[]): EntityColumnDefinition[] {
  return columns
    .filter((c) => c.defaultVisible)
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Returns the columns to show in mobile compact view (priority <= threshold).
 */
export function getMobileColumns(
  columns: EntityColumnDefinition[],
  maxPriority = 3
): EntityColumnDefinition[] {
  return columns
    .filter((c) => c.defaultVisible && c.priority <= maxPriority)
    .sort((a, b) => a.priority - b.priority);
}
