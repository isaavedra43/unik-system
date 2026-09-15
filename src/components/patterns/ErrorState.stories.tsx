import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { ErrorState } from './ErrorState';

const meta = {
  title: 'Patterns/ErrorState',
  component: ErrorState,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  args: {
    title: 'No se pudieron cargar las estadísticas',
    message: 'Revisa tu conexión e intenta de nuevo.',
    onRetry: fn(),
  },
} satisfies Meta<typeof ErrorState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutRetry: Story = {
  args: {
    onRetry: undefined,
    message: 'No tienes permiso para ver este tablero.',
    title: 'Acceso denegado',
  },
};

export const WithoutMessage: Story = {
  args: { message: undefined },
};

export const Compact: Story = {
  args: { compact: true, title: 'No se pudo cargar la gráfica' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 360 }}>
        <Story />
      </div>
    ),
  ],
};
