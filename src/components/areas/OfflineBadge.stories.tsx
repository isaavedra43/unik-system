import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { OfflineBadgeView } from './OfflineBadge';

/**
 * The presentational half of `OfflineBadge`: the wired component reads the
 * offline command queue, which needs a browser session, so the stories drive
 * the same states by hand.
 */
const meta = {
  title: 'Operaciones/OfflineBadge',
  component: OfflineBadgeView,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof OfflineBadgeView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SinConexion: Story = {
  args: { online: false, pending: 0 },
};

export const SinConexionConPendientes: Story = {
  args: { online: false, pending: 3 },
};

export const PorEnviar: Story = {
  args: { online: true, pending: 2, onFlush: () => {} },
};

export const Enviando: Story = {
  args: { online: true, pending: 2, flushing: true, onFlush: () => {} },
};

export const Detenidas: Story = {
  args: { online: true, pending: 0, stuck: 1 },
};

export const DeOtraPersona: Story = {
  args: { online: true, pending: 0, pendingOtherUsers: 4 },
};

/** Everything sent and online: the badge renders nothing. */
export const TodoEnviado: Story = {
  args: { online: true, pending: 0 },
};
