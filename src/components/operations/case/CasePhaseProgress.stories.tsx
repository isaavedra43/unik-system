import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { CasePhaseProgress } from './CasePhaseProgress';

const meta = {
  title: 'Operaciones/CasePhaseProgress',
  component: CasePhaseProgress,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof CasePhaseProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EnAbastecimiento: Story = {
  args: {
    currentPhaseLabel: 'Abastecimiento',
    progress: {
      total: 15,
      done: 6,
      percent: 40,
      overdue: 1,
      phases: [
        { key: 'planning', label: 'Planeación', total: 3, done: 3, state: 'done' },
        { key: 'sourcing', label: 'Abastecimiento', total: 6, done: 3, state: 'current' },
        { key: 'preparing', label: 'Preparación', total: 2, done: 0, state: 'pending' },
        { key: 'delivering', label: 'Entrega', total: 3, done: 0, state: 'pending' },
        { key: 'closing', label: 'Cierre', total: 1, done: 0, state: 'pending' },
      ],
    },
  },
};

export const ReciénAbierto: Story = {
  args: {
    currentPhaseLabel: 'Planeación',
    progress: {
      total: 15,
      done: 0,
      percent: 0,
      overdue: 0,
      phases: [
        { key: 'planning', label: 'Planeación', total: 3, done: 0, state: 'current' },
        { key: 'sourcing', label: 'Abastecimiento', total: 6, done: 0, state: 'pending' },
        { key: 'delivering', label: 'Entrega', total: 3, done: 0, state: 'pending' },
      ],
    },
  },
};

export const Cerrado: Story = {
  args: {
    currentPhaseLabel: 'Cierre',
    progress: {
      total: 15,
      done: 15,
      percent: 100,
      overdue: 0,
      phases: [
        { key: 'planning', label: 'Planeación', total: 3, done: 3, state: 'done' },
        { key: 'sourcing', label: 'Abastecimiento', total: 6, done: 6, state: 'done' },
        { key: 'preparing', label: 'Preparación', total: 2, done: 2, state: 'done' },
        { key: 'delivering', label: 'Entrega', total: 3, done: 3, state: 'done' },
        { key: 'closing', label: 'Cierre', total: 1, done: 1, state: 'current' },
      ],
    },
  },
};

export const SinPasos: Story = {
  args: {
    currentPhaseLabel: 'Planeación',
    progress: { total: 0, done: 0, percent: 0, overdue: 0, phases: [] },
  },
};
