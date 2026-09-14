import fs from 'fs/promises';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { sanitizeSvgColor, TONE_HEX, TONE_TINT_HEX } from './status-tone';
import { formatDocValue, summarizeSpec, type ComposedDocumentSpec, type DocBlock, type DocColumn, type DocImage, type DocKpi, type GeneratedDocumentInfo } from './document-spec';

/**
 * Word (.docx) rendering of a composed document — the same content model as
 * the PDF composer so the assistant can deliver "el mismo reporte en Word"
 * (editable) without a second authoring pass.
 */

type DocChild = Paragraph | Table;

const FONT = 'Calibri';
const BODY = 20; // half-points → 10pt
const MUTED = '64748B';
const DARK = '0F172A';
const TEXT = '334155';
const RULE = 'D9DEE5';

function hex(color: string | undefined, fallback: string): string {
  return sanitizeSvgColor(color, fallback).replace('#', '').toUpperCase();
}

interface Border {
  style: (typeof BorderStyle)[keyof typeof BorderStyle];
  size: number;
  color: string;
}
interface Borders {
  top: Border;
  bottom: Border;
  left: Border;
  right: Border;
}
const THIN: Border = { style: BorderStyle.SINGLE, size: 4, color: RULE };
const CELL_BORDERS: Borders = { top: THIN, bottom: THIN, left: THIN, right: THIN };
const NO_BORDER: Border = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS: Borders = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };

function run(text: string, opts: { bold?: boolean; italics?: boolean; color?: string; size?: number } = {}): TextRun {
  return new TextRun({ text, bold: opts.bold, italics: opts.italics, color: opts.color ?? TEXT, size: opts.size ?? BODY, font: FONT });
}

function para(text: string, opts: { bold?: boolean; italics?: boolean; color?: string; size?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; after?: number; before?: number } = {}): Paragraph {
  return new Paragraph({ alignment: opts.align, spacing: { after: opts.after ?? 120, before: opts.before ?? 0 }, children: [run(text, opts)] });
}

function cell(children: Paragraph[], opts: { fill?: string; borders?: Borders; width?: number } = {}): TableCell {
  return new TableCell({
    borders: opts.borders ?? CELL_BORDERS,
    shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill, color: 'auto' } : undefined,
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    children,
  });
}

function kpiTable(items: DocKpi[], brand: string): Table[] {
  const tables: Table[] = [];
  for (let start = 0; start < items.length; start += 4) {
    const chunk = items.slice(start, start + 4);
    tables.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: chunk.map((k) =>
              cell(
                [
                  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [run(k.value, { bold: true, size: 36, color: k.tone ? TONE_HEX[k.tone].replace('#', '').toUpperCase() : brand })] }),
                  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: k.note ? 20 : 0 }, children: [run(k.label.toUpperCase(), { bold: true, size: 15, color: MUTED })] }),
                  ...(k.note ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [run(k.note, { size: 15, color: MUTED })] })] : []),
                ],
                { fill: 'F5F7FA', width: 100 / chunk.length }
              )
            ),
          }),
        ],
      })
    );
  }
  return tables;
}

function dataTable(block: Extract<DocBlock, { type: 'table' }>, brand: string): Table {
  const columns: DocColumn[] = block.columns.length > 0 ? block.columns : Object.keys(block.rows[0] ?? {}).map((key) => ({ header: key, key }));
  const alignFor = (c: DocColumn) =>
    c.align === 'right' || (!c.align && (c.format === 'currency' || c.format === 'number' || c.format === 'percentage'))
      ? AlignmentType.RIGHT
      : c.align === 'center'
        ? AlignmentType.CENTER
        : AlignmentType.LEFT;
  const header = new TableRow({
    tableHeader: true,
    children: columns.map((c) => cell([new Paragraph({ alignment: alignFor(c), spacing: { after: 0 }, children: [run(c.header.toUpperCase(), { bold: true, color: 'FFFFFF', size: 16 })] })], { fill: brand })),
  });
  const body = block.rows.map(
    (row, i) =>
      new TableRow({
        children: columns.map((c) =>
          cell([new Paragraph({ alignment: alignFor(c), spacing: { after: 0 }, children: [run(formatDocValue(row[c.key], c.format), { size: 17 })] })], {
            fill: i % 2 === 1 ? 'F8FAFC' : undefined,
          })
        ),
      })
  );
  const totals = block.totalsRow
    ? [
        new TableRow({
          children: columns.map((c) => {
            const raw = block.totalsRow?.[c.key];
            const text = raw === null || raw === undefined ? '' : typeof raw === 'string' ? raw : formatDocValue(raw, c.format);
            return cell([new Paragraph({ alignment: alignFor(c), spacing: { after: 0 }, children: [run(text, { bold: true, size: 17, color: DARK })] })], { fill: 'E2E8F0' });
          }),
        }),
      ]
    : [];
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...body, ...totals] });
}

function imageParagraphs(image: DocImage, caption: string | undefined, maxHeightPx: number): Paragraph[] {
  // Word page (A4, 2.54 cm margins) content width ≈ 620 px at 96 dpi.
  const maxW = 620;
  const scale = Math.min(maxW / image.width, maxHeightPx / image.height, 1);
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const out: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new ImageRun({ type: image.mimeType === 'image/png' ? 'png' : 'jpg', data: image.data, transformation: { width: w, height: h } })],
    }),
  ];
  if (caption) out.push(para(caption, { italics: true, color: MUTED, size: 16, align: AlignmentType.CENTER, after: 200 }));
  return out;
}

function barsTable(block: Extract<DocBlock, { type: 'bars' }>, brand: string): Table {
  const items = block.items.filter((i) => Number.isFinite(i.value));
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0) || 1;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: items.map((item) => {
      const pct = Math.max(2, Math.round((Math.abs(item.value) / max) * 100));
      const label = `${item.value.toLocaleString('es-MX')}${block.valueSuffix ?? ''}${block.showPercent === false ? '' : ` (${((Math.max(0, item.value) / total) * 100).toFixed(1)}%)`}`;
      return new TableRow({
        children: [
          cell([para(item.label, { size: 17, after: 0 })], { borders: NO_BORDERS, width: 32 }),
          new TableCell({
            borders: NO_BORDERS,
            width: { size: 48, type: WidthType.PERCENTAGE },
            margins: { top: 40, bottom: 40, left: 60, right: 60 },
            children: [
              new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                rows: [
                  new TableRow({
                    children: [
                      new TableCell({ borders: NO_BORDERS, width: { size: pct, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.CLEAR, fill: hex(item.color, `#${brand}`), color: 'auto' }, children: [new Paragraph({ spacing: { after: 0 }, children: [run(' ', { size: 12 })] })] }),
                      new TableCell({ borders: NO_BORDERS, width: { size: 100 - pct, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.CLEAR, fill: 'F1F5F9', color: 'auto' }, children: [new Paragraph({ spacing: { after: 0 }, children: [run(' ', { size: 12 })] })] }),
                    ],
                  }),
                ],
              }),
            ],
          }),
          cell([para(label, { bold: true, size: 17, after: 0, align: AlignmentType.RIGHT, color: DARK })], { borders: NO_BORDERS, width: 20 }),
        ],
      });
    }),
  });
}

function blockToChildren(block: DocBlock, brand: string): DocChild[] {
  switch (block.type) {
    case 'heading': {
      const level = block.level ?? 1;
      return [
        new Paragraph({
          heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          spacing: { before: level === 1 ? 320 : 220, after: 120 },
          children: [run(block.text, { bold: true, color: level === 3 ? MUTED : level === 1 ? brand : DARK, size: level === 1 ? 30 : level === 2 ? 25 : 21 })],
        }),
      ];
    }
    case 'paragraph':
      return [
        para(block.text, {
          size: block.style === 'lead' ? 22 : block.style === 'note' ? 17 : BODY,
          italics: block.style === 'note',
          color: block.style === 'muted' || block.style === 'note' ? MUTED : TEXT,
          after: 140,
        }),
      ];
    case 'bullets': {
      const out: DocChild[] = [];
      if (block.title) out.push(...blockToChildren({ type: 'heading', text: block.title, level: 3 }, brand));
      block.items.forEach((item, i) => {
        out.push(
          new Paragraph({
            spacing: { after: 60 },
            indent: { left: 360, hanging: 260 },
            children: [run(block.ordered ? `${i + 1}.  ` : '•  ', { bold: true, color: brand }), run(item)],
          })
        );
      });
      out.push(new Paragraph({ spacing: { after: 80 } }));
      return out;
    }
    case 'callout': {
      const tone = block.tone ?? 'info';
      const fill = TONE_TINT_HEX[tone].replace('#', '').toUpperCase();
      const color = TONE_HEX[tone].replace('#', '').toUpperCase();
      const children: Paragraph[] = [];
      if (block.title) children.push(para(block.title, { bold: true, color, after: 60 }));
      children.push(para(block.text, { color: DARK, after: 0 }));
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ children: [cell(children, { fill, borders: { ...NO_BORDERS, left: { style: BorderStyle.SINGLE, size: 24, color } } })] })],
        }),
        new Paragraph({ spacing: { after: 120 } }),
      ];
    }
    case 'kpis':
      return [...kpiTable(block.items, brand), new Paragraph({ spacing: { after: 120 } })];
    case 'keyValue': {
      const out: DocChild[] = [];
      if (block.title) out.push(...blockToChildren({ type: 'heading', text: block.title, level: 3 }, brand));
      out.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: block.items.map(
            (item) =>
              new TableRow({
                children: [
                  cell([para(item.label, { bold: true, color: MUTED, after: 0 })], { width: 35, borders: { ...NO_BORDERS, bottom: THIN } }),
                  cell([para(item.value, { after: 0 })], { width: 65, borders: { ...NO_BORDERS, bottom: THIN } }),
                ],
              })
          ),
        }),
        new Paragraph({ spacing: { after: 120 } })
      );
      return out;
    }
    case 'table': {
      const out: DocChild[] = [];
      if (block.title) out.push(...blockToChildren({ type: 'heading', text: block.title, level: 2 }, brand));
      if (block.caption) out.push(para(block.caption, { color: MUTED, size: 18, after: 80 }));
      if (block.rows.length === 0) out.push(para('(Sin filas)', { italics: true, color: MUTED }));
      else out.push(dataTable(block, brand));
      if (block.footnote) out.push(para(block.footnote, { italics: true, color: MUTED, size: 16, before: 60 }));
      out.push(new Paragraph({ spacing: { after: 120 } }));
      return out;
    }
    case 'bars': {
      const out: DocChild[] = [];
      if (block.title) out.push(...blockToChildren({ type: 'heading', text: block.title, level: 3 }, brand));
      out.push(barsTable(block, brand), new Paragraph({ spacing: { after: 120 } }));
      return out;
    }
    case 'image':
      return imageParagraphs(block.image, block.caption, block.maxHeight ? Math.round(block.maxHeight * 1.33) : 560);
    case 'divider':
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } }, spacing: { after: 160 } })];
    case 'pageBreak':
      return [new Paragraph({ children: [new PageBreak()] })];
    default:
      return [];
  }
}

export async function generateComposedDocx(outputPath: string, spec: ComposedDocumentSpec): Promise<GeneratedDocumentInfo> {
  const brand = hex(spec.brandColor, '#2563EB');
  const children: DocChild[] = [];
  const generatedAt = new Date().toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Mexico_City' });

  if (spec.cover) {
    children.push(
      para(spec.logoText ?? 'UNIK', { bold: true, color: brand, size: 44, align: AlignmentType.CENTER, before: 1200, after: 300 }),
      para(spec.title, { bold: true, color: DARK, size: 40, align: AlignmentType.CENTER, after: 160 })
    );
    if (spec.subtitle) children.push(para(spec.subtitle, { color: MUTED, size: 24, align: AlignmentType.CENTER, after: 160 }));
    children.push(para(spec.cover.metaLine ?? generatedAt, { bold: true, color: DARK, size: 19, align: AlignmentType.CENTER, after: 360 }));
    if (spec.cover.kpis && spec.cover.kpis.length > 0) children.push(...kpiTable(spec.cover.kpis, brand), new Paragraph({ spacing: { after: 200 } }));
    if (spec.cover.note) children.push(para(spec.cover.note, { italics: true, color: MUTED, size: 16, align: AlignmentType.CENTER }));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  } else {
    children.push(para(spec.title, { bold: true, color: DARK, size: 36, after: 80 }));
    if (spec.subtitle) children.push(para(spec.subtitle, { color: MUTED, size: 22, after: 200 }));
  }

  for (const block of spec.blocks) children.push(...blockToChildren(block, brand));

  if (spec.appendix && spec.appendix.images.length > 0) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(...blockToChildren({ type: 'heading', text: spec.appendix.title ?? 'Anexo: documentos originales', level: 1 }, brand));
    if (spec.appendix.intro) children.push(para(spec.appendix.intro, { color: MUTED }));
    spec.appendix.images.forEach((img, i) => {
      if (i > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(...imageParagraphs(img, img.caption ?? `Anexo ${i + 1}`, 760));
    });
  }

  const doc = new Document({
    creator: spec.author ?? 'UNIK Asistente IA',
    title: spec.title,
    styles: { default: { document: { run: { font: FONT, size: BODY } } } },
    sections: [
      {
        properties: { page: { size: spec.orientation === 'landscape' ? { orientation: 'landscape' } : undefined } },
        headers: spec.headerLabel
          ? { default: new Header({ children: [para(spec.headerLabel, { bold: true, color: brand, size: 15, align: AlignmentType.RIGHT, after: 0 })] }) }
          : undefined,
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 0 },
                children: [
                  run(`${spec.footerLabel ?? `Generado por ${spec.author ?? 'UNIK Asistente IA'} · ${generatedAt}`}   ·   Página `, { size: 14, color: MUTED }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 14, color: MUTED, font: FONT }),
                  run(' de ', { size: 14, color: MUTED }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 14, color: MUTED, font: FONT }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(outputPath, buffer);
  // Word paginates on open; the page count is an estimate for the tool result only.
  const counts = summarizeSpec(spec);
  const estimatedPages = Math.max(1, (spec.cover ? 1 : 0) + Math.ceil((spec.blocks.length * 0.35 + counts.rowCount / 28)) + (spec.appendix?.images.length ?? 0));
  return { sizeBytes: buffer.length, pageCount: estimatedPages, ...counts };
}
