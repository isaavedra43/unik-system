import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

/**
 * Professional PDF Report Generator
 *
 * Generates branded PDF reports with:
 * - Header with logo area, title, subtitle
 * - Brand color accent line
 * - Data tables with alternating row colors
 - - Summary cards (KPIs)
 * - Footer with page numbers and timestamp
 *
 * All visual elements are customizable via options.
 */

export interface PdfTableColumn {
  header: string;
  key: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  format?: (value: unknown) => string;
}

export interface PdfReportOptions {
  title: string;
  subtitle?: string;
  author?: string;
  brandColor?: string; // hex like '#2563eb'
  accentColor?: string; // secondary accent
  logoText?: string; // text-based logo (no image upload needed)
  columns: PdfTableColumn[];
  rows: Record<string, unknown>[];
  summaryCards?: Array<{ label: string; value: string; color?: string }>;
  metadata?: Record<string, string>; // extra metadata at bottom
  fontSize?: number;
  orientation?: 'portrait' | 'landscape';
}

const DEFAULT_BRAND = '#2563eb';
const DEFAULT_ACCENT = '#64748b';
const PAGE_MARGIN = 50;
const CONTENT_WIDTH = (doc: PDFKit.PDFDocument) => doc.page.width - PAGE_MARGIN * 2;

export function generatePdfReport(
  outputPath: string,
  options: PdfReportOptions
): Promise<{ sizeBytes: number; pageCount: number }> {
  return new Promise((resolve, reject) => {
    const brand = options.brandColor ?? DEFAULT_BRAND;
    const accent = options.accentColor ?? DEFAULT_ACCENT;
    const fontSize = options.fontSize ?? 10;

    const doc = new PDFDocument({
      size: 'A4',
      layout: options.orientation ?? 'portrait',
      margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
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
    const drawPage = () => {
      pageCount++;
      // Footer
      doc.fontSize(8)
        .fillColor(accent)
        .text(
          `Generado por UNIK Asistente IA · ${new Date().toLocaleString('es-MX')} · Página ${pageCount}`,
          PAGE_MARGIN,
          doc.page.height - 40,
          { width: CONTENT_WIDTH(doc), align: 'center' }
        );
    };

    // ===== HEADER =====
    const headerY = doc.y;
    // Logo text (left)
    if (options.logoText) {
      doc.fontSize(20)
        .fillColor(brand)
        .font('Helvetica-Bold')
        .text(options.logoText, PAGE_MARGIN, headerY);
    }
    // Title (center/right)
    doc.fontSize(22)
      .fillColor('#1e293b')
      .font('Helvetica-Bold')
      .text(options.title, PAGE_MARGIN, headerY, { width: CONTENT_WIDTH(doc), align: 'right' });

    // Subtitle
    if (options.subtitle) {
      doc.moveDown(0.3)
        .fontSize(11)
        .fillColor(accent)
        .font('Helvetica')
        .text(options.subtitle, { width: CONTENT_WIDTH(doc), align: 'right' });
    }

    // Brand accent line
    doc.moveDown(0.5);
    const lineY = doc.y;
    doc.moveTo(PAGE_MARGIN, lineY)
      .lineTo(doc.page.width - PAGE_MARGIN, lineY)
      .lineWidth(3)
      .strokeColor(brand)
      .stroke();

    doc.moveDown(1);

    // ===== SUMMARY CARDS (KPIs) =====
    if (options.summaryCards && options.summaryCards.length > 0) {
      const cardWidth = (CONTENT_WIDTH(doc) - (options.summaryCards.length - 1) * 10) / options.summaryCards.length;
      const cardHeight = 60;
      const cardY = doc.y;
      options.summaryCards.forEach((card, i) => {
        const x = PAGE_MARGIN + i * (cardWidth + 10);
        const cardColor = card.color ?? brand;
        // Card background
        doc.roundedRect(x, cardY, cardWidth, cardHeight, 8)
          .fillColor('#f8fafc')
          .fill();
        // Top accent
        doc.roundedRect(x, cardY, cardWidth, 4, 2)
          .fillColor(cardColor)
          .fill();
        // Label
        doc.fontSize(8)
          .fillColor(accent)
          .font('Helvetica')
          .text(card.label.toUpperCase(), x + 10, cardY + 12, { width: cardWidth - 20 });
        // Value
        doc.fontSize(16)
          .fillColor('#1e293b')
          .font('Helvetica-Bold')
          .text(card.value, x + 10, cardY + 28, { width: cardWidth - 20 });
      });
      doc.y = cardY + cardHeight + 20;
    }

    // ===== TABLE =====
    if (options.rows.length > 0) {
      const cols = options.columns;
      const colWidths = cols.map((c) => c.width ?? CONTENT_WIDTH(doc) / cols.length);
      const tableY = doc.y;
      const rowHeight = 24;
      const headerHeight = 26;

      // Check if we need a new page
      const totalTableHeight = headerHeight + options.rows.length * rowHeight;
      if (tableY + totalTableHeight > doc.page.height - PAGE_MARGIN - 40) {
        doc.addPage();
      }

      // Header row
      let x = PAGE_MARGIN;
      doc.roundedRect(PAGE_MARGIN, doc.y, CONTENT_WIDTH(doc), headerHeight, 4)
        .fillColor(brand)
        .fill();
      cols.forEach((col, i) => {
        const align = col.align ?? 'left';
        doc.fontSize(9)
          .fillColor('#ffffff')
          .font('Helvetica-Bold')
          .text(col.header, x + 6, doc.y + 8, {
            width: colWidths[i] - 12,
            align: align === 'right' ? 'right' : align === 'center' ? 'center' : 'left',
          });
        x += colWidths[i];
      });
      doc.y += headerHeight;

      // Data rows
      options.rows.forEach((row, rowIdx) => {
        // Check page break
        if (doc.y + rowHeight > doc.page.height - PAGE_MARGIN - 40) {
          doc.addPage();
          // Redraw header
          x = PAGE_MARGIN;
          doc.roundedRect(PAGE_MARGIN, doc.y, CONTENT_WIDTH(doc), headerHeight, 4)
            .fillColor(brand)
            .fill();
          cols.forEach((col, i) => {
            const align = col.align ?? 'left';
            doc.fontSize(9)
              .fillColor('#ffffff')
              .font('Helvetica-Bold')
              .text(col.header, x + 6, doc.y + 8, {
                width: colWidths[i] - 12,
                align: align === 'right' ? 'right' : align === 'center' ? 'center' : 'left',
              });
            x += colWidths[i];
          });
          doc.y += headerHeight;
        }

        x = PAGE_MARGIN;
        const cellY = doc.y; // Save Y position for this row — all cells use the same Y
        const isAlt = rowIdx % 2 === 1;
        if (isAlt) {
          doc.rect(PAGE_MARGIN, cellY, CONTENT_WIDTH(doc), rowHeight)
            .fillColor('#f1f5f9')
            .fill();
        }
        cols.forEach((col, i) => {
          const rawValue = row[col.key];
          const value = col.format ? col.format(rawValue) : String(rawValue ?? '');
          const align = col.align ?? 'left';
          doc.fontSize(fontSize)
            .fillColor('#334155')
            .font('Helvetica')
            .text(value, x + 6, cellY + 7, {
              width: colWidths[i] - 12,
              align: align === 'right' ? 'right' : align === 'center' ? 'center' : 'left',
            });
          x += colWidths[i];
        });
        doc.y = cellY + rowHeight; // Move to next row
      });
    }

    // ===== METADATA FOOTER =====
    if (options.metadata) {
      doc.moveDown(1.5);
      doc.fontSize(8)
        .fillColor(accent)
        .font('Helvetica-Oblique');
      for (const [key, value] of Object.entries(options.metadata)) {
        doc.text(`${key}: ${value}`, { width: CONTENT_WIDTH(doc) });
      }
    }

    // Page numbers on all pages
    drawPage();
    doc.on('pageAdded', drawPage);

    doc.end();

    stream.on('finish', () => {
      const stats = fs.statSync(outputPath);
      resolve({ sizeBytes: stats.size, pageCount });
    });
    stream.on('error', reject);
  });
}
