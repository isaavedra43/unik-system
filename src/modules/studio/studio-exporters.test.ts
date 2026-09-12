import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { extractFigures } from './studio-content';
import {
  exportFileName,
  renderStudioExport,
  sheetNameForTable,
  STUDIO_EXPORT_FORMATS,
  type StudioExportFormat,
} from './studio-exporters';
import { checkFigures, verifyStudioExport } from './studio-verification';
import { makeTestPng, sampleContent } from './studio-test-utils';

/**
 * Every exporter renders the sample document (KPIs, prose with amounts, two
 * amount tables, list, image, page break) and the verification step reopens
 * the file: all figures must be found. A tampered file must FAIL.
 */

let dir: string;
const png = makeTestPng(16, 10);
const title = 'Reporte de cierre 2026 — Sucursales';
const loadImage = async (id: string) =>
  id === 'img1' ? { buffer: png, mimeType: 'image/png' } : null;

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unik-studio-exporters-'));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function renderAndVerify(format: StudioExportFormat, withImage = true) {
  const content = sampleContent(withImage ? 'img1' : undefined);
  const outputPath = path.join(dir, `${format}-${withImage ? 'img' : 'plain'}.${format}`);
  const rendered = await renderStudioExport(format, { title, content, outputPath, loadImage });
  const verification = await verifyStudioExport(format, outputPath, { title, content });
  return { content, outputPath, rendered, verification };
}

describe.each(STUDIO_EXPORT_FORMATS)('export %s', (format) => {
  it('renders a non-empty file that passes render verification (no figure lost)', async () => {
    const { rendered, verification } = await renderAndVerify(format);
    expect(rendered.sizeBytes).toBeGreaterThan(0);
    expect(verification.ok, JSON.stringify(verification.checks)).toBe(true);
    const figures = verification.checks.find((c) => c.name === 'figures');
    expect(figures?.ok).toBe(true);
    expect(verification.checks.find((c) => c.name === 'title')?.ok).toBe(true);
  });

  it('also verifies without images (placeholders only)', async () => {
    const { verification } = await renderAndVerify(format, false);
    expect(verification.ok, JSON.stringify(verification.checks)).toBe(true);
  });
});

describe('PDF', () => {
  it('reports pages and uses the branded report engine for report-shaped documents', async () => {
    const reportContent = {
      version: 1 as const,
      blocks: sampleContent().blocks.filter(
        (b) => b.type === 'heading' || b.type === 'table' || b.type === 'kpi'
      ),
    };
    const outputPath = path.join(dir, 'report-shaped.pdf');
    const rendered = await renderStudioExport('pdf', {
      title: 'Cierre 2026',
      content: reportContent,
      outputPath,
    });
    expect(rendered.pageCount).toBeGreaterThan(0);
    const verification = await verifyStudioExport('pdf', outputPath, {
      title: 'Cierre 2026',
      content: reportContent,
    });
    expect(verification.ok, JSON.stringify(verification.checks)).toBe(true);
    expect(verification.checks.find((c) => c.name === 'pages')?.ok).toBe(true);
  });

  it('paginates long tables without losing rows', async () => {
    const content = sampleContent();
    const table = content.blocks.find((b) => b.id === 'b_t1');
    if (table?.type === 'table') {
      table.rows = Array.from({ length: 120 }, (_, i) => ({
        branch: `Sucursal ${i + 1}`,
        orders: i + 1,
        total: 1000.25 + i * 1111.11,
        balance: i * 7,
        share: (i % 100) + 0.5,
      }));
    }
    const outputPath = path.join(dir, 'long.pdf');
    const rendered = await renderStudioExport('pdf', { title, content, outputPath });
    expect(rendered.pageCount).toBeGreaterThan(2);
    const verification = await verifyStudioExport('pdf', outputPath, { title, content });
    expect(verification.ok, JSON.stringify(verification.checks)).toBe(true);
  });
});

describe('XLSX', () => {
  it('writes one sheet per table plus the summary sheet with stable names', async () => {
    const { rendered } = await renderAndVerify('xlsx');
    expect(rendered.sheetNames).toEqual(['Resumen', 'Ventas por sucursal', 'Saldos vencidos']);
    const used = new Set<string>();
    expect(sheetNameForTable(0, 'Ventas: [Q3]/2026 * detalle largo que excede', used)).toBe(
      'Ventas Q3 2026 detalle largo'
    );
    expect(sheetNameForTable(1, 'Ventas: [Q3]/2026 * detalle largo que excede', used)).toBe(
      'Ventas Q3 2026 detalle l (2)'
    );
    expect(sheetNameForTable(2, 'Resumen', used)).toBe('Resumen (2)');
  });

  it('fails verification when a cell was altered after rendering', async () => {
    const { content, outputPath } = await renderAndVerify('xlsx', false);
    const tampered = JSON.parse(JSON.stringify(content)) as typeof content;
    const table = tampered.blocks.find((b) => b.id === 'b_t1');
    if (table?.type === 'table') table.rows[1].total = 999999;
    const verification = await verifyStudioExport('xlsx', outputPath, { title, content: tampered });
    expect(verification.ok).toBe(false);
    const cells = verification.checks.find((c) => c.name === 'cells');
    expect(cells?.ok).toBe(false);
    expect(cells?.detail).toContain('Ventas por sucursal');
  });
});

describe('verification catches lost content', () => {
  it('html: a removed amount is reported with its location', async () => {
    const { content, outputPath } = await renderAndVerify('html', false);
    const html = await fsp.readFile(outputPath, 'utf8');
    await fsp.writeFile(outputPath, html.replaceAll('$45,000.50', '$—'));
    const verification = await verifyStudioExport('html', outputPath, { title, content });
    expect(verification.ok).toBe(false);
    const figures = verification.checks.find((c) => c.name === 'figures');
    expect(figures?.ok).toBe(false);
    expect(figures?.detail).toContain('45,000.50');
  });

  it('csv: only data figures are required, prose figures are not', async () => {
    const { content, outputPath } = await renderAndVerify('csv', false);
    const csv = await fsp.readFile(outputPath, 'utf8');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('## Ventas por sucursal');
    expect(csv).toContain('## Saldos vencidos');
    expect(csv).toContain('"Constructora Río Bravo, S.A."');
    const verification = await verifyStudioExport('csv', outputPath, { title, content });
    expect(verification.ok).toBe(true);
    await fsp.writeFile(outputPath, csv.replace('$402,100.25', ''));
    const broken = await verifyStudioExport('csv', outputPath, { title, content });
    expect(broken.ok).toBe(false);
  });

  it('docx/pptx: an OOXML package that is not a ZIP fails the structure check', async () => {
    const outputPath = path.join(dir, 'broken.docx');
    await fsp.writeFile(outputPath, 'no soy un zip');
    const verification = await verifyStudioExport('docx', outputPath, {
      title,
      content: sampleContent(),
    });
    expect(verification.ok).toBe(false);
    expect(verification.checks.some((c) => c.name === 'read' && !c.ok)).toBe(true);
  });

  it('pdf: an empty file fails', async () => {
    const outputPath = path.join(dir, 'empty.pdf');
    fs.writeFileSync(outputPath, '');
    const verification = await verifyStudioExport('pdf', outputPath, {
      title,
      content: sampleContent(),
    });
    expect(verification.ok).toBe(false);
    expect(verification.checks[0]).toMatchObject({ name: 'file', ok: false });
  });

  it('checkFigures tolerates thousands separators, currency symbols and spacing', () => {
    const figures = extractFigures(sampleContent());
    const text =
      'Total 1 234 567.89 · 312 · 3957.00 · 18.5 · 45000.50 · 512,300.50 · 402100.25 · 320167.14 · 18000.50 · 25000.50 · 20000.00 · 15/09/2026 · 20/09/2026 · 12000 · 15000 · 120 · 98 · 94 · 41.5 · 32.6 · 25.9 · 30 · 10234 · 10241 · 2026';
    expect(checkFigures(figures, text).ok).toBe(true);
    expect(checkFigures(figures, 'nada').ok).toBe(false);
  });
});

describe('file names', () => {
  it('derives a safe file name from the title', () => {
    expect(exportFileName('Cierre: ventas/2026 · Sucursal "Norte"', 'pdf')).toBe(
      'Cierre-ventas2026-Sucursal-Norte.pdf'
    );
    expect(exportFileName('¿?', 'xlsx')).toBe('documento.xlsx');
  });
});
