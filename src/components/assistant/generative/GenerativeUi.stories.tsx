import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import '@/app/globals.css';
import { GenerativeUi } from './GenerativeUi';
import type { UiComponent } from '@/modules/ai/generative-ui/types';

/** Fixtures only: no real data, no network. */
const meta: Meta<typeof GenerativeUi> = {
  title: 'Assistant/GenerativeUi',
  component: GenerativeUi,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof GenerativeUi>;

const components = (list: UiComponent[]): Story => ({
  args: { components: list, interactive: false },
});

export const EmailList: Story = components([
  {
    type: 'records',
    heading: 'Resultados',
    source: 'Gmail',
    total: 14,
    items: [
      {
        title: 'Cotización piel de elefante',
        subtitle: 'Ana Ruiz <ana@example.com>',
        body: 'Te envío los precios actualizados para el pedido de la semana…',
        date: '2026-09-20T10:00:00Z',
        badge: { label: 'Sin leer', tone: 'warning' },
      },
      {
        title: 'Confirmación de entrega',
        subtitle: 'Luis Mora <luis@example.com>',
        date: '2026-09-21T15:30:00Z',
        url: 'https://mail.example.com/thread/1',
      },
    ],
  },
]);

export const Table: Story = components([
  {
    type: 'table',
    source: 'Google Sheets',
    columns: ['Producto', 'Cantidad', 'Bodega'],
    rows: [
      ['Piel 5xll', '20', 'Centro'],
      ['Loseta gris', '120', 'Norte'],
    ],
    total: 2,
  },
]);

export const Detail: Story = components([
  {
    type: 'record',
    source: 'GitHub',
    record: {
      title: 'Corregir sync de Zoho',
      subtitle: 'israel',
      body: 'El scheduler duplica eventos cuando…',
      badge: { label: 'open', tone: 'success' },
      url: 'https://github.com/example/repo/issues/1',
      fields: [{ label: 'Comentarios', value: '3' }],
    },
  },
]);

export const Notices: Story = components([
  {
    type: 'notice',
    tone: 'success',
    title: 'Slack: acción completada',
    detail: 'SLACK_SEND_MESSAGE',
  },
  {
    type: 'notice',
    tone: 'warning',
    title: 'Resultado por confirmar · GMAIL_SEND_EMAIL',
    detail: 'Tiempo agotado (45s). La operación pudo completarse.',
  },
  {
    type: 'notice',
    tone: 'danger',
    title: 'No se pudo ejecutar GITHUB_CREATE_AN_ISSUE',
    detail: 'Falta el parámetro obligatorio "title"',
  },
]);

export const ConnectAccount: Story = components([
  { type: 'connect', toolkit: 'gmail', name: 'Gmail', connected: false },
]);
