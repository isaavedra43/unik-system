import PDFDocument from 'pdfkit';
import fs from 'fs';
import { sanitizeSvgColor, toneForStatusLabel, TONE_HEX, TONE_TINT_HEX, type StatusTone } from './status-tone';
import { cellText, resolveColumns, type PdfTableColumn } from './pdf-generator';
import {
  formatDocValue,
  summarizeSpec,
  type ComposedDocumentSpec,
  type DocBlock,
  type DocImage,
  type DocKpi,
  type DocTone,
  type GeneratedDocumentInfo,
} from './document-spec';

/**
 * Composed-document PDF generator (pdfkit).
 *
 * A flow layout on top of the same primitives the tabular report generator
 * uses (measured text, normalized table columns, status pills), plus the
 * pieces an elaborate business document needs: a cover page with big
 * numbers, running header/footer with "Página X de N", headings, paragraphs,
 * bullet lists, tinted callouts, KPI cards, key/value blocks, horizontal
 * bar charts and embedded photos (appendix with the original attachments).
 *
 * Pagination rules:
 * - text blocks are measured first; a block that does not fit moves to the
 *   next page unless it is taller than a page (then pdfkit flows it);
 * - table rows never split; the header row repeats on every page;
 * - headings keep together with what follows them;
 * - the running header lives in the top margin and the footer in the bottom
 *   margin, so pdfkit's own page breaks never overlap them.
 */

const PAGE_MARGIN = 48;
const HEADER_BAND = 26; // running header height inside the top margin
const FOOTER_BAND = 30;
const TOP_MARGIN = PAGE_MARGIN + HEADER_BAND;
const BOTTOM_MARGIN = PAGE_MARGIN + FOOTER_BAND;

const TEXT_DARK = '#0f172a';
const TEXT_BODY = '#334155';
const TEXT_MUTED = '#64748b';
const RULE = '#e2e8f0';
const CARD_FILL = '#f8fafc';
const TOTALS_FILL = '#e2e8f0';

const BODY_SIZE = 9.5;
const LINE_GAP = 2.5;
const TABLE_FONT = 8;
const CELL_PAD_X = 6;
const CELL_PAD_Y = 4;
const HEADER_ROW_H = 22;
const MIN_ROW_H = 18;
const DETAIL_FONT = 7.5;
const DETAIL_LABEL_W = 80;

const DEFAULT_BRAND = '#2563eb';
const DEFAULT_ACCENT = '#64748b';

const TONE_FALLBACK: Record<DocTone, StatusTone> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  muted: 'muted',
};

interface Layout {
  doc: PDFKit.PDFDocument;
  brand: string;
  accent: string;
  y: number;
  pageIndex: number;
  coverPages: Set<number>;
}

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - PAGE_MARGIN * 2;
}

function bottomLimit(doc: PDFKit.PDFDocument): number {
  return doc.page.height - BOTTOM_MARGIN;
}

function textHeight(doc: PDFKit.PDFDocument, text: string, width: number, size: number, font = 'Helvetica'): number {
  doc.font(font).fontSize(size);
  return doc.heightOfString(text || ' ', { width, lineGap: LINE_GAP });
}

/** Adds a page; the `pageAdded` listener draws the running header and tracks the index. */
function newPage(l: Layout): void {
  l.doc.addPage();
  l.y = TOP_MARGIN;
}

/** Moves to a new page when `height` does not fit below the cursor. */
function ensure(l: Layout, height: number): void {
  if (l.y + height > bottomLimit(l.doc) && l.y > TOP_MARGIN + 1) newPage(l);
}

function drawRunningHeader(l: Layout, label: string | undefined): void {
  const { doc } = l;
  if (!label) return;
  const y = PAGE_MARGIN - 6;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(l.brand)
    .text(label, PAGE_MARGIN, y, { width: contentWidth(doc), align: 'right', lineBreak: false });
  doc.moveTo(PAGE_MARGIN, y + 14).lineTo(doc.page.width - PAGE_MARGIN, y + 14).lineWidth(0.5).strokeColor(RULE).stroke();
}

function drawFooter(l: Layout, pageNumber: number, totalPages: number, spec: ComposedDocumentSpec, generatedAt: string): void {
  const { doc } = l;
  const y = doc.page.height - PAGE_MARGIN - 12;
  const cw = contentWidth(doc);
  // The footer sits INSIDE the bottom margin. pdfkit adds a page whenever text is written
  // below `page.height - margins.bottom`, which turned a 4-page report into 16 pages (each
  // footer line pushed a blank page). Lift the margin while drawing it.
  doc.page.margins.bottom = 0;
  doc.moveTo(PAGE_MARGIN, y - 6).lineTo(doc.page.width - PAGE_MARGIN, y - 6).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.font('Helvetica-Bold').fontSize(7).fillColor(l.brand)
    .text(spec.logoText ?? 'UNIK', PAGE_MARGIN, y, { width: cw / 4, lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor(l.accent)
    .text(spec.footerLabel ?? `Generado por ${spec.author ?? 'UNIK Asistente IA'} · ${generatedAt}`, PAGE_MARGIN + cw / 4, y, {
      width: cw / 2,
      align: 'center',
      lineBreak: false,
      ellipsis: true,
    });
  doc.text(`Página ${pageNumber} de ${totalPages}`, PAGE_MARGIN + (cw * 3) / 4, y, { width: cw / 4, align: 'right', lineBreak: false });
}

/* ------------------------------------------------------------------ */
/* Blocks                                                             */
/* ------------------------------------------------------------------ */

function drawKpiCards(l: Layout, items: DocKpi[], big: boolean): void {
  const { doc } = l;
  if (items.length === 0) return;
  const cw = contentWidth(doc);
  const perRow = Math.min(items.length, big ? 3 : 4);
  const gap = 10;
  const cardW = (cw - (perRow - 1) * gap) / perRow;
  const cardH = big ? 64 : 50;
  for (let start = 0; start < items.length; start += perRow) {
    const rowItems = items.slice(start, start + perRow);
    ensure(l, cardH + 10);
    rowItems.forEach((card, i) => {
      const x = PAGE_MARGIN + i * (cardW + gap);
      const tone = card.tone ? TONE_HEX[TONE_FALLBACK[card.tone]] : l.brand;
      doc.roundedRect(x, l.y, cardW, cardH, 6).fillColor(CARD_FILL).fill();
      doc.roundedRect(x, l.y, cardW, cardH, 6).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.rect(x, l.y + 8, 3, cardH - 16).fillColor(tone).fill();
      doc.font('Helvetica-Bold').fontSize(big ? 20 : 15).fillColor(TEXT_DARK)
        .text(card.value, x + 12, l.y + (big ? 10 : 8), { width: cardW - 20, lineBreak: false, ellipsis: true });
      doc.font('Helvetica-Bold').fontSize(7).fillColor(l.accent)
        .text(card.label.toUpperCase(), x + 12, l.y + (big ? 36 : 28), { width: cardW - 20, lineBreak: false, ellipsis: true });
      if (card.note) {
        doc.font('Helvetica').fontSize(6.5).fillColor(TEXT_MUTED)
          .text(card.note, x + 12, l.y + (big ? 47 : 38), { width: cardW - 20, lineBreak: false, ellipsis: true });
      }
    });
    l.y += cardH + 10;
  }
}

function drawCover(l: Layout, spec: ComposedDocumentSpec, generatedAt: string): void {
  const { doc } = l;
  l.coverPages.add(l.pageIndex);
  const cw = contentWidth(doc);
  let y = PAGE_MARGIN + 60;
  const logo = spec.logoText ?? 'UNIK';
  doc.font('Helvetica-Bold').fontSize(26).fillColor(l.brand).text(logo, PAGE_MARGIN, y, { width: cw, align: 'center' });
  y = doc.y + 26;
  doc.font('Helvetica-Bold').fontSize(22).fillColor(TEXT_DARK).text(spec.title, PAGE_MARGIN, y, { width: cw, align: 'center', lineGap: 3 });
  y = doc.y + 10;
  if (spec.subtitle) {
    doc.font('Helvetica').fontSize(12).fillColor(l.accent).text(spec.subtitle, PAGE_MARGIN, y, { width: cw, align: 'center', lineGap: 2 });
    y = doc.y + 10;
  }
  const meta = spec.cover?.metaLine ?? generatedAt;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TEXT_DARK).text(meta, PAGE_MARGIN, y, { width: cw, align: 'center' });
  y = doc.y + 24;
  l.y = y;
  if (spec.cover?.kpis && spec.cover.kpis.length > 0) drawKpiCards(l, spec.cover.kpis, true);
  if (spec.cover?.note) {
    l.y += 8;
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(TEXT_MUTED).text(spec.cover.note, PAGE_MARGIN + 20, l.y, { width: cw - 40, align: 'center', lineGap: 2 });
    l.y = doc.y;
  }
}

function drawHeading(l: Layout, text: string, level: 1 | 2 | 3): void {
  const { doc } = l;
  const size = level === 1 ? 15 : level === 2 ? 12 : 10;
  const cw = contentWidth(doc);
  const h = textHeight(doc, text, cw - 12, size, 'Helvetica-Bold');
  // Keep the heading with at least a few lines of what follows.
  ensure(l, h + 56);
  l.y += level === 1 ? 10 : 6;
  if (level === 1) {
    doc.rect(PAGE_MARGIN, l.y + 2, 4, Math.max(12, h - 2)).fillColor(l.brand).fill();
  }
  doc.font('Helvetica-Bold').fontSize(size).fillColor(level === 3 ? l.accent : TEXT_DARK)
    .text(text, PAGE_MARGIN + (level === 1 ? 12 : 0), l.y, { width: cw - (level === 1 ? 12 : 0), lineGap: LINE_GAP });
  l.y = doc.y + (level === 1 ? 8 : 5);
}

function drawParagraph(l: Layout, text: string, style: 'normal' | 'lead' | 'muted' | 'note'): void {
  const { doc } = l;
  const cw = contentWidth(doc);
  const size = style === 'lead' ? 10.5 : style === 'note' ? 8 : BODY_SIZE;
  const font = style === 'note' ? 'Helvetica-Oblique' : 'Helvetica';
  const color = style === 'muted' || style === 'note' ? TEXT_MUTED : TEXT_BODY;
  const h = textHeight(doc, text, cw, size, font);
  const remaining = bottomLimit(doc) - l.y;
  // Move short blocks whole; let pdfkit flow a paragraph taller than what's left only when
  // a reasonable chunk (≥ 4 lines) would still land on this page.
  if (h > remaining && (h < remaining * 3 || remaining < 60)) ensure(l, h);
  doc.font(font).fontSize(size).fillColor(color).text(text, PAGE_MARGIN, l.y, { width: cw, lineGap: LINE_GAP, align: 'left' });
  l.y = doc.y + 6;
}

function drawBullets(l: Layout, items: string[], ordered: boolean, title?: string): void {
  const { doc } = l;
  const cw = contentWidth(doc);
  if (title) {
    drawHeading(l, title, 3);
  }
  const indent = 16;
  items.forEach((item, i) => {
    const marker = ordered ? `${i + 1}.` : '•';
    const h = textHeight(doc, item, cw - indent, BODY_SIZE);
    ensure(l, h + 3);
    doc.font('Helvetica-Bold').fontSize(BODY_SIZE).fillColor(l.brand).text(marker, PAGE_MARGIN, l.y, { width: indent, lineBreak: false });
    doc.font('Helvetica').fontSize(BODY_SIZE).fillColor(TEXT_BODY).text(item, PAGE_MARGIN + indent, l.y, { width: cw - indent, lineGap: LINE_GAP });
    l.y = doc.y + 3;
  });
  l.y += 4;
}

function drawCallout(l: Layout, tone: DocTone, title: string | undefined, text: string): void {
  const { doc } = l;
  const cw = contentWidth(doc);
  const t = TONE_FALLBACK[tone];
  const padX = 12;
  const padY = 9;
  const innerW = cw - padX * 2 - 4;
  const titleH = title ? textHeight(doc, title, innerW, 9.5, 'Helvetica-Bold') + 3 : 0;
  const bodyH = textHeight(doc, text, innerW, BODY_SIZE);
  const boxH = padY * 2 + titleH + bodyH;
  ensure(l, boxH + 8);
  doc.roundedRect(PAGE_MARGIN, l.y, cw, boxH, 5).fillColor(TONE_TINT_HEX[t]).fill();
  doc.rect(PAGE_MARGIN, l.y, 4, boxH).fillColor(TONE_HEX[t]).fill();
  let ty = l.y + padY;
  if (title) {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TONE_HEX[t]).text(title, PAGE_MARGIN + padX + 4, ty, { width: innerW, lineGap: LINE_GAP });
    ty = doc.y + 3;
  }
  doc.font('Helvetica').fontSize(BODY_SIZE).fillColor(TEXT_DARK).text(text, PAGE_MARGIN + padX + 4, ty, { width: innerW, lineGap: LINE_GAP });
  l.y += boxH + 10;
}

function drawKeyValue(l: Layout, items: Array<{ label: string; value: string }>, title?: string): void {
  const { doc } = l;
  const cw = contentWidth(doc);
  if (title) drawHeading(l, title, 3);
  const labelW = Math.min(180, cw * 0.35);
  for (const item of items) {
    const h = Math.max(textHeight(doc, item.label, labelW - 8, BODY_SIZE, 'Helvetica-Bold'), textHeight(doc, item.value, cw - labelW, BODY_SIZE));
    ensure(l, h + 6);
    doc.font('Helvetica-Bold').fontSize(BODY_SIZE).fillColor(l.accent).text(item.label, PAGE_MARGIN, l.y, { width: labelW - 8, lineGap: LINE_GAP });
    doc.font('Helvetica').fontSize(BODY_SIZE).fillColor(TEXT_BODY).text(item.value, PAGE_MARGIN + labelW, l.y, { width: cw - labelW, lineGap: LINE_GAP });
    l.y += h + 4;
    doc.moveTo(PAGE_MARGIN, l.y - 1).lineTo(PAGE_MARGIN + cw, l.y - 1).lineWidth(0.3).strokeColor(RULE).stroke();
  }
  l.y += 6;
}

function drawTable(l: Layout, block: Extract<DocBlock, { type: 'table' }>): void {
  const { doc } = l;
  const cw = contentWidth(doc);
  if (block.title) drawHeading(l, block.title, 2);
  if (block.caption) {
    drawParagraph(l, block.caption, 'muted');
  }
  // Short identifiers (folios, dates, amounts) must never break mid-word: "OV-2342 / 3".
  const isShortIdColumn = (key: string): boolean => {
    const values = block.rows.map((r) => formatDocValue(r[key])).filter((v) => v.length > 0);
    return values.length > 0 && values.every((v) => v.length <= 14 && !/\s/.test(v));
  };
  const columns: PdfTableColumn[] =
    block.columns.length > 0
      ? block.columns.map((c) => ({
          header: c.header,
          key: c.key,
          width: c.width,
          align: c.align ?? (c.format === 'currency' || c.format === 'number' || c.format === 'percentage' ? 'right' : 'left'),
          nowrap: c.format === 'currency' || c.format === 'number' || c.format === 'date' || (!c.detail && isShortIdColumn(c.key)),
          detail: c.detail,
          format: (v: unknown) => formatDocValue(v, c.format),
        }))
      : Object.keys(block.rows[0] ?? {}).map((key) => ({ header: key, key, nowrap: isShortIdColumn(key), format: (v: unknown) => formatDocValue(v) }));

  if (block.rows.length === 0) {
    drawParagraph(l, '(Sin filas)', 'note');
    return;
  }

  const { tableColumns, detailColumns, widths, innerWidths, fontSize } = resolveColumns(doc, columns, TABLE_FONT, cw, block.rows);

  const drawHeaderRow = (): void => {
    doc.rect(PAGE_MARGIN, l.y, cw, HEADER_ROW_H).fillColor(l.brand).fill();
    let x = PAGE_MARGIN;
    tableColumns.forEach((col, i) => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff')
        .text(col.header.toUpperCase(), x + CELL_PAD_X, l.y + 7, { width: innerWidths[i], align: col.align ?? 'left', lineBreak: false, ellipsis: true });
      x += widths[i];
    });
    l.y += HEADER_ROW_H;
  };

  ensure(l, HEADER_ROW_H + MIN_ROW_H * 2);
  drawHeaderRow();

  const detailW = cw - CELL_PAD_X - DETAIL_LABEL_W;
  block.rows.forEach((row, rowIdx) => {
    const values = tableColumns.map((col) => cellText(col, row));
    // Measure with pdfkit itself so the row is exactly as tall as the wrapped text it will draw.
    doc.font('Helvetica').fontSize(fontSize);
    const cellHeights = values.map((v, i) => (v ? doc.heightOfString(v, { width: innerWidths[i], lineGap: 0 }) : 0));
    const mainH = Math.max(MIN_ROW_H, Math.ceil(Math.max(...cellHeights, 0)) + CELL_PAD_Y * 2 + 1);
    const details = detailColumns.map((col) => ({ col, value: cellText(col, row) })).filter((d) => d.value.trim().length > 0);
    doc.font('Helvetica').fontSize(DETAIL_FONT);
    const detailHeights = details.map((d) => Math.ceil(doc.heightOfString(d.value, { width: detailW, lineGap: 0 })) + 3);
    const detailH = detailHeights.reduce((s, h) => s + h, 0);
    const rowH = Math.min(mainH + detailH, bottomLimit(doc) - TOP_MARGIN - HEADER_ROW_H);

    if (l.y + rowH > bottomLimit(doc)) {
      newPage(l);
      drawHeaderRow();
    }
    if (rowIdx % 2 === 1) doc.rect(PAGE_MARGIN, l.y, cw, rowH).fillColor(CARD_FILL).fill();

    let x = PAGE_MARGIN;
    tableColumns.forEach((col, i) => {
      const value = values[i];
      const align = col.align ?? 'left';
      const tone = align !== 'right' ? toneForStatusLabel(value) : null;
      doc.fontSize(fontSize);
      if (tone && !value.includes('\n')) {
        doc.font('Helvetica-Bold');
        const tw = doc.widthOfString(value);
        if (tw + 10 <= innerWidths[i]) {
          const pillW = tw + 10;
          const pillH = fontSize + 6;
          const px = align === 'center' ? x + CELL_PAD_X + (innerWidths[i] - pillW) / 2 : x + CELL_PAD_X;
          doc.roundedRect(px, l.y + CELL_PAD_Y - 2, pillW, pillH, pillH / 2).fillColor(TONE_TINT_HEX[tone]).fill();
          doc.fillColor(TONE_HEX[tone]).text(value, px + 5, l.y + CELL_PAD_Y + 1, { width: pillW - 10, lineBreak: false });
          x += widths[i];
          return;
        }
      }
      doc.font('Helvetica').fillColor(TEXT_BODY)
        .text(value, x + CELL_PAD_X, l.y + CELL_PAD_Y, { width: innerWidths[i], height: mainH - CELL_PAD_Y, align, ellipsis: true, lineGap: 0, lineBreak: !col.nowrap });
      x += widths[i];
    });
    doc.moveTo(PAGE_MARGIN, l.y + rowH).lineTo(PAGE_MARGIN + cw, l.y + rowH).lineWidth(0.4).strokeColor(RULE).stroke();

    if (details.length > 0) {
      let dy = l.y + mainH;
      details.forEach((d, i) => {
        const h = detailHeights[i];
        doc.font('Helvetica-Bold').fontSize(DETAIL_FONT).fillColor(l.accent).text(`${d.col.header}:`, PAGE_MARGIN + CELL_PAD_X, dy, { width: DETAIL_LABEL_W, lineBreak: false });
        doc.font('Helvetica').fontSize(DETAIL_FONT).fillColor(TEXT_BODY).text(d.value, PAGE_MARGIN + CELL_PAD_X + DETAIL_LABEL_W, dy, { width: detailW, height: h, ellipsis: true });
        dy += h;
      });
    }
    l.y += rowH;
  });

  if (block.totalsRow) {
    const h = MIN_ROW_H + 2;
    if (l.y + h > bottomLimit(doc)) {
      newPage(l);
      drawHeaderRow();
    }
    doc.rect(PAGE_MARGIN, l.y, cw, h).fillColor(TOTALS_FILL).fill();
    doc.moveTo(PAGE_MARGIN, l.y).lineTo(PAGE_MARGIN + cw, l.y).lineWidth(1.2).strokeColor(l.brand).stroke();
    let x = PAGE_MARGIN;
    tableColumns.forEach((col, i) => {
      const raw = block.totalsRow?.[col.key];
      const value = raw === null || raw === undefined ? '' : typeof raw === 'string' ? raw : cellText(col, block.totalsRow ?? {});
      doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(TEXT_DARK)
        .text(value, x + CELL_PAD_X, l.y + CELL_PAD_Y + 1, { width: innerWidths[i], align: col.align ?? 'left', lineBreak: false, ellipsis: true });
      x += widths[i];
    });
    l.y += h;
  }

  l.y += 6;
  if (block.footnote) drawParagraph(l, block.footnote, 'note');
  l.y += 4;
}

function drawBars(l: Layout, block: Extract<DocBlock, { type: 'bars' }>): void {
  const { doc } = l;
  const cw = contentWidth(doc);
  if (block.title) drawHeading(l, block.title, 3);
  const items = block.items.filter((i) => Number.isFinite(i.value));
  if (items.length === 0) return;
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0) || 1;
  const labelW = Math.min(170, cw * 0.32);
  const valueW = 78;
  const barW = cw - labelW - valueW - 16;
  const barH = 12;
  const rowH = barH + 7;
  ensure(l, Math.min(items.length, 4) * rowH + 8);
  for (const item of items) {
    ensure(l, rowH);
    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_BODY).text(item.label, PAGE_MARGIN, l.y + 1, { width: labelW - 8, lineBreak: false, ellipsis: true });
    doc.roundedRect(PAGE_MARGIN + labelW, l.y, barW, barH, 3).fillColor(CARD_FILL).fill();
    const w = Math.max(2, (Math.abs(item.value) / max) * barW);
    doc.roundedRect(PAGE_MARGIN + labelW, l.y, w, barH, 3).fillColor(sanitizeSvgColor(item.color, l.brand)).fill();
    const pct = block.showPercent === false ? '' : ` (${((Math.max(0, item.value) / total) * 100).toFixed(1)}%)`;
    const valueText = `${item.value.toLocaleString('es-MX')}${block.valueSuffix ?? ''}${pct}`;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(TEXT_DARK).text(valueText, PAGE_MARGIN + labelW + barW + 8, l.y + 1, { width: valueW, align: 'right', lineBreak: false });
    l.y += rowH;
  }
  l.y += 8;
}

function drawImage(l: Layout, image: DocImage, caption: string | undefined, maxHeight?: number): void {
  const { doc } = l;
  const cw = contentWidth(doc);
  const pageH = bottomLimit(doc) - TOP_MARGIN;
  const maxH = Math.min(maxHeight ?? 440, pageH - 30);
  const scale = Math.min(cw / image.width, maxH / image.height);
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  const captionH = caption ? textHeight(doc, caption, cw, 8, 'Helvetica-Oblique') + 4 : 0;
  ensure(l, drawH + captionH + 8);
  const x = PAGE_MARGIN + (cw - drawW) / 2;
  try {
    doc.image(image.data, x, l.y, { width: drawW, height: drawH });
    doc.rect(x, l.y, drawW, drawH).lineWidth(0.5).strokeColor(RULE).stroke();
  } catch {
    doc.roundedRect(x, l.y, drawW, Math.min(drawH, 60), 4).fillColor(CARD_FILL).fill();
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(TEXT_MUTED).text('(Imagen no compatible)', x, l.y + 24, { width: drawW, align: 'center' });
  }
  l.y += drawH + 4;
  if (caption) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(TEXT_MUTED).text(caption, PAGE_MARGIN, l.y, { width: cw, align: 'center', lineGap: 2 });
    l.y = doc.y + 4;
  }
  l.y += 6;
}

function drawDivider(l: Layout): void {
  const { doc } = l;
  ensure(l, 14);
  l.y += 4;
  doc.moveTo(PAGE_MARGIN, l.y).lineTo(doc.page.width - PAGE_MARGIN, l.y).lineWidth(0.6).strokeColor(RULE).stroke();
  l.y += 10;
}

function drawBlock(l: Layout, block: DocBlock): void {
  switch (block.type) {
    case 'heading':
      return drawHeading(l, block.text, block.level ?? 1);
    case 'paragraph':
      return drawParagraph(l, block.text, block.style ?? 'normal');
    case 'bullets':
      return drawBullets(l, block.items, block.ordered === true, block.title);
    case 'callout':
      return drawCallout(l, block.tone ?? 'info', block.title, block.text);
    case 'kpis':
      return drawKpiCards(l, block.items, false);
    case 'keyValue':
      return drawKeyValue(l, block.items, block.title);
    case 'table':
      return drawTable(l, block);
    case 'bars':
      return drawBars(l, block);
    case 'image':
      return drawImage(l, block.image, block.caption, block.maxHeight);
    case 'divider':
      return drawDivider(l);
    case 'pageBreak':
      newPage(l);
      return;
    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

export function generateComposedPdf(outputPath: string, spec: ComposedDocumentSpec): Promise<GeneratedDocumentInfo> {
  return new Promise((resolve, reject) => {
    const brand = sanitizeSvgColor(spec.brandColor, DEFAULT_BRAND);
    const accent = sanitizeSvgColor(spec.accentColor, DEFAULT_ACCENT);
    const doc = new PDFDocument({
      size: 'A4',
      layout: spec.orientation ?? 'portrait',
      bufferPages: true,
      margins: { top: TOP_MARGIN, bottom: BOTTOM_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
      info: { Title: spec.title, Author: spec.author ?? 'UNIK Asistente IA', Subject: spec.subtitle ?? '', Creator: 'UNIK' },
    });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const generatedAt = new Date().toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Mexico_City' });
    const l: Layout = { doc, brand, accent, y: TOP_MARGIN, pageIndex: 0, coverPages: new Set() };

    // Pages pdfkit adds on its own (a paragraph flowing past the bottom) get the
    // running header too; pages we add through newPage() are already covered.
    doc.on('pageAdded', () => {
      l.pageIndex += 1;
      if (!l.coverPages.has(l.pageIndex)) drawRunningHeader(l, spec.headerLabel);
    });

    try {
      if (spec.cover) {
        drawCover(l, spec, generatedAt);
        newPage(l);
      } else {
        // Inline title band when there is no cover.
        drawRunningHeader(l, spec.headerLabel);
        const cw = contentWidth(doc);
        doc.font('Helvetica-Bold').fontSize(20).fillColor(TEXT_DARK).text(spec.title, PAGE_MARGIN, l.y, { width: cw, lineGap: 3 });
        l.y = doc.y + 4;
        if (spec.subtitle) {
          doc.font('Helvetica').fontSize(10.5).fillColor(accent).text(spec.subtitle, PAGE_MARGIN, l.y, { width: cw, lineGap: 2 });
          l.y = doc.y + 4;
        }
        doc.moveTo(PAGE_MARGIN, l.y + 4).lineTo(doc.page.width - PAGE_MARGIN, l.y + 4).lineWidth(2).strokeColor(brand).stroke();
        l.y += 16;
      }

      for (const block of spec.blocks) drawBlock(l, block);

      if (spec.appendix && spec.appendix.images.length > 0) {
        newPage(l);
        drawHeading(l, spec.appendix.title ?? 'Anexo: documentos originales', 1);
        if (spec.appendix.intro) drawParagraph(l, spec.appendix.intro, 'muted');
        spec.appendix.images.forEach((img, i) => {
          if (i > 0) newPage(l);
          drawImage(l, img, img.caption ?? `Anexo ${i + 1}`);
        });
      }
    } catch (err) {
      reject(err);
      return;
    }

    const range = doc.bufferedPageRange();
    const pageCount = range.count;
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      drawFooter(l, i - range.start + 1, pageCount, spec, generatedAt);
    }
    if (doc.bufferedPageRange().count !== pageCount) {
      reject(new Error(`El pie de página agregó páginas (${doc.bufferedPageRange().count} vs ${pageCount})`));
      return;
    }
    doc.end();

    stream.on('finish', () => {
      const stats = fs.statSync(outputPath);
      resolve({ sizeBytes: stats.size, pageCount, ...summarizeSpec(spec) });
    });
    stream.on('error', reject);
  });
}
