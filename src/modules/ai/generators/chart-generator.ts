/**
 * SVG Chart Generator
 *
 * Generates professional charts as SVG strings (no native dependencies needed).
 * Supports: bar, horizontal bar, line, pie, doughnut.
 *
 * The SVG is stored inline in the database and rendered in the chat.
 */

type ChartType = 'bar' | 'horizontal-bar' | 'line' | 'pie' | 'doughnut';

interface ChartSeries {
  label: string;
  values: number[];
}

interface ChartOptions {
  type: ChartType;
  title: string;
  subtitle?: string;
  labels: string[];
  series: ChartSeries[];
  width?: number;
  height?: number;
  brandColor?: string;
  colors?: string[];
  showLegend?: boolean;
  showValues?: boolean;
  horizontalGrid?: boolean;
}

const DEFAULT_COLORS = [
  '#2563eb', '#16a34a', '#dc2626', '#ca8a04', '#9333ea',
  '#0891b2', '#ea580c', '#4f46e5', '#059669', '#be185d',
];

const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 380;
const MARGIN = { top: 50, right: 30, bottom: 50, left: 60 };

export function generateChartSvg(options: ChartOptions): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const colors = options.colors ?? DEFAULT_COLORS;
  const brandColor = options.brandColor ?? DEFAULT_COLORS[0];

  switch (options.type) {
    case 'bar':
      return generateBarChart(options, width, height, colors, brandColor);
    case 'horizontal-bar':
      return generateHorizontalBarChart(options, width, height, colors, brandColor);
    case 'line':
      return generateLineChart(options, width, height, colors, brandColor);
    case 'pie':
      return generatePieChart(options, width, height, colors, brandColor, false);
    case 'doughnut':
      return generatePieChart(options, width, height, colors, brandColor, true);
    default:
      return generateBarChart(options, width, height, colors, brandColor);
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
}

function truncateLabel(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

function generateBarChart(
  opts: ChartOptions,
  width: number,
  height: number,
  colors: string[],
  brandColor: string
): string {
  const chartW = width - MARGIN.left - MARGIN.right;
  const chartH = height - MARGIN.top - MARGIN.bottom;
  const series = opts.series[0];
  const maxVal = Math.max(...series.values, 1);
  const barWidth = chartW / opts.labels.length * 0.65;
  const barGap = chartW / opts.labels.length * 0.35;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`;
  svg += `<rect width="${width}" height="${height}" fill="#ffffff" rx="8"/>`;

  // Title
  svg += `<text x="${width / 2}" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">${escapeXml(opts.title)}</text>`;
  if (opts.subtitle) {
    svg += `<text x="${width / 2}" y="42" text-anchor="middle" font-size="11" fill="#64748b">${escapeXml(opts.subtitle)}</text>`;
  }

  // Grid lines
  if (opts.horizontalGrid !== false) {
    for (let i = 0; i <= 5; i++) {
      const y = MARGIN.top + (chartH / 5) * i;
      svg += `<line x1="${MARGIN.left}" y1="${y}" x2="${MARGIN.left + chartW}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`;
      const val = maxVal - (maxVal / 5) * i;
      svg += `<text x="${MARGIN.left - 8}" y="${y + 4}" text-anchor="end" font-size="9" fill="#94a3b8">${val.toFixed(0)}</text>`;
    }
  }

  // Bars
  opts.labels.forEach((label, i) => {
    const val = series.values[i] ?? 0;
    const barH = (val / maxVal) * chartH;
    const x = MARGIN.left + i * (barWidth + barGap) + barGap / 2;
    const y = MARGIN.top + chartH - barH;
    const color = colors[i % colors.length];
    svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${color}" rx="3"/>`;
    if (opts.showValues) {
      svg += `<text x="${x + barWidth / 2}" y="${y - 5}" text-anchor="middle" font-size="10" fill="#475569" font-weight="bold">${val}</text>`;
    }
    svg += `<text x="${x + barWidth / 2}" y="${MARGIN.top + chartH + 18}" text-anchor="middle" font-size="9" fill="#64748b">${escapeXml(truncateLabel(label, 12))}</text>`;
  });

  // X axis
  svg += `<line x1="${MARGIN.left}" y1="${MARGIN.top + chartH}" x2="${MARGIN.left + chartW}" y2="${MARGIN.top + chartH}" stroke="#cbd5e1" stroke-width="1.5"/>`;
  svg += `</svg>`;
  return svg;
}

function generateHorizontalBarChart(
  opts: ChartOptions,
  width: number,
  height: number,
  colors: string[],
  brandColor: string
): string {
  const labelWidth = 120;
  const chartW = width - MARGIN.left - MARGIN.right - labelWidth;
  const barHeight = Math.min(30, (height - MARGIN.top - MARGIN.bottom) / opts.labels.length * 0.7);
  const gap = (height - MARGIN.top - MARGIN.bottom) / opts.labels.length * 0.3;
  const series = opts.series[0];
  const maxVal = Math.max(...series.values, 1);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`;
  svg += `<rect width="${width}" height="${height}" fill="#ffffff" rx="8"/>`;
  svg += `<text x="${width / 2}" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">${escapeXml(opts.title)}</text>`;
  if (opts.subtitle) {
    svg += `<text x="${width / 2}" y="42" text-anchor="middle" font-size="11" fill="#64748b">${escapeXml(opts.subtitle)}</text>`;
  }

  opts.labels.forEach((label, i) => {
    const val = series.values[i] ?? 0;
    const barW = (val / maxVal) * chartW;
    const y = MARGIN.top + i * (barHeight + gap);
    const color = colors[i % colors.length];
    svg += `<text x="${MARGIN.left}" y="${y + barHeight / 2 + 4}" font-size="9" fill="#64748b">${escapeXml(truncateLabel(label, 16))}</text>`;
    svg += `<rect x="${MARGIN.left + labelWidth}" y="${y}" width="${barW}" height="${barHeight}" fill="${color}" rx="3"/>`;
    if (opts.showValues) {
      svg += `<text x="${MARGIN.left + labelWidth + barW + 6}" y="${y + barHeight / 2 + 4}" font-size="10" fill="#475569" font-weight="bold">${val}</text>`;
    }
  });

  svg += `</svg>`;
  return svg;
}

function generateLineChart(
  opts: ChartOptions,
  width: number,
  height: number,
  colors: string[],
  brandColor: string
): string {
  const chartW = width - MARGIN.left - MARGIN.right;
  const chartH = height - MARGIN.top - MARGIN.bottom;
  const allValues = opts.series.flatMap((s) => s.values);
  const maxVal = Math.max(...allValues, 1);
  const minVal = Math.min(...allValues, 0);
  const range = maxVal - minVal || 1;
  const stepX = chartW / Math.max(opts.labels.length - 1, 1);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`;
  svg += `<rect width="${width}" height="${height}" fill="#ffffff" rx="8"/>`;
  svg += `<text x="${width / 2}" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">${escapeXml(opts.title)}</text>`;
  if (opts.subtitle) {
    svg += `<text x="${width / 2}" y="42" text-anchor="middle" font-size="11" fill="#64748b">${escapeXml(opts.subtitle)}</text>`;
  }

  // Grid
  for (let i = 0; i <= 5; i++) {
    const y = MARGIN.top + (chartH / 5) * i;
    svg += `<line x1="${MARGIN.left}" y1="${y}" x2="${MARGIN.left + chartW}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`;
    const val = maxVal - (range / 5) * i;
    svg += `<text x="${MARGIN.left - 8}" y="${y + 4}" text-anchor="end" font-size="9" fill="#94a3b8">${val.toFixed(0)}</text>`;
  }

  // X labels
  opts.labels.forEach((label, i) => {
    const x = MARGIN.left + i * stepX;
    svg += `<text x="${x}" y="${MARGIN.top + chartH + 18}" text-anchor="middle" font-size="9" fill="#64748b">${escapeXml(truncateLabel(label, 10))}</text>`;
  });

  // Lines
  opts.series.forEach((s, sIdx) => {
    const color = colors[sIdx % colors.length];
    let points = '';
    s.values.forEach((val, i) => {
      const x = MARGIN.left + i * stepX;
      const y = MARGIN.top + chartH - ((val - minVal) / range) * chartH;
      points += `${x},${y} `;
    });
    svg += `<polyline points="${points.trim()}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    // Dots
    s.values.forEach((val, i) => {
      const x = MARGIN.left + i * stepX;
      const y = MARGIN.top + chartH - ((val - minVal) / range) * chartH;
      svg += `<circle cx="${x}" cy="${y}" r="3" fill="${color}"/>`;
      if (opts.showValues) {
        svg += `<text x="${x}" y="${y - 8}" text-anchor="middle" font-size="9" fill="#475569" font-weight="bold">${val}</text>`;
      }
    });
  });

  // Legend
  if (opts.showLegend && opts.series.length > 1) {
    let legendX = MARGIN.left;
    const legendY = height - 15;
    opts.series.forEach((s, i) => {
      const color = colors[i % colors.length];
      svg += `<rect x="${legendX}" y="${legendY - 8}" width="10" height="10" fill="${color}" rx="2"/>`;
      svg += `<text x="${legendX + 14}" y="${legendY}" font-size="9" fill="#64748b">${escapeXml(s.label)}</text>`;
      legendX += s.label.length * 6 + 30;
    });
  }

  svg += `</svg>`;
  return svg;
}

function generatePieChart(
  opts: ChartOptions,
  width: number,
  height: number,
  colors: string[],
  brandColor: string,
  isDoughnut: boolean
): string {
  const cx = width / 2;
  const cy = height / 2 + 10;
  const radius = Math.min(width, height) / 3;
  const innerRadius = isDoughnut ? radius * 0.55 : 0;
  const series = opts.series[0];
  const total = series.values.reduce((s, v) => s + v, 0) || 1;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`;
  svg += `<rect width="${width}" height="${height}" fill="#ffffff" rx="8"/>`;
  svg += `<text x="${width / 2}" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">${escapeXml(opts.title)}</text>`;
  if (opts.subtitle) {
    svg += `<text x="${width / 2}" y="42" text-anchor="middle" font-size="11" fill="#64748b">${escapeXml(opts.subtitle)}</text>`;
  }

  let currentAngle = -Math.PI / 2;
  opts.labels.forEach((label, i) => {
    const val = series.values[i] ?? 0;
    const angle = (val / total) * Math.PI * 2;
    const endAngle = currentAngle + angle;
    const color = colors[i % colors.length];

    // Arc path
    const x1 = cx + radius * Math.cos(currentAngle);
    const y1 = cy + radius * Math.sin(currentAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);
    const x3 = cx + innerRadius * Math.cos(endAngle);
    const y3 = cy + innerRadius * Math.sin(endAngle);
    const x4 = cx + innerRadius * Math.cos(currentAngle);
    const y4 = cy + innerRadius * Math.sin(currentAngle);
    const largeArc = angle > Math.PI ? 1 : 0;

    let path = `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;
    if (isDoughnut) {
      path += ` L ${x3} ${y3} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x4} ${y4} Z`;
    } else {
      path += ` L ${cx} ${cy} Z`;
    }
    svg += `<path d="${path}" fill="${color}" stroke="#fff" stroke-width="2"/>`;

    // Label
    const midAngle = currentAngle + angle / 2;
    const labelR = radius * 0.7;
    const lx = cx + labelR * Math.cos(midAngle);
    const ly = cy + labelR * Math.sin(midAngle);
    const pct = ((val / total) * 100).toFixed(1);
    if (pct !== '0.0') {
      svg += `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="10" fill="#fff" font-weight="bold">${pct}%</text>`;
    }

    currentAngle = endAngle;
  });

  // Legend
  const legendY = height - 20;
  if (opts.labels.length > 0) {
    const legendItemWidth = width / Math.min(opts.labels.length, 5);
    opts.labels.forEach((label, i) => {
      if (i >= 5) return;
      const color = colors[i % colors.length];
      const lx = 20 + i * legendItemWidth;
      svg += `<rect x="${lx}" y="${legendY}" width="10" height="10" fill="${color}" rx="2"/>`;
      svg += `<text x="${lx + 14}" y="${legendY + 9}" font-size="9" fill="#64748b">${escapeXml(truncateLabel(label, 15))}</text>`;
    });
  }

  svg += `</svg>`;
  return svg;
}
