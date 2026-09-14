import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { generateComposedPdf } from './document-pdf-generator';
import { generateComposedDocx } from './document-docx-generator';
import { imageDimensions, summarizeSpec, type ComposedDocumentSpec, type DocImage } from './document-spec';

const files: string[] = [];
function tmp(ext: string): string {
  const p = path.join(os.tmpdir(), `unik-doc-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  files.push(p);
  return p;
}
afterEach(() => {
  for (const f of files.splice(0)) if (fs.existsSync(f)) fs.unlinkSync(f);
});

/** Builds a valid RGB PNG of the given size (solid color) without any image library. */
function makePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function image(width: number, height: number, caption?: string): DocImage {
  const data = makePng(width, height, [37, 99, 235]);
  return { data, mimeType: 'image/png', width, height, caption };
}

const orders = Array.from({ length: 70 }, (_, i) => ({
  orden: `OV-${23140 + i}`,
  cliente: i % 3 === 0 ? 'INTERMETROPOLITANA DE VIVIENDA S.A. DE C.V.' : `CLIENTE ${i}`,
  vendedor: ['Axel', 'Laura Martinez', 'Andrea Gutierrez'][i % 3],
  ticket: i % 4 === 0 ? 'Pendiente de envío' : 'En tránsito',
  pago: i % 5 === 0 ? 'Parcial' : 'Pagada',
  nota: i % 7 === 0 ? 'Recolección pendiente de entrega (el número manuscrito parece 23364; se asocia por cruce con el PDF)' : 'Producción',
}));

function spec(): ComposedDocumentSpec {
  return {
    title: 'Reporte consolidado de órdenes de venta no cerradas',
    subtitle: 'Comparativo entre el reporte del sistema y las notas de seguimiento de oficina',
    headerLabel: 'UNIK | Control de órdenes de venta',
    footerLabel: 'Fuente: reporte UNIK + notas manuscritas',
    cover: {
      metaLine: 'Corte: 14 de septiembre de 2026 | 65 órdenes',
      kpis: [
        { label: 'órdenes abiertas', value: '65' },
        { label: 'en producción o recolección', value: '37', tone: 'warning' },
        { label: 'anotadas como entregadas', value: '10', tone: 'danger', note: 'siguen abiertas en el sistema' },
      ],
      note: 'Cuando una lectura manuscrita es incierta, se marca expresamente.',
    },
    blocks: [
      { type: 'heading', text: '1. Resumen ejecutivo', level: 1 },
      { type: 'paragraph', style: 'lead', text: 'El reporte fuente contiene 65 órdenes con entrega a pie de obra que todavía aparecen como no cerradas. '.repeat(3) },
      { type: 'paragraph', text: 'El principal cuello de botella está antes de la entrega. '.repeat(12) },
      { type: 'kpis', items: [{ label: 'Producción', value: '17' }, { label: 'Recolección', value: '20' }, { label: 'Envío', value: '13' }, { label: 'Entregadas', value: '11' }] },
      { type: 'bars', title: 'Órdenes por motivo', items: [{ label: 'Recolección', value: 20 }, { label: 'Producción / material', value: 17 }, { label: 'Envío / programación', value: 13 }, { label: 'Entregado / cierre', value: 11 }, { label: 'Pago no reflejado', value: 2 }], valueSuffix: ' órdenes' },
      { type: 'bullets', title: 'Prioridades detectadas', ordered: true, items: ['Depurar entregas ya realizadas: revisar las 10 órdenes anotadas como entregadas.', 'Atacar producción + recolección: 37 órdenes concentradas en estos dos pasos.', 'Separar bloqueo financiero de bloqueo operativo.'] },
      { type: 'callout', tone: 'danger', title: 'Lo más urgente', text: 'OV-23425: la nota dice "Se llevó", pero el sistema la tiene en Pendiente de envío con pago parcial.' },
      { type: 'callout', tone: 'info', text: 'Aviso sin título.' },
      { type: 'keyValue', title: 'Ficha del corte', items: [{ label: 'Fuente sistema', value: 'PDF de 5 páginas con 65 órdenes' }, { label: 'Fuente manuscrita', value: '3 hojas de libreta' }] },
      { type: 'divider' },
      {
        type: 'heading', text: '2. Órdenes agrupadas por motivo', level: 1,
      },
      {
        type: 'table',
        title: 'Producción / material pendiente — 17 órdenes',
        caption: 'Incluye "Producción", "2 cajas pendientes de piso" y "Cantidad grande de piso".',
        columns: [
          { header: 'Orden', key: 'orden', width: 60 },
          { header: 'Cliente', key: 'cliente', width: 170 },
          { header: 'Vendedor', key: 'vendedor', width: 100 },
          { header: 'Ticket', key: 'ticket', width: 100 },
          { header: 'Pago', key: 'pago', width: 70 },
          { header: 'Nota manuscrita', key: 'nota', width: 160 },
        ],
        rows: orders,
        totalsRow: { orden: 'TOTAL', cliente: '70 órdenes' },
        footnote: 'Lecturas dudosas marcadas en la columna de nota.',
      },
      { type: 'pageBreak' },
      { type: 'table', title: 'Tabla sin columnas explícitas', columns: [], rows: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] },
      { type: 'image', image: image(800, 500), caption: 'Foto incrustada en el cuerpo' },
    ],
    appendix: { title: 'Anexo: fotos originales', intro: 'Respaldo de las notas.', images: [image(900, 1600, 'Hoja 1'), image(1600, 900, 'Hoja 2')] },
  };
}

async function realPageCount(file: string): Promise<number> {
  const pdfParseModule = await import('pdf-parse/lib/pdf-parse.js');
  const pdfParse = (pdfParseModule as unknown as { default?: (b: Buffer) => Promise<{ numpages: number }> }).default ?? (pdfParseModule as unknown as (b: Buffer) => Promise<{ numpages: number }>);
  const parsed = await pdfParse(fs.readFileSync(file));
  return parsed.numpages;
}

describe('generateComposedPdf', () => {
  it('reports the REAL page count (the footer must never push blank pages)', async () => {
    const out = tmp('pdf');
    const info = await generateComposedPdf(out, { ...spec(), footerLabel: 'Confidencial' });
    expect(await realPageCount(out)).toBe(info.pageCount);
  });

  it('renders cover, every block type, a long paginated table and the image appendix', async () => {
    const out = tmp('pdf');
    const info = await generateComposedPdf(out, spec());
    expect(info.sizeBytes).toBeGreaterThan(10_000);
    // cover + summary + 70-row table (≥2 pages) + explicit break + 2 appendix pages
    expect(info.pageCount).toBeGreaterThanOrEqual(6);
    expect(info.pageCount).toBeLessThan(14);
    expect(info.rowCount).toBe(72);
    expect(info.tableCount).toBe(2);
    expect(info.imageCount).toBe(3);
    const head = fs.readFileSync(out).subarray(0, 5).toString('ascii');
    expect(head).toBe('%PDF-');
  });

  it('works without a cover and with an empty table', async () => {
    const out = tmp('pdf');
    const info = await generateComposedPdf(out, {
      title: 'Minuta corta',
      blocks: [
        { type: 'paragraph', text: 'Hola.' },
        { type: 'table', title: 'Vacía', columns: [{ header: 'A', key: 'a' }], rows: [] },
      ],
    });
    expect(info.pageCount).toBe(1);
    expect(info.rowCount).toBe(0);
  });

  it('flows a paragraph longer than a page without losing the footer band', async () => {
    const out = tmp('pdf');
    const info = await generateComposedPdf(out, {
      title: 'Texto largo',
      headerLabel: 'UNIK | prueba',
      blocks: [{ type: 'paragraph', text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(400) }],
    });
    expect(info.pageCount).toBeGreaterThanOrEqual(3);
  });
});

describe('generateComposedDocx', () => {
  it('produces a Word file with the same spec', async () => {
    const out = tmp('docx');
    const info = await generateComposedDocx(out, spec());
    expect(info.sizeBytes).toBeGreaterThan(5_000);
    expect(info.rowCount).toBe(72);
    expect(fs.readFileSync(out).subarray(0, 2).toString('ascii')).toBe('PK');
  });
});

describe('document-spec helpers', () => {
  it('reads PNG and JPEG dimensions and rejects other formats', () => {
    expect(imageDimensions(makePng(12, 34, [0, 0, 0]))).toEqual({ width: 12, height: 34, mimeType: 'image/png' });
    // SOI + APP0 (length 16) + SOF0 (length 17: precision, height 480, width 640, 3 components)
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]),
      Buffer.alloc(9),
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 640, height: 480, mimeType: 'image/jpeg' });
    expect(imageDimensions(Buffer.from('RIFF....WEBPVP8 '))).toBeNull();
    expect(imageDimensions(Buffer.alloc(3))).toBeNull();
  });

  it('summarizes what a spec contains', () => {
    expect(summarizeSpec(spec())).toEqual({ blockCount: 15, tableCount: 2, rowCount: 72, imageCount: 3 });
  });
});
