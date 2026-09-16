import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { AreaWorkChips } from './AreaWorkChips';

const meta = {
  title: 'Operaciones/AreaWorkChips',
  component: AreaWorkChips,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof AreaWorkChips>;

export default meta;
type Story = StoryObj<typeof meta>;

const base = '/app/areas/compras/trabajo';

export const Default: Story = {
  args: {
    groups: [
      {
        label: 'Tipo',
        chips: [
          { id: 'all', label: 'Todo', href: base, active: true },
          { id: 'work_item', label: 'Trabajos', href: `${base}?kind=work_item`, active: false },
          { id: 'request_in', label: 'Recibidas', href: `${base}?kind=request_in`, active: false },
          {
            id: 'procurement_order',
            label: 'Órdenes',
            href: `${base}?kind=procurement_order`,
            active: false,
          },
        ],
      },
      {
        label: 'Estado',
        chips: [
          { id: 'open', label: 'Abiertos', href: base, active: true },
          { id: 'closed', label: 'Cerrados', href: `${base}?scope=closed`, active: false },
          { id: 'all', label: 'Todos', href: `${base}?scope=all`, active: false },
          {
            id: 'mine',
            label: 'Míos',
            href: `${base}?mios=1`,
            active: false,
            title: 'Sólo lo que tengo a cargo o cubro como suplente',
          },
          {
            id: 'overdue',
            label: 'Vencidos',
            href: `${base}?vencidos=1`,
            active: false,
            title: 'Sólo lo que ya pasó su fecha',
          },
        ],
      },
    ],
  },
};

export const WithActiveFilters: Story = {
  args: {
    groups: [
      {
        label: 'Tipo',
        chips: [
          { id: 'all', label: 'Todo', href: `${base}?vencidos=1`, active: false },
          {
            id: 'request_in',
            label: 'Recibidas',
            href: `${base}?kind=request_in&vencidos=1`,
            active: true,
          },
        ],
      },
      {
        label: 'Estado',
        chips: [
          {
            id: 'open',
            label: 'Abiertos',
            href: `${base}?kind=request_in&vencidos=1`,
            active: true,
          },
          { id: 'overdue', label: 'Vencidos', href: `${base}?kind=request_in`, active: true },
        ],
      },
    ],
  },
};

export const SingleGroup: Story = {
  args: {
    groups: [
      {
        label: 'Tipo',
        chips: [{ id: 'all', label: 'Todo', href: base, active: true }],
      },
    ],
  },
};
