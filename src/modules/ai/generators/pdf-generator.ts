import PDFDocument from 'pdfkit';
import fs from 'fs';
import { colorForStatusLabel, sanitizeSvgColor } from './status-tone';

/**
 * Professional PDF Report Generator
 *
 * Layout system:
 * - A4 landscape by default (8 columns need width)
 * - Header: logo + title + accent line + summary cards
 * - Table: dynamic row height based on measured text, no overlap
 * - Column widths are ALWAYS normalized to the page's content width, so a
 *   table never overflows the page regardless of how many columns are given.
 * - Long free-text fields (address, notes, product list) are rendered as
 *   full-width "detail lines" below the row instead of a cramped column.
 * - Pagination: repeats header on each page, never splits a row. Row height
 *   accounts for explicit "\n" line breaks so PDFKit never triggers its own
 *   mid-row automatic page break.
 * - Footer: page number + timestamp
 */

export interface PdfTableColumn {
  header: string;
  key: string;
  width?: number; // relative weight (points), normalized to fit the page — never absolute
  align?: 'left' | 'right' | 'center';
  format?: (value: unknown) => string;
  /** Render as a full-width wrapped line below the row instead of a table column (for long text). */
  detail?: boolean;
  /** Never wrap this column's values: it is guaranteed at least the width of its widest value
   * (order numbers, dates, amounts) — otherwise "$5,166.72" turns into "$5,166.7 / 2". */
  nowrap?: boolean;
}

export interface PdfSection {
  title?: string;
  columns: PdfTableColumn[];
  rows: Record<string, unknown>[];
}

interface PdfReportOptions {
  title: string;
  subtitle?: string;
  author?: string;
  brandColor?: string; // hex like '#2563eb'
  accentColor?: string; // secondary accent
  logoText?: string; // text-based logo
  columns: PdfTableColumn[];
  rows: Record<string, unknown>[];
  sections?: PdfSection[]; // multiple tables in one PDF
  summaryCards?: Array<{ label: string; value: string; color?: string }>;
  metadata?: Record<string, string>;
  fontSize?: number;
  orientation?: 'portrait' | 'landscape';
}

const DEFAULT_BRAND = '#2563eb';
const DEFAULT_ACCENT = '#64748b';

/** @deprecated use `colorForStatusLabel` from `./status-tone` — kept for existing test imports. */
export const toneForStatusLabel = colorForStatusLabel;
const PAGE_MARGIN = 40;
const FOOTER_HEIGHT = 30;
const CELL_PAD_X = 6;
const CELL_PAD_Y = 4;
const HEADER_HEIGHT = 22;
const MIN_ROW_HEIGHT = 20;
const MIN_COLUMN_WIDTH = 42;
const MAX_CONTENT_FONT_SIZE = 8;
const MIN_CONTENT_FONT_SIZE = 6;
const HEADER_FONT_SIZE = 8;
const DETAIL_FONT_SIZE = 7.5;
const DETAIL_LABEL_WIDTH = 90;

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - PAGE_MARGIN * 2;
}

function pageBottom(doc: PDFKit.PDFDocument): number {
  return doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT;
}

/**
 * Measures how many lines a text will occupy within a given column width at
 * a given font size — mirrors pdfkit's own wrapping so the row height we
 * compute always matches what pdfkit actually renders. Honors explicit "\n"
 * as a forced break (pdfkit does too); a naive word-split would swallow it
 * and under-count lines, which is what caused rows to overflow their
 * computed height and trigger pdfkit's own emergency page breaks mid-row.
 */
function measureLines(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
  fontSize: number
): number {
  if (!text) return 1;
  doc.fontSize(fontSize).font('Helvetica');
  const paragraphs = text.split('\n');
  let total = 0;
  for (const para of paragraphs) {
    if (para.length === 0) {
      total += 1;
      continue;
    }
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      total += 1;
      continue;
    }
    let lines = 1;
    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (doc.widthOfString(testLine) <= maxWidth) {
        currentLine = testLine;
        continue;
      }
      if (!currentLine) {
        // Word itself wider than column: hard-break it character by character.
        let chunk = '';
        for (const ch of word) {
          if (doc.widthOfString(chunk + ch) <= maxWidth) {
            chunk += ch;
          } else {
            if (chunk) lines++;
            chunk = ch;
          }
        }
        currentLine = chunk;
      } else {
        lines++;
        currentLine = word;
      }
    }
    total += lines;
  }
  return Math.max(1, total);
}

interface ResolvedColumns {
  tableColumns: PdfTableColumn[];
  detailColumns: PdfTableColumn[];
  widths: number[];
  innerWidths: number[];
  fontSize: number;
}

/**
 * Splits columns into table columns (rendered side by side) and detail
 * columns (rendered as full-width wrapped lines below the row), then
 * normalizes table column widths to exactly fill the page's content width —
 * regardless of how many columns or what widths the caller requested. This
 * is what prevents a wide table from ever running off the right edge of the
 * page. If there are still too many columns to stay readable, the content
 * font size is shrunk (down to a floor) before anything is allowed to
 * overflow.
 */
function resolveColumns(
  doc: PDFKit.PDFDocument,
  cols: PdfTableColumn[],
  requestedFontSize: number,
  totalWidth: number,
  rows: Record<string, unknown>[] = []
): ResolvedColumns {
  const tableColumns = cols.filter((c) => !c.detail);
  const detailColumns = cols.filter((c) => c.detail);
  const n = Math.max(1, tableColumns.length);

  let fontSize = requestedFontSize;
  // Too many columns for the requested font size: shrink it so every column
  // can still fit at least MIN_COLUMN_WIDTH.
  while (fontSize > MIN_CONTENT_FONT_SIZE && totalWidth / n < MIN_COLUMN_WIDTH) {
    fontSize -= 0.5;
  }

  const weights = tableColumns.map((c) => (c.width && c.width > 0 ? c.width : totalWidth / n));
  const weightSum = weights.reduce((s, w) => s + w, 0) || 1;
  // Normalize proportionally to the actual page width, then enforce a floor
  // per column and re-distribute any leftover from columns that were
  // already above the floor — this keeps relative proportions (a customer
  // name column stays wider than a status column) while guaranteeing the
  // total always equals totalWidth exactly.
  let widths = weights.map((w) => (w / weightSum) * totalWidth);
  // Per-column floor: the generic minimum, or — for nowrap columns — the width of the widest
  // value they actually have to show (measured with the real font), so they never break mid-word.
  doc.fontSize(fontSize).font('Helvetica');
  const floors = tableColumns.map((c) => {
    const generic = Math.min(MIN_COLUMN_WIDTH, totalWidth / n);
    if (!c.nowrap) return generic;
    const widest = rows.reduce((m, r) => Math.max(m, doc.widthOfString(cellText(c, r))), 0);
    // Never let a single column claim more than 30% of the page even in nowrap mode.
    return Math.max(generic, Math.min(widest + CELL_PAD_X * 2 + 2, totalWidth * 0.3));
  });
  let deficit = 0;
  widths = widths.map((w, i) => {
    if (w < floors[i]) {
      deficit += floors[i] - w;
      return floors[i];
    }
    return w;
  });
  if (deficit > 0) {
    const aboveFloorIdx = widths.map((w, i) => (w > floors[i] ? i : -1)).filter((i) => i >= 0);
    const aboveFloorTotal = aboveFloorIdx.reduce((s, i) => s + (widths[i] - floors[i]), 0) || 1;
    for (const i of aboveFloorIdx) {
      const share = ((widths[i] - floors[i]) / aboveFloorTotal) * deficit;
      widths[i] = Math.max(floors[i], widths[i] - share);
    }
  }
  // Final correction so widths sum EXACTLY to totalWidth (rounding safety).
  const sumNow = widths.reduce((s, w) => s + w, 0);
  if (widths.length > 0 && sumNow > 0) {
    widths[widths.length - 1] += totalWidth - sumNow;
  }

  return {
    tableColumns,
    detailColumns,
    widths,
    innerWidths: widths.map((w) => Math.max(4, w - CELL_PAD_X * 2)),
    fontSize,
  };
}

function cellText(col: PdfTableColumn, row: Record<string, unknown>): string {
  const rawValue = row[col.key];
  if (col.format) return col.format(rawValue);
  if (rawValue === null || rawValue === undefined) return '';
  if (typeof rawValue === 'object') {
    if (Array.isArray(rawValue)) {
      return rawValue
        .map((v) =>
          typeof v === 'object' && v !== null
            ? Object.entries(v as Record<string, unknown>)
                .map(([k, v2]) => `${k}: ${String(v2 ?? '')}`)
                .join(', ')
            : String(v)
        )
        .join('\n');
    }
    return Object.entries(rawValue as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v ?? '')}`)
      .join(', ');
  }
  return String(rawValue);
}

export function generatePdfReport(
  outputPath: string,
  options: PdfReportOptions
): Promise<{ sizeBytes: number; pageCount: number }> {
  return new Promise((resolve, reject) => {
    // brandColor/accentColor/summaryCards[].color are AI tool-call arguments (model-controlled);
    // pdfkit isn't an HTML-injection context, but a garbage color string can throw at render
    // time — validate to a strict hex color (or fall back) for robustness, same rule as the
    // SVG-based generators (see sanitizeSvgColor).
    const brand = sanitizeSvgColor(options.brandColor, DEFAULT_BRAND);
    const accent = sanitizeSvgColor(options.accentColor, DEFAULT_ACCENT);
    const requestedFontSize = options.fontSize ?? MAX_CONTENT_FONT_SIZE;
    const orientation = options.orientation ?? 'landscape';

    const doc = new PDFDocument({
      size: 'A4',
      layout: orientation,
      // Keep pages in memory until the end so the footer can say "Página X de N" on EVERY page.
      // (The previous `doc.on('pageAdded', drawFooter)` was registered after the table was
      // drawn, so pages 2+ had no footer and pageCount was always reported as 1.)
      bufferPages: true,
      margins: {
        top: PAGE_MARGIN,
        bottom: PAGE_MARGIN,
        left: PAGE_MARGIN,
        right: PAGE_MARGIN,
      },
      info: {
        Title: options.title,
        Author: options.author ?? 'UNIK Asistente IA',
        Subject: options.subtitle ?? '',
        Creator: 'UNIK',
      },
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const generatedAt = new Date().toLocaleString('es-MX');
    const drawFooter = (pageNumber: number, totalPages: number) => {
      doc.fontSize(7)
        .fillColor(accent)
        .font('Helvetica')
        .text(
          `Generado por UNIK Asistente IA · ${generatedAt} · Página ${pageNumber} de ${totalPages}`,
          PAGE_MARGIN,
          doc.page.height - 25,
          { width: contentWidth(doc), align: 'center', lineBreak: false }
        );
    };

    // ===== HEADER =====
    const headerY = PAGE_MARGIN;
    if (options.logoText) {
      doc.fontSize(18)
        .fillColor(brand)
        .font('Helvetica-Bold')
        .text(options.logoText, PAGE_MARGIN, headerY);
    }
    doc.fontSize(20)
      .fillColor('#1e293b')
      .font('Helvetica-Bold')
      .text(options.title, PAGE_MARGIN, headerY, {
        width: contentWidth(doc),
        align: 'right',
      });

    let cursorY = headerY + 26;

    if (options.subtitle) {
      doc.fontSize(10)
        .fillColor(accent)
        .font('Helvetica')
        .text(options.subtitle, PAGE_MARGIN, cursorY, {
          width: contentWidth(doc),
          align: 'right',
        });
      cursorY += 16;
    }

    // Brand accent line
    doc.moveTo(PAGE_MARGIN, cursorY)
      .lineTo(doc.page.width - PAGE_MARGIN, cursorY)
      .lineWidth(2.5)
      .strokeColor(brand)
      .stroke();
    cursorY += 8;

    // ===== SUMMARY CARDS (KPIs) =====
    if (options.summaryCards && options.summaryCards.length > 0) {
      const cardGap = 8;
      const cardWidth =
        (contentWidth(doc) - (options.summaryCards.length - 1) * cardGap) /
        options.summaryCards.length;
      const cardHeight = 44;
      options.summaryCards.forEach((card, i) => {
        const x = PAGE_MARGIN + i * (cardWidth + cardGap);
        const cardColor = sanitizeSvgColor(card.color, brand);
        doc.roundedRect(x, cursorY, cardWidth, cardHeight, 6)
          .fillColor('#f8fafc')
          .fill();
        doc.roundedRect(x, cursorY, cardWidth, 3, 2)
          .fillColor(cardColor)
          .fill();
        doc.fontSize(7)
          .fillColor(accent)
          .font('Helvetica')
          .text(card.label.toUpperCase(), x + 8, cursorY + 8, {
            width: cardWidth - 16,
          });
        doc.fontSize(14)
          .fillColor('#1e293b')
          .font('Helvetica-Bold')
          .text(card.value, x + 8, cursorY + 20, {
            width: cardWidth - 16,
          });
      });
      cursorY += cardHeight + 12;
    }

    // ===== TABLE(S) =====
    // Build sections: if options.sections is provided, use those; otherwise use the single table
    const sections: PdfSection[] = options.sections && options.sections.length > 0
      ? options.sections
      : [{ columns: options.columns, rows: options.rows }];

    for (let secIdx = 0; secIdx < sections.length; secIdx++) {
      const section = sections[secIdx];

      // Section title (if provided and not the first section, or if it's a multi-section PDF)
      if (section.title && (sections.length > 1 || secIdx > 0)) {
        // Page break if not enough space for title + header + at least one row
        if (cursorY + 40 > pageBottom(doc)) {
          doc.addPage();
          cursorY = PAGE_MARGIN;
        }
        cursorY += 8;
        doc.fontSize(11)
          .fillColor('#1e293b')
          .font('Helvetica-Bold')
          .text(section.title, PAGE_MARGIN, cursorY, {
            width: contentWidth(doc),
          });
        cursorY += 20;
      }

      if (section.rows.length === 0) {
        cursorY += 12;
        doc.fontSize(8)
          .fillColor(accent)
          .font('Helvetica-Oblique')
          .text('(Sin datos)', PAGE_MARGIN, cursorY, { width: contentWidth(doc) });
        cursorY += 16;
        continue;
      }

      const cw = contentWidth(doc);
      const { tableColumns, detailColumns, widths: colWidths, innerWidths, fontSize } =
        resolveColumns(doc, section.columns, requestedFontSize, cw, section.rows);

      const drawTableHeader = (y: number): number => {
        doc.rect(PAGE_MARGIN, y, cw, HEADER_HEIGHT)
          .fillColor(brand)
          .fill();
        let x = PAGE_MARGIN;
        for (let i = 0; i < tableColumns.length; i++) {
          const col = tableColumns[i];
          const align = col.align ?? 'left';
          doc.fontSize(HEADER_FONT_SIZE)
            .fillColor('#ffffff')
            .font('Helvetica-Bold')
            .text(col.header, x + CELL_PAD_X, y + 6, {
              width: innerWidths[i],
              align: align === 'right' ? 'right' : align === 'center' ? 'center' : 'left',
            });
          x += colWidths[i];
        }
        return y + HEADER_HEIGHT;
      };

      let tableY = cursorY;
      const bottomLimit = pageBottom(doc);

      if (tableY + HEADER_HEIGHT > bottomLimit) {
        doc.addPage();
        tableY = PAGE_MARGIN;
      }

      tableY = drawTableHeader(tableY);

      for (let rowIdx = 0; rowIdx < section.rows.length; rowIdx++) {
        const row = section.rows[rowIdx];

        const cellValues = tableColumns.map((col) => cellText(col, row));
        const cellLines = cellValues.map((value, i) => measureLines(doc, value, innerWidths[i], fontSize));
        const maxLines = Math.max(...cellLines, 1);
        const tableRowHeight = Math.max(MIN_ROW_HEIGHT, maxLines * (fontSize + 2) + CELL_PAD_Y * 2);

        // Detail lines (address, notes, product list...) render full-width below the row.
        const detailWidth = cw - CELL_PAD_X - DETAIL_LABEL_WIDTH;
        const detailEntries = detailColumns
          .map((col) => ({ col, value: cellText(col, row) }))
          .filter((d) => d.value.trim().length > 0);
        const detailLineCounts = detailEntries.map((d) => measureLines(doc, d.value, detailWidth, DETAIL_FONT_SIZE));
        const detailHeight = detailEntries.reduce(
          (sum, d, i) => sum + Math.max(1, detailLineCounts[i]) * (DETAIL_FONT_SIZE + 2) + 3,
          0
        );

        const rowHeight = tableRowHeight + detailHeight;

        // A single row taller than a full page (e.g. an order with dozens of
        // products) would never fit anywhere — cap it so pagination logic
        // below always terminates instead of looping forever.
        const maxRowHeight = bottomLimit - PAGE_MARGIN - HEADER_HEIGHT;
        const cappedRowHeight = Math.min(rowHeight, Math.max(maxRowHeight, MIN_ROW_HEIGHT));

        if (tableY + cappedRowHeight > bottomLimit && tableY > PAGE_MARGIN + HEADER_HEIGHT) {
          doc.addPage();
          tableY = PAGE_MARGIN;
          tableY = drawTableHeader(tableY);
        }

        const isAlt = rowIdx % 2 === 1;
        if (isAlt) {
          doc.rect(PAGE_MARGIN, tableY, cw, cappedRowHeight)
            .fillColor('#f1f5f9')
            .fill();
        }

        const rowY = tableY;
        let x = PAGE_MARGIN;
        for (let i = 0; i < tableColumns.length; i++) {
          const col = tableColumns[i];
          const align = col.align ?? 'left';
          // Never color amount columns even if a value happened to collide with a status word.
          const statusColor = align !== 'right' ? toneForStatusLabel(cellValues[i]) : null;
          doc.fontSize(fontSize)
            .fillColor(statusColor ?? '#334155')
            .font(statusColor ? 'Helvetica-Bold' : 'Helvetica')
            .text(cellValues[i], x + CELL_PAD_X, rowY + CELL_PAD_Y, {
              width: innerWidths[i],
              height: tableRowHeight - CELL_PAD_Y,
              align: align === 'right' ? 'right' : align === 'center' ? 'center' : 'left',
              ellipsis: true,
            });
          x += colWidths[i];
        }

        if (detailEntries.length > 0) {
          let detailY = rowY + tableRowHeight;
          for (let i = 0; i < detailEntries.length; i++) {
            const { col, value } = detailEntries[i];
            const lineCount = Math.max(1, detailLineCounts[i]);
            const thisHeight = lineCount * (DETAIL_FONT_SIZE + 2) + 3;
            doc.fontSize(DETAIL_FONT_SIZE)
              .fillColor(accent)
              .font('Helvetica-Bold')
              .text(`${col.header}:`, PAGE_MARGIN + CELL_PAD_X, detailY, { width: DETAIL_LABEL_WIDTH });
            doc.fontSize(DETAIL_FONT_SIZE)
              .fillColor('#334155')
              .font('Helvetica')
              .text(value, PAGE_MARGIN + CELL_PAD_X + DETAIL_LABEL_WIDTH, detailY, {
                width: detailWidth,
                height: thisHeight,
                ellipsis: true,
              });
            detailY += thisHeight;
          }
        }

        tableY += cappedRowHeight;
      }

      cursorY = tableY + 8;
    }

    // ===== METADATA FOOTER =====
    if (options.metadata) {
      cursorY += 16;
      doc.fontSize(7)
        .fillColor(accent)
        .font('Helvetica-Oblique');
      for (const [key, value] of Object.entries(options.metadata)) {
        doc.text(`${key}: ${value}`, PAGE_MARGIN, cursorY, {
          width: contentWidth(doc),
        });
        cursorY += 12;
      }
    }

    // Footer on every buffered page, now that the real page count is known.
    const range = doc.bufferedPageRange();
    const pageCount = range.count;
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      drawFooter(i - range.start + 1, pageCount);
    }

    doc.end();

    stream.on('finish', () => {
      const stats = fs.statSync(outputPath);
      resolve({ sizeBytes: stats.size, pageCount });
    });
    stream.on('error', reject);
  });
}
