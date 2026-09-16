import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import '@/styles/operations/neural-ops.css';
import { StepNode } from './StepNode';
import type { ProcessStepView } from './process-model';

const BASE: ProcessStepView = {
  key: 'comprar_material',
  label: 'Comprar material faltante',
  areaKey: 'compras',
  areaLabel: 'Compras',
  areaTone: 'info',
  layer: 1,
  order: 0,
  x: 0,
  y: 0,
  width: 220,
  height: 84,
  metrics: {
    started: 42,
    completed: 38,
    p50ActiveMin: 90,
    p90ActiveMin: 260,
    p50WaitMin: 120,
    p90WaitMin: 480,
    breached: 6,
    breachPct: 14.3,
    reworked: 2,
    reworkPct: 4.8,
    tone: 'warning',
  },
  highlighted: false,
  dimmed: false,
  sequenceIndex: null,
};

const meta = {
  title: 'Control Tower/Neural/StepNode',
  component: StepNode,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: { step: BASE },
} satisfies Meta<typeof StepNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Paso con historia: insignias de p50 activo, p90 de espera e incumplimiento. */
export const ConMediciones: Story = {};

/** Paso sin mediciones: lo dice, no muestra ceros que parecerían reales. */
export const SinMediciones: Story = {
  args: { step: { ...BASE, metrics: null } },
};

/** Paso que incumple su SLA con frecuencia. */
export const Incumpliendo: Story = {
  args: {
    step: {
      ...BASE,
      metrics: { ...BASE.metrics!, breached: 24, breachPct: 57.1, tone: 'danger' },
    },
  },
};

/** Paso dentro de la variante seleccionada (muestra su posición en el camino). */
export const EnLaVariante: Story = {
  args: { step: { ...BASE, highlighted: true, sequenceIndex: 2 } },
};

/** Paso fuera de la variante seleccionada: se atenúa, nunca se esconde. */
export const FueraDeLaVariante: Story = {
  args: { step: { ...BASE, dimmed: true } },
};

/** Cada área tiene su color, el mismo en el visor, el grafo y la simulación. */
export const PorArea: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, max-content)' }}>
      {(
        [
          ['ventas', 'Ventas', 'brand'],
          ['compras', 'Compras', 'info'],
          ['inventario', 'Inventario', 'success'],
          ['manufactura', 'Manufactura', 'warning'],
          ['logistica', 'Logística', 'danger'],
          ['contabilidad', 'Contabilidad', 'muted'],
        ] as const
      ).map(([areaKey, areaLabel, tone]) => (
        <StepNode
          key={areaKey}
          step={{
            ...BASE,
            key: areaKey,
            label: `Paso de ${areaLabel}`,
            areaKey,
            areaLabel,
            areaTone: tone,
            metrics: null,
          }}
        />
      ))}
    </div>
  ),
};
