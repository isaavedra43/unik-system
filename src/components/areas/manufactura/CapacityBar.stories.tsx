import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { CapacityBar } from './CapacityBar';

const meta = {
  title: 'Operaciones/Manufactura/CapacityBar',
  component: CapacityBar,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof CapacityBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Saludable: Story = {
  args: {
    centerName: 'Corte',
    capacityUnitLabel: 'm²',
    windows: [
      {
        shiftName: 'Matutino',
        day: '2026-09-16',
        start: '2026-09-16T13:00:00.000Z',
        end: '2026-09-16T21:00:00.000Z',
        capacity: 120,
        load: 54,
        available: 66,
        utilizationPct: 45,
        overloaded: false,
      },
      {
        shiftName: 'Vespertino',
        day: '2026-09-16',
        start: '2026-09-16T21:00:00.000Z',
        end: '2026-09-17T05:00:00.000Z',
        capacity: 120,
        load: 96,
        available: 24,
        utilizationPct: 80,
        overloaded: false,
      },
    ],
  },
};

export const Sobrecargado: Story = {
  args: {
    centerName: 'Acabado',
    capacityUnitLabel: 'minutos',
    windows: [
      {
        shiftName: 'Matutino',
        day: '2026-09-16',
        start: '2026-09-16T13:00:00.000Z',
        end: '2026-09-16T21:00:00.000Z',
        capacity: 480,
        load: 612,
        available: -132,
        utilizationPct: 127.5,
        overloaded: true,
      },
      {
        shiftName: 'Vespertino',
        day: '2026-09-16',
        start: '2026-09-16T21:00:00.000Z',
        end: '2026-09-17T05:00:00.000Z',
        capacity: 480,
        load: 432,
        available: 48,
        utilizationPct: 90,
        overloaded: false,
      },
      {
        shiftName: 'Matutino',
        day: '2026-09-17',
        start: '2026-09-17T13:00:00.000Z',
        end: '2026-09-17T21:00:00.000Z',
        capacity: 480,
        load: 120,
        available: 360,
        utilizationPct: 25,
        overloaded: false,
      },
      {
        shiftName: 'Vespertino',
        day: '2026-09-17',
        start: '2026-09-17T21:00:00.000Z',
        end: '2026-09-18T05:00:00.000Z',
        capacity: 480,
        load: 0,
        available: 480,
        utilizationPct: 0,
        overloaded: false,
      },
    ],
  },
};

export const SinTurnos: Story = {
  args: {
    centerName: 'Pintura',
    capacityUnitLabel: 'piezas',
    windows: [],
  },
};
