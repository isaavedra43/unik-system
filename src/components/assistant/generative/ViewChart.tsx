'use client';

import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UiChartSeries } from '@/modules/ai/generative-ui/types';

/**
 * Live chart for `renderView` specs. Recharts is only loaded when a view is
 * actually emitted (dynamic import at the call site).
 */

const PALETTE = [
  'var(--unik-accent, #6366f1)',
  'var(--unik-success, #16a34a)',
  'var(--unik-warning, #d97706)',
  'var(--unik-danger, #dc2626)',
];

interface Props {
  chart: 'bar' | 'line' | 'pie';
  labels: string[];
  series: UiChartSeries[];
  unit?: string;
}

export default function ViewChart({ chart, labels, series, unit }: Props) {
  const data = labels.map((label, i) => {
    const row: Record<string, string | number> = { label };
    for (const s of series) row[s.name ?? 'valor'] = s.data[i] ?? 0;
    return row;
  });

  const tooltip = (
    <Tooltip
      formatter={(v) => (v == null ? '' : unit ? `${String(v)} ${unit}` : String(v))}
      contentStyle={{ fontSize: 12, borderRadius: 8 }}
    />
  );

  if (chart === 'pie') {
    const pieData = labels.map((label, i) => ({
      name: label,
      value: series[0]?.data[i] ?? 0,
    }));
    return (
      <div className="gui-chart" role="img" aria-label="Gráfica de pastel">
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={48} outerRadius={80} paddingAngle={2}>
              {pieData.map((_, i) => (
                <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
            {tooltip}
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart === 'line') {
    return (
      <div className="gui-chart" role="img" aria-label="Gráfica de líneas">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--unik-border)" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
            {tooltip}
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {series.map((s, i) => (
              <Line
                key={s.name ?? i}
                type="monotone"
                dataKey={s.name ?? 'valor'}
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="gui-chart" role="img" aria-label="Gráfica de barras">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--unik-border)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
          {tooltip}
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {series.map((s, i) => (
            <Bar
              key={s.name ?? i}
              dataKey={s.name ?? 'valor'}
              fill={PALETTE[i % PALETTE.length]}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
