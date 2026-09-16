import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { Play } from 'lucide-react';
import '@/styles/operations/neural-ops.css';
import { Button } from '@/components/ui/primitives';
import { TimeSlider } from './TimeSlider';
import { formatDateTime, formatDay } from './neural-model';

const EVENTS = [
  '2026-03-01T08:15:00.000Z',
  '2026-03-01T09:40:00.000Z',
  '2026-03-01T12:05:00.000Z',
  '2026-03-02T07:30:00.000Z',
  '2026-03-03T16:45:00.000Z',
];

const meta = {
  title: 'Control Tower/Neural/TimeSlider',
  component: TimeSlider,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    label: 'Instante reproducido',
    value: 2,
    min: 0,
    max: EVENTS.length - 1,
    onChange: fn(),
    formatValue: (value: number) => formatDateTime(EVENTS[value] ?? null),
    minLabel: 'Inicio',
    maxLabel: 'Último evento',
  },
} satisfies Meta<typeof TimeSlider>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Recorre los eventos de un expediente (←/→, Inicio/Fin con el teclado). */
export const PorEvento: Story = {};

/** Con ayuda debajo del control. */
export const ConDescripcion: Story = {
  args: {
    description: 'Mueve el deslizador para ver cómo estaba el expediente en ese momento.',
  },
};

/** Con el botón de reproducir al lado (un evento por segundo). */
export const ConReproduccion: Story = {
  args: {
    actions: (
      <Button type="button" variant="secondary" size="sm" icon={<Play className="h-4 w-4" />}>
        Reproducir
      </Button>
    ),
  },
};

/** Fijando el instante del grafo: 0 es ahora, a la izquierda se retrocede. */
export const InstanteDelGrafo: Story = {
  args: {
    label: 'Instante de la red',
    value: -14,
    min: -90,
    max: 0,
    formatValue: (value: number) =>
      value === 0
        ? 'Ahora'
        : formatDay(new Date(Date.parse('2026-03-31T00:00:00.000Z') + value * 86_400_000)),
    minLabel: 'Hace 90 días',
    maxLabel: 'Ahora',
    description: 'La red se reconstruye con las relaciones vigentes en ese momento.',
  },
};

/** Sin historia que recorrer: el control se deshabilita en vez de mentir. */
export const SinHistoria: Story = {
  args: { value: 0, min: 0, max: 0, formatValue: () => 'Sin eventos', minLabel: '', maxLabel: '' },
};

function InteractiveTimeSlider(args: React.ComponentProps<typeof TimeSlider>) {
  const [value, setValue] = useState(0);
  return (
    <TimeSlider
      {...args}
      value={value}
      onChange={setValue}
      formatValue={(current) => formatDateTime(EVENTS[current] ?? null)}
    />
  );
}

/** Interactivo: el valor cambia de verdad al moverlo. */
export const Interactivo: Story = {
  render: (args) => <InteractiveTimeSlider {...args} />,
};
