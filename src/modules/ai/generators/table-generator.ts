/**
 * Table Generator (inline for chat rendering)
 *
 * Generates a structured table object that the chat UI renders as an HTML table.
 * Not a file — stored as inlineData in AiArtifact.
 */

export interface TableColumn {
  header: string;
  key: string;
  align?: 'left' | 'right' | 'center';
  format?: 'currency' | 'number' | 'percentage' | 'date' | 'text';
}

export interface TableData {
  title: string;
  subtitle?: string;
  columns: TableColumn[];
  rows: Record<string, unknown>[];
  summary?: Array<{ label: string; value: string }>;
  brandColor?: string;
}

export function generateTableData(options: TableData): TableData {
  // Return as-is; the UI will render it
  return {
    title: options.title,
    subtitle: options.subtitle,
    columns: options.columns,
    rows: options.rows,
    summary: options.summary,
    brandColor: options.brandColor ?? '#2563eb',
  };
}
