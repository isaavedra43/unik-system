export { DataTable } from './DataTable';

// Estados de vistas de datos (EmptyState vive en ui/composite y se re-exporta, no se duplica).
export { EmptyState } from '@/components/ui/composite';
export { ErrorState, type ErrorStateProps } from './ErrorState';
export { LoadingState, type LoadingStateProps, type LoadingStateVariant } from './LoadingState';

// Kit de dashboard sin recharts. Las gráficas (TrendChart, BarBreakdown, useChartTheme)
// NO se re-exportan aquí: viven en '@/components/patterns/dashboard/charts' para que
// importar este barrel nunca meta recharts en el bundle.
export { StatCard, type StatCardProps } from './dashboard/StatCard';
export { KpiGrid, type KpiGridProps } from './dashboard/KpiGrid';
export { ChartCard, type ChartCardProps, type ChartCardState } from './dashboard/ChartCard';
export { StatusStrip, type StatusStripProps } from './dashboard/StatusStrip';
export { AlertList, type AlertListItem, type AlertListProps } from './dashboard/AlertList';
export {
  buildChartTheme,
  CHART_CHROME_TOKENS,
  CHART_TONE_TOKENS,
  CHART_TONES,
  chartToneVar,
  formatChartValue,
  getDefaultChartColors,
  readChartColors,
  resolveChartColors,
  SERIES_TONE_ORDER,
  toneAt,
  type ChartChromeKey,
  type ChartColors,
  type ChartTheme,
  type ChartTone,
} from './dashboard/chart-theme';
export {
  ALERT_SEVERITY_LABEL,
  type AlertSeverity,
  type DeltaDirection,
  type StatDelta,
  type StatTone,
  type StatusSegment,
} from './dashboard/dashboard-utils';
