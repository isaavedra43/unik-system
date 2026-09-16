import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { ScanLookup } from '@/modules/operations/scan-resolver';
import { ScanInput } from './ScanInput';

/**
 * The resolver is injected so the stories never call the scan API. The camera
 * button only appears where the browser has `BarcodeDetector`; the manual
 * field is always there.
 */

const location: ScanLookup = {
  code: 'A-01-02',
  kind: 'location',
  title: 'Ubicación A-01-02',
  subtitle: 'Rack norte · 2 registros de existencia',
  items: [
    {
      id: 'si-1',
      title: 'Placa de acero 3/8"',
      subtitle: 'PL-000045 · 1200 × 2400 · Ubicación A-01-02',
      quantity: '3.5',
      unit: 'pza',
      locationCode: 'A-01-02',
      confidenceLabel: 'Controlado',
    },
    {
      id: 'si-2',
      title: 'Perfil PTR 2"',
      subtitle: 'CT-000012 · Ubicación A-01-02',
      quantity: '18',
      unit: 'pza',
      locationCode: 'A-01-02',
      confidenceLabel: 'Provisional',
    },
  ],
  moreItems: 0,
  href: '/app/areas/inventario/mapa?scan=A-01-02',
  message: null,
};

const unknown: ScanLookup = {
  code: 'XYZ-9',
  kind: 'unknown',
  title: 'No reconocimos el código',
  subtitle: 'Leímos "XYZ-9"',
  items: [],
  moreItems: 0,
  href: null,
  message:
    'No corresponde a una etiqueta, una ubicación ni un SKU de este almacén. Revisa el código o captúralo a mano.',
};

const meta = {
  title: 'Operaciones/ScanInput',
  component: ScanInput,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ScanInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UbicacionEncontrada: Story = {
  args: { resolve: async () => location },
};

export const CodigoDesconocido: Story = {
  args: { resolve: async () => unknown },
};

export const SinPermiso: Story = {
  args: {
    resolve: async () => {
      throw new Error('No tienes permiso para consultar el inventario');
    },
  },
};
