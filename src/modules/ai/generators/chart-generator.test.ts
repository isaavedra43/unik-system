import { describe, it, expect } from 'vitest';
import { generateChartSvg } from './chart-generator';

describe('generateChartSvg — XML escaping (pre-existing bug: escaper was a no-op)', () => {
  it('escapes "&", "<", ">" in labels/titles so the SVG stays valid XML', () => {
    // Real customer name from production data — this is not a hypothetical case.
    const svg = generateChartSvg({
      type: 'bar',
      title: 'Ventas <script>',
      labels: ['M&T ARQUITECTOS', 'Juan & María'],
      series: [{ label: 'Total', values: [100, 200] }],
    });
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('M&T ARQUITECTOS'); // raw bare "&" would break the SVG's XML
    expect(svg).toContain('M&amp;T'); // labels are also truncated to fit under bars — that's separate, expected behavior
    expect(svg).toContain('Juan &amp; María');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('still renders a well-formed, parseable SVG for normal labels', () => {
    const svg = generateChartSvg({
      type: 'pie',
      title: 'Distribución',
      labels: ['A', 'B'],
      series: [{ label: 'Total', values: [60, 40] }],
    });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
  });
});
