import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { AlertTriangle, CheckCircle2, MessageSquare, Truck } from 'lucide-react';
import { KpiGrid } from './KpiGrid';
import { StatCard } from './StatCard';

const meta = {
  title: 'Patterns/Dashboard/StatCard',
  component: StatCard,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 320 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    label: 'Expedientes abiertos',
    value: '128',
    hint: '12 creados hoy',
    icon: <MessageSquare size={20} />,
  },
} satisfies Meta<typeof StatCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithDelta: Story = {
  args: {
    delta: { value: '8%', direction: 'up', label: 'vs. semana anterior' },
  },
};

export const LowerIsBetter: Story = {
  args: {
    label: 'Entregas fallidas 7 d',
    value: '3',
    hint: undefined,
    icon: <Truck size={20} />,
    tone: 'danger',
    delta: { value: '2', direction: 'up', intent: 'negative' },
  },
};

export const Tones: Story = {
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 'none' }}>
        <Story />
      </div>
    ),
  ],
  render: () => (
    <KpiGrid columns={4}>
      <StatCard label="Por defecto" value="42" icon={<MessageSquare size={20} />} />
      <StatCard
        label="Tasa de éxito"
        value="98.2%"
        hint="3 errores"
        tone="success"
        icon={<CheckCircle2 size={20} />}
      />
      <StatCard
        label="Menciones no leídas"
        value="7"
        tone="warning"
        icon={<AlertTriangle size={20} />}
      />
      <StatCard
        label="Alertas activas"
        value="2"
        tone="danger"
        icon={<AlertTriangle size={20} />}
      />
      <StatCard
        label="Solicitudes entrantes"
        value="15"
        tone="info"
        icon={<MessageSquare size={20} />}
      />
      <StatCard label="Sin icono" value="1,204" hint="Valor sin icono decorativo" />
    </KpiGrid>
  ),
};

export const AsLink: Story = {
  args: {
    href: '/app/areas/ventas/trabajo',
    hint: 'Abrir centro de trabajo',
  },
};

export const Live: Story = {
  args: {
    label: 'Entregas en ruta',
    value: '9',
    live: true,
    icon: <Truck size={20} />,
  },
};

export const Loading: Story = {
  args: {
    loading: true,
  },
};
