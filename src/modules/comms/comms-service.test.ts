import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { CommAccount } from '@prisma/client';
import type { ChannelAdapter, OutboundMessage, OutboundResult } from './channel-adapters';

/**
 * Inbox service with an in-memory Prisma and a scripted channel adapter:
 * single persistence of inbound messages, consent gate, uncertain sends,
 * duplicate merge, assisted handover.
 */

const { db, sent, script, scriptedAdapter } = await vi.hoisted(async () => {
  const { FakePrisma } = await import('./testing/fake-prisma');
  const sentMessages: OutboundMessage[] = [];
  const state: { next: OutboundResult } = {
    next: { externalId: 'ext-1', status: 'sent', cost: 0.01 },
  };
  const adapter: ChannelAdapter = {
    provider: 'twilio_whatsapp',
    async send(_account, message) {
      sentMessages.push(message);
      return state.next;
    },
    async parseWebhook() {
      return null;
    },
    async testConnection() {
      return { ok: true, detail: 'mock' };
    },
  };
  return { db: new FakePrisma(), sent: sentMessages, script: state, scriptedAdapter: adapter };
});

vi.mock('@/lib/prisma', () => ({ prisma: db.client }));
vi.mock('@/modules/auth/authorization', () => ({
  hasPermission: (user: CurrentUser, key: string) =>
    user.isSuperAdmin || user.permissionKeys.includes(key as never),
}));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: vi.fn(async () => undefined) }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: vi.fn(async () => ({})),
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}`, inbox: (s: string) => `inbox:${s}` },
}));
vi.mock('@/modules/jobs/job-queue', () => ({
  enqueueJob: vi.fn(async () => ({ id: 'job1', status: 'pending', deduplicated: false })),
  registerJobHandler: () => undefined,
  JOB_PRIORITY: { interactive: 10, normal: 100, maintenance: 300, bulk: 500 },
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: () => undefined }));
vi.mock('@/modules/storage/storage-access', () => ({
  registerFileAccessResolver: () => undefined,
  registerUploadTargetResolver: () => undefined,
  resolveFileAccess: async (_actor: unknown, id: string) => ({
    allowed: true,
    object: { id, status: 'ready' },
  }),
}));
vi.mock('@/modules/storage/storage-service', () => ({
  StorageError: class extends Error {},
  saveGeneratedFile: vi.fn(),
  authorizeDownload: vi.fn(),
  getStorageObject: vi.fn(),
  readObjectToBuffer: vi.fn(),
}));
vi.mock('@/modules/extensions/connections-service', () => ({
  createConnection: vi.fn(async () => ({ id: 'conn1' })),
  readConnectionSecret: vi.fn(async () => ({})),
}));
vi.mock('@/modules/ai/ai-client', () => ({
  chatCompletion: vi.fn(async () => {
    throw new Error('IA no disponible');
  }),
}));
vi.mock('@/modules/comms/adapters', () => ({
  getChannelAdapter: () => scriptedAdapter,
  listChannelProviders: () => ['twilio_whatsapp'],
  hasMediaFetcher: () => false,
  PROVIDER_HOSTS: { twilio_whatsapp: ['api.twilio.com'] },
  extensionNamespaceFor: () => 'comm.twilio',
  generateTelegramWebhookSecret: () => ({ secret: 's', hash: 'h' }),
  verifyTelegramSecret: () => true,
  computeTwilioSignature: () => '',
  resolveTwilioWebhookUrl: (u: string) => u,
}));

import {
  listConversations,
  mergeDuplicate,
  recordInboundMessage,
  sendOutboundMessage,
  updateConversation,
} from './comms-service';
import { CommsError } from './comms-errors';
import { detectConsentKeyword, normalizePhone } from './normalize';

const agent: CurrentUser = {
  id: 'u_agent',
  username: 'agent',
  name: 'Agente Uno',
  email: null,
  mustChangePassword: false,
  roleKeys: ['ventas'],
  permissionKeys: ['inbox.use', 'inbox.assign'] as never,
  isSuperAdmin: false,
};
const outsider: CurrentUser = {
  ...agent,
  id: 'u_out',
  roleKeys: ['cobranza'],
  permissionKeys: ['inbox.use'] as never,
};

let account: CommAccount;

beforeEach(() => {
  db.tables.clear();
  sent.length = 0;
  script.next = { externalId: 'ext-1', status: 'sent', cost: 0.01 };
  account = db.seed('commAccount', {
    provider: 'twilio_whatsapp',
    label: 'Ventas',
    identifier: '+5218112345678',
    teamKeys: ['ventas'],
  }) as CommAccount;
  db.seed('user', { id: 'u_agent', name: 'Agente Uno', username: 'agent' });
  db.seed('user', { id: 'u_two', name: 'Agente Dos', username: 'two' });
  db.seed('user', { id: 'u_out', name: 'Cobranza', username: 'cob' });
});

function inbound(
  externalId: string,
  body: string,
  from = '+5218199999999',
  receivedAt = new Date()
) {
  return { externalId, from, fromName: 'Ana', body, media: [], receivedAt };
}

describe('inbound persistence', () => {
  it('stores an external message exactly once and increments unread', async () => {
    const first = await recordInboundMessage(account, inbound('SM1', 'Hola'));
    const second = await recordInboundMessage(account, inbound('SM1', 'Hola'));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(db.rows('commMessage')).toHaveLength(1);
    expect(db.rows('commContact')).toHaveLength(1);
    expect(db.rows('commContact')[0].phone).toBe('+5218199999999');
    const conversation = db.rows('commConversation')[0];
    expect(conversation.unreadCount).toBe(1);
    expect(conversation.lastInboundAt).toBeInstanceOf(Date);
  });

  it('reuses the contact conversation and reopens it when resolved', async () => {
    await recordInboundMessage(account, inbound('SM1', 'Hola'));
    db.rows('commConversation')[0].status = 'resolved';
    await recordInboundMessage(account, inbound('SM2', 'Sigo aquí'));
    expect(db.rows('commConversation')).toHaveLength(1);
    expect(db.rows('commConversation')[0].status).toBe('open');
    expect(db.rows('commMessage')).toHaveLength(2);
  });

  it('records opt-out and opt-in keywords as consent records', async () => {
    await recordInboundMessage(account, inbound('SM1', 'BAJA'));
    expect(db.rows('consentRecord')[0]).toMatchObject({
      channel: 'whatsapp',
      status: 'opted_out',
      source: 'keyword',
    });
    await recordInboundMessage(account, inbound('SM2', 'alta'));
    expect(db.rows('consentRecord')[1]).toMatchObject({ status: 'opted_in' });
    expect(detectConsentKeyword('  Stop ')).toBe('opted_out');
    expect(detectConsentKeyword('quiero darme de baja del servicio')).toBeNull();
    expect(normalizePhone('whatsapp:+52 (81) 1234-5678')).toBe('+528112345678');
    expect(normalizePhone('8112345678')).toBe('+528112345678');
  });
});

describe('outbound sending', () => {
  it('blocks sending after an opt-out unless the contact wrote again within 24h', async () => {
    const { conversation } = await recordInboundMessage(account, inbound('SM1', 'Hola'));
    const contactId = conversation.contactId;
    db.seed('consentRecord', {
      contactId,
      channel: 'whatsapp',
      status: 'opted_out',
      source: 'keyword',
      recordedAt: new Date(),
    });
    await expect(
      sendOutboundMessage({
        accountId: account.id,
        conversationId: conversation.id,
        body: 'Hola',
        sentByUserId: agent.id,
        actor: agent,
      })
    ).rejects.toMatchObject({ code: 'opted_out' });
    expect(sent).toHaveLength(0);

    // The customer writes again after opting out: replies inside the window are allowed.
    await recordInboundMessage(
      account,
      inbound('SM2', 'Ok, sí me interesa', '+5218199999999', new Date(Date.now() + 5_000))
    );
    const message = await sendOutboundMessage({
      accountId: account.id,
      conversationId: conversation.id,
      body: 'Con gusto',
      sentByUserId: agent.id,
      actor: agent,
    });
    expect(message.status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('+5218199999999');
    expect(sent[0].idempotencyKey).toBe(message.id);
  });

  it('marks the message uncertain when the adapter cannot confirm', async () => {
    const { conversation } = await recordInboundMessage(account, inbound('SM1', 'Hola'));
    script.next = { externalId: null, status: 'queued', uncertain: true, error: 'timeout' };
    const message = await sendOutboundMessage({
      accountId: account.id,
      conversationId: conversation.id,
      body: 'Hola',
      sentByUserId: agent.id,
      actor: agent,
    });
    expect(message.uncertain).toBe(true);
    expect(message.status).toBe('queued');
    expect(db.rows('commMessage').find((m) => m.id === message.id)?.providerMeta).toMatchObject({
      uncertain: true,
    });
  });

  it('refuses users whose teams do not include the account', async () => {
    const { conversation } = await recordInboundMessage(account, inbound('SM1', 'Hola'));
    await expect(
      sendOutboundMessage({
        accountId: account.id,
        conversationId: conversation.id,
        body: 'Hola',
        sentByUserId: outsider.id,
        actor: outsider,
      })
    ).rejects.toBeInstanceOf(CommsError);
    const list = await listConversations(outsider, {});
    expect(list.items).toHaveLength(0);
    const mine = await listConversations(agent, { search: 'Ana' });
    expect(mine.items).toHaveLength(1);
  });
});

describe('assignment', () => {
  it('assigns a conversation to the current agent', async () => {
    const { conversation } = await recordInboundMessage(
      account,
      inbound('SM1', 'Necesito una cotización')
    );
    const assigned = await updateConversation(agent, conversation.id, {
      assignedToUserId: agent.id,
    });
    expect(assigned.assignedToUserId).toBe('u_agent');
  });

  it('lets a plain inbox user take an unassigned conversation but not reassign it', async () => {
    const plain: CurrentUser = { ...agent, id: 'u_two', permissionKeys: ['inbox.use'] as never };
    const { conversation } = await recordInboundMessage(account, inbound('SM1', 'Hola'));
    const taken = await updateConversation(plain, conversation.id, { assignedToUserId: 'u_two' });
    expect(taken.assignedToUserId).toBe('u_two');
    await expect(
      updateConversation(plain, conversation.id, { assignedToUserId: 'u_agent' })
    ).rejects.toBeInstanceOf(CommsError);
  });
});

describe('duplicate contacts', () => {
  it('flags a probable duplicate for review and merges conversations into the survivor', async () => {
    const survivor = db.seed('commContact', {
      displayName: 'Ana López',
      phone: '+5218199999999',
      email: 'ana@acme.com',
    });
    // A second contact created from Telegram with the same email gets flagged when reviewed.
    const { createContact } = await import('./comms-contacts-service');
    const created = await createContact(agent, {
      displayName: 'Ana Lopez',
      email: 'ANA@acme.com',
      telegramId: '555',
    });
    expect(created.duplicateReviewStatus).toBe('pending');
    expect(created.duplicateOfId).toBe(survivor.id);

    const conversation = db.seed('commConversation', {
      accountId: account.id,
      contactId: created.id,
    });
    db.seed('commitment', {
      description: 'Enviar cotización',
      ownerUserId: 'u_agent',
      contactId: created.id,
    });

    const merged = await mergeDuplicate(agent, created.id);
    expect(merged.survivor.id).toBe(survivor.id);
    expect(merged.moved.conversations).toBe(1);
    expect(merged.moved.commitments).toBe(1);
    expect(db.rows('commConversation').find((c) => c.id === conversation.id)?.contactId).toBe(
      survivor.id
    );
    const dup = db.rows('commContact').find((c) => c.id === created.id)!;
    expect(dup).toMatchObject({
      duplicateReviewStatus: 'confirmed',
      duplicateOfId: survivor.id,
      telegramId: null,
    });
    expect(db.rows('commContact').find((c) => c.id === survivor.id)?.telegramId).toBe('555');
  });
});
