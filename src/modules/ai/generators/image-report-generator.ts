/**
 * Report Image Generator
 *
 * Renders a data report (title + KPI summary + table) as a single flat SVG image —
 * NOT a bar/line/pie chart (see chart-generator.ts for those). This is for "dame una
 * imagen del reporte": a shareable, self-contained visual snapshot of tabular data,
 * styled like the PDF report but as one image instead of a paginated document.
 *
 * No canvas/headless-browser dependency: column widths are estimated from character
 * counts (see `estimateTextWidth`), which is why row count is capped by default —
 * this is meant for a compact, glanceable summary, not the full detail (use
 * generatePdfReport/generateExcelReport for that).
 */

import { colorForStatusLabel, sanitizeSvgColor } from './status-tone';

export interface ReportImageColumn {
  header: string;
  key: string;
  align?: 'left' | 'right' | 'center';
  format?: (value: unknown) => string;
}

export interface ReportImageOptions {
  title: string;
  subtitle?: string;
  logoText?: string;
  brandColor?: string;
  accentColor?: string;
  columns: ReportImageColumn[];
  rows: Record<string, unknown>[];
  summaryCards?: Array<{ label: string; value: string; color?: string }>;
  /** Rows beyond this are omitted with a "+N more" footer note. Default 20 — this is a
   * compact snapshot image, not the full export. */
  maxRows?: number;
  fontSize?: number;
}

export interface ReportImageResult {
  svg: string;
  width: number;
  height: number;
  rowsShown: number;
  rowsOmitted: number;
}

const DEFAULT_BRAND = '#2563eb';
const DEFAULT_ACCENT = '#64748b';
const DEFAULT_FONT_SIZE = 11;
const MARGIN = 24;
const CELL_PAD_X = 10;
const HEADER_ROW_HEIGHT = 32;
const MIN_COL_WIDTH = 56;
const MAX_COL_WIDTH = 260;
const KPI_CARD_HEIGHT = 52;
const KPI_CARD_GAP = 10;
const FOOTER_HEIGHT = 26;

/**
 * Rough proportional-font width estimate (no canvas/font-metrics available server-side).
 * Good enough for sizing/truncating a compact snapshot image — not pixel-perfect.
 */
function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  let units = 0;
  for (const ch of text) {
    if (" .,;:'|!ijl".includes(ch)) units += 0.3;
    else if ('mwMW@%'.includes(ch)) units += 0.82;
    else if (ch >= 'A' && ch <= 'Z') units += 0.68;
    else units += 0.54;
  }
  return units * fontSize * (bold ? 1.08 : 1);
}

function truncateToWidth(text: string, maxWidth: number, fontSize: number, bold = false): string {
  if (estimateTextWidth(text, fontSize, bold) <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && estimateTextWidth(`${s}…`, fontSize, bold) > maxWidth) {
    s = s.slice(0, -1);
  }
  return `${s}…`;
}

const XML_ESCAPES: Record<string, string> = {
  '&': String.fromCharCode(38, 97, 109, 112, 59), // &amp;
  '<': String.fromCharCode(38, 108, 116, 59), // &lt;
  '>': String.fromCharCode(38, 103, 116, 59), // &gt;
  '"': String.fromCharCode(38, 113, 117, 111, 116, 59), // &quot;
};

function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => XML_ESCAPES[ch]);
}

function cellText(col: ReportImageColumn, row: Record<string, unknown>): string {
  const raw = row[col.key];
  if (col.format) return col.format(raw);
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'object') {
    if (Array.isArray(raw)) return raw.map((v) => String(v)).join(', ');
    return Object.values(raw as Record<string, unknown>).map((v) => String(v ?? '')).join(' ');
  }
  return String(raw);
}

export function generateReportImageSvg(options: ReportImageOptions): ReportImageResult {
  // Colors are AI tool-call arguments (model-controlled) interpolated directly into SVG fill
  // attributes below; sanitize here so the rest of this function is safe by construction.
  const brand = sanitizeSvgColor(options.brandColor, DEFAULT_BRAND);
  const accent = sanitizeSvgColor(options.accentColor, DEFAULT_ACCENT);
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  const maxRows = options.maxRows ?? 20;
  const cols = options.columns;
  const allRows = options.rows;
  const rows = allRows.slice(0, maxRows);
  const rowsOmitted = Math.max(0, allRows.length - rows.length);

  // Pre-compute every cell's text once (also used for width estimation).
  const cellsByRow = rows.map((row) => cols.map((col) => cellText(col, row)));

  const colWidths = cols.map((col, i) => {
    const headerW = estimateTextWidth(col.header, fontSize, true) + CELL_PAD_X * 2;
    const valuesW = cellsByRow.length > 0 ? Math.max(...cellsByRow.map((r) => estimateTextWidth(r[i], fontSize))) + CELL_PAD_X * 2 : 0;
    return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, headerW, valuesW));
  });

  const tableWidth = colWidths.reduce((s, w) => s + w, 0);
  const contentWidth = Math.max(tableWidth, 360);
  const width = contentWidth + MARGIN * 2;

  const rowHeight = fontSize + 14;
  const kpiCount = options.summaryCards?.length ?? 0;
  const kpiAreaHeight = kpiCount > 0 ? KPI_CARD_HEIGHT + 16 : 0;
  const headerAreaHeight = 34 + (options.subtitle ? 16 : 0) + 12;
  const tableHeight = HEADER_ROW_HEIGHT + rows.length * rowHeight;
  const height =
    MARGIN + headerAreaHeight + kpiAreaHeight + tableHeight + FOOTER_HEIGHT + (rowsOmitted > 0 ? 18 : 0) + MARGIN;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`;
  svg += `<rect width="${width}" height="${height}" fill="#ffffff" rx="10"/>`;

  // ===== Header =====
  let y = MARGIN + 20;
  if (options.logoText) {
    svg += `<text x="${MARGIN}" y="${y}" font-size="16" font-weight="bold" fill="${brand}">${escapeXml(options.logoText)}</text>`;
  }
  svg += `<text x="${width - MARGIN}" y="${y}" text-anchor="end" font-size="18" font-weight="bold" fill="#1e293b">${escapeXml(options.title)}</text>`;
  y += 6;
  if (options.subtitle) {
    y += 16;
    svg += `<text x="${width - MARGIN}" y="${y}" text-anchor="end" font-size="10" fill="${accent}">${escapeXml(options.subtitle)}</text>`;
  }
  y += 10;
  svg += `<rect x="${MARGIN}" y="${y}" width="${contentWidth}" height="2.5" fill="${brand}" rx="1"/>`;
  y += 16;

  // ===== KPI cards =====
  if (kpiCount > 0) {
    const cards = options.summaryCards!;
    const cardWidth = (contentWidth - (cards.length - 1) * KPI_CARD_GAP) / cards.length;
    cards.forEach((card, i) => {
      const x = MARGIN + i * (cardWidth + KPI_CARD_GAP);
      const color = sanitizeSvgColor(card.color, brand);
      svg += `<rect x="${x}" y="${y}" width="${cardWidth}" height="${KPI_CARD_HEIGHT}" fill="#f8fafc" rx="6"/>`;
      svg += `<rect x="${x}" y="${y}" width="${cardWidth}" height="3" fill="${color}" rx="1.5"/>`;
      const label = truncateToWidth(card.label.toUpperCase(), cardWidth - 16, 8);
      svg += `<text x="${x + 10}" y="${y + 18}" font-size="8" fill="${accent}">${escapeXml(label)}</text>`;
      const value = truncateToWidth(card.value, cardWidth - 16, 15, true);
      svg += `<text x="${x + 10}" y="${y + 38}" font-size="15" font-weight="bold" fill="#1e293b">${escapeXml(value)}</text>`;
    });
    y += KPI_CARD_HEIGHT + 16;
  }

  // ===== Table =====
  const tableTop = y;
  svg += `<rect x="${MARGIN}" y="${tableTop}" width="${contentWidth}" height="${HEADER_ROW_HEIGHT}" fill="${brand}" rx="4"/>`;
  {
    let x = MARGIN;
    cols.forEach((col, i) => {
      const align = col.align ?? 'left';
      const tx = align === 'right' ? x + colWidths[i] - CELL_PAD_X : align === 'center' ? x + colWidths[i] / 2 : x + CELL_PAD_X;
      const anchor = align === 'right' ? 'end' : align === 'center' ? 'middle' : 'start';
      const label = truncateToWidth(col.header, colWidths[i] - CELL_PAD_X * 2, 9, true);
      svg += `<text x="${tx}" y="${tableTop + HEADER_ROW_HEIGHT / 2 + 3}" text-anchor="${anchor}" font-size="9" font-weight="bold" fill="#ffffff">${escapeXml(label)}</text>`;
      x += colWidths[i];
    });
  }

  let rowY = tableTop + HEADER_ROW_HEIGHT;
  cellsByRow.forEach((cells, rowIdx) => {
    if (rowIdx % 2 === 1) {
      svg += `<rect x="${MARGIN}" y="${rowY}" width="${contentWidth}" height="${rowHeight}" fill="#f1f5f9"/>`;
    }
    let x = MARGIN;
    cols.forEach((col, i) => {
      const align = col.align ?? 'left';
      const innerWidth = colWidths[i] - CELL_PAD_X * 2;
      const value = truncateToWidth(cells[i], innerWidth, fontSize);
      const statusColor = align !== 'right' ? colorForStatusLabel(cells[i]) : null;
      const tx = align === 'right' ? x + colWidths[i] - CELL_PAD_X : align === 'center' ? x + colWidths[i] / 2 : x + CELL_PAD_X;
      const anchor = align === 'right' ? 'end' : align === 'center' ? 'middle' : 'start';
      svg +=
        `<text x="${tx}" y="${rowY + rowHeight / 2 + fontSize * 0.32}" text-anchor="${anchor}" font-size="${fontSize}" ` +
        `${statusColor ? 'font-weight="bold" ' : ''}fill="${statusColor ?? '#334155'}">${escapeXml(value)}</text>`;
      x += colWidths[i];
    });
    rowY += rowHeight;
  });

  // Table outline
  svg += `<rect x="${MARGIN}" y="${tableTop}" width="${contentWidth}" height="${HEADER_ROW_HEIGHT + rows.length * rowHeight}" fill="none" stroke="#e2e8f0" stroke-width="1" rx="4"/>`;

  let footerY = rowY + 6;
  if (rowsOmitted > 0) {
    svg += `<text x="${MARGIN}" y="${footerY + 10}" font-size="9" fill="${accent}" font-style="italic">+${rowsOmitted} más — pide el PDF o Excel para ver todas las filas.</text>`;
    footerY += 18;
  }

  svg += `<text x="${width / 2}" y="${footerY + 10}" text-anchor="middle" font-size="7.5" fill="${accent}">Generado por UNIK Asistente IA · ${new Date().toLocaleString('es-MX')}</text>`;

  svg += `</svg>`;

  return { svg, width, height, rowsShown: rows.length, rowsOmitted };
}
