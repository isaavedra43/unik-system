'use client';

import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/utils';
import { formatChartValue, type ChartTone } from './chart-theme';
import { useChartTheme } from './use-chart-theme';

type StringKey<T> = Extract<keyof T, string>;

export interface TrendSeries<TDatum extends object> {
  key: StringKey<TDatum>;
  label: string;
  tone: ChartTone;
}

export interface TrendChartProps<TDatum extends object> {
  data: readonly TDatum[];
  series: TrendSeries<TDatum>[];
  kind?: 'line' | 'area';
  xKey: StringKey<TDatum>;
  /** Formats Y values (axis ticks, tooltip and the accessible table). */
  yFormat?: (value: number) => string;
  /**
   * The series counts things (expedientes, entregas, conteos): the axis shows
   * whole numbers only. Without it Recharts offers ticks like `0.25`, and half
   * an expediente does not exist.
   */
  integerY?: boolean;
  /** Formats X values (axis ticks, tooltip label and the accessible table). */
  xFormat?: (value: string | number) => string;
  /** Height in px; defaults to filling the parent (e.g. ChartCard). */
  height?: number;
  /** Accessible title of the chart and caption of its data table. */
  ariaLabel?: string;
  /** Header of the X column in the accessible table. */
  xLabel?: string;
  showLegend?: boolean;
  emptyText?: string;
  className?: string;
}

const MARGIN = { top: 8, right: 12, bottom: 0, left: 0 };

/** Time series (line or area) themed with the --unik-chart-* palette. */
export function TrendChart<TDatum extends object>({
  data,
  series,
  kind = 'line',
  xKey,
  yFormat,
  integerY,
  xFormat,
  height,
  ariaLabel = 'Tendencia',
  xLabel = 'Periodo',
  showLegend,
  emptyText = 'Sin datos para mostrar en este periodo.',
  className,
}: TrendChartProps<TDatum>) {
  const { theme, ref } = useChartTheme();

  if (data.length === 0 || series.length === 0) {
    return (
      <div className={cn('chart-canvas chart-canvas-empty', className)} style={{ height }}>
        <p className="chart-card-state-text">{emptyText}</p>
      </div>
    );
  }

  const rows = data as TDatum[];
  const legend = showLegend ?? series.length > 1;
  const formatX = (value: unknown): string =>
    xFormat && (typeof value === 'string' || typeof value === 'number')
      ? xFormat(value)
      : formatChartValue(value);
  const tooltipLabel = (label: ReactNode): ReactNode =>
    typeof label === 'string' || typeof label === 'number' ? formatX(label) : label;
  const tooltipValue = (value: unknown, name: unknown): [ReactNode, ReactNode] => [
    formatChartValue(value, yFormat),
    typeof name === 'string' || typeof name === 'number' ? name : '',
  ];
  const legendLabel = (value: unknown) => (
    <span className="chart-legend-label">{String(value)}</span>
  );

  const axes = (
    <>
      <CartesianGrid {...theme.grid} />
      <XAxis dataKey={xKey} {...theme.xAxis} tickFormatter={(value) => formatX(value)} />
      <YAxis
        {...theme.yAxis}
        {...(integerY ? { allowDecimals: false, domain: [0, 'auto'] as const } : {})}
        tickFormatter={(value) => formatChartValue(value, yFormat)}
      />
      <Tooltip
        contentStyle={theme.tooltip.contentStyle}
        labelStyle={theme.tooltip.labelStyle}
        itemStyle={theme.tooltip.itemStyle}
        cursor={theme.tooltip.lineCursor}
        labelFormatter={tooltipLabel}
        formatter={tooltipValue}
      />
      {legend ? <Legend {...theme.legend} formatter={legendLabel} /> : null}
    </>
  );

  return (
    <div ref={ref} className={cn('chart-canvas', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height={height ?? '100%'} minHeight={160}>
        {kind === 'area' ? (
          <AreaChart data={rows} margin={MARGIN} title={ariaLabel}>
            {axes}
            {series.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={theme.colors.series[s.tone]}
                fill={theme.colors.series[s.tone]}
                fillOpacity={0.12}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={rows} margin={MARGIN} title={ariaLabel}>
            {axes}
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={theme.colors.series[s.tone]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">{xLabel}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <th scope="row">{formatX(row[xKey])}</th>
              {series.map((s) => (
                <td key={s.key}>{formatChartValue(row[s.key], yFormat)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
