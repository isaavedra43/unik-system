import { describe, expect, it } from 'vitest';
import {
  buildChartTheme,
  CHART_TONES,
  chartToneVar,
  formatChartValue,
  getDefaultChartColors,
  readChartColors,
  resolveChartColors,
  SERIES_TONE_ORDER,
  toneAt,
} from './chart-theme';

describe('chart palette', () => {
  it('maps the six tones to --unik-chart-1..6', () => {
    expect(CHART_TONES.map(chartToneVar)).toEqual([
      'var(--unik-chart-1)',
      'var(--unik-chart-2)',
      'var(--unik-chart-3)',
      'var(--unik-chart-4)',
      'var(--unik-chart-5)',
      'var(--unik-chart-6)',
    ]);
  });

  it('cycles the series order for any index', () => {
    expect(toneAt(0)).toBe('brand');
    expect(toneAt(1)).toBe('warning');
    expect(toneAt(6)).toBe('brand');
    expect(toneAt(7)).toBe('warning');
    expect(toneAt(-1)).toBe('danger');
  });

  it('orders series as a permutation of the palette that never puts brand next to info', () => {
    expect([...SERIES_TONE_ORDER].sort()).toEqual([...CHART_TONES].sort());
    const brand = SERIES_TONE_ORDER.indexOf('brand');
    const info = SERIES_TONE_ORDER.indexOf('info');
    expect(Math.abs(brand - info)).toBeGreaterThan(1);
    // Cycling wraps the last tone next to the first one.
    expect(SERIES_TONE_ORDER.at(-1)).not.toBe('info');
    // "good"/"bad" tones are not among the first three default series.
    expect(SERIES_TONE_ORDER.slice(0, 3)).not.toContain('success');
    expect(SERIES_TONE_ORDER.slice(0, 3)).not.toContain('danger');
  });

  it('uses CSS variables by default (server / before mount)', () => {
    const colors = getDefaultChartColors();
    expect(colors.series.success).toBe('var(--unik-chart-3)');
    expect(colors.chrome.tick).toBe('var(--unik-text-muted)');
    expect(readChartColors()).toEqual(colors);
  });
});

describe('resolveChartColors', () => {
  it('prefers the chart token when it resolves', () => {
    const tokens: Record<string, string> = {
      '--unik-chart-1': ' rgb(30, 58, 95) ',
      '--unik-border': 'rgb(228, 231, 236)',
    };
    const colors = resolveChartColors((name) => tokens[name] ?? '');
    expect(colors.series.brand).toBe('rgb(30, 58, 95)');
    expect(colors.chrome.axis).toBe('rgb(228, 231, 236)');
  });

  it('falls back to the semantic source token, then to currentColor', () => {
    const tokens: Record<string, string> = { '--unik-danger': 'rgb(179, 38, 30)' };
    const colors = resolveChartColors((name) => tokens[name] ?? '');
    expect(colors.series.danger).toBe('rgb(179, 38, 30)');
    expect(colors.series.info).toBe('currentColor');
    expect(colors.chrome.grid).toBe('var(--unik-border-subtle)');
  });
});

describe('buildChartTheme', () => {
  it('wires palette colors into axis, grid and tooltip props', () => {
    const colors = resolveChartColors((name) => (name === '--unik-text-muted' ? 'gray' : ''));
    const theme = buildChartTheme(colors);
    expect(theme.xAxis.tick.fill).toBe('gray');
    expect(theme.yAxis.tick.fill).toBe('gray');
    expect(theme.grid.stroke).toBe('var(--unik-border-subtle)');
    expect(theme.tooltip.contentStyle.background).toBe('var(--unik-surface)');
    expect(theme.tooltip.contentStyle.borderRadius).toBe('var(--unik-radius-md)');
  });
});

describe('formatChartValue', () => {
  it('formats numbers, numeric strings and ranges', () => {
    const money = (v: number) => `$${v.toFixed(2)}`;
    expect(formatChartValue(1234.5)).toBe((1234.5).toLocaleString('es-MX'));
    expect(formatChartValue(10, money)).toBe('$10.00');
    expect(formatChartValue('7', money)).toBe('$7.00');
    expect(formatChartValue('abc', money)).toBe('abc');
    expect(formatChartValue([1, 2], money)).toBe('$1.00 – $2.00');
    expect(formatChartValue(null)).toBe('—');
  });
});
