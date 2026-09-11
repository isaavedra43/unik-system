import ExcelJS from 'exceljs';
import fs from 'fs';
import { hexToArgb, toneForStatusLabel, TONE_HEX } from './status-tone';

/**
 * Professional Excel/XLSX Report Generator
 *
 * Generates branded Excel reports with:
 * - Styled header row with brand colors
 * - Alternating row colors
 * - Auto-fit column widths
 * - Summary/KPI sheet
 * - Data types (numbers, currency, dates)
 * - Freeze header row
 * - Auto-filter
 */

export interface ExcelColumn {
  header: string;
  key: string;
  width?: number;
  type?: 'text' | 'number' | 'currency' | 'date' | 'percentage';
  format?: string;
}

interface ExcelReportOptions {
  title: string;
  subtitle?: string;
  author?: string;
  brandColor?: string; // hex like 'FF2563EB' (ARGB for ExcelJS)
  columns: ExcelColumn[];
  rows: Record<string, unknown>[];
  summaryCards?: Array<{ label: string; value: string }>;
  sheetName?: string;
}

const DEFAULT_BRAND = 'FF2563EB';
const HEADER_FILL: Partial<ExcelJS.Fill> = { type: 'pattern', pattern: 'solid' };
const ALT_FILL: Partial<ExcelJS.Fill> = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

/** `options.brandColor` is caller-supplied (ultimately AI tool-call args) — validate it's a
 * real 8-digit ARGB hex before it reaches ExcelJS, rather than trusting it as-is. */
function sanitizeArgb(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  return /^[0-9A-Fa-f]{8}$/.test(value) ? value.toUpperCase() : fallback;
}

export async function generateExcelReport(
  outputPath: string,
  options: ExcelReportOptions
): Promise<{ sizeBytes: number }> {
  const brand = sanitizeArgb(options.brandColor, DEFAULT_BRAND);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = options.author ?? 'UNIK Asistente IA';
  workbook.created = new Date();
  workbook.title = options.title;

  // ===== Summary sheet (if KPIs) =====
  if (options.summaryCards && options.summaryCards.length > 0) {
    const summarySheet = workbook.addWorksheet('Resumen', { properties: { tabColor: { argb: brand } } });
    summarySheet.columns = [
      { width: 30 },
      { width: 25 },
    ];
    // Title
    summarySheet.mergeCells('A1:B1');
    const titleCell = summarySheet.getCell('A1');
    titleCell.value = options.title;
    titleCell.font = { size: 16, bold: true, color: { argb: 'FF1E293B' } };
    // Subtitle
    if (options.subtitle) {
      summarySheet.mergeCells('A2:B2');
      const subCell = summarySheet.getCell('A2');
      subCell.value = options.subtitle;
      subCell.font = { size: 11, color: { argb: 'FF64748B' } };
    }
    // Brand line
    summarySheet.getCell('A3').fill = { ...HEADER_FILL, fgColor: { argb: brand } } as ExcelJS.Fill;
    summarySheet.getCell('B3').fill = { ...HEADER_FILL, fgColor: { argb: brand } } as ExcelJS.Fill;
    // KPIs
    let row = 5;
    for (const card of options.summaryCards) {
      summarySheet.getCell(`A${row}`).value = card.label;
      summarySheet.getCell(`A${row}`).font = { bold: true, color: { argb: 'FF64748B' } };
      summarySheet.getCell(`B${row}`).value = card.value;
      summarySheet.getCell(`B${row}`).font = { size: 14, bold: true, color: { argb: 'FF1E293B' } };
      row++;
    }
    // Timestamp
    summarySheet.getCell(`A${row + 1}`).value = 'Generado:';
    summarySheet.getCell(`A${row + 1}`).font = { italic: true, color: { argb: 'FF94A3B8' } };
    summarySheet.getCell(`B${row + 1}`).value = new Date().toLocaleString('es-MX');
    summarySheet.getCell(`B${row + 1}`).font = { italic: true, color: { argb: 'FF94A3B8' } };
  }

  // ===== Data sheet =====
  const sheetName = options.sheetName ?? 'Datos';
  const sheet = workbook.addWorksheet(sheetName, { properties: { tabColor: { argb: brand } } });

  // Configure columns
  sheet.columns = options.columns.map((col) => ({
    header: col.header,
    key: col.key,
    width: col.width ?? Math.max(col.header.length + 4, 15),
  }));

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.fill = { ...HEADER_FILL, fgColor: { argb: brand } } as ExcelJS.Fill;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = {
      bottom: { style: 'medium', color: { argb: brand } },
    };
  });

  // Add data rows
  options.rows.forEach((row, idx) => {
    const excelRow = sheet.addRow(row);
    if (idx % 2 === 1) {
      excelRow.eachCell((cell) => {
        cell.fill = { ...ALT_FILL } as ExcelJS.Fill;
      });
    }
    // Apply column types
    options.columns.forEach((col, colIdx) => {
      const cell = excelRow.getCell(colIdx + 1);
      if (col.type === 'currency') {
        cell.numFmt = '"$"#,##0.00';
        cell.alignment = { horizontal: 'right' };
      } else if (col.type === 'number') {
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      } else if (col.type === 'date') {
        cell.numFmt = 'DD/MM/YYYY';
      } else if (col.type === 'percentage') {
        cell.numFmt = '0.0%';
        cell.alignment = { horizontal: 'right' };
      } else if (col.type === 'text' || !col.type) {
        // Color known status labels (Cerrado, Pendiente, Enviado...) the same way the PDF and
        // report image do, so a status reads the same color across every report format.
        const tone = typeof cell.value === 'string' ? toneForStatusLabel(cell.value) : null;
        if (tone) {
          cell.font = { bold: true, color: { argb: hexToArgb(TONE_HEX[tone]) } };
        }
      }
    });
  });

  // Auto-filter and freeze
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: options.columns.length },
  };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Write file
  await workbook.xlsx.writeFile(outputPath);
  const stats = fs.statSync(outputPath);
  return { sizeBytes: stats.size };
}
