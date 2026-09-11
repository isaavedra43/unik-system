import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generatePdfReport, toneForStatusLabel } from './pdf-generator';

const files: string[] = [];
function tmpPdf(): string {
  const p = path.join(os.tmpdir(), `unik-pdf-test-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  files.push(p);
  return p;
}
afterEach(() => {
  for (const f of files.splice(0)) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('generatePdfReport — wide table with long free-text columns', () => {
  it('never produces one page per row (the reported bug: 50 rows across 20 near-empty pages)', async () => {
    const columns = [
      { header: 'Orden', key: 'number', width: 62 },
      { header: 'Fecha', key: 'date', width: 62 },
      { header: 'Cliente', key: 'customer', width: 130 },
      { header: 'Vendedor', key: 'salesperson', width: 95 },
      { header: 'Estado', key: 'status', width: 65 },
      { header: 'Pago', key: 'paidStatus', width: 70 },
      { header: 'Facturación', key: 'invoicedStatus', width: 75 },
      { header: 'Entrega', key: 'shippedStatus', width: 70 },
      { header: 'Método de Pago', key: 'paymentMethod', width: 95 },
      { header: 'Método de Entrega', key: 'deliveryMethod', width: 110 },
      { header: 'Total', key: 'total', width: 75, align: 'right' as const },
      { header: 'Saldo', key: 'balance', width: 75, align: 'right' as const },
      { header: 'Productos', key: 'items', detail: true },
      { header: 'Dirección', key: 'shippingAddress', detail: true },
    ];
    const rows = Array.from({ length: 50 }, (_, i) => ({
      number: `OV-${23300 + i}`,
      date: '10/09/2026',
      customer: 'CARMEN HERNANDEZ SANDOVAL',
      salesperson: 'Axel',
      status: 'Confirmada',
      paidStatus: 'Pagada',
      invoicedStatus: 'Facturada',
      shippedStatus: 'Pendiente',
      paymentMethod: 'TRANSFERENCIA',
      deliveryMethod: 'A PIE DE OBRA (LIBRE DE MANIOBRAS)',
      total: '$126,730.00',
      balance: '$0.00',
      items: 'PISO PORCELANATO 60X60 — 40 m2\nADHESIVO GRIS — 6 sacos\nBOQUILLA — 2 kg',
      shippingAddress: 'Rancho La Sarteneja, Cueramaro, Guanajuato, CP 36980 (favor de llamar para pedir ubicación)',
    }));

    const out = tmpPdf();
    const { pageCount, sizeBytes } = await generatePdfReport(out, {
      title: 'Ventas (Histórico)',
      columns,
      rows,
      orientation: 'landscape',
    });

    expect(sizeBytes).toBeGreaterThan(0);
    // 50 rows with ~4 detail lines each fit comfortably in well under 20 pages;
    // the bug produced one page per row (≈50), so this guards the fix.
    expect(pageCount).toBeLessThan(15);
    expect(pageCount).toBeGreaterThan(0);
  });

  it('keeps table columns within the page width even with many narrow columns (no clipped last column)', async () => {
    const columns = Array.from({ length: 16 }, (_, i) => ({ header: `Col ${i}`, key: `c${i}` }));
    const row: Record<string, string> = {};
    for (let i = 0; i < 16; i++) row[`c${i}`] = `valor ${i}`;

    const out = tmpPdf();
    const { pageCount, sizeBytes } = await generatePdfReport(out, {
      title: 'Reporte ancho',
      columns,
      rows: [row, row, row],
      orientation: 'landscape',
    });
    expect(sizeBytes).toBeGreaterThan(0);
    expect(pageCount).toBe(1);
  });

  it('handles a single very long detail value without hanging or throwing', async () => {
    const out = tmpPdf();
    const longNote = 'x'.repeat(2000);
    const { pageCount } = await generatePdfReport(out, {
      title: 'Nota larga',
      columns: [
        { header: 'Orden', key: 'number' },
        { header: 'Notas', key: 'notes', detail: true },
      ],
      rows: [{ number: 'OV-1', notes: longNote }],
    });
    expect(pageCount).toBeGreaterThan(0);
    expect(pageCount).toBeLessThan(50);
  });
});

describe('generatePdfReport — nowrap columns keep ids/amounts on one line', () => {
  it('a curated sales-order layout with long names and amounts still fits and stays bounded', async () => {
    const columns = [
      { header: 'Orden', key: 'number', width: 62, nowrap: true },
      { header: 'Fecha', key: 'date', width: 62, nowrap: true },
      { header: 'Cliente', key: 'customer', width: 130 },
      { header: 'Vendedor', key: 'salesperson', width: 95 },
      { header: 'Ticket', key: 'ticketStatus', width: 90 },
      { header: 'Pago', key: 'paidStatus', width: 70 },
      { header: 'Método', key: 'paymentMethod', width: 95 },
      { header: 'Entrega', key: 'deliveryMethod', width: 110 },
      { header: 'Total', key: 'total', width: 75, align: 'right' as const, nowrap: true },
      { header: 'Saldo', key: 'balance', width: 75, align: 'right' as const, nowrap: true },
      { header: 'Dirección', key: 'shippingAddress', detail: true },
    ];
    const rows = Array.from({ length: 76 }, (_, i) => ({
      number: `OV-${23300 + i}`,
      date: '10/09/2026',
      customer: 'MA. GUADALUPE ESTRADA AVILA DE LA TORRE',
      salesperson: 'Andrea Gutierrez',
      ticketStatus: i % 3 === 0 ? 'En tránsito' : i % 3 === 1 ? 'Pendiente de envío' : 'Cerrado',
      paidStatus: 'Parcial',
      paymentMethod: 'EFECTIVO Y TRANSFERENCIA',
      deliveryMethod: 'A PIE DE OBRA (LIBRE DE MANIOBRAS)',
      total: '$560,833.08',
      balance: '$290,000.00',
      shippingAddress: 'CONDOMINIO 1 MANZANA A LOTE 9 EL MOLINO RESIDENCIAL CAMPO DE GOLF, León, Guanajuato',
    }));
    const out = tmpPdf();
    const { pageCount, sizeBytes } = await generatePdfReport(out, { title: 'Ventas Pendientes de Entrega a Pie de Obra de Este Mes', columns, rows });
    expect(sizeBytes).toBeGreaterThan(0);
    expect(pageCount).toBeGreaterThan(1);
    expect(pageCount).toBeLessThan(10); // 76 rows + address lines ≈ 4-6 pages, never 1 row/page
  });
});

describe('toneForStatusLabel — colored status badges', () => {
  it('recognizes the real Spanish labels the app and the AI tools produce', () => {
    expect(toneForStatusLabel('Cerrado')).toBe('#15803d');
    expect(toneForStatusLabel('En tránsito')).toBe('#2563eb');
    expect(toneForStatusLabel('Pendiente de envío')).toBe('#b45309');
    expect(toneForStatusLabel('Anulado')).toBe('#b91c1c');
    expect(toneForStatusLabel('Pagada')).toBe('#15803d');
  });

  it('is case/whitespace-insensitive but does not color arbitrary text (e.g. customer names, amounts)', () => {
    expect(toneForStatusLabel('  cerrado  ')).toBe('#15803d');
    expect(toneForStatusLabel('CARMEN HERNANDEZ SANDOVAL')).toBeNull();
    expect(toneForStatusLabel('$126,730.00')).toBeNull();
  });
});

describe('generatePdfReport — status columns render without breaking layout', () => {
  it('a report with real ticketStatus labels still builds a valid, bounded PDF', async () => {
    const out = tmpPdf();
    const rows = [
      { number: 'OV-23381', ticketStatus: 'En tránsito', total: '$5,166.72' },
      { number: 'OV-23380', ticketStatus: 'Pendiente de envío', total: '$126,730.00' },
      { number: 'OV-23311', ticketStatus: 'Cerrado', total: '$14,658.00' },
    ];
    const { sizeBytes, pageCount } = await generatePdfReport(out, {
      title: 'Ticket status',
      columns: [
        { header: 'Orden', key: 'number' },
        { header: 'Ticket', key: 'ticketStatus' },
        { header: 'Total', key: 'total', align: 'right' },
      ],
      rows,
    });
    expect(sizeBytes).toBeGreaterThan(0);
    expect(pageCount).toBe(1);
  });
});
