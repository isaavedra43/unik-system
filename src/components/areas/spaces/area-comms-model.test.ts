import { describe, expect, it } from 'vitest';
import type { AreaRequestDTO } from '@/modules/operations/area-requests-service';
import {
  AREA_COMMS_TABS,
  channelActivityLabel,
  commsTabHref,
  groupAreaChannels,
  isOpenRequestStatus,
  parseCommsTab,
  requestMetaLine,
  requestStatusTone,
  summarizeRequests,
  type AreaRequestRow,
  type ChannelInput,
} from './area-comms-model';

const NOW = new Date('2026-09-15T18:00:00.000Z');
const BASE = '/app/areas/compras/comunicaciones';

function channel(overrides: Partial<ChannelInput> & { id: string }): ChannelInput {
  return {
    type: 'case',
    name: null,
    unreadCount: 0,
    lastMessageAt: '2026-09-15T12:00:00.000Z',
    lastMessagePreview: null,
    areaKey: null,
    caseId: null,
    ...overrides,
  };
}

function request(overrides: Partial<AreaRequestDTO> = {}): AreaRequestDTO {
  return {
    id: 'req-1',
    caseId: 'case-1',
    caseNumber: 'EXP-9',
    customerName: 'Constructora del Norte',
    fromAreaKey: 'ventas',
    fromAreaLabel: 'Ventas',
    toAreaKey: 'compras',
    toAreaLabel: 'Compras',
    kind: 'purchase_shortfall',
    kindLabel: 'Faltante de compra',
    objectType: 'case_demand',
    objectId: 'dem-1',
    title: 'Comprar 40 piezas de loseta',
    payload: {},
    freeText: null,
    priority: 'normal',
    priorityLabel: 'Normal',
    status: 'sent',
    statusLabel: 'Enviada',
    blocksDelivery: false,
    dueAt: '2026-09-16T18:00:00.000Z',
    overdue: false,
    ownerUserId: 'u-owner',
    ownerName: 'Ana',
    backupUserId: null,
    backupName: null,
    workItemId: 'wi-1',
    createdByType: 'user',
    createdById: 'u-sales',
    createdByName: 'Luis',
    chatMessageId: null,
    answer: null,
    answeredAt: null,
    closedAt: null,
    version: 1,
    createdAt: '2026-09-14T18:00:00.000Z',
    updatedAt: '2026-09-14T18:00:00.000Z',
    ...overrides,
  };
}

const row = (overrides: Partial<AreaRequestDTO> = {}): AreaRequestRow => ({
  request: request(overrides),
  actions: [],
  noActionsReason: null,
});

describe('tabs', () => {
  it('falls back to the internal chat for anything unknown', () => {
    expect(parseCommsTab('solicitudes')).toBe('solicitudes');
    expect(parseCommsTab('externos')).toBe('externos');
    expect(parseCommsTab('otra')).toBe('chat');
    expect(parseCommsTab(undefined)).toBe('chat');
  });

  it('keeps the chat tab clean in the URL and carries the open conversation', () => {
    expect(commsTabHref(BASE, 'chat')).toBe(BASE);
    expect(commsTabHref(BASE, 'chat', { channelId: 'ch-1' })).toBe(`${BASE}?canal=ch-1`);
    expect(commsTabHref(BASE, 'solicitudes')).toBe(`${BASE}?tab=solicitudes`);
    expect(commsTabHref(BASE, 'externos', { channelId: 'ch-1' })).toBe(`${BASE}?tab=externos`);
  });

  it('has a label for every tab', () => {
    expect(AREA_COMMS_TABS).toHaveLength(3);
  });
});

describe('groupAreaChannels', () => {
  const channels: ChannelInput[] = [
    channel({ id: 'area-compras', type: 'area', areaKey: 'compras', name: 'Compras' }),
    channel({ id: 'area-ventas', type: 'area', areaKey: 'ventas', name: 'Ventas', unreadCount: 7 }),
    channel({
      id: 'case-old',
      caseId: 'c-old',
      name: 'EXP-1',
      lastMessageAt: '2026-09-10T10:00:00.000Z',
    }),
    channel({
      id: 'case-unread',
      caseId: 'c-unread',
      name: 'EXP-2',
      unreadCount: 2,
      lastMessageAt: '2026-09-11T10:00:00.000Z',
    }),
    channel({
      id: 'case-recent',
      caseId: 'c-recent',
      name: 'EXP-3',
      lastMessageAt: '2026-09-15T17:00:00.000Z',
    }),
    channel({ id: 'dm-1', type: 'dm', name: null }),
    channel({ id: 'group-1', type: 'group', name: 'Equipo' }),
  ];

  it('picks the channel of this area only', () => {
    const grouped = groupAreaChannels(channels, { areaKey: 'compras' });
    expect(grouped.areaChannel?.id).toBe('area-compras');
    expect(groupAreaChannels(channels, { areaKey: 'manufactura' }).areaChannel).toBeNull();
  });

  it('puts the unread sales rooms first and then the most recent', () => {
    const grouped = groupAreaChannels(channels, { areaKey: 'compras' });
    expect(grouped.caseRooms.map((room) => room.id)).toEqual([
      'case-unread',
      'case-recent',
      'case-old',
    ]);
  });

  it('leaves direct messages and groups out of the area space', () => {
    const grouped = groupAreaChannels(channels, { areaKey: 'compras' });
    expect(grouped.caseRooms.some((room) => room.id === 'dm-1' || room.id === 'group-1')).toBe(
      false
    );
  });

  it('counts the unread of this area and of every room, even past the visible limit', () => {
    const grouped = groupAreaChannels(channels, { areaKey: 'ventas', limit: 1 });
    expect(grouped.caseRooms).toHaveLength(1);
    expect(grouped.unreadCaseRooms).toBe(1);
    expect(grouped.totalUnread).toBe(9);
  });

  it('names a room that lost its name instead of showing an empty line', () => {
    const grouped = groupAreaChannels([channel({ id: 'case-x', caseId: 'c-x', name: '  ' })], {
      areaKey: 'compras',
    });
    expect(grouped.caseRooms[0].name).toBe('Sala de venta');
  });

  it('labels the activity of a conversation in Spanish', () => {
    const grouped = groupAreaChannels(channels, { areaKey: 'compras' });
    expect(channelActivityLabel(grouped.caseRooms[1], NOW)).toBe('hace 1 h');
  });
});

describe('requests', () => {
  it('reads an open request past its due date as late whatever its status', () => {
    expect(requestStatusTone(request({ status: 'accepted', overdue: true }))).toBe('danger');
    expect(requestStatusTone(request({ status: 'accepted' }))).toBe('info');
    expect(requestStatusTone(request({ status: 'blocked' }))).toBe('warning');
    expect(requestStatusTone(request({ status: 'resolved', overdue: true }))).toBe('success');
    expect(requestStatusTone(request({ status: 'otro' }))).toBe('default');
  });

  it('knows which statuses are still open', () => {
    expect(isOpenRequestStatus('sent')).toBe(true);
    expect(isOpenRequestStatus('blocked')).toBe(true);
    expect(isOpenRequestStatus('resolved')).toBe(false);
  });

  it('counts late and blocking requests on both directions', () => {
    const summary = summarizeRequests(
      [
        row(),
        row({ id: 'r-2', overdue: true }),
        row({ id: 'r-3', status: 'resolved', overdue: true }),
      ],
      [row({ id: 'r-4', blocksDelivery: true }), row({ id: 'r-5', overdue: true })]
    );
    expect(summary).toEqual({
      incoming: 3,
      incomingOverdue: 1,
      outgoing: 2,
      outgoingOverdue: 1,
      blocking: 1,
    });
  });

  it('describes a request without repeating empty fields', () => {
    expect(requestMetaLine(request())).toBe(
      'Faltante de compra · Ventas → Compras · EXP-9 · Constructora del Norte'
    );
    expect(requestMetaLine(request({ caseNumber: null, customerName: null }))).toBe(
      'Faltante de compra · Ventas → Compras'
    );
  });
});
