// Gráficas del kit de dashboard. Dependen de recharts, por eso tienen su propio barrel
// y no se re-exportan desde '@/components/patterns'.
export { TrendChart, type TrendChartProps, type TrendSeries } from './TrendChart';
export { BarBreakdown, type BarBreakdownDatum, type BarBreakdownProps } from './BarBreakdown';
export { useChartTheme } from './use-chart-theme';
