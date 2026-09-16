import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { HealthList } from './HealthList';

/**
 * Lista de salud del Control Tower: nombre, pista y valor con tono.
 * Es presentacional: recibe textos ya formateados y no decide nada.
 */
const meta = {
  title: 'Control Tower/HealthList',
  component: HealthList,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof HealthList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SincronizacionZoho: Story = {
  args: {
    label: 'Corridas de sincronización',
    emptyText: 'Todavía no hay corridas registradas.',
    items: [
      {
        id: 'zoho:sales_order',
        label: 'sales_order',
        hint: 'zoho',
        tone: 'success',
        value: 'Completada · hace 4 min',
      },
      {
        id: 'zoho:package',
        label: 'package',
        hint: 'zoho',
        tone: 'warning',
        value: 'Completada · hace 3 h',
      },
      {
        id: 'zoho:item',
        label: 'item',
        hint: 'zoho',
        tone: 'danger',
        value: 'Falló · hace 12 min',
      },
    ],
  },
};

export const ColaDeTrabajos: Story = {
  args: {
    label: 'Cola de trabajos de fondo',
    emptyText: 'La cola está vacía.',
    items: [
      { id: 'pending', label: 'Pendientes', value: '12' },
      { id: 'running', label: 'En curso', value: '2' },
      { id: 'failed', label: 'Fallidos', tone: 'danger', value: '3' },
      { id: 'completed', label: 'Terminados', value: '1,204' },
    ],
  },
};

/** Con `max`, el resto se resume en una fila en vez de crecer sin fin. */
export const ConResumenDeSobrantes: Story = {
  args: {
    label: 'Personas con trabajo vencido',
    emptyText: 'Nadie tiene trabajo vencido ahora mismo.',
    max: 3,
    items: Array.from({ length: 7 }, (_, index) => ({
      id: `u${index}`,
      label: `Persona ${index + 1}`,
      tone: 'danger' as const,
      value: `${7 - index} vencidos`,
    })),
  },
};

export const Vacia: Story = {
  args: {
    label: 'Proyecciones y consumo de IA',
    emptyText: 'Sin proyecciones ni consumo registrado.',
    items: [],
  },
};
