import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import type { RowActionActor } from '@/modules/areas/work-actions';
import { NextActionCard } from './NextActionCard';

const NOW = new Date('2026-09-15T15:00:00.000Z');

const actor: RowActionActor = { id: 'u-me', permissionKeys: [], isSuperAdmin: false };

function row(overrides: Partial<AreaWorkRow> = {}): AreaWorkRow {
  return {
    id: 'work_item:wi-1',
    rowKind: 'work_item',
    sourceId: 'wi-1',
    areaKey: 'inventario',
    caseId: 'case-1',
    caseNumber: 'EXP-1042',
    customerName: 'Constructora del Norte',
    title: 'Verificar existencia de placa de acero 3/8"',
    status: 'open',
    statusLabel: 'Abierto',
    statusTone: 'default',
    priority: 'normal',
    priorityLabel: 'Normal',
    ownerUserId: 'u-me',
    ownerName: 'Ana Ruiz',
    dueAt: '2026-09-15T16:30:00.000Z',
    startedAt: null,
    lastActivityAt: '2026-09-15T14:00:00.000Z',
    escalationLevel: 0,
    waitReason: null,
    objectType: null,
    objectId: null,
    counterpartyName: null,
    locationCode: 'A-01-02',
    amount: null,
    quantity: null,
    version: 3,
    overdue: false,
    open: true,
    extra: {},
    ...overrides,
  };
}

const meta = {
  title: 'Operaciones/NextActionCard',
  component: NextActionCard,
  parameters: { layout: 'padded' },
  args: {
    areaLabel: 'Inventario',
    now: NOW,
    actor,
    actPermissions: ['inventory.count'],
    onAction: () => {},
    onOpen: () => {},
  },
} satisfies Meta<typeof NextActionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PorVencer: Story = {
  args: { next: { row: row(), reason: 'next_due' } },
};

export const Vencido: Story = {
  args: {
    next: {
      row: row({ dueAt: '2026-09-15T11:00:00.000Z', overdue: true, statusTone: 'danger' }),
      reason: 'overdue',
    },
  },
};

export const EnCurso: Story = {
  args: {
    next: {
      row: row({
        status: 'in_progress',
        statusLabel: 'En curso',
        statusTone: 'info',
        startedAt: '2026-09-15T14:30:00.000Z',
      }),
      reason: 'in_progress',
    },
  },
};

/** The row belongs to somebody else: the card explains instead of offering a command. */
export const EscaladoDelArea: Story = {
  args: {
    next: {
      row: row({
        id: 'work_item:wi-9',
        sourceId: 'wi-9',
        ownerUserId: 'u-otra',
        ownerName: 'Luis Prado',
        status: 'escalated',
        statusLabel: 'Escalado',
        statusTone: 'danger',
        escalationLevel: 2,
      }),
      reason: 'area_escalated',
    },
  },
};

export const AlDia: Story = {
  args: { next: null },
};
