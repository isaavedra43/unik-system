import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { ChartCard } from './ChartCard';
import { TrendChart } from './TrendChart';

interface EventsPoint {
  hour: string;
  events: number;
  errors: number;
  retries: number;
}

const events: EventsPoint[] = [
  { hour: '08:00', events: 120, errors: 3, retries: 5 },
  { hour: '09:00', events: 180, errors: 6, retries: 8 },
  { hour: '10:00', events: 240, errors: 4, retries: 6 },
  { hour: '11:00', events: 210, errors: 9, retries: 12 },
  { hour: '12:00', events: 260, errors: 5, retries: 7 },
  { hour: '13:00', events: 190, errors: 2, retries: 3 },
  { hour: '14:00', events: 230, errors: 7, retries: 9 },
];

const cash = [
  { day: '2026-09-01', balance: 182000 },
  { day: '2026-09-05', balance: 164500 },
  { day: '2026-09-10', balance: 201300 },
  { day: '2026-09-15', balance: 195750 },
];

const money = (value: number) =>
  value.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

const meta: Meta = {
  title: 'Patterns/Dashboard/TrendChart',
  component: TrendChart,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 720 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

export const Line: Story = {
  render: () => (
    <ChartCard title="Eventos por hora" description="Hoy">
      <TrendChart
        data={events}
        xKey="hour"
        xLabel="Hora"
        series={[
          { key: 'events', label: 'Eventos', tone: 'brand' },
          { key: 'errors', label: 'Errores', tone: 'danger' },
          { key: 'retries', label: 'Reintentos', tone: 'warning' },
        ]}
        ariaLabel="Eventos por hora"
      />
    </ChartCard>
  ),
};

export const Area: Story = {
  render: () => (
    <ChartCard title="Caja 30 días">
      <TrendChart
        kind="area"
        data={cash}
        xKey="day"
        xLabel="Día"
        xFormat={(value) => String(value).slice(5)}
        yFormat={money}
        series={[{ key: 'balance', label: 'Saldo', tone: 'info' }]}
        ariaLabel="Saldo de caja por día"
      />
    </ChartCard>
  ),
};

export const FixedHeight: Story = {
  render: () => (
    <TrendChart
      height={180}
      data={events}
      xKey="hour"
      series={[{ key: 'events', label: 'Eventos', tone: 'success' }]}
      ariaLabel="Eventos por hora"
    />
  ),
};

export const Loading: Story = {
  render: () => <ChartCard title="Eventos por hora" state="loading" />,
};

export const Empty: Story = {
  render: () => (
    <ChartCard title="Eventos por hora">
      <TrendChart
        data={[] as EventsPoint[]}
        xKey="hour"
        series={[{ key: 'events', label: 'Eventos', tone: 'brand' }]}
      />
    </ChartCard>
  ),
};

export const Error: Story = {
  render: () => <ChartCard title="Eventos por hora" state="error" onRetry={fn()} />,
};
