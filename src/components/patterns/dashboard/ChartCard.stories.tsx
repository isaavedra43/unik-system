import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { RefreshCw } from 'lucide-react';
import { fn } from 'storybook/test';
import { Button } from '@/components/shadcn/button';
import { BarBreakdown } from './BarBreakdown';
import { ChartCard } from './ChartCard';
import { TrendChart } from './TrendChart';

const trend = [
  { day: '09-01', created: 12, closed: 8 },
  { day: '09-02', created: 15, closed: 11 },
  { day: '09-03', created: 9, closed: 14 },
  { day: '09-04', created: 18, closed: 12 },
  { day: '09-05', created: 14, closed: 16 },
  { day: '09-06', created: 7, closed: 9 },
  { day: '09-07', created: 11, closed: 10 },
];

const meta = {
  title: 'Patterns/Dashboard/ChartCard',
  component: ChartCard,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    title: 'Creados vs cerrados (30 días)',
    description: 'Expedientes de venta por día',
    onRetry: fn(),
    children: (
      <TrendChart
        data={trend}
        xKey="day"
        series={[
          { key: 'created', label: 'Creados', tone: 'brand' },
          { key: 'closed', label: 'Cerrados', tone: 'success' },
        ]}
        ariaLabel="Creados vs cerrados por día"
      />
    ),
  },
} satisfies Meta<typeof ChartCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithChart: Story = {};

export const WithActions: Story = {
  args: {
    actions: (
      <Button type="button" variant="outline" size="sm">
        <RefreshCw aria-hidden="true" />
        Actualizar
      </Button>
    ),
  },
};

export const AutoHeight: Story = {
  args: {
    title: 'Vencidos por área',
    description: undefined,
    height: 'auto',
    children: (
      <BarBreakdown
        data={[
          { label: 'Ventas', value: 12 },
          { label: 'Compras', value: 7 },
          { label: 'Logística', value: 5, tone: 'warning' },
          { label: 'Contabilidad', value: 2 },
        ]}
        valueLabel="Vencidos"
        ariaLabel="Vencidos por área"
      />
    ),
  },
};

export const Loading: Story = {
  args: { state: 'loading' },
};

export const Empty: Story = {
  args: { state: 'empty' },
};

export const EmptyCustomText: Story = {
  args: { state: 'empty', emptyText: 'Todavía no hay expedientes cerrados este mes.' },
};

export const Error: Story = {
  args: { state: 'error', errorText: 'El servidor tardó demasiado en responder.' },
};
