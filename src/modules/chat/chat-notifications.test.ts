import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return {
    fake: createOpsFake({
      relations: { internalChatMember: { user: { model: 'user', fk: 'userId' } } },
      defaults: { internalChatMember: () => ({ leftAt: null, mutedUntil: null }) },
    }),
    notifyUser: vi.fn(async (input: Record<string, unknown>) => ({ id: String(input.userId) })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));

import { seedUser } from '@/modules/operations/testing/fixtures';
import { notifyChatMessage } from './chat-notifications';

const { fake } = mocks;

function notifiedUserIds(): string[] {
  return mocks.notifyUser.mock.calls.map(([input]) => String(input.userId)).sort();
}

beforeEach(() => {
  fake.tables.clear();
  mocks.notifyUser.mockClear();
  seedUser(fake, { id: 'ana', name: 'Ana' });
  seedUser(fake, { id: 'luis', name: 'Luis' });
  seedUser(fake, { id: 'bot_compras', name: 'IA de Compras', isBot: true });
  seedUser(fake, { id: 'bot_admin', name: 'IA Administradora', isBot: true });
  fake.seed('internalChatChannel', { id: 'chan', type: 'area', name: 'Compras', createdBy: 'bot_admin' });
  for (const userId of ['ana', 'luis', 'bot_compras', 'bot_admin']) {
    fake.seed('internalChatMember', { channelId: 'chan', userId, role: 'member' });
  }
});

const base = {
  messageId: 'msg_1',
  channelId: 'chan',
  content: 'Solicitud a Compras',
};

describe('notifyChatMessage with AI users', () => {
  it('skips template posts of bots (the dispatcher notifies the responsible)', async () => {
    await notifyChatMessage({
      ...base,
      senderId: 'bot_compras',
      senderName: 'IA de Compras',
      senderIsBot: true,
      meta: { kind: 'agent_request', requestId: 'req_1' },
      mentionedUserIds: ['ana'],
    });
    await notifyChatMessage({
      ...base,
      senderId: 'bot_compras',
      senderName: 'IA de Compras',
      senderIsBot: true,
      meta: { kind: 'case_started', template: true },
    });

    expect(mocks.notifyUser).not.toHaveBeenCalled();
  });

  it('notifies people (never bot members) for free-form bot replies', async () => {
    await notifyChatMessage({
      ...base,
      senderId: 'bot_compras',
      senderName: 'IA de Compras',
      senderIsBot: true,
      meta: { kind: 'agent_reply' },
      mentionedUserIds: ['ana'],
    });

    expect(notifiedUserIds()).toEqual(['ana', 'luis']);
    const toAna = mocks.notifyUser.mock.calls.find(([input]) => input.userId === 'ana')![0];
    expect(toAna).toMatchObject({ category: 'chat_mention', title: 'IA de Compras te mencionó en #Compras' });
  });

  it('keeps notifying people for human messages, excluding bot members', async () => {
    await notifyChatMessage({
      ...base,
      senderId: 'ana',
      senderName: 'Ana',
      // a person cannot opt out of notifications with a template-looking meta
      meta: { kind: 'agent_request' },
    });

    expect(notifiedUserIds()).toEqual(['luis']);
  });
});
