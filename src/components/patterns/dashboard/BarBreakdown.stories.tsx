import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { BarBreakdown } from './BarBreakdown';
import { ChartCard } from './ChartCard';

const meta = {
  title: 'Patterns/Dashboard/BarBreakdown',
  component: BarBreakdown,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    ariaLabel: 'Vencidos por área',
    valueLabel: 'Vencidos',
    categoryLabel: 'Área',
    data: [
      { label: 'Ventas', value: 14 },
      { label: 'Compras', value: 9 },
      { label: 'Inventario', value: 6 },
      { label: 'Manufactura', value: 4 },
      { label: 'Logística', value: 11, tone: 'warning' },
      { label: 'Contabilidad', value: 2 },
    ],
  },
} satisfies Meta<typeof BarBreakdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Formatted: Story = {
  args: {
    ariaLabel: 'Presupuesto consumido por categoría',
    valueLabel: 'Consumido',
    categoryLabel: 'Categoría',
    tone: 'info',
    valueFormat: (value) =>
      value.toLocaleString('es-MX', {
        style: 'currency',
        currency: 'MXN',
        maximumFractionDigits: 0,
      }),
    data: [
      { label: 'Fletes', value: 84500 },
      { label: 'Materia prima', value: 312000 },
      { label: 'Servicios', value: 41200 },
      { label: 'Nómina', value: 256000, tone: 'danger' },
    ],
  },
};

export const InChartCard: Story = {
  render: (args) => (
    <ChartCard title="Vencidos por área" height="auto">
      <BarBreakdown {...args} />
    </ChartCard>
  ),
};

/** 10 rows inside a ChartCard with its default height (240px): the card grows, bars stay inside. */
export const ManyRowsDefaultHeight: Story = {
  args: {
    data: [
      { label: 'Ventas', value: 14 },
      { label: 'Compras', value: 9 },
      { label: 'Inventario', value: 6 },
      { label: 'Manufactura', value: 4 },
      { label: 'Logística', value: 11, tone: 'warning' },
      { label: 'Contabilidad', value: 2 },
      { label: 'Administración', value: 3 },
      { label: 'Calidad', value: 5 },
      { label: 'Mantenimiento', value: 1 },
      { label: 'Atención a clientes', value: 7 },
    ],
  },
  render: (args) => (
    <ChartCard title="Vencidos por área">
      <BarBreakdown {...args} />
    </ChartCard>
  ),
};

export const Loading: Story = {
  render: () => <ChartCard title="Vencidos por área" state="loading" />,
};

export const Empty: Story = {
  args: { data: [] },
};

export const Error: Story = {
  render: () => <ChartCard title="Vencidos por área" state="error" onRetry={fn()} />,
};
