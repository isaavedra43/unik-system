/**
 * Chart theme for the dashboard kit (Recharts).
 *
 * Pure module (no React): it can be imported from server and client code.
 * Colors always come from the UNIK design tokens:
 *   --unik-chart-1..6 → brand, info, success, warning, danger, text-muted.
 *
 * Before the chart mounts (SSR, first paint) every color is a `var(--unik-*)`
 * string, which SVG presentation attributes and inline styles understand.
 * Once mounted, `readChartColors()` resolves the tokens with
 * `getComputedStyle`, falling back to the semantic source token and finally to
 * `currentColor` when the stylesheet is not loaded (e.g. an isolated preview).
 */

export const CHART_TONES = ['brand', 'info', 'success', 'warning', 'danger', 'muted'] as const;

export type ChartTone = (typeof CHART_TONES)[number];

interface ToneToken {
  /** Chart palette token, e.g. `--unik-chart-1`. */
  chart: string;
  /** Semantic token the palette token derives from. */
  source: string;
}

export const CHART_TONE_TOKENS: Record<ChartTone, ToneToken> = {
  brand: { chart: '--unik-chart-1', source: '--unik-brand' },
  info: { chart: '--unik-chart-2', source: '--unik-info' },
  success: { chart: '--unik-chart-3', source: '--unik-success' },
  warning: { chart: '--unik-chart-4', source: '--unik-warning' },
  danger: { chart: '--unik-chart-5', source: '--unik-danger' },
  muted: { chart: '--unik-chart-6', source: '--unik-text-muted' },
};

/** Non-series chrome of a chart (axes, grid, tooltip). */
export const CHART_CHROME_TOKENS = {
  axis: '--unik-border',
  grid: '--unik-border-subtle',
  tick: '--unik-text-muted',
  legend: '--unik-text-secondary',
  tooltipBg: '--unik-surface',
  tooltipBorder: '--unik-border',
  tooltipText: '--unik-text',
  tooltipLabel: '--unik-text-secondary',
  cursor: '--unik-surface-hover',
} as const;

export type ChartChromeKey = keyof typeof CHART_CHROME_TOKENS;

export interface ChartColors {
  series: Record<ChartTone, string>;
  chrome: Record<ChartChromeKey, string>;
}

/**
 * Order used for series without an explicit tone (`toneAt`). It is NOT the
 * token order: brand and info are two dark blues in the light theme (ΔE ≈ 9,
 * hard to tell apart as 2px lines), so they never sit next to each other.
 * Checked with the dataviz palette validator (OKLab ΔE ×100, Machado 2009
 * protan/deutan) on both themes: worst adjacent pair ΔE 12 CVD / 16.5 normal
 * (light) and 11.1 / 18.5 (dark), above the ≥ 8 CVD target and the ≥ 15
 * normal-vision floor. success and danger come late because they read as
 * "good"/"bad"; a series that really means good/bad picks them explicitly.
 */
export const SERIES_TONE_ORDER = [
  'brand',
  'warning',
  'info',
  'success',
  'muted',
  'danger',
] as const satisfies readonly ChartTone[];

/** Deterministic tone for the n-th series when the caller does not pick one. */
export function toneAt(index: number): ChartTone {
  const size = SERIES_TONE_ORDER.length;
  return SERIES_TONE_ORDER[((index % size) + size) % size];
}

/** `var(--unik-chart-n)` for a tone. Safe in CSS, inline styles and SVG attributes. */
export function chartToneVar(tone: ChartTone): string {
  return `var(${CHART_TONE_TOKENS[tone].chart})`;
}

/** Colors expressed as CSS variables (used before mount and on the server). */
export function getDefaultChartColors(): ChartColors {
  const series = {} as Record<ChartTone, string>;
  for (const tone of CHART_TONES) series[tone] = chartToneVar(tone);
  const chrome = {} as Record<ChartChromeKey, string>;
  for (const key of Object.keys(CHART_CHROME_TOKENS) as ChartChromeKey[]) {
    chrome[key] = `var(${CHART_CHROME_TOKENS[key]})`;
  }
  return { series, chrome };
}

/**
 * Resolves the palette through a token reader (pure, testable).
 * Order: chart token → semantic source token → `currentColor`.
 * Chrome colors fall back to their CSS variable so they still follow the theme.
 */
export function resolveChartColors(readToken: (name: string) => string): ChartColors {
  const read = (name: string) => readToken(name).trim();
  const defaults = getDefaultChartColors();
  const series = {} as Record<ChartTone, string>;
  for (const tone of CHART_TONES) {
    const { chart, source } = CHART_TONE_TOKENS[tone];
    series[tone] = read(chart) || read(source) || 'currentColor';
  }
  const chrome = {} as Record<ChartChromeKey, string>;
  for (const key of Object.keys(CHART_CHROME_TOKENS) as ChartChromeKey[]) {
    chrome[key] = read(CHART_CHROME_TOKENS[key]) || defaults.chrome[key];
  }
  return { series, chrome };
}

/**
 * Reads the resolved palette from the DOM. Without a DOM (server, unit tests)
 * it returns the CSS-variable defaults.
 */
export function readChartColors(element?: Element | null): ChartColors {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return getDefaultChartColors();
  }
  const target = element ?? window.document?.documentElement;
  if (!target) return getDefaultChartColors();
  const styles = window.getComputedStyle(target);
  return resolveChartColors((name) => styles.getPropertyValue(name));
}

/** Default props for axes, grid, tooltip and legend built from a palette. */
export function buildChartTheme(colors: ChartColors = getDefaultChartColors()) {
  const tick = { fill: colors.chrome.tick, fontSize: '0.75rem' };
  return {
    colors,
    grid: {
      stroke: colors.chrome.grid,
      strokeDasharray: '3 3',
      vertical: false,
    },
    xAxis: {
      stroke: colors.chrome.axis,
      tick,
      tickLine: false,
      axisLine: { stroke: colors.chrome.axis },
      tickMargin: 8,
      minTickGap: 16,
    },
    yAxis: {
      stroke: colors.chrome.axis,
      tick,
      tickLine: false,
      axisLine: false,
      width: 56,
    },
    tooltip: {
      contentStyle: {
        background: colors.chrome.tooltipBg,
        border: `1px solid ${colors.chrome.tooltipBorder}`,
        borderRadius: 'var(--unik-radius-md)',
        boxShadow: 'var(--unik-shadow-md)',
        color: colors.chrome.tooltipText,
        fontSize: 'var(--unik-text-xs)',
        padding: 'var(--unik-space-2) var(--unik-space-3)',
      },
      labelStyle: {
        color: colors.chrome.tooltipLabel,
        fontWeight: 600,
        marginBottom: 'var(--unik-space-1)',
      },
      itemStyle: {
        color: colors.chrome.tooltipText,
        padding: 0,
      },
      lineCursor: { stroke: colors.chrome.axis, strokeDasharray: '3 3' },
      barCursor: { fill: colors.chrome.cursor },
    },
    legend: {
      iconType: 'circle' as const,
      iconSize: 8,
      wrapperStyle: {
        color: colors.chrome.legend,
        fontSize: 'var(--unik-text-xs)',
        paddingTop: 'var(--unik-space-2)',
      },
    },
  };
}

export type ChartTheme = ReturnType<typeof buildChartTheme>;

/** Formats a chart value with an optional formatter, tolerating Recharts value shapes. */
export function formatChartValue(value: unknown, format?: (value: number) => string): string {
  if (Array.isArray(value)) return value.map((v) => formatChartValue(v, format)).join(' – ');
  if (typeof value === 'number') {
    return format ? format(value) : value.toLocaleString('es-MX');
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (format && value.trim() !== '' && Number.isFinite(numeric)) return format(numeric);
    return value;
  }
  return value == null ? '—' : String(value);
}
