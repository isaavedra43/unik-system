import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { ChartCard } from './ChartCard';
import { StatusStrip } from './StatusStrip';

const meta = {
  title: 'Patterns/Dashboard/StatusStrip',
  component: StatusStrip,
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
    label: 'Expedientes por fase',
    segments: [
      { key: 'quote', label: 'Cotización', count: 18, tone: 'muted' },
      { key: 'purchase', label: 'Compra', count: 9, tone: 'info' },
      { key: 'manufacturing', label: 'Manufactura', count: 6, tone: 'brand' },
      { key: 'delivery', label: 'Entrega', count: 12, tone: 'success' },
      { key: 'blocked', label: 'Bloqueados', count: 3, tone: 'danger' },
    ],
  },
} satisfies Meta<typeof StatusStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutLegend: Story = {
  args: { showLegend: false },
};

export const InChartCard: Story = {
  render: (args) => (
    <ChartCard title="Expedientes por fase" height="auto">
      <StatusStrip {...args} />
    </ChartCard>
  ),
};

export const Loading: Story = {
  render: () => <ChartCard title="Expedientes por fase" height={72} state="loading" />,
};

export const Empty: Story = {
  args: {
    label: 'Entregas por estado',
    segments: [
      { key: 'planned', label: 'Planeadas', count: 0, tone: 'info' },
      { key: 'delivered', label: 'Entregadas', count: 0, tone: 'success' },
    ],
  },
};

export const Error: Story = {
  render: () => (
    <ChartCard title="Expedientes por fase" height="auto" state="error" onRetry={fn()} />
  ),
};
