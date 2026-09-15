import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { AlertList } from './AlertList';
import { ChartCard } from './ChartCard';

const meta = {
  title: 'Patterns/Dashboard/AlertList',
  component: AlertList,
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
    label: 'Alertas de logística',
    emptyText: 'Sin alertas: todo está en orden.',
    items: [
      {
        id: 'a1',
        severity: 'danger',
        title: 'Entrega EXP-0142 en conflicto con Zoho',
        detail: 'El paquete cambió de transportista fuera de UNIK.',
        href: '/app/areas/logistica/trabajo',
        at: '2026-09-15T09:42:00.000Z',
      },
      {
        id: 'a2',
        severity: 'warning',
        title: 'Viaje V-88 sin chofer asignado',
        detail: 'Sale hoy a las 14:00.',
        at: '2026-09-15T08:10:00.000Z',
      },
      {
        id: 'a3',
        severity: 'info',
        title: '3 entregas confirmadas por el cliente',
        at: '2026-09-15T07:55:00.000Z',
      },
      {
        id: 'a4',
        severity: 'warning',
        title: 'Entrega EXP-0139 fallida',
        detail: 'Domicilio cerrado; reprogramar.',
      },
    ],
  },
} satisfies Meta<typeof AlertList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithMax: Story = {
  args: { max: 2 },
};

export const WithMaxAndLink: Story = {
  args: { max: 2, moreHref: '/app/admin/control-tower/excepciones' },
};

export const InChartCard: Story = {
  render: (args) => (
    <ChartCard title="Alertas" height="auto">
      <AlertList {...args} />
    </ChartCard>
  ),
};

export const Loading: Story = {
  render: () => <ChartCard title="Alertas" height={160} state="loading" />,
};

export const Empty: Story = {
  args: { items: [] },
};

export const Error: Story = {
  render: () => <ChartCard title="Alertas" height="auto" state="error" onRetry={fn()} />,
};
