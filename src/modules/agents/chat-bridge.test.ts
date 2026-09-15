import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return {
    fake: createOpsFake({
      relations: {
        internalChatChannel: {
          members: { model: 'internalChatMember', childFk: 'channelId' },
          messages: { model: 'internalChatMessage', childFk: 'channelId' },
        },
        internalChatMember: {
          user: { model: 'user', fk: 'userId' },
          channel: { model: 'internalChatChannel', fk: 'channelId' },
        },
        internalChatMessage: {
          sender: { model: 'user', fk: 'senderId' },
          replyTo: { model: 'internalChatMessage', fk: 'replyToId' },
          attachments: { model: 'internalChatAttachment', childFk: 'messageId' },
          reactions: { model: 'internalChatReaction', childFk: 'messageId' },
          readReceipts: { model: 'internalChatReadReceipt', childFk: 'messageId' },
          mentions: { model: 'internalChatMention', childFk: 'messageId' },
          pins: { model: 'internalChatPinnedMessage', childFk: 'messageId' },
          bookmarks: { model: 'internalChatBookmark', childFk: 'messageId' },
        },
        internalChatReaction: { user: { model: 'user', fk: 'userId' } },
      },
      defaults: {
        internalChatChannel: () => ({ name: null, avatarPath: null, lastMessageAt: new Date(), createdAt: new Date() }),
        internalChatMessage: () => ({
          content: null,
          replyToId: null,
          forwardedFromId: null,
          forwardedBy: null,
          editedAt: null,
          deletedAt: null,
          priority: 'normal',
          threadId: null,
          meta: null,
          createdAt: new Date(),
        }),
      },
      uniques: {
        internalChatThread: [['rootMessageId']],
        internalChatMention: [['messageId', 'userId']],
      },
    }),
    notifyChatMessage: vi.fn(async () => {}),
    recordAuditEvent: vi.fn(async () => {}),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/chat/chat-presence-service', () => ({
  getPresence: vi.fn(async () => new Map<string, string>()),
  getTotalUnread: vi.fn(async () => 0),
}));
vi.mock('@/modules/chat/chat-admin-service', () => ({
  detectChatAlerts: vi.fn(async () => {}),
  isUserSuspended: vi.fn(async () => false),
}));
vi.mock('@/modules/chat/chat-notifications', () => ({ notifyChatMessage: mocks.notifyChatMessage }));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: mocks.recordAuditEvent }));

import { seedAreas, seedResponsible, seedUser } from '@/modules/operations/testing/fixtures';
import { AgentBridgeError, ensureAreaChannel, ensureCaseRoom, postAsAgent } from './chat-bridge';
import { ensureAgentIdentities } from './identities';

const fake = mocks.fake;
const NOW = new Date('2026-09-15T15:29:00.000Z');

const botId = (username: string) => fake.rows('user').find((u) => u.username === username)!.id as string;
const activeMembers = (channelId: string) =>
  fake
    .rows('internalChatMember')
    .filter((m) => m.channelId === channelId && m.leftAt === null)
    .map((m) => m.userId as string)
    .sort();
const channelsOfType = (type: string) => fake.rows('internalChatChannel').filter((c) => c.type === type);

function seedCase() {
  fake.seed('operationalCase', {
    id: 'case_1',
    caseSeq: 1,
    caseNumber: 'EXP-1',
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: 'so_1',
    processVersionId: 'pv_1',
    ownerUserId: 'vendedor',
    salesOrderNumber: 'OV-23131',
    customerName: 'Constructora Norte',
  });
  // Compras takes part (work item + request), Inventario sends the request.
  fake.seed('workItem', { id: 'wi_1', caseId: 'case_1', areaKey: 'compras', kind: 'action', title: 'Cotizar', ownerUserId: 'marta', dueAt: NOW });
  fake.seed('areaRequest', {
    id: 'req_1',
    caseId: 'case_1',
    fromAreaKey: 'inventario',
    toAreaKey: 'compras',
    kind: 'purchase_shortfall',
    objectType: 'case_demand',
    objectId: 'dem_1',
    title: 'Faltan 15 m²',
    payload: {},
    dueAt: NOW,
    ownerUserId: 'marta',
    createdByType: 'ai',
  });
  // A pending step of an alternative path must NOT pull Logística into the room.
  fake.seed('caseStep', { id: 'st_1', caseId: 'case_1', stepKey: 'deliver', areaKey: 'logistica', kind: 'action', status: 'pending', label: 'Entregar' });
}

beforeAll(() => {
  seedAreas(fake);
  seedUser(fake, { id: 'ana', name: 'Ana', permissions: ['inventory.view'] });
  seedUser(fake, { id: 'pedro', name: 'Pedro', permissions: ['sales_orders.view'] });
  seedUser(fake, { id: 'viejo', name: 'Inactivo', isActive: false, permissions: ['inventory.count'] });
  seedUser(fake, { id: 'root', name: 'Root', superAdmin: true });
  for (const id of ['carla', 'luis', 'marta', 'nico', 'vero', 'lalo', 'vendedor']) seedUser(fake, { id, name: id });
  seedResponsible(fake, { area: 'inventario', userId: 'carla', backupUserId: 'luis' });
  seedResponsible(fake, { area: 'compras', userId: 'marta', backupUserId: 'nico' });
  seedResponsible(fake, { area: 'ventas', userId: 'vero' });
  seedResponsible(fake, { area: 'logistica', userId: 'lalo' });
  seedCase();
});

beforeEach(async () => {
  await ensureAgentIdentities();
  mocks.notifyChatMessage.mockClear();
});

describe('ensureAreaChannel', () => {
  it('creates the area channel with permission holders, responsible, backup and the bots, and links Area.chatChannelId', async () => {
    const result = await ensureAreaChannel('inventario');
    expect(result.isNew).toBe(true);
    const channel = fake.rows('internalChatChannel').find((c) => c.id === result.id)!;
    expect(channel).toMatchObject({ type: 'area', name: 'Inventario', createdBy: botId('ia_admin') });
    expect(fake.rows('area').find((a) => a.key === 'inventario')!.chatChannelId).toBe(result.id);
    expect(activeMembers(result.id)).toEqual(['ana', 'carla', 'luis', botId('ia_admin'), botId('ia_inventario')].sort());
  });

  it('is idempotent and never duplicates the channel', async () => {
    const first = await ensureAreaChannel('inventario');
    const second = await ensureAreaChannel('inventario');
    expect(second).toMatchObject({ id: first.id, isNew: false, members: { added: [], reactivated: [], removed: [] } });
    expect(channelsOfType('area').filter((c) => c.id === first.id)).toHaveLength(1);
    expect(fake.rows('area').filter((a) => a.chatChannelId === first.id)).toHaveLength(1);
  });

  it('follows permission changes for people but keeps the bots', async () => {
    const { id } = await ensureAreaChannel('inventario');
    const anaRole = fake.rows('role').find((r) => r.key === 'perm_ana')!;
    const permissions = fake.rows('rolePermission');
    permissions.splice(permissions.findIndex((p) => p.roleId === anaRole.id), 1);
    const result = await ensureAreaChannel('inventario');
    expect(result.members.removed).toEqual(['ana']);
    expect(activeMembers(id)).toEqual(['carla', 'luis', botId('ia_admin'), botId('ia_inventario')].sort());
    fake.seed('rolePermission', { roleId: anaRole.id, permissionKey: 'inventory.view' });
    expect((await ensureAreaChannel('inventario')).members.reactivated).toEqual(['ana']);
  });

  it('uses the administrator bot for Administración and module permissions for Ventas', async () => {
    const ventas = await ensureAreaChannel('ventas');
    expect(activeMembers(ventas.id)).toEqual(['pedro', 'vero', botId('ia_admin'), botId('ia_ventas')].sort());
    const admin = await ensureAreaChannel('administracion');
    expect(activeMembers(admin.id)).toEqual([botId('ia_admin')]);
  });

  it('rejects unknown areas', async () => {
    await expect(ensureAreaChannel('marketing')).rejects.toBeInstanceOf(AgentBridgeError);
  });
});

describe('ensureCaseRoom', () => {
  it('creates the room with responsibles and backups of the involved areas, their bots and the case owner', async () => {
    const result = await ensureCaseRoom('case_1');
    const channel = fake.rows('internalChatChannel').find((c) => c.id === result.id)!;
    expect(channel).toMatchObject({ type: 'case', name: 'EXP-1 · OV-23131 · Constructora Norte' });
    expect(fake.rows('operationalCase').find((c) => c.id === 'case_1')!.chatChannelId).toBe(result.id);
    expect(activeMembers(result.id)).toEqual(
      ['vendedor', 'vero', 'marta', 'nico', 'carla', 'luis', botId('ia_admin'), botId('ia_ventas'), botId('ia_compras'), botId('ia_inventario')].sort()
    );
    expect(activeMembers(result.id)).not.toContain('lalo');
    expect(activeMembers(result.id)).not.toContain(botId('ia_logistica'));
  });

  it('is idempotent', async () => {
    const first = await ensureCaseRoom('case_1');
    const second = await ensureCaseRoom('case_1');
    expect(second.id).toBe(first.id);
    expect(second.isNew).toBe(false);
    expect(fake.rows('operationalCase').filter((c) => c.chatChannelId === first.id)).toHaveLength(1);
    expect(channelsOfType('case').filter((c) => c.id === first.id)).toHaveLength(1);
  });

  it('fails for unknown cases', async () => {
    await expect(ensureCaseRoom('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('postAsAgent', () => {
  it('posts as the bot, joining it to the room first when needed, and the bot stays on later syncs', async () => {
    const room = await ensureCaseRoom('case_1');
    const dto = await postAsAgent('area:logistica', room.id, '🚚 Logística revisa la ruta', { kind: 'agent_notice', caseId: 'case_1' });
    const stored = fake.rows('internalChatMessage').find((m) => m.id === dto.id)!;
    expect(stored).toMatchObject({ senderId: botId('ia_logistica'), channelId: room.id, meta: { kind: 'agent_notice', caseId: 'case_1' } });
    expect(activeMembers(room.id)).toContain(botId('ia_logistica'));
    await ensureCaseRoom('case_1');
    expect(activeMembers(room.id)).toContain(botId('ia_logistica'));
  });

  it('links the first request announcement to AreaRequest.chatMessageId', async () => {
    const room = await ensureCaseRoom('case_1');
    const first = await postAsAgent('area:inventario', room.id, '📦 Solicitud a Compras', { kind: 'agent_request', requestId: 'req_1', caseId: 'case_1' });
    const area = await ensureAreaChannel('compras');
    await postAsAgent('area:compras', area.id, '📦 Copia al área', { kind: 'agent_request', requestId: 'req_1' });
    expect(fake.rows('areaRequest').find((r) => r.id === 'req_1')!.chatMessageId).toBe(first.id);
  });

  it('rejects unknown agents, empty text and non-operations channels', async () => {
    const room = await ensureCaseRoom('case_1');
    await expect(postAsAgent('area:marketing', room.id, 'hola')).rejects.toMatchObject({ code: 'unknown_agent' });
    await expect(postAsAgent('admin', room.id, '   ')).rejects.toMatchObject({ code: 'empty_message' });
    fake.seed('internalChatChannel', { id: 'dm_1', type: 'dm', createdBy: 'ana' });
    await expect(postAsAgent('admin', 'dm_1', 'hola')).rejects.toMatchObject({ code: 'channel_not_operational' });
  });
});
