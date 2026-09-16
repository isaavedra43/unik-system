import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { RadarSignalDTO } from '@/modules/crm/crm-dto';
import { RadarSignalRow } from './RadarSignalRow';

const NOW = new Date('2026-09-15T18:00:00.000Z');

const base: RadarSignalDTO = {
  id: 'sig-1',
  kind: 'no_followup',
  kindLabel: 'Sin seguimiento',
  subjectKey: 'conv-1',
  opportunityId: 'opp-1',
  conversationId: 'conv-1',
  quoteId: null,
  zohoContactId: null,
  commContactId: 'contact-1',
  customerName: 'Aceros del Norte',
  salespersonUserId: 'u-ana',
  salespersonName: 'Ana Ramírez',
  score: 62,
  reason: 'Aceros del Norte escribió por última vez hace 2 días y nadie le ha dado seguimiento.',
  data: null,
  computedAt: '2026-09-15T17:00:00.000Z',
  expiresAt: '2026-09-15T19:00:00.000Z',
  status: 'active',
  statusLabel: 'Activa',
  snoozedUntil: null,
  aiExplanation: null,
  aiSuggestedMessage: null,
  aiGeneratedAt: null,
  version: 3,
};

const noop = () => undefined;

const meta = {
  title: 'Ventas/RadarSignalRow',
  component: RadarSignalRow,
  parameters: { layout: 'padded' },
  args: {
    signal: base,
    selected: false,
    busy: false,
    explaining: false,
    now: NOW,
    onSelect: noop,
    onPrepareMessage: noop,
    onSnooze: noop,
    onDismiss: noop,
    onConvert: noop,
  },
  decorators: [
    (Story) => (
      <ul className="ventas-radar-list" style={{ maxWidth: 720 }}>
        <Story />
      </ul>
    ),
  ],
} satisfies Meta<typeof RadarSignalRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SinSeguimiento: Story = {};

export const Urgente: Story = {
  args: {
    signal: {
      ...base,
      id: 'sig-2',
      kind: 'delivery_incident',
      kindLabel: 'Incidencia en entrega',
      score: 88,
      reason:
        'El expediente EXP-42 (orden SO-1183) de Aceros del Norte tiene una incidencia crítica: «Falta material para completar la entrega». Avisa al cliente antes de que pregunte.',
    },
    selected: true,
  },
};

export const ConBorrador: Story = {
  args: {
    signal: {
      ...base,
      id: 'sig-3',
      kind: 'quote_expiring',
      kindLabel: 'Cotización por vencer',
      score: 71,
      quoteId: 'quote-1',
      reason:
        'La cotización COT-00042 por $125,000 de Aceros del Norte vence mañana y el cliente ya la vio.',
      aiExplanation:
        'El cliente abrió la cotización dos veces esta semana: tiene interés, pero la vigencia termina mañana y nadie ha confirmado.',
      aiSuggestedMessage:
        'Hola, le recuerdo que la cotización COT-00042 vence mañana. ¿La confirmamos hoy o le extiendo la vigencia?',
      aiGeneratedAt: '2026-09-15T17:30:00.000Z',
    },
  },
};

export const EnviandoComando: Story = {
  args: { busy: true },
};

export const SinConversacion: Story = {
  args: {
    signal: {
      ...base,
      id: 'sig-4',
      kind: 'repurchase_overdue',
      kindLabel: 'Recompra atrasada',
      conversationId: null,
      commContactId: null,
      opportunityId: null,
      salespersonName: null,
      salespersonUserId: null,
      score: 47,
      reason:
        'Aceros del Norte suele comprar cada 45 días (mediana de 6 órdenes) y su última orden fue hace 78 días.',
    },
  },
};
