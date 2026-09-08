import PDFDocument from 'pdfkit';
import fs from 'fs';

/**
 * Professional PDF Report Generator
 *
 * Layout system:
 * - A4 landscape by default (8 columns need width)
 * - Header: logo + title + accent line + summary cards
 * - Table: dynamic row height based on measured text, no overlap
 * - Pagination: repeats header on each page, never splits a row
 * - Footer: page number + timestamp
 */

export interface PdfTableColumn {
  header: string;
  key: string;
  width?: number; // absolute points
  align?: 'left' | 'right' | 'center';
  format?: (value: unknown) => string;
}

export interface PdfReportOptions {
  title: string;
  subtitle?: string;
  author?: string;
  brandColor?: string; // hex like '#2563eb'
  accentColor?: string; // secondary accent
  logoText?: string; // text-based logo
  columns: PdfTableColumn[];
  rows: Record<string, unknown>[];
  summaryCards?: Array<{ label: string; value: string; color?: string }>;
  metadata?: Record<string, string>;
  fontSize?: number;
  orientation?: 'portrait' | 'landscape';
}

const DEFAULT_BRAND = '#2563eb';
const DEFAULT_ACCENT = '#64748b';
const PAGE_MARGIN = 40;
const FOOTER_HEIGHT = 30;
const CELL_PAD_X = 6;
const CELL_PAD_Y = 4;
const HEADER_HEIGHT = 22;
const MIN_ROW_HEIGHT = 20;
const CONTENT_FONT_SIZE = 8;
const HEADER_FONT_SIZE = 8;
const LINE_HEIGHT = 10;

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - PAGE_MARGIN * 2;
}

function pageBottom(doc: PDFKit.PDFDocument): number {
  return doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT;
}

/**
 * Measures how many lines a text will occupy within a given column width
 * at a given font size. Uses pdfkit's widthOfString to wrap manually.
 */
function measureLines(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
  fontSize: number
): number {
  if (!text || text.length === 0) return 1;
  doc.fontSize(fontSize).font('Helvetica');
  const words = text.split(/\s+/);
  let lines = 1;
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (doc.widthOfString(testLine) <= maxWidth) {
      currentLine = testLine;
    } else {
      // Word itself wider than column? Hard-break it.
      if (!currentLine) {
        // Break long word char by char
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
  }
  return lines;
}

/**
 * Computes column widths from percentage hints or equal distribution.
 * Percentages are relative to content width.
 */
function computeColumnWidths(
  cols: PdfTableColumn[],
  totalWidth: number
): number[] {
  // If all columns have explicit widths, use them
  const explicit = cols.map((c) => c.width);
  if (explicit.every((w) => w !== undefined)) {
    return explicit as number[];
  }
  // Default distribution: equal
  return cols.map(() => totalWidth / cols.length);
}

export function generatePdfReport(
  outputPath: string,
  options: PdfReportOptions
): Promise<{ sizeBytes: number; pageCount: number }> {
  return new Promise((resolve, reject) => {
    const brand = options.brandColor ?? DEFAULT_BRAND;
    const accent = options.accentColor ?? DEFAULT_ACCENT;
    const fontSize = options.fontSize ?? CONTENT_FONT_SIZE;
    const orientation = options.orientation ?? 'landscape';

    const doc = new PDFDocument({
      size: 'A4',
      layout: orientation,
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

    let pageCount = 0;
    const drawFooter = () => {
      pageCount++;
      doc.fontSize(7)
        .fillColor(accent)
        .font('Helvetica')
        .text(
          `Generado por UNIK Asistente IA · ${new Date().toLocaleString('es-MX')} · Página ${pageCount}`,
          PAGE_MARGIN,
          doc.page.height - 25,
          { width: contentWidth(doc), align: 'center' }
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
        const cardColor = card.color ?? brand;
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

    // ===== TABLE =====
    if (options.rows.length > 0) {
      const cols = options.columns;
      const cw = contentWidth(doc);
      const colWidths = computeColumnWidths(cols, cw);

      // Inner text width per column (account for horizontal padding)
      const innerWidths = colWidths.map((w) => w - CELL_PAD_X * 2);

      /**
       * Draws the table header row at the given Y position.
       * Returns the Y position after the header.
       */
      const drawTableHeader = (y: number): number => {
        // Background bar
        doc.rect(PAGE_MARGIN, y, cw, HEADER_HEIGHT)
          .fillColor(brand)
          .fill();
        // Header text — save Y so all columns align
        let x = PAGE_MARGIN;
        for (let i = 0; i < cols.length; i++) {
          const col = cols[i];
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

      // Start table immediately after header/summary
      let tableY = cursorY;
      const bottomLimit = pageBottom(doc);

      // If header doesn't fit, new page
      if (tableY + HEADER_HEIGHT > bottomLimit) {
        doc.addPage();
        tableY = PAGE_MARGIN;
      }

      tableY = drawTableHeader(tableY);

      // Data rows
      for (let rowIdx = 0; rowIdx < options.rows.length; rowIdx++) {
        const row = options.rows[rowIdx];

        // Pre-compute formatted values and measure lines for each cell
        const cellData = cols.map((col, i) => {
          const rawValue = row[col.key];
          const value = col.format
            ? col.format(rawValue)
            : String(rawValue ?? '');
          const lines = measureLines(doc, value, innerWidths[i], fontSize);
          return { value, lines };
        });

        // Row height = max lines * lineHeight + padding
        const maxLines = Math.max(...cellData.map((c) => c.lines), 1);
        const rowHeight = Math.max(
          MIN_ROW_HEIGHT,
          maxLines * LINE_HEIGHT + CELL_PAD_Y * 2
        );

        // Page break BEFORE drawing — never split a row
        if (tableY + rowHeight > bottomLimit) {
          doc.addPage();
          tableY = PAGE_MARGIN;
          tableY = drawTableHeader(tableY);
        }

        // Zebra striping — draw background for full row height
        const isAlt = rowIdx % 2 === 1;
        if (isAlt) {
          doc.rect(PAGE_MARGIN, tableY, cw, rowHeight)
            .fillColor('#f1f5f9')
            .fill();
        }

        // Draw all cells at the same rowY
        const rowY = tableY;
        let x = PAGE_MARGIN;
        for (let i = 0; i < cols.length; i++) {
          const col = cols[i];
          const { value } = cellData[i];
          const align = col.align ?? 'left';
          doc.fontSize(fontSize)
            .fillColor('#334155')
            .font('Helvetica')
            .text(value, x + CELL_PAD_X, rowY + CELL_PAD_Y, {
              width: innerWidths[i],
              align: align === 'right' ? 'right' : align === 'center' ? 'center' : 'left',
            });
          x += colWidths[i];
        }

        // Advance Y by the actual row height
        tableY += rowHeight;
      }

      cursorY = tableY;
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

    // Draw footer on first page and subsequent pages
    drawFooter();
    doc.on('pageAdded', drawFooter);

    doc.end();

    stream.on('finish', () => {
      const stats = fs.statSync(outputPath);
      resolve({ sizeBytes: stats.size, pageCount });
    });
    stream.on('error', reject);
  });
}
