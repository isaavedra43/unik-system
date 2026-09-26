'use client';

import React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UiChartSeries } from '@/modules/ai/generative-ui/types';

/**
 * Live chart for `renderView` specs (loaded on demand — recharts only ships
 * when a chart is actually shown). Colors come from the agent palette tokens
 * so charts follow light/dark.
 */

export const CHART_COLORS = [
  'var(--agent-hue-1)',
  'var(--agent-hue-4)',
  'var(--agent-hue-2)',
  'var(--agent-hue-3)',
  'var(--agent-hue-7)',
  'var(--agent-hue-9)',
  'var(--agent-hue-5)',
];

const fmt = (unit?: string) => (v: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const abs = Math.abs(n);
  const short =
    abs >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : abs >= 10_000
        ? `${Math.round(n / 1000)}k`
        : n.toLocaleString('es-MX');
  return unit === '$' || unit === 'MXN' ? `$${short}` : unit ? `${short} ${unit}` : short;
};

interface Props {
  chart: 'bar' | 'line' | 'pie';
  labels: string[];
  series: UiChartSeries[];
  unit?: string;
}

export default function ChartView({ chart, labels, series, unit }: Props) {
  const data = labels.map((label, i) => {
    const row: Record<string, string | number> = { label };
    series.forEach((s, si) => {
      row[s.name ?? `Serie ${si + 1}`] = s.data[i] ?? 0;
    });
    return row;
  });
  const keys = series.map((s, si) => s.name ?? `Serie ${si + 1}`);
  const axis = {
    stroke: 'var(--unik-text-muted)',
    fontSize: 11,
    tickLine: false,
    axisLine: false,
  } as const;
  const tooltip = (
    <Tooltip
      cursor={{ fill: 'color-mix(in srgb, var(--unik-text) 5%, transparent)' }}
      contentStyle={{
        background: 'var(--unik-surface)',
        border: '1px solid var(--unik-border)',
        borderRadius: 10,
        fontSize: 12,
        color: 'var(--unik-text)',
      }}
      formatter={(v) => fmt(unit)(Number(v))}
    />
  );

  return (
    <>
      <div className="uv-chart">
        <ResponsiveContainer width="100%" height="100%">
          {chart === 'pie' ? (
            <PieChart>
              {tooltip}
              <Pie
                data={data}
                dataKey={keys[0]}
                nameKey="label"
                innerRadius="52%"
                outerRadius="82%"
                paddingAngle={2}
                stroke="var(--unik-surface)"
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          ) : chart === 'line' ? (
            <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--unik-border-subtle)" />
              <XAxis dataKey="label" {...axis} />
              <YAxis {...axis} width={48} tickFormatter={fmt(unit)} />
              {tooltip}
              {keys.map((k, i) => (
                <Area
                  key={k}
                  type="monotone"
                  dataKey={k}
                  stroke={CHART_COLORS[i % CHART_COLORS.length]}
                  strokeWidth={2}
                  fill={CHART_COLORS[i % CHART_COLORS.length]}
                  fillOpacity={0.12}
                />
              ))}
            </AreaChart>
          ) : (
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--unik-border-subtle)" />
              <XAxis dataKey="label" {...axis} />
              <YAxis {...axis} width={48} tickFormatter={fmt(unit)} />
              {tooltip}
              {keys.map((k, i) => (
                <Bar
                  key={k}
                  dataKey={k}
                  fill={CHART_COLORS[i % CHART_COLORS.length]}
                  radius={[6, 6, 0, 0]}
                  maxBarSize={42}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      {(keys.length > 1 || chart === 'pie') && (
        <div className="uv-chart-legend">
          {(chart === 'pie' ? labels : keys).map((k, i) => (
            <span key={k}>
              <i style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
              {k}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
