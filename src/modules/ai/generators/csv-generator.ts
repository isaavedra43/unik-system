import fs from 'fs';

/**
 * CSV Report Generator
 *
 * Generates clean CSV files with proper escaping, BOM for Excel compatibility,
 * and optional metadata header.
 */

interface CsvReportOptions {
  title?: string;
  columns: Array<{ header: string; key: string; format?: (value: unknown) => string }>;
  rows: Record<string, unknown>[];
  includeMetadata?: boolean;
}

function escapeCsvValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function generateCsvReport(
  outputPath: string,
  options: CsvReportOptions
): { sizeBytes: number } {
  const lines: string[] = [];

  // BOM for Excel UTF-8 compatibility
  lines.push('\uFEFF');

  if (options.includeMetadata && options.title) {
    lines.push(`# ${options.title}`);
    lines.push(`# Generado: ${new Date().toLocaleString('es-MX')}`);
    lines.push('#');
  }

  // Header
  lines.push(options.columns.map((c) => escapeCsvValue(c.header)).join(','));

  // Data rows
  for (const row of options.rows) {
    const values = options.columns.map((col) => {
      const raw = row[col.key];
      const formatted = col.format ? col.format(raw) : String(raw ?? '');
      return escapeCsvValue(formatted);
    });
    lines.push(values.join(','));
  }

  const content = lines.join('\n');
  fs.writeFileSync(outputPath, content, 'utf-8');
  const stats = fs.statSync(outputPath);
  return { sizeBytes: stats.size };
}
