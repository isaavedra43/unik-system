import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { LoadingState } from './LoadingState';

const meta = {
  title: 'Patterns/LoadingState',
  component: LoadingState,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  args: {
    variant: 'table',
  },
} satisfies Meta<typeof LoadingState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Table: Story = {};

export const Kpi: Story = {
  args: { variant: 'kpi', label: 'Cargando indicadores…' },
};

export const Chat: Story = {
  args: { variant: 'chat', label: 'Cargando conversación…' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640 }}>
        <Story />
      </div>
    ),
  ],
};

export const List: Story = {
  args: { variant: 'list', rows: 4 },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 420 }}>
        <Story />
      </div>
    ),
  ],
};
