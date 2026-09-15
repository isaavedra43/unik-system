import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        internalChatChannel: () => ({ name: null, avatarPath: null, lastMessageAt: new Date() }),
        internalChatMember: () => ({
          role: 'member',
          joinedAt: new Date(),
          lastReadAt: new Date(),
          mutedUntil: null,
          leftAt: null,
        }),
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
vi.mock('./chat-presence-service', () => ({
  getPresence: vi.fn(async () => new Map<string, string>()),
  getTotalUnread: vi.fn(async () => 0),
}));
vi.mock('./chat-admin-service', () => ({
  detectChatAlerts: vi.fn(async () => {}),
  isUserSuspended: vi.fn(async () => false),
}));
vi.mock('./chat-notifications', () => ({ notifyChatMessage: mocks.notifyChatMessage }));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: mocks.recordAuditEvent }));

import { AuthorizationError } from '@/modules/auth/authorization';
import { seedArea, seedUser } from '@/modules/operations/testing/fixtures';
import {
  ChatError,
  createAreaChannel,
  createCaseRoom,
  createDmChannel,
  createGroupChannel,
  getChannel,
  listUserChannels,
  onBotMentioned,
  removeMember,
  searchUsers,
  sendMessage,
  sendSystemMessage,
  syncChannelMembers,
  type BotMentionEvent,
} from './chat-service';

const { fake } = mocks;

type SessionUser = ReturnType<typeof seedUser>['currentUser'];
let ana: SessionUser;
let luis: SessionUser;

function activeMembers(channelId: string): string[] {
  return fake
    .rows('internalChatMember')
    .filter((m) => m.channelId === channelId && m.leftAt === null)
    .map((m) => m.userId as string)
    .sort();
}

function seedCase(id = 'case_1') {
  return fake.seed('operationalCase', {
    id,
    caseSeq: 1,
    caseNumber: 'EXP-1',
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: `so_${id}`,
    processVersionId: 'pv_1',
    ownerUserId: 'luis',
  });
}

async function comprasChannel(memberUserIds: string[] = ['ana', 'luis', 'bot_compras']) {
  const result = await createAreaChannel('compras', {
    name: 'Compras',
    memberUserIds,
    createdBy: 'bot_admin',
  });
  return result.id;
}

beforeEach(() => {
  fake.tables.clear();
  mocks.notifyChatMessage.mockClear();
  mocks.recordAuditEvent.mockClear();
  seedUser(fake, { id: 'bot_admin', username: 'ia_admin', name: 'IA Administradora', isBot: true });
  seedUser(fake, { id: 'bot_compras', username: 'ia_compras', name: 'IA de Compras', isBot: true });
  seedUser(fake, { id: 'bot_ventas', username: 'ia_ventas', name: 'IA de Ventas', isBot: true });
  seedUser(fake, { id: 'old', username: 'old', name: 'Inactivo', isActive: false });
  ana = seedUser(fake, { id: 'ana', username: 'ana', name: 'Ana' }).currentUser;
  luis = seedUser(fake, { id: 'luis', username: 'luis', name: 'Luis' }).currentUser;
  seedArea(fake, 'compras');
});

describe('createAreaChannel', () => {
  it('creates the channel once, links Area.chatChannelId and skips inactive or unknown users', async () => {
    const first = await createAreaChannel('compras', {
      name: '  Compras  ',
      memberUserIds: ['ana', 'bot_compras', 'ana', 'old', 'ghost'],
      createdBy: 'bot_admin',
    });

    expect(first.isNew).toBe(true);
    expect(fake.rows('internalChatChannel').find((c) => c.id === first.id)).toMatchObject({
      type: 'area',
      name: 'Compras',
      createdBy: 'bot_admin',
    });
    expect(fake.rows('area').find((a) => a.key === 'compras')?.chatChannelId).toBe(first.id);
    expect(activeMembers(first.id)).toEqual(['ana', 'bot_admin', 'bot_compras']);
    const creatorMembership = fake
      .rows('internalChatMember')
      .find((m) => m.channelId === first.id && m.userId === 'bot_admin');
    expect(creatorMembership?.role).toBe('owner');
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'chat.area_channel_created', targetId: first.id })
    );

    const second = await createAreaChannel('compras', {
      name: 'Compras',
      memberUserIds: ['bot_compras', 'ana'],
      createdBy: 'bot_admin',
    });

    expect(second).toEqual({
      id: first.id,
      isNew: false,
      members: { added: [], reactivated: [], removed: [] },
    });
    expect(fake.rows('internalChatChannel')).toHaveLength(1);
    expect(fake.rows('internalChatMember').filter((m) => m.channelId === first.id)).toHaveLength(3);
    expect(mocks.recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('renames the existing channel and syncs its members on later calls', async () => {
    const id = await comprasChannel(['ana', 'bot_compras']);

    const result = await createAreaChannel('compras', {
      name: 'Compras y abasto',
      memberUserIds: ['luis', 'bot_compras'],
      createdBy: 'bot_admin',
    });

    expect(result).toEqual({
      id,
      isNew: false,
      members: { added: ['luis'], reactivated: [], removed: ['ana'] },
    });
    expect(fake.rows('internalChatChannel').find((c) => c.id === id)?.name).toBe('Compras y abasto');
    expect(activeMembers(id)).toEqual(['bot_admin', 'bot_compras', 'luis']);
  });

  it('rejects unknown areas, inactive creators and invalid names', async () => {
    await expect(
      createAreaChannel('bodega', { name: 'Bodega', memberUserIds: [], createdBy: 'bot_admin' })
    ).rejects.toThrow('Área no encontrada: bodega');
    await expect(
      createAreaChannel('compras', { name: 'Compras', memberUserIds: [], createdBy: 'old' })
    ).rejects.toThrow('El creador del canal no existe o está inactivo');
    await expect(
      createAreaChannel('compras', { name: '   ', memberUserIds: [], createdBy: 'bot_admin' })
    ).rejects.toBeInstanceOf(ChatError);
    expect(fake.rows('internalChatChannel')).toHaveLength(0);
  });

  it('adopts the channel linked by a concurrent call and discards its own', async () => {
    fake.seed('internalChatChannel', {
      id: 'chan_winner',
      type: 'area',
      name: 'Compras',
      createdBy: 'bot_admin',
    });
    fake.seed('internalChatMember', { channelId: 'chan_winner', userId: 'bot_admin', role: 'owner' });
    const delegate = fake.client.area;
    const original = delegate.updateMany;
    const spy = vi.spyOn(delegate, 'updateMany').mockImplementationOnce(async (args: unknown) => {
      // The competitor commits its link between our read and our compare-and-set.
      fake.rows('area').find((a) => a.key === 'compras')!.chatChannelId = 'chan_winner';
      return original(args);
    });

    const result = await createAreaChannel('compras', {
      name: 'Compras',
      memberUserIds: ['ana'],
      createdBy: 'bot_admin',
    });
    spy.mockRestore();

    expect(result).toEqual({
      id: 'chan_winner',
      isNew: false,
      members: { added: ['ana'], reactivated: [], removed: [] },
    });
    expect(fake.rows('internalChatChannel').map((c) => c.id)).toEqual(['chan_winner']);
    expect(fake.rows('internalChatMember').every((m) => m.channelId === 'chan_winner')).toBe(true);
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe('createCaseRoom', () => {
  it('creates the sales room idempotently and relinks when the linked channel was deleted', async () => {
    seedCase();
    const input = { name: 'EXP-1 · OV-23131', memberUserIds: ['luis', 'bot_ventas'], createdBy: 'bot_admin' };

    const first = await createCaseRoom('case_1', input);
    const again = await createCaseRoom('case_1', input);

    expect(first.isNew).toBe(true);
    expect(again).toMatchObject({ id: first.id, isNew: false });
    expect(fake.rows('internalChatChannel')).toHaveLength(1);
    expect(fake.rows('internalChatChannel')[0]).toMatchObject({ type: 'case', name: 'EXP-1 · OV-23131' });
    expect(fake.rows('operationalCase')[0].chatChannelId).toBe(first.id);
    expect(activeMembers(first.id)).toEqual(['bot_admin', 'bot_ventas', 'luis']);

    fake.tables.set('internalChatChannel', []);
    fake.tables.set('internalChatMember', []);
    const recreated = await createCaseRoom('case_1', input);

    expect(recreated.isNew).toBe(true);
    expect(recreated.id).not.toBe(first.id);
    expect(fake.rows('operationalCase')[0].chatChannelId).toBe(recreated.id);
  });

  it('rejects unknown cases', async () => {
    await expect(
      createCaseRoom('missing', { name: 'Sala', memberUserIds: [], createdBy: 'bot_admin' })
    ).rejects.toThrow('Expediente no encontrado: missing');
  });
});

describe('syncChannelMembers', () => {
  it('is idempotent, keeps the creator and reactivates without an unread backlog', async () => {
    const id = await comprasChannel(['ana']);

    expect(await syncChannelMembers(id, ['ana', 'luis'])).toEqual({
      added: ['luis'],
      reactivated: [],
      removed: [],
    });
    expect(await syncChannelMembers(id, ['luis', 'ana', 'luis'])).toEqual({
      added: [],
      reactivated: [],
      removed: [],
    });

    expect(await syncChannelMembers(id, ['luis'])).toEqual({
      added: [],
      reactivated: [],
      removed: ['ana'],
    });
    const anaRow = fake.rows('internalChatMember').find((m) => m.channelId === id && m.userId === 'ana')!;
    expect(anaRow.leftAt).toBeInstanceOf(Date);
    expect(activeMembers(id)).toEqual(['bot_admin', 'luis']);

    anaRow.lastReadAt = new Date('2026-01-01T00:00:00Z');
    expect(await syncChannelMembers(id, ['luis', 'ana'])).toEqual({
      added: [],
      reactivated: ['ana'],
      removed: [],
    });
    expect(anaRow.leftAt).toBeNull();
    expect((anaRow.lastReadAt as Date).getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
    expect(fake.rows('internalChatMember').filter((m) => m.channelId === id)).toHaveLength(3);
  });

  it('only manages area and case channels', async () => {
    fake.seed('internalChatChannel', { id: 'grp', type: 'group', name: 'Equipo', createdBy: 'ana' });
    await expect(syncChannelMembers('grp', ['ana'])).rejects.toThrow(
      'Solo los canales de área y las salas de venta sincronizan sus miembros'
    );
    await expect(syncChannelMembers('nope', ['ana'])).rejects.toThrow('Canal no encontrado');
  });
});

describe('sendSystemMessage', () => {
  it('requires an active bot user that belongs to the channel', async () => {
    const id = await comprasChannel();

    await expect(sendSystemMessage({ id: 'ana' }, id, { content: 'Hola' })).rejects.toBeInstanceOf(
      AuthorizationError
    );
    await expect(
      sendSystemMessage({ id: 'bot_ventas' }, id, { content: 'Hola' })
    ).rejects.toThrow('No eres miembro de este canal');

    fake.rows('user').find((u) => u.id === 'bot_compras')!.isActive = false;
    await expect(
      sendSystemMessage({ id: 'bot_compras' }, id, { content: 'Hola' })
    ).rejects.toThrow('El usuario de IA está inactivo');
    expect(fake.rows('internalChatMessage')).toHaveLength(0);
  });

  it('persists meta, mentions only people and returns a bot DTO', async () => {
    const id = await comprasChannel();
    const meta = {
      kind: 'agent_request',
      requestId: 'req_1',
      caseId: 'case_1',
      quickActions: ['accept', 'block', 'open_case'],
    };

    const dto = await sendSystemMessage({ id: 'bot_compras' }, id, {
      content: '  📦 Solicitud a Compras · faltan 15 m². Responsable: @ana (cc @ia_compras)  ',
      meta,
    });

    const row = fake.rows('internalChatMessage').find((m) => m.id === dto.id)!;
    expect(row.meta).toEqual(meta);
    expect(dto).toMatchObject({
      channelId: id,
      senderId: 'bot_compras',
      senderName: 'IA de Compras',
      senderIsBot: true,
      meta,
      content: '📦 Solicitud a Compras · faltan 15 m². Responsable: @ana (cc @ia_compras)',
      mentions: ['ana'],
    });
    const channel = fake.rows('internalChatChannel').find((c) => c.id === id)!;
    expect((channel.lastMessageAt as Date).getTime()).toBe((row.createdAt as Date).getTime());
    expect(mocks.notifyChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: dto.id,
        senderIsBot: true,
        meta,
        mentionedUserIds: ['ana'],
      })
    );
  });

  it('replies inside the thread of a message of the same channel', async () => {
    const id = await comprasChannel();
    const root = await sendMessage(ana, { channelId: id, content: '¿Cuándo llega?' });

    const first = await sendSystemMessage({ id: 'bot_compras' }, id, {
      content: 'Llega el jueves',
      replyToId: root.id,
    });
    const second = await sendSystemMessage({ id: 'bot_compras' }, id, {
      content: 'Confirmado con el proveedor',
      replyToId: root.id,
    });

    expect(fake.rows('internalChatThread')).toHaveLength(1);
    expect(first.threadId).toBe(fake.rows('internalChatThread')[0].id);
    expect(second.threadId).toBe(first.threadId);
    expect(first.replyToId).toBe(root.id);

    fake.seed('internalChatChannel', { id: 'other', type: 'group', name: 'Otro', createdBy: 'ana' });
    fake.seed('internalChatMessage', { id: 'foreign', channelId: 'other', senderId: 'ana', content: 'x' });
    await expect(
      sendSystemMessage({ id: 'bot_compras' }, id, { content: 'No', replyToId: 'foreign' })
    ).rejects.toThrow('El mensaje al que respondes no pertenece a este canal');
  });

  it('rejects empty content and unusable meta', async () => {
    const id = await comprasChannel();
    await expect(sendSystemMessage({ id: 'bot_compras' }, id, { content: '   ' })).rejects.toThrow(
      'El mensaje debe tener contenido'
    );
    await expect(
      sendSystemMessage({ id: 'bot_compras' }, id, {
        content: 'Hola',
        meta: { kind: 'x'.repeat(65) },
      })
    ).rejects.toThrow('Tipo de metadatos inválido');
    await expect(
      sendSystemMessage({ id: 'bot_compras' }, id, {
        content: 'Hola',
        meta: { kind: 'agent_notice', blob: 'x'.repeat(20_000) },
      })
    ).rejects.toThrow('Los metadatos del mensaje son demasiado grandes');
  });

  it('never triggers the bot-mention hook, even when a bot mentions another bot', async () => {
    const id = await comprasChannel(['ana', 'bot_compras', 'bot_ventas']);
    const listener = vi.fn();
    const off = onBotMentioned(listener);
    try {
      await sendSystemMessage({ id: 'bot_compras' }, id, { content: '@ia_ventas avisa al cliente' });
    } finally {
      off();
    }
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('bot mentions from people', () => {
  it('calls the listeners with the mentioned bot members', async () => {
    const id = await comprasChannel();
    const events: BotMentionEvent[] = [];
    const off = onBotMentioned((event) => {
      events.push(event);
    });

    let message;
    try {
      message = await sendMessage(ana, {
        channelId: id,
        content: 'Hola @ia_compras, ¿llega el material? cc @luis @ia_compras',
      });
    } finally {
      off();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      messageId: message.id,
      channelId: id,
      channelType: 'area',
      senderId: 'ana',
      senderName: 'Ana',
      content: 'Hola @ia_compras, ¿llega el material? cc @luis @ia_compras',
      threadId: null,
      replyToId: null,
      bots: [{ userId: 'bot_compras', username: 'ia_compras', name: 'IA de Compras' }],
    });
    expect(message.mentions.sort()).toEqual(['bot_compras', 'luis']);
    expect(message.senderIsBot).toBe(false);
    expect(message.meta).toBeNull();
  });

  it('ignores messages without bot mentions, isolates failing listeners and honors unsubscribe', async () => {
    const id = await comprasChannel(['ana', 'luis', 'bot_compras', 'bot_ventas']);
    const failing = vi.fn(() => {
      throw new Error('boom');
    });
    const recorder = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const offFailing = onBotMentioned(failing);
    const offRecorder = onBotMentioned(recorder);

    try {
      await sendMessage(luis, { channelId: id, content: 'Gracias @ana' });
      expect(recorder).not.toHaveBeenCalled();

      await expect(
        sendMessage(luis, { channelId: id, content: '@ia_ventas y @ia_compras revisen' })
      ).resolves.toMatchObject({ senderId: 'luis' });
      expect(failing).toHaveBeenCalledTimes(1);
      expect(recorder).toHaveBeenCalledTimes(1);
      expect(recorder.mock.calls[0][0].bots.map((b: { userId: string }) => b.userId)).toEqual([
        'bot_ventas',
        'bot_compras',
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('chat.bot_mention_listener_failed'));
    } finally {
      offFailing();
      offRecorder();
      warn.mockRestore();
    }

    await sendMessage(luis, { channelId: id, content: '@ia_compras ¿sigues ahí?' });
    expect(recorder).toHaveBeenCalledTimes(1);
  });
});

describe('people-only channels and DTOs', () => {
  it('does not allow direct chats or groups with bots', async () => {
    await expect(createDmChannel(ana, 'bot_compras')).rejects.toThrow(
      'Los asistentes de IA solo participan en los canales de área'
    );
    await expect(createGroupChannel(ana, 'Equipo', ['luis', 'bot_compras'])).rejects.toThrow(
      'Los asistentes de IA solo participan en los canales de área'
    );
    expect(fake.rows('internalChatChannel')).toHaveLength(0);
  });

  it('marks bots in the user search', async () => {
    const results = await searchUsers(ana, 'ia');
    expect(results.find((u) => u.id === 'bot_compras')).toMatchObject({ isBot: true });
    const people = await searchUsers(ana, 'luis');
    expect(people).toEqual([expect.objectContaining({ id: 'luis', isBot: false })]);
  });

  it('exposes the area/case link and bot members in channel DTOs', async () => {
    const areaId = await comprasChannel();
    seedCase();
    const room = await createCaseRoom('case_1', {
      name: 'EXP-1',
      memberUserIds: ['ana', 'bot_ventas'],
      createdBy: 'bot_admin',
    });

    const area = await getChannel(areaId, 'ana');
    expect(area).toMatchObject({ type: 'area', areaKey: 'compras', caseId: null });
    expect(area?.members.find((m) => m.userId === 'bot_compras')?.isBot).toBe(true);
    expect(area?.members.find((m) => m.userId === 'ana')?.isBot).toBe(false);

    const channels = await listUserChannels('ana');
    expect(channels.find((c) => c.id === room.id)).toMatchObject({
      type: 'case',
      areaKey: null,
      caseId: 'case_1',
    });
  });

  it('counts unread messages only when there was activity after the last read', async () => {
    const id = await comprasChannel();
    const membership = fake
      .rows('internalChatMember')
      .find((m) => m.channelId === id && m.userId === 'ana')!;
    membership.lastReadAt = new Date(Date.now() - 60_000);
    await sendSystemMessage({ id: 'bot_compras' }, id, { content: 'Aviso' });

    const count = vi.spyOn(fake.client.internalChatMessage, 'count');
    try {
      expect((await listUserChannels('ana')).find((c) => c.id === id)?.unreadCount).toBe(1);
      expect(count).toHaveBeenCalledTimes(1);

      membership.lastReadAt = new Date(Date.now() + 60_000);
      count.mockClear();
      expect((await listUserChannels('ana')).find((c) => c.id === id)?.unreadCount).toBe(0);
      expect(count).not.toHaveBeenCalled();
    } finally {
      count.mockRestore();
    }
  });

  it('does not let people leave or remove members of managed channels', async () => {
    const id = await comprasChannel();
    await expect(removeMember(ana, id, 'ana')).rejects.toThrow(
      'Los miembros de los canales de área y de las salas de venta se administran automáticamente'
    );
    expect(activeMembers(id)).toContain('ana');
  });
});
