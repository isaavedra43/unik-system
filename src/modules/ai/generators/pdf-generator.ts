import PDFDocument from 'pdfkit';
import fs from 'fs';
import {
  colorForStatusLabel,
  sanitizeSvgColor,
  toneForStatusLabel as statusTone,
  TONE_HEX,
  TONE_TINT_HEX,
} from './status-tone';

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
  /** Optional bold "TOTAL" row drawn after the last data row (values pre-computed by the caller). */
  totalsRow?: Record<string, unknown>;
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
const HEADER_HEIGHT = 24;
const MIN_ROW_HEIGHT = 20;
const TEXT_DARK = '#0f172a';
const TEXT_BODY = '#334155';
const ROW_ALT_FILL = '#f8fafc';
const ROW_BORDER = '#e2e8f0';
const TOTALS_FILL = '#e2e8f0';
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

    const generatedAt = new Date().toLocaleString('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Mexico_City',
    });
    const totalRows = (options.sections && options.sections.length > 0 ? options.sections : [{ rows: options.rows }])
      .reduce((s, sec) => s + sec.rows.length, 0);

    const drawFooter = (pageNumber: number, totalPages: number) => {
      // The footer must sit ABOVE pdfkit's bottom margin (page.height - PAGE_MARGIN): writing
      // text below it triggers an automatic page break, which silently appended blank pages
      // (and made the reported pageCount wrong). Content stops at pageBottom(), which reserves
      // FOOTER_HEIGHT for exactly this strip.
      const y = doc.page.height - PAGE_MARGIN - 14;
      const cw = contentWidth(doc);
      doc.moveTo(PAGE_MARGIN, y - 6)
        .lineTo(doc.page.width - PAGE_MARGIN, y - 6)
        .lineWidth(0.5)
        .strokeColor(ROW_BORDER)
        .stroke();
      doc.fontSize(7).font('Helvetica-Bold').fillColor(brand)
        .text(options.logoText ?? 'UNIK', PAGE_MARGIN, y, { width: cw / 3, align: 'left', lineBreak: false });
      doc.fontSize(7).font('Helvetica').fillColor(accent)
        .text(`Generado por UNIK Asistente IA · ${generatedAt}`, PAGE_MARGIN + cw / 3, y, { width: cw / 3, align: 'center', lineBreak: false });
      doc.fontSize(7).font('Helvetica').fillColor(accent)
        .text(`Página ${pageNumber} de ${totalPages}`, PAGE_MARGIN + (cw * 2) / 3, y, { width: cw / 3, align: 'right', lineBreak: false });
    };

    // ===== HEADER =====
    // Left: brand badge + title + subtitle. Right: generation meta. Then a brand rule.
    const headerY = PAGE_MARGIN;
    const cwHeader = contentWidth(doc);
    let titleX = PAGE_MARGIN;
    if (options.logoText) {
      doc.fontSize(13).font('Helvetica-Bold');
      const badgeW = doc.widthOfString(options.logoText) + 18;
      const badgeH = 26;
      doc.roundedRect(PAGE_MARGIN, headerY, badgeW, badgeH, 6).fillColor(brand).fill();
      doc.fillColor('#ffffff').text(options.logoText, PAGE_MARGIN + 9, headerY + 7, { width: badgeW - 18, lineBreak: false });
      titleX = PAGE_MARGIN + badgeW + 12;
    }
    const metaWidth = 170;
    const titleWidth = cwHeader - (titleX - PAGE_MARGIN) - metaWidth - 12;
    doc.fontSize(18)
      .fillColor(TEXT_DARK)
      .font('Helvetica-Bold')
      .text(options.title, titleX, headerY + 2, { width: titleWidth, lineBreak: false, ellipsis: true });

    doc.fontSize(7.5).fillColor(accent).font('Helvetica')
      .text(`${totalRows} ${totalRows === 1 ? 'registro' : 'registros'}`, doc.page.width - PAGE_MARGIN - metaWidth, headerY + 3, { width: metaWidth, align: 'right', lineBreak: false });
    doc.text(generatedAt, doc.page.width - PAGE_MARGIN - metaWidth, headerY + 14, { width: metaWidth, align: 'right', lineBreak: false });

    let cursorY = headerY + 30;

    if (options.subtitle) {
      doc.fontSize(9)
        .fillColor(accent)
        .font('Helvetica')
        .text(options.subtitle, titleX, cursorY, { width: titleWidth, lineBreak: false, ellipsis: true });
      cursorY += 14;
    }

    cursorY += 4;
    // Brand accent rule
    doc.moveTo(PAGE_MARGIN, cursorY)
      .lineTo(doc.page.width - PAGE_MARGIN, cursorY)
      .lineWidth(2)
      .strokeColor(brand)
      .stroke();
    cursorY += 10;

    // ===== SUMMARY CARDS (KPIs) =====
    if (options.summaryCards && options.summaryCards.length > 0) {
      const cardGap = 10;
      const cardWidth =
        (contentWidth(doc) - (options.summaryCards.length - 1) * cardGap) /
        options.summaryCards.length;
      const cardHeight = 48;
      options.summaryCards.forEach((card, i) => {
        const x = PAGE_MARGIN + i * (cardWidth + cardGap);
        const cardColor = sanitizeSvgColor(card.color, brand);
        doc.roundedRect(x, cursorY, cardWidth, cardHeight, 6)
          .fillColor(ROW_ALT_FILL)
          .fill();
        doc.roundedRect(x, cursorY, cardWidth, cardHeight, 6)
          .lineWidth(0.5)
          .strokeColor(ROW_BORDER)
          .stroke();
        doc.rect(x, cursorY + 8, 3, cardHeight - 16)
          .fillColor(cardColor)
          .fill();
        doc.fontSize(7)
          .fillColor(accent)
          .font('Helvetica-Bold')
          .text(card.label.toUpperCase(), x + 12, cursorY + 9, {
            width: cardWidth - 20,
            lineBreak: false,
            ellipsis: true,
          });
        doc.fontSize(15)
          .fillColor(TEXT_DARK)
          .font('Helvetica-Bold')
          .text(card.value, x + 12, cursorY + 22, {
            width: cardWidth - 20,
            lineBreak: false,
            ellipsis: true,
          });
      });
      cursorY += cardHeight + 14;
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
        doc.rect(PAGE_MARGIN, cursorY + 1, 3, 12).fillColor(brand).fill();
        doc.fontSize(11)
          .fillColor(TEXT_DARK)
          .font('Helvetica-Bold')
          .text(section.title, PAGE_MARGIN + 9, cursorY, {
            width: contentWidth(doc) - 9,
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
            .text(col.header.toUpperCase(), x + CELL_PAD_X, y + 7, {
              width: innerWidths[i],
              align: align === 'right' ? 'right' : align === 'center' ? 'center' : 'left',
              lineBreak: false,
              ellipsis: true,
            });
          x += colWidths[i];
        }
        return y + HEADER_HEIGHT;
      };

      /** Draws a status value as a tinted pill when it is a known status label and fits on one line. */
      const drawCell = (
        value: string,
        x: number,
        y: number,
        innerWidth: number,
        rowHeight: number,
        align: 'left' | 'right' | 'center',
        allowPill: boolean
      ) => {
        const tone = allowPill ? statusTone(value) : null;
        doc.fontSize(fontSize);
        if (tone && !value.includes('\n')) {
          doc.font('Helvetica-Bold');
          const textW = doc.widthOfString(value);
          const pillW = Math.min(innerWidth, textW + 10);
          if (textW + 10 <= innerWidth) {
            const pillH = fontSize + 6;
            const pillX = align === 'right' ? x + innerWidth - pillW : align === 'center' ? x + (innerWidth - pillW) / 2 : x;
            const pillY = y + CELL_PAD_Y - 2;
            doc.roundedRect(pillX, pillY, pillW, pillH, pillH / 2).fillColor(TONE_TINT_HEX[tone]).fill();
            doc.fillColor(TONE_HEX[tone]).text(value, pillX + 5, pillY + 3, { width: pillW - 10, lineBreak: false });
            return;
          }
        }
        doc.fillColor(tone ? TONE_HEX[tone] : TEXT_BODY)
          .font(tone ? 'Helvetica-Bold' : 'Helvetica')
          .text(value, x, y + CELL_PAD_Y, {
            width: innerWidth,
            height: rowHeight - CELL_PAD_Y,
            align,
            ellipsis: true,
          });
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
            .fillColor(ROW_ALT_FILL)
            .fill();
        }

        const rowY = tableY;
        let x = PAGE_MARGIN;
        for (let i = 0; i < tableColumns.length; i++) {
          const col = tableColumns[i];
          const align = col.align ?? 'left';
          // Never color amount columns even if a value happened to collide with a status word.
          drawCell(cellValues[i], x + CELL_PAD_X, rowY, innerWidths[i], tableRowHeight, align, align !== 'right');
          x += colWidths[i];
        }
        // Hairline under every row: keeps long tables readable without heavy zebra stripes.
        doc.moveTo(PAGE_MARGIN, rowY + cappedRowHeight)
          .lineTo(PAGE_MARGIN + cw, rowY + cappedRowHeight)
          .lineWidth(0.4)
          .strokeColor(ROW_BORDER)
          .stroke();

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

      // ===== TOTALS ROW =====
      if (section.totalsRow) {
        const totalsValues = tableColumns.map((col) => {
          const raw = section.totalsRow![col.key];
          if (raw === null || raw === undefined) return '';
          if (typeof raw === 'string' && raw.startsWith('TOTAL')) return raw;
          return cellText(col, section.totalsRow!);
        });
        const totalsHeight = MIN_ROW_HEIGHT + 2;
        if (tableY + totalsHeight > bottomLimit) {
          doc.addPage();
          tableY = PAGE_MARGIN;
          tableY = drawTableHeader(tableY);
        }
        doc.rect(PAGE_MARGIN, tableY, cw, totalsHeight).fillColor(TOTALS_FILL).fill();
        doc.moveTo(PAGE_MARGIN, tableY).lineTo(PAGE_MARGIN + cw, tableY).lineWidth(1.5).strokeColor(brand).stroke();
        let tx = PAGE_MARGIN;
        for (let i = 0; i < tableColumns.length; i++) {
          const align = tableColumns[i].align ?? 'left';
          doc.fontSize(fontSize)
            .fillColor(TEXT_DARK)
            .font('Helvetica-Bold')
            .text(totalsValues[i], tx + CELL_PAD_X, tableY + CELL_PAD_Y + 1, {
              width: innerWidths[i],
              align: align === 'right' ? 'right' : align === 'center' ? 'center' : 'left',
              lineBreak: false,
              ellipsis: true,
            });
          tx += colWidths[i];
        }
        tableY += totalsHeight;
      }

      cursorY = tableY + 10;
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
