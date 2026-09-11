import { describe, it, expect } from 'vitest';
import { generateReportImageSvg } from './image-report-generator';

describe('generateReportImageSvg', () => {
  const columns = [
    { header: 'Orden', key: 'number' },
    { header: 'Cliente', key: 'customer' },
    { header: 'Ticket', key: 'ticketStatus' },
    { header: 'Total', key: 'total', align: 'right' as const },
  ];

  it('builds a valid, well-formed SVG for a small dataset', () => {
    const rows = [
      { number: 'OV-23380', customer: 'CARMEN HERNANDEZ SANDOVAL', ticketStatus: 'Pendiente de envío', total: '$126,730.00' },
      { number: 'OV-23311', customer: 'ABEL TAVAREZ', ticketStatus: 'Cerrado', total: '$14,658.00' },
    ];
    const { svg, width, height, rowsShown, rowsOmitted } = generateReportImageSvg({
      title: 'Ventas Pendientes',
      logoText: 'UNIK',
      columns,
      rows,
    });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('Ventas Pendientes');
    expect(svg).toContain('OV-23380');
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(rowsShown).toBe(2);
    expect(rowsOmitted).toBe(0);
  });

  it('colors known status labels (e.g. "Cerrado") without coloring arbitrary text', () => {
    const rows = [{ number: 'OV-1', customer: 'ALGUIEN', ticketStatus: 'Cerrado', total: '$100.00' }];
    const { svg } = generateReportImageSvg({ title: 'T', columns, rows });
    // The "Cerrado" cell gets the success color; the customer name does not.
    expect(svg).toMatch(/fill="#15803d"[^>]*>Cerrado</);
    expect(svg).not.toMatch(/fill="#15803d"[^>]*>ALGUIEN</);
  });

  it('caps rows at maxRows and reports how many were omitted', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ number: `OV-${i}`, customer: 'X', ticketStatus: 'Abierto', total: '$1.00' }));
    const { rowsShown, rowsOmitted, svg } = generateReportImageSvg({ title: 'T', columns, rows, maxRows: 10 });
    expect(rowsShown).toBe(10);
    expect(rowsOmitted).toBe(40);
    expect(svg).toContain('+40 más');
  });

  it('renders summary/KPI cards when provided', () => {
    const { svg } = generateReportImageSvg({
      title: 'T',
      columns,
      rows: [],
      summaryCards: [{ label: 'Total', value: '$500,000.00' }, { label: 'Órdenes', value: '13' }],
    });
    expect(svg).toContain('TOTAL');
    expect(svg).toContain('$500,000.00');
    expect(svg).toContain('13');
  });

  it('handles zero rows without throwing', () => {
    expect(() => generateReportImageSvg({ title: 'Vacío', columns, rows: [] })).not.toThrow();
  });

  it('truncates a very long value instead of blowing up column width', () => {
    const rows = [{ number: 'OV-1', customer: 'X'.repeat(500), ticketStatus: 'Abierto', total: '$1.00' }];
    const { svg, width } = generateReportImageSvg({ title: 'T', columns, rows });
    expect(svg).toContain('…');
    expect(width).toBeLessThan(2000); // column width is capped, not proportional to the 500-char value
  });

  it('escapes XML-sensitive characters in titles and values', () => {
    const rows = [{ number: 'OV-1', customer: 'Juan & María <VIP>', ticketStatus: 'Abierto', total: '$1.00' }];
    const { svg } = generateReportImageSvg({ title: 'Reporte "especial" <2026>', columns, rows });
    expect(svg).not.toContain('<VIP>');
    expect(svg).not.toContain('<2026>');
    expect(svg).toContain('&amp;');
  });
});
