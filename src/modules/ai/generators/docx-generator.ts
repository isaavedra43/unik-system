import fs from 'fs/promises';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

/**
 * Word (.docx) report generator — same content model as the PDF generator
 * (title, subtitle, KPI cards, one or more table sections) so the assistant can
 * offer "en Word" for anything it already offers "en PDF".
 */

export interface DocxColumn {
  header: string;
  key: string;
  format?: 'currency' | 'number' | 'percentage' | 'date' | 'text';
}

export interface DocxSection {
  title?: string;
  columns: DocxColumn[];
  rows: Record<string, unknown>[];
}

export interface DocxReportOptions {
  title: string;
  subtitle?: string;
  author?: string;
  brandColor?: string;
  summaryCards?: Array<{ label: string; value: string }>;
  sections: DocxSection[];
  notes?: string;
}

function formatValue(value: unknown, format?: DocxColumn['format']): string {
  if (value === null || value === undefined) return '—';
  if (format === 'currency') {
    const n = Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(value);
  }
  if (format === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('es-MX') : String(value);
  }
  if (format === 'percentage') return `${value}%`;
  if (value instanceof Date) return value.toLocaleDateString('es-MX');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function hex(color: string | undefined, fallback: string): string {
  const c = (color ?? '').replace('#', '').trim();
  return /^[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : fallback;
}

const THIN = { style: BorderStyle.SINGLE, size: 4, color: 'D9DEE5' } as const;
const CELL_BORDERS = { top: THIN, bottom: THIN, left: THIN, right: THIN };

function cell(text: string, opts: { bold?: boolean; fill?: string; color?: string; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}): TableCell {
  return new TableCell({
    borders: CELL_BORDERS,
    shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill, color: 'auto' } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        alignment: opts.align ?? AlignmentType.LEFT,
        children: [new TextRun({ text, bold: opts.bold, color: opts.color, size: 18, font: 'Calibri' })],
      }),
    ],
  });
}

function buildTable(section: DocxSection, brand: string): Table {
  const header = new TableRow({
    tableHeader: true,
    children: section.columns.map((c) => cell(c.header, { bold: true, fill: brand, color: 'FFFFFF' })),
  });
  const body = section.rows.map(
    (row, i) =>
      new TableRow({
        children: section.columns.map((c) =>
          cell(formatValue(row[c.key], c.format), {
            fill: i % 2 === 1 ? 'F5F7FA' : undefined,
            align: c.format === 'currency' || c.format === 'number' || c.format === 'percentage' ? AlignmentType.RIGHT : AlignmentType.LEFT,
          })
        ),
      })
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...body] });
}

export async function generateDocxReport(
  options: DocxReportOptions,
  outputPath: string
): Promise<{ sizeBytes: number; rowCount: number; sectionCount: number }> {
  const brand = hex(options.brandColor, '1E3A5F');
  const children: Array<Paragraph | Table> = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: options.title, bold: true, color: brand, font: 'Calibri' })],
    })
  );
  if (options.subtitle) {
    children.push(new Paragraph({ children: [new TextRun({ text: options.subtitle, color: '6B7280', size: 20, font: 'Calibri' })] }));
  }
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Generado por UNIK · ${new Date().toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' })}${options.author ? ` · ${options.author}` : ''}`,
          color: '9CA3AF',
          size: 16,
          font: 'Calibri',
        }),
      ],
      spacing: { after: 200 },
    })
  );

  if (options.summaryCards && options.summaryCards.length > 0) {
    const cards = options.summaryCards.slice(0, 6);
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: cards.map((c) => cell(c.label.toUpperCase(), { fill: 'EEF2F7', color: '6B7280' })) }),
          new TableRow({ children: cards.map((c) => cell(c.value, { bold: true, fill: 'EEF2F7', color: brand })) }),
        ],
      }),
      new Paragraph({ spacing: { after: 200 } })
    );
  }

  let rowCount = 0;
  for (const section of options.sections) {
    if (section.title) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 },
          children: [new TextRun({ text: section.title, bold: true, color: brand, font: 'Calibri' })],
        })
      );
    }
    if (section.rows.length === 0) {
      children.push(new Paragraph({ children: [new TextRun({ text: 'Sin datos.', italics: true, color: '9CA3AF', font: 'Calibri' })] }));
      continue;
    }
    children.push(buildTable(section, brand), new Paragraph({ spacing: { after: 160 } }));
    rowCount += section.rows.length;
  }

  if (options.notes) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: 'Notas', color: brand, font: 'Calibri' })] }),
      new Paragraph({ children: [new TextRun({ text: options.notes, size: 20, font: 'Calibri' })] })
    );
  }

  const doc = new Document({
    creator: options.author ?? 'UNIK',
    title: options.title,
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
    sections: [{ properties: {}, children }],
  });
  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(outputPath, buffer);
  return { sizeBytes: buffer.length, rowCount, sectionCount: options.sections.length };
}
