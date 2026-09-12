import fs from 'fs';
import fsp from 'fs/promises';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  generatePdfReport,
  type PdfSection,
  type PdfTableColumn,
} from '@/modules/ai/generators/pdf-generator';
import { sanitizeSvgColor } from '@/modules/ai/generators/status-tone';
import type {
  ImageBlock,
  KpiBlock,
  ListBlock,
  StudioBlock,
  StudioContent,
  TableBlock,
} from './studio-content';
import { parseStudioNumber, renderCellText, type StudioColumnFormat } from './studio-format';
import {
  docxImageType,
  fitImage,
  isPdfCompatibleImage,
  readImageSize,
  toDataUri,
} from './studio-images';

/**
 * Renders a StudioContent into every supported file format. Pure file
 * generation: no database, no object storage. The export job feeds it the
 * content, resolves images and hands the result to the verification step.
 *
 * Rules every renderer follows:
 * - cells go through `renderCellText` (the verification step predicts strings);
 * - nothing is truncated or elided (long values wrap or widen the canvas);
 * - images are embedded (no external URLs) or replaced by their alt text.
 */

export type StudioExportFormat = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'html' | 'md' | 'svg';

export const STUDIO_EXPORT_FORMATS: StudioExportFormat[] = [
  'pdf',
  'docx',
  'xlsx',
  'csv',
  'pptx',
  'html',
  'md',
  'svg',
];

export const EXPORT_FORMAT_INFO: Record<
  StudioExportFormat,
  { label: string; extension: string; mimeType: string }
> = {
  pdf: { label: 'PDF', extension: 'pdf', mimeType: 'application/pdf' },
  docx: {
    label: 'Word (DOCX)',
    extension: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  xlsx: {
    label: 'Excel (XLSX)',
    extension: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  csv: { label: 'CSV', extension: 'csv', mimeType: 'text/csv' },
  pptx: {
    label: 'PowerPoint (PPTX)',
    extension: 'pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  html: { label: 'HTML', extension: 'html', mimeType: 'text/html' },
  md: { label: 'Markdown', extension: 'md', mimeType: 'text/markdown' },
  svg: { label: 'Imagen (SVG)', extension: 'svg', mimeType: 'image/svg+xml' },
};

export function isStudioExportFormat(value: unknown): value is StudioExportFormat {
  return typeof value === 'string' && (STUDIO_EXPORT_FORMATS as string[]).includes(value);
}

export interface ExportImage {
  buffer: Buffer;
  mimeType: string;
}

export interface ExportRenderInput {
  title: string;
  content: StudioContent;
  outputPath: string;
  /** Resolves the bytes of an image block. Missing/failed images render as their alt text. */
  loadImage?: (storageObjectId: string) => Promise<ExportImage | null>;
  generatedAt?: Date;
}

export interface ExportRenderResult {
  sizeBytes: number;
  pageCount?: number;
  /** xlsx: sheet names in order. */
  sheetNames?: string[];
}

const BRAND = '#2563eb';
const ACCENT = '#64748b';
const TEXT_DARK = '#0f172a';
const TEXT_BODY = '#334155';
const ROW_ALT = '#f8fafc';
const BORDER = '#e2e8f0';
const KPI_SHEET_NAME = 'Resumen';

// ---------------------------------------------------------------------------
// Shared helpers (also used by the verification step)
// ---------------------------------------------------------------------------

export function formatGeneratedAt(date: Date): string {
  return date.toLocaleString('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City',
  });
}

export function isNumericFormat(format?: StudioColumnFormat): boolean {
  return format === 'number' || format === 'currency' || format === 'percentage';
}

/** Header + data rows as rendered strings (the exact text every renderer prints). */
export function tableStrings(block: TableBlock): { header: string[]; rows: string[][] } {
  return {
    header: block.columns.map((c) => c.header || c.key),
    rows: block.rows.map((row) => block.columns.map((c) => renderCellText(row[c.key], c.format))),
  };
}

/** Deterministic, Excel-safe, unique sheet name for the N-th table. */
export function sheetNameForTable(
  index: number,
  title: string | undefined,
  used: Set<string>
): string {
  const base = (title && title.trim().length > 0 ? title.trim() : `Tabla ${index + 1}`)
    .replace(/[\[\]:*?/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28);
  let candidate = base.length > 0 ? base : `Tabla ${index + 1}`;
  let n = 2;
  while (
    used.has(candidate.toLowerCase()) ||
    candidate.toLowerCase() === KPI_SHEET_NAME.toLowerCase()
  ) {
    candidate = `${base.slice(0, 24)} (${n})`;
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function kpiSheetName(): string {
  return KPI_SHEET_NAME;
}

/** Value written into an XLSX cell: real numbers for numeric data, rendered text otherwise. */
export function xlsxCellValue(
  value: string | number | boolean | null | undefined,
  format?: StudioColumnFormat
): number | string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return renderCellText(value, format);
  if (isNumericFormat(format)) {
    const n = parseStudioNumber(value);
    if (n !== null) return n;
  }
  return renderCellText(value, format);
}

export function xlsxNumberFormat(format?: StudioColumnFormat): string | undefined {
  if (format === 'currency') return '"$"#,##0.00';
  if (format === 'percentage') return '0.##"%"';
  if (format === 'number') return '#,##0.##';
  return undefined;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function safeFileStem(title: string): string {
  const stem = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return stem.length > 0 ? stem : 'documento';
}

export function exportFileName(title: string, format: StudioExportFormat): string {
  return `${safeFileStem(title)}.${EXPORT_FORMAT_INFO[format].extension}`;
}

type ImageMap = Map<string, ExportImage | null>;

async function resolveImages(
  content: StudioContent,
  loadImage?: ExportRenderInput['loadImage']
): Promise<ImageMap> {
  const map: ImageMap = new Map();
  for (const block of content.blocks) {
    if (block.type !== 'image' || map.has(block.id)) continue;
    if (!loadImage) {
      map.set(block.id, null);
      continue;
    }
    try {
      map.set(block.id, await loadImage(block.storageObjectId));
    } catch {
      map.set(block.id, null);
    }
  }
  return map;
}

function imagePlaceholder(block: ImageBlock): string {
  return `[Imagen: ${block.alt || 'sin descripción'}]`;
}

function listItemPrefix(block: ListBlock, index: number): string {
  return block.ordered ? `${index + 1}. ` : '• ';
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function renderStudioExport(
  format: StudioExportFormat,
  input: ExportRenderInput
): Promise<ExportRenderResult> {
  const generatedAt = input.generatedAt ?? new Date();
  const images = await resolveImages(input.content, input.loadImage);
  const ctx: RenderContext = { ...input, generatedAt, images };
  switch (format) {
    case 'pdf':
      return renderPdf(ctx);
    case 'docx':
      return renderDocx(ctx);
    case 'xlsx':
      return renderXlsx(ctx);
    case 'csv':
      return renderCsv(ctx);
    case 'pptx':
      return renderPptx(ctx);
    case 'html':
      return renderHtml(ctx);
    case 'md':
      return renderMarkdown(ctx);
    case 'svg':
      return renderSvg(ctx);
    default: {
      const never: never = format;
      throw new Error(`Formato no soportado: ${String(never)}`);
    }
  }
}

interface RenderContext extends ExportRenderInput {
  generatedAt: Date;
  images: ImageMap;
}

async function writeAndStat(
  outputPath: string,
  data: Buffer | string
): Promise<ExportRenderResult> {
  await fsp.writeFile(outputPath, data);
  const stat = await fsp.stat(outputPath);
  return { sizeBytes: stat.size };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PDF_MARGIN = 40;
const PDF_FOOTER = 26;

/**
 * "Report shaped" documents (title + KPIs + tables only) reuse the branded
 * report engine of the assistant so both surfaces look identical. Anything with
 * prose, lists or images goes through the block renderer below.
 */
function reportShape(ctx: RenderContext): {
  sections: PdfSection[];
  summaryCards: Array<{ label: string; value: string }>;
  subtitle?: string;
} | null {
  const blocks = ctx.content.blocks;
  if (ctx.title.length > 60) return null;
  if (!blocks.some((b) => b.type === 'table')) return null;
  const sections: PdfSection[] = [];
  const summaryCards: Array<{ label: string; value: string }> = [];
  let subtitle: string | undefined;
  let pendingHeading: string | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    switch (block.type) {
      case 'divider':
      case 'pageBreak':
        break;
      case 'kpi':
        summaryCards.push(...block.cards);
        break;
      case 'heading': {
        if (pendingHeading !== null) return null;
        if (i === 0 && block.level === 1) {
          subtitle = block.text === ctx.title ? undefined : block.text;
          break;
        }
        pendingHeading = block.text;
        break;
      }
      case 'table': {
        sections.push({
          title: pendingHeading ?? block.title,
          columns: block.columns.map<PdfTableColumn>((c) => ({
            header: c.header || c.key,
            key: c.key,
            align: c.align ?? (isNumericFormat(c.format) ? 'right' : 'left'),
            nowrap: isNumericFormat(c.format),
            format: (v) => renderCellText(v as string | number | boolean | null, c.format),
          })),
          rows: block.rows,
        });
        pendingHeading = null;
        break;
      }
      default:
        return null;
    }
  }
  if (pendingHeading !== null) return null;
  if (
    summaryCards.length > 6 ||
    summaryCards.some((c) => c.value.length > 16 || c.label.length > 40)
  ) {
    return null;
  }
  if (subtitle && subtitle.length > 90) return null;
  return { sections, summaryCards, subtitle };
}

async function renderPdf(ctx: RenderContext): Promise<ExportRenderResult> {
  const shape = reportShape(ctx);
  if (shape) {
    const wide = shape.sections.some((s) => s.columns.length > 5);
    const result = await generatePdfReport(ctx.outputPath, {
      title: ctx.title,
      subtitle: shape.subtitle,
      author: 'UNIK Estudio visual',
      logoText: 'UNIK',
      columns: shape.sections[0].columns,
      rows: shape.sections[0].rows,
      sections: shape.sections,
      summaryCards: shape.summaryCards.length > 0 ? shape.summaryCards : undefined,
      orientation: wide ? 'landscape' : 'portrait',
    });
    return { sizeBytes: result.sizeBytes, pageCount: result.pageCount };
  }
  return renderPdfBlocks(ctx);
}

function renderPdfBlocks(ctx: RenderContext): Promise<ExportRenderResult> {
  return new Promise((resolve, reject) => {
    const wide = ctx.content.blocks.some((b) => b.type === 'table' && b.columns.length > 6);
    const doc = new PDFDocument({
      size: 'A4',
      layout: wide ? 'landscape' : 'portrait',
      bufferPages: true,
      margins: {
        top: PDF_MARGIN,
        bottom: PDF_MARGIN + PDF_FOOTER,
        left: PDF_MARGIN,
        right: PDF_MARGIN,
      },
      info: { Title: ctx.title, Author: 'UNIK Estudio visual', Creator: 'UNIK' },
    });
    const stream = fs.createWriteStream(ctx.outputPath);
    doc.pipe(stream);

    const cw = () => doc.page.width - PDF_MARGIN * 2;
    const bottom = () => doc.page.height - PDF_MARGIN - PDF_FOOTER;
    const ensureSpace = (height: number) => {
      if (doc.y + height > bottom()) {
        doc.addPage();
      }
    };

    // Title block
    doc.font('Helvetica-Bold').fontSize(20).fillColor(TEXT_DARK);
    doc.text(ctx.title, PDF_MARGIN, PDF_MARGIN, { width: cw() });
    doc.font('Helvetica').fontSize(8).fillColor(ACCENT);
    doc.text(`Generado por UNIK Estudio visual · ${formatGeneratedAt(ctx.generatedAt)}`, {
      width: cw(),
    });
    doc.moveDown(0.4);
    doc
      .moveTo(PDF_MARGIN, doc.y)
      .lineTo(doc.page.width - PDF_MARGIN, doc.y)
      .lineWidth(2)
      .strokeColor(BRAND)
      .stroke();
    doc.y += 12;

    for (const block of ctx.content.blocks) {
      switch (block.type) {
        case 'heading': {
          const size = block.level === 1 ? 16 : block.level === 2 ? 13 : 11;
          doc.font('Helvetica-Bold').fontSize(size).fillColor(TEXT_DARK);
          ensureSpace(doc.heightOfString(block.text, { width: cw() }) + 8);
          doc.text(block.text, PDF_MARGIN, doc.y + 4, { width: cw() });
          doc.y += 4;
          break;
        }
        case 'paragraph': {
          doc.font('Helvetica').fontSize(10).fillColor(TEXT_BODY);
          doc.text(block.text, PDF_MARGIN, doc.y, { width: cw(), lineGap: 2 });
          doc.y += 8;
          break;
        }
        case 'list': {
          doc.font('Helvetica').fontSize(10).fillColor(TEXT_BODY);
          block.items.forEach((item, i) => {
            const prefix = listItemPrefix(block, i);
            const prefixWidth = 22;
            const height = doc.heightOfString(item, { width: cw() - prefixWidth });
            ensureSpace(height + 2);
            const y = doc.y;
            doc.text(prefix, PDF_MARGIN + 4, y, { width: prefixWidth, lineBreak: false });
            doc.text(item, PDF_MARGIN + prefixWidth + 4, y, { width: cw() - prefixWidth - 4 });
            doc.y = y + height + 3;
          });
          doc.y += 6;
          break;
        }
        case 'kpi':
          drawPdfKpis(doc, block, cw, ensureSpace);
          break;
        case 'table':
          drawPdfTable(doc, block, cw, bottom);
          break;
        case 'image': {
          const image = ctx.images.get(block.id) ?? null;
          if (image && isPdfCompatibleImage(image.mimeType)) {
            const size = fitImage(readImageSize(image.buffer, image.mimeType), cw(), 380);
            ensureSpace(size.height + 24);
            try {
              doc.image(image.buffer, PDF_MARGIN, doc.y, {
                width: size.width,
                height: size.height,
              });
              doc.y += size.height + 4;
            } catch {
              doc.font('Helvetica-Oblique').fontSize(9).fillColor(ACCENT);
              doc.text(imagePlaceholder(block), PDF_MARGIN, doc.y, { width: cw() });
            }
          } else {
            doc.font('Helvetica-Oblique').fontSize(9).fillColor(ACCENT);
            doc.text(imagePlaceholder(block), PDF_MARGIN, doc.y, { width: cw() });
          }
          if (block.caption) {
            doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(ACCENT);
            doc.text(block.caption, PDF_MARGIN, doc.y, { width: cw() });
          }
          doc.y += 8;
          break;
        }
        case 'pageBreak':
          doc.addPage();
          break;
        case 'divider':
          ensureSpace(14);
          doc
            .moveTo(PDF_MARGIN, doc.y + 4)
            .lineTo(doc.page.width - PDF_MARGIN, doc.y + 4)
            .lineWidth(0.6)
            .strokeColor(BORDER)
            .stroke();
          doc.y += 12;
          break;
        default:
          break;
      }
    }

    // Footer on every buffered page (real page count is known now).
    const range = doc.bufferedPageRange();
    const pageCount = range.count;
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // The footer lives inside the reserved strip below the content margin.
      doc.page.margins.bottom = PDF_MARGIN;
      const y = doc.page.height - PDF_MARGIN - 12;
      doc
        .moveTo(PDF_MARGIN, y - 6)
        .lineTo(doc.page.width - PDF_MARGIN, y - 6)
        .lineWidth(0.5)
        .strokeColor(BORDER)
        .stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(BRAND);
      doc.text('UNIK', PDF_MARGIN, y, { width: cw() / 3, lineBreak: false });
      doc.font('Helvetica').fontSize(7).fillColor(ACCENT);
      doc.text(`Página ${i - range.start + 1} de ${pageCount}`, PDF_MARGIN + (cw() * 2) / 3, y, {
        width: cw() / 3,
        align: 'right',
        lineBreak: false,
      });
    }
    doc.end();
    stream.on('finish', () => {
      const stats = fs.statSync(ctx.outputPath);
      resolve({ sizeBytes: stats.size, pageCount });
    });
    stream.on('error', reject);
  });
}

function drawPdfKpis(
  doc: PDFKit.PDFDocument,
  block: KpiBlock,
  cw: () => number,
  ensureSpace: (h: number) => void
): void {
  const perRow = Math.min(4, block.cards.length);
  const gap = 8;
  const cardWidth = (cw() - gap * (perRow - 1)) / perRow;
  for (let start = 0; start < block.cards.length; start += perRow) {
    const rowCards = block.cards.slice(start, start + perRow);
    doc.font('Helvetica-Bold').fontSize(14);
    const valueHeights = rowCards.map((c) =>
      doc.heightOfString(c.value, { width: cardWidth - 16 })
    );
    doc.font('Helvetica-Bold').fontSize(7);
    const labelHeights = rowCards.map((c) =>
      doc.heightOfString(c.label.toUpperCase(), { width: cardWidth - 16 })
    );
    const cardHeight = Math.max(...valueHeights.map((v, i) => v + labelHeights[i])) + 20;
    ensureSpace(cardHeight + 10);
    const y = doc.y;
    rowCards.forEach((card, i) => {
      const x = PDF_MARGIN + i * (cardWidth + gap);
      doc.roundedRect(x, y, cardWidth, cardHeight, 5).fillColor(ROW_ALT).fill();
      doc.roundedRect(x, y, cardWidth, cardHeight, 5).lineWidth(0.5).strokeColor(BORDER).stroke();
      doc
        .rect(x, y + 6, 3, cardHeight - 12)
        .fillColor(BRAND)
        .fill();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(ACCENT);
      doc.text(card.label.toUpperCase(), x + 10, y + 7, { width: cardWidth - 16 });
      doc.font('Helvetica-Bold').fontSize(14).fillColor(TEXT_DARK);
      doc.text(card.value, x + 10, y + 9 + labelHeights[i], { width: cardWidth - 16 });
    });
    doc.y = y + cardHeight + 10;
  }
}

function drawPdfTable(
  doc: PDFKit.PDFDocument,
  block: TableBlock,
  cw: () => number,
  bottom: () => number
): void {
  const { header, rows } = tableStrings(block);
  const fontSize = block.columns.length > 8 ? 7 : block.columns.length > 5 ? 8 : 9;
  const padX = 5;
  const padY = 4;
  const total = cw();

  if (block.title) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(TEXT_DARK);
    if (doc.y + 30 > bottom()) doc.addPage();
    doc
      .rect(PDF_MARGIN, doc.y + 2, 3, 11)
      .fillColor(BRAND)
      .fill();
    doc.fillColor(TEXT_DARK).text(block.title, PDF_MARGIN + 8, doc.y, { width: total - 8 });
    doc.y += 4;
  }

  // Column widths: proportional to the widest content, floor per column, normalized to the page.
  doc.font('Helvetica').fontSize(fontSize);
  const desired = block.columns.map((col, i) => {
    let w = doc.widthOfString(header[i]) * 1.1;
    for (const r of rows) w = Math.max(w, doc.widthOfString(r[i]));
    return Math.min(w + padX * 2, total * 0.45);
  });
  const sum = desired.reduce((a, b) => a + b, 0) || 1;
  const floor = Math.min(40, total / block.columns.length);
  let widths = desired.map((w) => Math.max(floor, (w / sum) * total));
  const over = widths.reduce((a, b) => a + b, 0) - total;
  if (over > 0) {
    const flexible = widths.map((w) => w - floor);
    const flexSum = flexible.reduce((a, b) => a + b, 0) || 1;
    widths = widths.map((w, i) => w - (flexible[i] / flexSum) * over);
  }
  const inner = widths.map((w) => Math.max(6, w - padX * 2));
  const aligns = block.columns.map(
    (c) => c.align ?? (isNumericFormat(c.format) ? 'right' : 'left')
  );

  const headerHeight = (() => {
    doc.font('Helvetica-Bold').fontSize(fontSize);
    const h = Math.max(...header.map((t, i) => doc.heightOfString(t, { width: inner[i] })));
    return h + padY * 2;
  })();

  const drawHeader = () => {
    const y = doc.y;
    doc.rect(PDF_MARGIN, y, total, headerHeight).fillColor(BRAND).fill();
    doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#ffffff');
    let x = PDF_MARGIN;
    header.forEach((text, i) => {
      doc.text(text, x + padX, y + padY, { width: inner[i], align: aligns[i] });
      x += widths[i];
    });
    doc.y = y + headerHeight;
  };

  if (doc.y + headerHeight + 24 > bottom()) doc.addPage();
  drawHeader();

  doc.font('Helvetica').fontSize(fontSize);
  rows.forEach((cells, rowIdx) => {
    const heights = cells.map((text, i) => doc.heightOfString(text || ' ', { width: inner[i] }));
    const rowHeight = Math.max(...heights, fontSize + 2) + padY * 2;
    if (doc.y + rowHeight > bottom()) {
      doc.addPage();
      drawHeader();
      doc.font('Helvetica').fontSize(fontSize);
    }
    const y = doc.y;
    if (rowIdx % 2 === 1) doc.rect(PDF_MARGIN, y, total, rowHeight).fillColor(ROW_ALT).fill();
    doc.fillColor(TEXT_BODY);
    let x = PDF_MARGIN;
    cells.forEach((text, i) => {
      doc.text(text, x + padX, y + padY, { width: inner[i], align: aligns[i] });
      x += widths[i];
    });
    doc
      .moveTo(PDF_MARGIN, y + rowHeight)
      .lineTo(PDF_MARGIN + total, y + rowHeight)
      .lineWidth(0.4)
      .strokeColor(BORDER)
      .stroke();
    doc.y = y + rowHeight;
  });
  if (rows.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(fontSize).fillColor(ACCENT);
    doc.text('(Sin datos)', PDF_MARGIN, doc.y + 4, { width: total });
  }
  doc.y += 12;
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

const ORDERED_LIST_REF = 'studio-ordered';

function docxTextRuns(
  text: string,
  options: { bold?: boolean; color?: string; size?: number } = {}
) {
  const lines = text.split('\n');
  return lines.map(
    (line, i) => new TextRun({ text: line, break: i > 0 ? 1 : undefined, ...options })
  );
}

async function renderDocx(ctx: RenderContext): Promise<ExportRenderResult> {
  const children: Array<Paragraph | Table> = [];
  children.push(new Paragraph({ text: ctx.title, heading: HeadingLevel.TITLE }));
  children.push(
    new Paragraph({
      children: docxTextRuns(
        `Generado por UNIK Estudio visual · ${formatGeneratedAt(ctx.generatedAt)}`,
        {
          color: '64748B',
          size: 16,
        }
      ),
      spacing: { after: 240 },
    })
  );
  let orderedInstance = 0;

  for (const block of ctx.content.blocks) {
    switch (block.type) {
      case 'heading':
        children.push(
          new Paragraph({
            text: block.text,
            heading:
              block.level === 1
                ? HeadingLevel.HEADING_1
                : block.level === 2
                  ? HeadingLevel.HEADING_2
                  : HeadingLevel.HEADING_3,
          })
        );
        break;
      case 'paragraph':
        children.push(
          new Paragraph({ children: docxTextRuns(block.text), spacing: { after: 160 } })
        );
        break;
      case 'list':
        orderedInstance++;
        block.items.forEach((item) => {
          children.push(
            new Paragraph({
              children: docxTextRuns(item),
              ...(block.ordered
                ? {
                    numbering: { reference: ORDERED_LIST_REF, level: 0, instance: orderedInstance },
                  }
                : { bullet: { level: 0 } }),
            })
          );
        });
        children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
        break;
      case 'kpi':
        children.push(docxKpiTable(block));
        children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
        break;
      case 'table':
        if (block.title) {
          children.push(new Paragraph({ text: block.title, heading: HeadingLevel.HEADING_3 }));
        }
        children.push(docxDataTable(block));
        children.push(new Paragraph({ text: '', spacing: { after: 160 } }));
        break;
      case 'image': {
        const image = ctx.images.get(block.id) ?? null;
        const type = image ? docxImageType(image.mimeType) : null;
        if (image && type) {
          const size = fitImage(readImageSize(image.buffer, image.mimeType), 600, 420);
          children.push(
            new Paragraph({
              children: [
                new ImageRun({
                  type,
                  data: image.buffer,
                  transformation: { width: size.width, height: size.height },
                  altText: {
                    title: block.alt,
                    description: block.alt,
                    name: block.alt || 'imagen',
                  },
                }),
              ],
            })
          );
        } else {
          children.push(
            new Paragraph({ children: docxTextRuns(imagePlaceholder(block), { color: '64748B' }) })
          );
        }
        if (block.caption) {
          children.push(
            new Paragraph({
              children: docxTextRuns(block.caption, { color: '64748B', size: 18 }),
              spacing: { after: 160 },
            })
          );
        }
        break;
      }
      case 'pageBreak':
        children.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case 'divider':
        children.push(
          new Paragraph({
            text: '',
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1', space: 1 } },
            spacing: { after: 160 },
          })
        );
        break;
      default:
        break;
    }
  }

  const document = new Document({
    creator: 'UNIK Estudio visual',
    title: ctx.title,
    numbering: {
      config: [
        {
          reference: ORDERED_LIST_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 540, hanging: 300 } } },
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });
  const buffer = await Packer.toBuffer(document);
  return writeAndStat(ctx.outputPath, buffer);
}

function docxCell(
  text: string,
  options: { bold?: boolean; fill?: string; color?: string; align?: 'left' | 'right' | 'center' }
) {
  return new TableCell({
    shading: options.fill
      ? { type: ShadingType.CLEAR, fill: options.fill, color: 'auto' }
      : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [
      new Paragraph({
        alignment:
          options.align === 'right'
            ? AlignmentType.RIGHT
            : options.align === 'center'
              ? AlignmentType.CENTER
              : AlignmentType.LEFT,
        children: docxTextRuns(text, { bold: options.bold, color: options.color, size: 18 }),
      }),
    ],
  });
}

function docxDataTable(block: TableBlock): Table {
  const { header, rows } = tableStrings(block);
  const aligns = block.columns.map(
    (c) => c.align ?? (isNumericFormat(c.format) ? 'right' : 'left')
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: header.map((h, i) =>
          docxCell(h, { bold: true, fill: '2563EB', color: 'FFFFFF', align: aligns[i] })
        ),
      }),
      ...rows.map(
        (cells, rowIdx) =>
          new TableRow({
            children: cells.map((text, i) =>
              docxCell(text, { fill: rowIdx % 2 === 1 ? 'F8FAFC' : undefined, align: aligns[i] })
            ),
          })
      ),
    ],
  });
}

function docxKpiTable(block: KpiBlock): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: block.cards.map(
          (card) =>
            new TableCell({
              shading: { type: ShadingType.CLEAR, fill: 'F8FAFC', color: 'auto' },
              margins: { top: 100, bottom: 100, left: 120, right: 120 },
              children: [
                new Paragraph({
                  children: docxTextRuns(card.label.toUpperCase(), {
                    color: '64748B',
                    size: 14,
                    bold: true,
                  }),
                }),
                new Paragraph({ children: docxTextRuns(card.value, { bold: true, size: 28 }) }),
              ],
            })
        ),
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

async function renderXlsx(ctx: RenderContext): Promise<ExportRenderResult> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'UNIK Estudio visual';
  workbook.created = ctx.generatedAt;
  workbook.title = ctx.title;

  const summary = workbook.addWorksheet(KPI_SHEET_NAME, {
    properties: { tabColor: { argb: 'FF2563EB' } },
  });
  summary.columns = [{ width: 42 }, { width: 32 }];
  summary.addRow(['Documento', ctx.title]).font = { bold: true, size: 13 };
  summary.addRow(['Generado', formatGeneratedAt(ctx.generatedAt)]);
  summary.addRow([]);
  const kpiBlocks = ctx.content.blocks.filter((b): b is KpiBlock => b.type === 'kpi');
  if (kpiBlocks.length > 0) {
    const head = summary.addRow(['Indicador', 'Valor']);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    for (const block of kpiBlocks) {
      for (const card of block.cards) summary.addRow([card.label, card.value]);
    }
    summary.addRow([]);
  }

  const used = new Set<string>();
  const sheetNames: string[] = [KPI_SHEET_NAME];
  const tables = ctx.content.blocks.filter((b): b is TableBlock => b.type === 'table');
  const indexHead = summary.addRow(['Hoja', 'Filas']);
  indexHead.font = { bold: true };
  tables.forEach((block, index) => {
    const name = sheetNameForTable(index, block.title, used);
    sheetNames.push(name);
    summary.addRow([name, block.rows.length]);
    const sheet = workbook.addWorksheet(name);
    sheet.columns = block.columns.map((c) => ({
      header: c.header || c.key,
      key: c.key,
      width: Math.min(60, Math.max(12, (c.header || c.key).length + 4)),
    }));
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    headerRow.alignment = { vertical: 'middle' };
    block.rows.forEach((row, rowIdx) => {
      const values: Record<string, number | string> = {};
      for (const col of block.columns) values[col.key] = xlsxCellValue(row[col.key], col.format);
      const added = sheet.addRow(values);
      block.columns.forEach((col, i) => {
        const cell = added.getCell(i + 1);
        const numFmt = xlsxNumberFormat(col.format);
        if (numFmt && typeof cell.value === 'number') cell.numFmt = numFmt;
        if (isNumericFormat(col.format)) cell.alignment = { horizontal: 'right' };
        if (rowIdx % 2 === 1) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        }
      });
    });
    // Auto width from rendered strings (never hides digits with ####).
    const { rows } = tableStrings(block);
    block.columns.forEach((col, i) => {
      const widest = rows.reduce(
        (m, r) => Math.max(m, r[i].length),
        (col.header || col.key).length
      );
      const column = sheet.getColumn(i + 1);
      column.width = Math.min(80, Math.max(12, widest + 3));
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    if (block.rows.length > 0) {
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: block.columns.length },
      };
    }
  });
  if (tables.length === 0) summary.addRow(['(sin tablas)', '']);

  await workbook.xlsx.writeFile(ctx.outputPath);
  const stat = await fsp.stat(ctx.outputPath);
  return { sizeBytes: stat.size, sheetNames };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

async function renderCsv(ctx: RenderContext): Promise<ExportRenderResult> {
  const lines: string[] = [
    `\uFEFF# ${ctx.title}`,
    `# Generado: ${formatGeneratedAt(ctx.generatedAt)}`,
  ];
  const kpiCards = ctx.content.blocks.flatMap((b) => (b.type === 'kpi' ? b.cards : []));
  if (kpiCards.length > 0) {
    lines.push('', '## Indicadores', 'Indicador,Valor');
    for (const card of kpiCards) lines.push(`${csvEscape(card.label)},${csvEscape(card.value)}`);
  }
  let index = 0;
  for (const block of ctx.content.blocks) {
    if (block.type !== 'table') continue;
    index++;
    const { header, rows } = tableStrings(block);
    lines.push('', `## ${block.title ?? `Tabla ${index}`}`);
    lines.push(header.map(csvEscape).join(','));
    for (const cells of rows) lines.push(cells.map(csvEscape).join(','));
  }
  if (index === 0 && kpiCards.length === 0)
    lines.push('', '## Documento sin tablas ni indicadores');
  return writeAndStat(ctx.outputPath, lines.join('\r\n') + '\r\n');
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

const PPTX_ROWS_PER_SLIDE = 12;
const PPTX_MAX_TEXT_CHARS = 900;

async function renderPptx(ctx: RenderContext): Promise<ExportRenderResult> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'UNIK Estudio visual';
  pptx.title = ctx.title;

  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: 'FFFFFF' };
  titleSlide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 10,
    h: 0.18,
    fill: { color: '2563EB' },
  });
  titleSlide.addText(ctx.title, {
    x: 0.5,
    y: 1.6,
    w: 9,
    h: 1.6,
    fontSize: 32,
    bold: true,
    color: '0F172A',
    fit: 'shrink',
  });
  titleSlide.addText(`UNIK Estudio visual · ${formatGeneratedAt(ctx.generatedAt)}`, {
    x: 0.5,
    y: 3.3,
    w: 9,
    h: 0.5,
    fontSize: 12,
    color: '64748B',
  });

  type TextPart = { text: string; options?: Record<string, unknown> };
  let current: {
    slide: ReturnType<typeof pptx.addSlide>;
    parts: TextPart[];
    chars: number;
    title: string;
  } | null = null;

  const flushText = () => {
    if (current && current.parts.length > 0) {
      current.slide.addText(current.parts as never, {
        x: 0.5,
        y: 1.1,
        w: 9,
        h: 4.1,
        fontSize: 14,
        color: '334155',
        valign: 'top',
        fit: 'shrink',
        paraSpaceAfter: 6,
      });
      current.parts = [];
      current.chars = 0;
    }
  };
  const newSlide = (title: string) => {
    flushText();
    const slide = pptx.addSlide();
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.12, fill: { color: '2563EB' } });
    slide.addText(title, {
      x: 0.5,
      y: 0.3,
      w: 9,
      h: 0.7,
      fontSize: 22,
      bold: true,
      color: '0F172A',
      fit: 'shrink',
    });
    current = { slide, parts: [], chars: 0, title };
    return slide;
  };
  const appendParts = (parts: TextPart[], chars: number) => {
    if (!current) newSlide('Contenido');
    if (current!.chars > 0 && current!.chars + chars > PPTX_MAX_TEXT_CHARS) {
      const title = current!.title;
      newSlide(`${title} (cont.)`);
    }
    current!.parts.push(...parts);
    current!.chars += chars;
  };

  for (const block of ctx.content.blocks) {
    switch (block.type) {
      case 'heading':
        newSlide(block.text);
        break;
      case 'paragraph':
        appendParts([{ text: block.text, options: { breakLine: true } }], block.text.length);
        break;
      case 'list':
        appendParts(
          block.items.map((item) => ({
            text: item,
            options: { bullet: block.ordered ? { type: 'number' } : true, breakLine: true },
          })),
          block.items.reduce((s, i) => s + i.length + 2, 0)
        );
        break;
      case 'kpi': {
        const slide = newSlide('Indicadores');
        const perRow = Math.min(4, block.cards.length);
        const gap = 0.2;
        const w = (9 - gap * (perRow - 1)) / perRow;
        block.cards.forEach((card, i) => {
          const col = i % perRow;
          const row = Math.floor(i / perRow);
          slide.addText(
            [
              {
                text: card.label.toUpperCase(),
                options: { fontSize: 10, color: '64748B', breakLine: true },
              },
              { text: card.value, options: { fontSize: 22, bold: true, color: '0F172A' } },
            ],
            {
              x: 0.5 + col * (w + gap),
              y: 1.2 + row * 1.35,
              w,
              h: 1.15,
              fill: { color: 'F8FAFC' },
              line: { color: 'E2E8F0', width: 0.75 },
              valign: 'middle',
              fit: 'shrink',
            }
          );
        });
        current = { slide, parts: [], chars: PPTX_MAX_TEXT_CHARS, title: 'Indicadores' };
        break;
      }
      case 'table': {
        const { header, rows } = tableStrings(block);
        const aligns = block.columns.map(
          (c) => c.align ?? (isNumericFormat(c.format) ? 'right' : 'left')
        );
        const chunks: string[][][] = [];
        for (let i = 0; i < Math.max(1, rows.length); i += PPTX_ROWS_PER_SLIDE) {
          chunks.push(rows.slice(i, i + PPTX_ROWS_PER_SLIDE));
        }
        const baseTitle = block.title ?? 'Tabla';
        chunks.forEach((chunk, ci) => {
          const slide = newSlide(
            chunks.length > 1 ? `${baseTitle} (${ci + 1}/${chunks.length})` : baseTitle
          );
          const fontSize = block.columns.length > 8 ? 8 : block.columns.length > 5 ? 9 : 11;
          const tableRows = [
            header.map((h, i) => ({
              text: h,
              options: {
                bold: true,
                color: 'FFFFFF',
                fill: { color: '2563EB' },
                align: aligns[i],
                fontSize,
              },
            })),
            ...chunk.map((cells, r) =>
              cells.map((text, i) => ({
                text,
                options: {
                  align: aligns[i],
                  fontSize,
                  color: '334155',
                  fill: { color: r % 2 === 1 ? 'F8FAFC' : 'FFFFFF' },
                },
              }))
            ),
          ];
          slide.addTable(tableRows as never, {
            x: 0.4,
            y: 1.1,
            w: 9.2,
            border: { type: 'solid', color: 'E2E8F0', pt: 0.5 },
            autoPage: false,
          });
          current = { slide, parts: [], chars: PPTX_MAX_TEXT_CHARS, title: baseTitle };
        });
        break;
      }
      case 'image': {
        const slide = newSlide(block.caption ?? block.alt ?? 'Imagen');
        const image = ctx.images.get(block.id) ?? null;
        if (image) {
          const size = fitImage(readImageSize(image.buffer, image.mimeType), 9 * 96, 4.2 * 96);
          slide.addImage({
            data: toDataUri(image.buffer, image.mimeType),
            x: 0.5 + (9 - size.width / 96) / 2,
            y: 1.1,
            w: size.width / 96,
            h: size.height / 96,
            altText: block.alt,
          });
        } else {
          slide.addText(imagePlaceholder(block), {
            x: 0.5,
            y: 2,
            w: 9,
            h: 1,
            fontSize: 14,
            color: '64748B',
          });
        }
        current = { slide, parts: [], chars: PPTX_MAX_TEXT_CHARS, title: block.alt };
        break;
      }
      case 'pageBreak':
        flushText();
        current = null;
        break;
      case 'divider':
      default:
        break;
    }
  }
  flushText();

  const output = await pptx.write({ outputType: 'nodebuffer' });
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
  return writeAndStat(ctx.outputPath, buffer);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const HTML_STYLE = `
  :root { color-scheme: light; }
  body { margin: 0; background: #f8fafc; color: #334155; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 24px 48px; background: #fff; }
  h1.doc-title { font-size: 28px; color: #0f172a; margin: 0 0 4px; border-bottom: 3px solid ${BRAND}; padding-bottom: 8px; }
  .meta { color: ${ACCENT}; font-size: 12px; margin-bottom: 24px; }
  h1, h2, h3 { color: #0f172a; }
  h2 { font-size: 20px; } h3 { font-size: 16px; }
  p { line-height: 1.55; white-space: pre-wrap; }
  .table-wrap { overflow-x: auto; margin: 12px 0 20px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { background: ${BRAND}; color: #fff; text-align: left; padding: 8px 10px; }
  td { padding: 7px 10px; border-bottom: 1px solid ${BORDER}; vertical-align: top; }
  tr:nth-child(even) td { background: ${ROW_ALT}; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .kpis { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0 20px; }
  .kpi { flex: 1 1 160px; background: ${ROW_ALT}; border: 1px solid ${BORDER}; border-left: 4px solid ${BRAND}; border-radius: 6px; padding: 10px 12px; }
  .kpi .label { font-size: 11px; color: ${ACCENT}; text-transform: uppercase; letter-spacing: .04em; }
  .kpi .value { font-size: 20px; font-weight: 700; color: #0f172a; word-break: break-word; }
  figure { margin: 16px 0; } figure img { max-width: 100%; height: auto; border-radius: 6px; }
  figcaption { color: ${ACCENT}; font-size: 12px; margin-top: 6px; }
  hr { border: 0; border-top: 1px solid ${BORDER}; margin: 20px 0; }
  .page-break { page-break-after: always; break-after: page; }
  .placeholder { color: ${ACCENT}; font-style: italic; }
  footer { color: ${ACCENT}; font-size: 11px; margin-top: 32px; text-align: center; }
`;

function htmlBlocks(ctx: RenderContext): string {
  const out: string[] = [];
  for (const block of ctx.content.blocks) {
    switch (block.type) {
      case 'heading':
        out.push(`<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`);
        break;
      case 'paragraph':
        out.push(`<p>${escapeHtml(block.text)}</p>`);
        break;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        out.push(
          `<${tag}>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</${tag}>`
        );
        break;
      }
      case 'kpi':
        out.push(
          `<div class="kpis">${block.cards
            .map(
              (c) =>
                `<div class="kpi"><div class="label">${escapeHtml(c.label)}</div><div class="value">${escapeHtml(c.value)}</div></div>`
            )
            .join('')}</div>`
        );
        break;
      case 'table': {
        const { header, rows } = tableStrings(block);
        const numeric = block.columns.map((c) => isNumericFormat(c.format));
        const cls = (i: number) => (numeric[i] ? ' class="num"' : '');
        out.push(
          `${block.title ? `<h3>${escapeHtml(block.title)}</h3>` : ''}<div class="table-wrap"><table><thead><tr>${header
            .map((h, i) => `<th${cls(i)}>${escapeHtml(h)}</th>`)
            .join('')}</tr></thead><tbody>${rows
            .map(
              (cells) =>
                `<tr>${cells.map((t, i) => `<td${cls(i)}>${escapeHtml(t)}</td>`).join('')}</tr>`
            )
            .join('')}</tbody></table></div>`
        );
        break;
      }
      case 'image': {
        const image = ctx.images.get(block.id) ?? null;
        const body = image
          ? `<img src="${toDataUri(image.buffer, image.mimeType)}" alt="${escapeHtml(block.alt)}">`
          : `<span class="placeholder">${escapeHtml(imagePlaceholder(block))}</span>`;
        out.push(
          `<figure>${body}${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ''}</figure>`
        );
        break;
      }
      case 'pageBreak':
        out.push('<div class="page-break"></div>');
        break;
      case 'divider':
        out.push('<hr>');
        break;
      default:
        break;
    }
  }
  return out.join('\n');
}

async function renderHtml(ctx: RenderContext): Promise<ExportRenderResult> {
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(ctx.title)}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<main>
<h1 class="doc-title">${escapeHtml(ctx.title)}</h1>
<div class="meta">Generado por UNIK Estudio visual · ${escapeHtml(formatGeneratedAt(ctx.generatedAt))}</div>
${htmlBlocks(ctx)}
<footer>UNIK</footer>
</main>
</body>
</html>
`;
  return writeAndStat(ctx.outputPath, html);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function mdCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

async function renderMarkdown(ctx: RenderContext): Promise<ExportRenderResult> {
  const out: string[] = [
    `# ${ctx.title}`,
    '',
    `_Generado por UNIK Estudio visual · ${formatGeneratedAt(ctx.generatedAt)}_`,
    '',
  ];
  for (const block of ctx.content.blocks) {
    switch (block.type) {
      case 'heading':
        out.push(`${'#'.repeat(Math.min(6, block.level + 1))} ${block.text}`, '');
        break;
      case 'paragraph':
        out.push(block.text, '');
        break;
      case 'list':
        block.items.forEach((item, i) => out.push(`${block.ordered ? `${i + 1}.` : '-'} ${item}`));
        out.push('');
        break;
      case 'kpi':
        out.push('| Indicador | Valor |', '| --- | --- |');
        block.cards.forEach((c) => out.push(`| ${mdCell(c.label)} | ${mdCell(c.value)} |`));
        out.push('');
        break;
      case 'table': {
        const { header, rows } = tableStrings(block);
        if (block.title) out.push(`**${block.title}**`, '');
        out.push(`| ${header.map(mdCell).join(' | ')} |`);
        out.push(
          `| ${block.columns.map((c) => (isNumericFormat(c.format) ? '---:' : '---')).join(' | ')} |`
        );
        rows.forEach((cells) => out.push(`| ${cells.map(mdCell).join(' | ')} |`));
        out.push('');
        break;
      }
      case 'image': {
        const image = ctx.images.get(block.id) ?? null;
        out.push(
          image
            ? `![${block.alt}](${toDataUri(image.buffer, image.mimeType)})`
            : `*${imagePlaceholder(block)}*`
        );
        if (block.caption) out.push('', `_${block.caption}_`);
        out.push('');
        break;
      }
      case 'pageBreak':
        out.push('<div style="page-break-after: always"></div>', '');
        break;
      case 'divider':
        out.push('---', '');
        break;
      default:
        break;
    }
  }
  return writeAndStat(ctx.outputPath, out.join('\n'));
}

// ---------------------------------------------------------------------------
// SVG (document snapshot image)
// ---------------------------------------------------------------------------

const SVG_MARGIN = 28;
const SVG_MIN_CONTENT = 860;

/** Proportional-font width estimate (same approach as the assistant's image report generator). */
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

function wrapText(text: string, maxWidth: number, fontSize: number, bold = false): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (estimateTextWidth(candidate, fontSize, bold) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (estimateTextWidth(word, fontSize, bold) <= maxWidth) {
        line = word;
        continue;
      }
      // Hard-break a word wider than the line (never drop characters).
      let chunk = '';
      for (const ch of word) {
        if (estimateTextWidth(chunk + ch, fontSize, bold) <= maxWidth) chunk += ch;
        else {
          lines.push(chunk);
          chunk = ch;
        }
      }
      line = chunk;
    }
    lines.push(line);
  }
  return lines;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => XML_ESCAPES[ch]);
}

async function renderSvg(ctx: RenderContext): Promise<ExportRenderResult> {
  const brand = sanitizeSvgColor(BRAND, BRAND);
  const fontSize = 12;
  const lineHeight = fontSize * 1.45;
  const cellPad = 8;

  // First pass: natural table widths decide the canvas width (never truncate a cell).
  const tableWidths = new Map<string, number[]>();
  let contentWidth = SVG_MIN_CONTENT;
  for (const block of ctx.content.blocks) {
    if (block.type !== 'table') continue;
    const { header, rows } = tableStrings(block);
    const widths = block.columns.map((_, i) => {
      let w = estimateTextWidth(header[i], 10, true);
      for (const r of rows) w = Math.max(w, estimateTextWidth(r[i], fontSize));
      return Math.max(48, w + cellPad * 2);
    });
    const total = widths.reduce((a, b) => a + b, 0);
    if (total < contentWidth) {
      // Stretch to fill the line proportionally.
      const scale = contentWidth / total;
      tableWidths.set(
        block.id,
        widths.map((w) => w * scale)
      );
    } else {
      tableWidths.set(block.id, widths);
      contentWidth = Math.max(contentWidth, total);
    }
  }
  const width = contentWidth + SVG_MARGIN * 2;
  const body: string[] = [];
  let y = SVG_MARGIN;

  const text = (
    x: number,
    baseline: number,
    value: string,
    opts: {
      size?: number;
      bold?: boolean;
      color?: string;
      anchor?: 'start' | 'middle' | 'end';
      italic?: boolean;
    } = {}
  ) => {
    body.push(
      `<text x="${x.toFixed(1)}" y="${baseline.toFixed(1)}" font-size="${opts.size ?? fontSize}"${
        opts.bold ? ' font-weight="bold"' : ''
      }${opts.italic ? ' font-style="italic"' : ''}${opts.anchor ? ` text-anchor="${opts.anchor}"` : ''} fill="${
        opts.color ?? TEXT_BODY
      }">${escapeXml(value)}</text>`
    );
  };
  const paragraphLines = (
    value: string,
    size: number,
    bold: boolean,
    color: string,
    x = SVG_MARGIN,
    maxWidth = contentWidth
  ) => {
    const lines = wrapText(value, maxWidth, size, bold);
    const lh = size * 1.45;
    for (const line of lines) {
      y += lh;
      text(x, y - size * 0.3, line, { size, bold, color });
    }
  };

  // Header
  const titleLines = wrapText(ctx.title, contentWidth - 90, 20, true);
  const badgeW = estimateTextWidth('UNIK', 12, true) + 16;
  body.push(
    `<rect x="${SVG_MARGIN}" y="${y}" width="${badgeW}" height="24" rx="6" fill="${brand}"/>`
  );
  text(SVG_MARGIN + badgeW / 2, y + 16.5, 'UNIK', {
    size: 12,
    bold: true,
    color: '#ffffff',
    anchor: 'middle',
  });
  let ty = y;
  for (const line of titleLines) {
    ty += 24;
    text(SVG_MARGIN + badgeW + 12, ty - 6, line, { size: 20, bold: true, color: TEXT_DARK });
  }
  y = Math.max(y + 24, ty) + 8;
  text(
    SVG_MARGIN,
    y + 6,
    `Generado por UNIK Estudio visual · ${formatGeneratedAt(ctx.generatedAt)}`,
    {
      size: 9,
      color: ACCENT,
    }
  );
  y += 14;
  body.push(
    `<rect x="${SVG_MARGIN}" y="${y}" width="${contentWidth}" height="2.5" fill="${brand}" rx="1"/>`
  );
  y += 18;

  for (const block of ctx.content.blocks) {
    switch (block.type) {
      case 'heading': {
        const size = block.level === 1 ? 18 : block.level === 2 ? 15 : 13;
        y += 6;
        paragraphLines(block.text, size, true, TEXT_DARK);
        y += 4;
        break;
      }
      case 'paragraph':
        paragraphLines(block.text, fontSize, false, TEXT_BODY);
        y += 8;
        break;
      case 'list':
        block.items.forEach((item, i) => {
          const prefix = listItemPrefix(block, i);
          const startY = y;
          paragraphLines(item, fontSize, false, TEXT_BODY, SVG_MARGIN + 26, contentWidth - 26);
          text(SVG_MARGIN + 6, startY + lineHeight - fontSize * 0.3, prefix.trim(), {
            color: ACCENT,
          });
        });
        y += 8;
        break;
      case 'kpi': {
        const perRow = Math.min(4, block.cards.length);
        const gap = 10;
        const cardW = (contentWidth - gap * (perRow - 1)) / perRow;
        for (let start = 0; start < block.cards.length; start += perRow) {
          const rowCards = block.cards.slice(start, start + perRow);
          const valueLines = rowCards.map((c) => wrapText(c.value, cardW - 20, 16, true));
          const labelLines = rowCards.map((c) =>
            wrapText(c.label.toUpperCase(), cardW - 20, 8, false)
          );
          const cardH =
            Math.max(...valueLines.map((v, i) => v.length * 20 + labelLines[i].length * 11)) + 22;
          rowCards.forEach((_card, i) => {
            const x = SVG_MARGIN + i * (cardW + gap);
            body.push(
              `<rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="6" fill="${ROW_ALT}" stroke="${BORDER}"/>`
            );
            body.push(
              `<rect x="${x}" y="${y}" width="${cardW}" height="3" fill="${brand}" rx="1.5"/>`
            );
            let cy = y + 8;
            for (const line of labelLines[i]) {
              cy += 11;
              text(x + 10, cy, line, { size: 8, color: ACCENT });
            }
            for (const line of valueLines[i]) {
              cy += 20;
              text(x + 10, cy, line, { size: 16, bold: true, color: TEXT_DARK });
            }
          });
          y += cardH + 12;
        }
        break;
      }
      case 'table': {
        const { header, rows } = tableStrings(block);
        const widths = tableWidths.get(block.id) ?? [];
        const aligns = block.columns.map(
          (c) => c.align ?? (isNumericFormat(c.format) ? 'right' : 'left')
        );
        const tableW = widths.reduce((a, b) => a + b, 0);
        if (block.title) {
          y += 4;
          paragraphLines(block.title, 13, true, TEXT_DARK);
          y += 2;
        }
        const headerH = 30;
        body.push(
          `<rect x="${SVG_MARGIN}" y="${y}" width="${tableW}" height="${headerH}" fill="${brand}" rx="4"/>`
        );
        let x = SVG_MARGIN;
        header.forEach((h, i) => {
          const anchor =
            aligns[i] === 'right' ? 'end' : aligns[i] === 'center' ? 'middle' : 'start';
          const tx =
            aligns[i] === 'right'
              ? x + widths[i] - cellPad
              : aligns[i] === 'center'
                ? x + widths[i] / 2
                : x + cellPad;
          text(tx, y + headerH / 2 + 3.5, h, { size: 10, bold: true, color: '#ffffff', anchor });
          x += widths[i];
        });
        y += headerH;
        const tableTop = y - headerH;
        rows.forEach((cells, rowIdx) => {
          const wrapped = cells.map((c, i) => wrapText(c, widths[i] - cellPad * 2, fontSize));
          const rowH = Math.max(...wrapped.map((w) => w.length), 1) * lineHeight + 8;
          if (rowIdx % 2 === 1)
            body.push(
              `<rect x="${SVG_MARGIN}" y="${y}" width="${tableW}" height="${rowH}" fill="#f1f5f9"/>`
            );
          let cx = SVG_MARGIN;
          wrapped.forEach((lines, i) => {
            const anchor =
              aligns[i] === 'right' ? 'end' : aligns[i] === 'center' ? 'middle' : 'start';
            const tx =
              aligns[i] === 'right'
                ? cx + widths[i] - cellPad
                : aligns[i] === 'center'
                  ? cx + widths[i] / 2
                  : cx + cellPad;
            lines.forEach((line, li) =>
              text(tx, y + 4 + (li + 1) * lineHeight - fontSize * 0.3, line, { anchor })
            );
            cx += widths[i];
          });
          y += rowH;
          body.push(
            `<line x1="${SVG_MARGIN}" y1="${y}" x2="${SVG_MARGIN + tableW}" y2="${y}" stroke="${BORDER}" stroke-width="1"/>`
          );
        });
        body.push(
          `<rect x="${SVG_MARGIN}" y="${tableTop}" width="${tableW}" height="${y - tableTop}" fill="none" stroke="${BORDER}" rx="4"/>`
        );
        y += 16;
        break;
      }
      case 'image': {
        const image = ctx.images.get(block.id) ?? null;
        if (image) {
          const size = fitImage(readImageSize(image.buffer, image.mimeType), contentWidth, 420);
          body.push(
            `<image x="${SVG_MARGIN}" y="${y}" width="${size.width}" height="${size.height}" href="${toDataUri(image.buffer, image.mimeType)}" preserveAspectRatio="xMidYMid meet"/>`
          );
          y += size.height + 6;
        } else {
          paragraphLines(imagePlaceholder(block), 11, false, ACCENT);
        }
        if (block.caption) {
          y += 4;
          text(SVG_MARGIN, y + 8, block.caption, { size: 10, color: ACCENT, italic: true });
          y += 14;
        }
        y += 8;
        break;
      }
      case 'divider':
        y += 6;
        body.push(
          `<line x1="${SVG_MARGIN}" y1="${y}" x2="${SVG_MARGIN + contentWidth}" y2="${y}" stroke="${BORDER}" stroke-width="1"/>`
        );
        y += 12;
        break;
      case 'pageBreak':
        y += 10;
        body.push(
          `<line x1="${SVG_MARGIN}" y1="${y}" x2="${SVG_MARGIN + contentWidth}" y2="${y}" stroke="${BORDER}" stroke-width="1" stroke-dasharray="6 4"/>`
        );
        y += 14;
        break;
      default:
        break;
    }
  }

  y += 10;
  text(width / 2, y + 8, 'Generado por UNIK Estudio visual', {
    size: 8,
    color: ACCENT,
    anchor: 'middle',
  });
  const height = y + SVG_MARGIN;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" font-family="Helvetica, Arial, sans-serif">` +
    `<title>${escapeXml(ctx.title)}</title>` +
    `<rect width="${Math.ceil(width)}" height="${Math.ceil(height)}" fill="#ffffff" rx="10"/>` +
    body.join('') +
    `</svg>`;
  return writeAndStat(ctx.outputPath, svg);
}

/** Type re-export for consumers that only need the block union. */
export type { StudioBlock };
