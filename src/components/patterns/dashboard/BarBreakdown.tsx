'use client';

import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  LabelList,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
} from 'recharts';
import { cn } from '@/lib/utils';
import { formatChartValue, type ChartTone } from './chart-theme';
import { useChartTheme } from './use-chart-theme';

export interface BarBreakdownDatum {
  label: string;
  value: number;
  tone?: ChartTone;
}

export interface BarBreakdownProps {
  data: BarBreakdownDatum[];
  /** Formats values (bar labels, tooltip and the accessible table). */
  valueFormat?: (value: number) => string;
  /** Tone for bars without their own tone. Default `brand`. */
  tone?: ChartTone;
  /** Name of the measure shown in the tooltip and table header. */
  valueLabel?: string;
  /** Header of the category column in the accessible table. */
  categoryLabel?: string;
  /** Height in px; defaults to 32px per row. */
  height?: number;
  /** Width reserved for category labels in px. */
  labelWidth?: number;
  ariaLabel?: string;
  emptyText?: string;
  className?: string;
}

const ROW_HEIGHT = 32;
const MIN_HEIGHT = 96;
const BAR_RADIUS: [number, number, number, number] = [0, 4, 4, 0];

/** Horizontal bar ranking by category, themed with the --unik-chart-* palette. */
export function BarBreakdown({
  data,
  valueFormat,
  tone = 'brand',
  valueLabel = 'Valor',
  categoryLabel = 'Categoría',
  height,
  labelWidth = 112,
  ariaLabel = 'Desglose',
  emptyText = 'Sin datos para mostrar en este periodo.',
  className,
}: BarBreakdownProps) {
  const { theme, ref } = useChartTheme();

  if (data.length === 0) {
    return (
      <div className={cn('chart-canvas chart-canvas-empty', className)} style={{ height }}>
        <p className="chart-card-state-text">{emptyText}</p>
      </div>
    );
  }

  const chartHeight = height ?? Math.max(MIN_HEIGHT, data.length * ROW_HEIGHT + 8);
  const colorAt = (index: number) => theme.colors.series[data[index]?.tone ?? tone];
  const renderBar = (props: BarShapeProps) => (
    <Rectangle {...props} radius={BAR_RADIUS} fill={colorAt(props.index)} />
  );
  const tooltipValue = (value: unknown): [ReactNode, ReactNode] => [
    formatChartValue(value, valueFormat),
    valueLabel,
  ];

  return (
    <div ref={ref} className={cn('chart-canvas', className)} style={{ height: chartHeight }}>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 56, bottom: 0, left: 0 }}
          barCategoryGap={8}
          title={ariaLabel}
        >
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis type="category" dataKey="label" {...theme.yAxis} width={labelWidth} />
          <Tooltip
            contentStyle={theme.tooltip.contentStyle}
            labelStyle={theme.tooltip.labelStyle}
            itemStyle={theme.tooltip.itemStyle}
            cursor={theme.tooltip.barCursor}
            formatter={tooltipValue}
          />
          <Bar
            dataKey="value"
            name={valueLabel}
            maxBarSize={18}
            isAnimationActive={false}
            shape={renderBar}
          >
            <LabelList
              dataKey="value"
              position="right"
              formatter={(label) => formatChartValue(label, valueFormat)}
              fill={theme.colors.chrome.tick}
              fontSize="0.75rem"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">{categoryLabel}</th>
            <th scope="col">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{formatChartValue(row.value, valueFormat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
