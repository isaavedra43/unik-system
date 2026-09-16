import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { AreaCommsList } from './AreaCommsList';

const meta = {
  title: 'Operaciones/AreaCommsList',
  component: AreaCommsList,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof AreaCommsList>;

export default meta;
type Story = StoryObj<typeof meta>;

const BASE = '/app/areas/compras/comunicaciones';
const NOW = '2026-09-15T18:00:00.000Z';

const areaChannel = {
  id: 'ch-area',
  name: 'Compras',
  unreadCount: 3,
  lastMessageAt: '2026-09-15T17:52:00.000Z',
  lastMessagePreview: 'IA · Coordinador de Compras: llegó una solicitud de Ventas',
  caseId: null,
};

const caseRooms = [
  {
    id: 'ch-case-1',
    name: 'EXP-128 · OV-4411 · Constructora del Norte',
    unreadCount: 2,
    lastMessageAt: '2026-09-15T17:30:00.000Z',
    lastMessagePreview: 'Ana: el proveedor confirma entrega el jueves',
    caseId: 'case-1',
  },
  {
    id: 'ch-case-2',
    name: 'EXP-127 · OV-4408 · Grupo Herrera',
    unreadCount: 0,
    lastMessageAt: '2026-09-15T14:05:00.000Z',
    lastMessagePreview: 'Luis: subí la evidencia de recepción',
    caseId: 'case-2',
  },
];

export const Default: Story = {
  args: {
    areaLabel: 'Compras',
    channels: {
      areaChannel,
      caseRooms,
      unreadCaseRooms: 1,
      totalUnread: 5,
    },
    selectedId: 'ch-area',
    onSelect: () => undefined,
    activeTab: 'chat',
    requests: { incoming: 4, incomingOverdue: 1, outgoing: 2 },
    requestsHref: `${BASE}?tab=solicitudes`,
    chatHref: BASE,
    externalHref: `${BASE}?tab=externos`,
    externalAccounts: 2,
    note: null,
    nowIso: NOW,
  },
};

export const SinCanalNiSalas: Story = {
  args: {
    ...Default.args,
    channels: { areaChannel: null, caseRooms: [], unreadCaseRooms: 0, totalUnread: 0 },
    selectedId: null,
    note: 'Todavía no hay canal de Compras: pide a Administración que corra el arranque de operaciones.',
    requests: { incoming: 0, incomingOverdue: 0, outgoing: 0 },
    externalHref: null,
    externalAccounts: 0,
  },
};

export const EnSolicitudes: Story = {
  args: {
    ...Default.args,
    activeTab: 'solicitudes',
    selectedId: null,
    requests: { incoming: 7, incomingOverdue: 3, outgoing: 1 },
  },
};
