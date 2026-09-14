/**
 * Content model shared by the "composed document" generators (PDF and Word).
 *
 * Unlike the tabular report generators (one or more tables fed by a data
 * tool), a composed document is AUTHORED by the assistant: an executive
 * summary, findings, grouped tables it built itself (for example after
 * cross-checking attachments against the system), callouts, simple bar
 * charts and an appendix with the original photos. The block list is a flat
 * sequence so the model can write it in one tool call.
 */

export type DocTone = 'info' | 'success' | 'warning' | 'danger' | 'muted';

export interface DocKpi {
  label: string;
  value: string;
  note?: string;
  tone?: DocTone;
}

export interface DocColumn {
  header: string;
  key: string;
  align?: 'left' | 'right' | 'center';
  /** Relative width weight (normalized to the page). */
  width?: number;
  format?: 'currency' | 'number' | 'percentage' | 'date' | 'text';
  /** Long free text rendered as a full-width line under the row (PDF). */
  detail?: boolean;
}

export interface DocImage {
  data: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  caption?: string;
  /** Natural size in pixels (measured from the file header). */
  width: number;
  height: number;
}

export type DocBlock =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'paragraph'; text: string; style?: 'normal' | 'lead' | 'muted' | 'note' }
  | { type: 'bullets'; items: string[]; ordered?: boolean; title?: string }
  | { type: 'callout'; tone?: DocTone; title?: string; text: string }
  | { type: 'kpis'; items: DocKpi[] }
  | { type: 'keyValue'; title?: string; items: Array<{ label: string; value: string }> }
  | {
      type: 'table';
      title?: string;
      caption?: string;
      columns: DocColumn[];
      rows: Record<string, unknown>[];
      totalsRow?: Record<string, unknown>;
      /** Shown in italics under the table (source, reading caveats…). */
      footnote?: string;
    }
  | { type: 'bars'; title?: string; items: Array<{ label: string; value: number; color?: string }>; valueSuffix?: string; showPercent?: boolean }
  | { type: 'image'; image: DocImage; caption?: string; maxHeight?: number }
  | { type: 'divider' }
  | { type: 'pageBreak' };

export interface DocCover {
  /** Big numbers under the title. */
  kpis?: DocKpi[];
  /** Small italic note at the bottom of the cover (scope, caveats). */
  note?: string;
  /** "Corte: 14 de septiembre de 2026 | 65 órdenes" */
  metaLine?: string;
}

export interface DocAppendix {
  title?: string;
  intro?: string;
  images: DocImage[];
}

export interface ComposedDocumentSpec {
  title: string;
  subtitle?: string;
  /** Running header text on inner pages, e.g. "UNIK | Control de órdenes de venta". */
  headerLabel?: string;
  /** Running footer text, e.g. "Fuente: reporte UNIK + notas manuscritas". */
  footerLabel?: string;
  author?: string;
  brandColor?: string;
  accentColor?: string;
  orientation?: 'portrait' | 'landscape';
  logoText?: string;
  /** When present a cover page is rendered before the content. */
  cover?: DocCover;
  blocks: DocBlock[];
  appendix?: DocAppendix;
}

export interface GeneratedDocumentInfo {
  sizeBytes: number;
  pageCount: number;
  blockCount: number;
  tableCount: number;
  rowCount: number;
  imageCount: number;
}

/** Formats a cell for the document tables (currency/number/date aware, never throws). */
export function formatDocValue(value: unknown, format?: DocColumn['format']): string {
  if (value === null || value === undefined) return '';
  if (format === 'currency') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(value);
  }
  if (format === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n.toLocaleString('es-MX') : String(value);
  }
  if (format === 'percentage') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? `${n.toLocaleString('es-MX', { maximumFractionDigits: 1 })}%` : String(value);
  }
  if (value instanceof Date) return value.toLocaleDateString('es-MX');
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Reads the natural size of a PNG or JPEG from its header. Returns null for
 * anything else (HEIC, WebP…) — those cannot be embedded by pdfkit/docx.
 */
export function imageDimensions(buffer: Buffer): { width: number; height: number; mimeType: 'image/png' | 'image/jpeg' } | null {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), mimeType: 'image/png' };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      // Padding bytes between segments.
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        if (width > 0 && height > 0) return { width, height, mimeType: 'image/jpeg' };
        return null;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2) return null;
      offset += 2 + segmentLength;
    }
  }
  return null;
}

/** Counts what a spec contains (for the tool result and the artifact meta). */
export function summarizeSpec(spec: ComposedDocumentSpec): Pick<GeneratedDocumentInfo, 'blockCount' | 'tableCount' | 'rowCount' | 'imageCount'> {
  let tableCount = 0;
  let rowCount = 0;
  let imageCount = spec.appendix?.images.length ?? 0;
  for (const block of spec.blocks) {
    if (block.type === 'table') {
      tableCount += 1;
      rowCount += block.rows.length;
    } else if (block.type === 'image') {
      imageCount += 1;
    }
  }
  return { blockCount: spec.blocks.length, tableCount, rowCount, imageCount };
}
