import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ZohoSyncPill } from './ZohoSyncPill';
import '@/styles/operations/logistica.css';

const meta = {
  title: 'Operaciones/Logística/ZohoSyncPill',
  component: ZohoSyncPill,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ZohoSyncPill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EsperandoAZoho: Story = {
  args: {
    delivery: {
      status: 'pending_external',
      zohoSyncState: 'pending_write',
      zohoError: null,
      mode: 'own_fleet',
    },
  },
};

export const Confirmado: Story = {
  args: {
    delivery: {
      status: 'assigned',
      zohoSyncState: 'readback_ok',
      zohoError: null,
      mode: 'carrier',
    },
  },
};

export const ConflictoConAccion: Story = {
  args: {
    delivery: {
      status: 'conflict',
      zohoSyncState: 'readback_mismatch',
      zohoError: null,
      mode: 'carrier',
    },
    onWrite: () => undefined,
  },
};

export const EscrituraFallida: Story = {
  args: {
    delivery: {
      status: 'failed',
      zohoSyncState: 'failed',
      zohoError: 'Zoho respondió 400: el paquete ya tiene embarque',
      mode: 'own_fleet',
    },
    onWrite: () => undefined,
  },
};

/** Una entrega que el cliente recoge no escribe en Zoho: la pastilla no aparece. */
export const SinSincronizacion: Story = {
  args: {
    delivery: {
      status: 'planned',
      zohoSyncState: 'not_required',
      zohoError: null,
      mode: 'customer_pickup',
    },
  },
};
