import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Activity, Package, ShoppingCart, Users } from 'lucide-react';
import { LoadingState } from '../LoadingState';
import { KpiGrid } from './KpiGrid';
import { StatCard } from './StatCard';

const tiles = [
  { label: 'Solicitudes abiertas', value: '24', icon: <ShoppingCart size={20} /> },
  { label: 'OC en tránsito', value: '11', icon: <Package size={20} /> },
  { label: 'Recepciones hoy', value: '4', icon: <Activity size={20} /> },
  {
    label: 'Proveedores con OC vencidas',
    value: '2',
    icon: <Users size={20} />,
    tone: 'warning' as const,
  },
  { label: 'Expedientes esperando compra', value: '6', icon: <ShoppingCart size={20} /> },
  { label: 'Sourcing en curso', value: '3', icon: <Activity size={20} /> },
];

const meta = {
  title: 'Patterns/Dashboard/KpiGrid',
  component: KpiGrid,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  args: {
    columns: 4,
    children: tiles.map((tile) => <StatCard key={tile.label} {...tile} />),
  },
} satisfies Meta<typeof KpiGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FourColumns: Story = {};

export const ThreeColumns: Story = {
  args: { columns: 3 },
};

export const TwoColumns: Story = {
  args: {
    columns: 2,
    children: tiles.slice(0, 4).map((tile) => <StatCard key={tile.label} {...tile} />),
  },
};

/** Exactly 4 tiles: 4 columns down to 1025px, then 2 and 1 (never 3 + 1). */
export const FourTiles: Story = {
  args: {
    children: tiles.slice(0, 4).map((tile) => <StatCard key={tile.label} {...tile} />),
  },
};

/** 8 tiles: 4 + 4 down to 1025px, 2 × 4 below (never 3 + 3 + 2). */
export const EightTiles: Story = {
  args: {
    children: [
      ...tiles,
      { label: 'Proveedores activos', value: '38', icon: <Users size={20} /> },
      { label: 'Compromiso del mes', value: '$1.2 M', icon: <Activity size={20} /> },
    ].map((tile) => <StatCard key={tile.label} {...tile} />),
  },
};

export const Loading: Story = {
  args: {
    children: tiles.slice(0, 4).map((tile) => <StatCard key={tile.label} {...tile} loading />),
  },
};

export const LoadingPlaceholder: Story = {
  render: () => <LoadingState variant="kpi" rows={8} label="Cargando indicadores…" />,
};
