import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Messaging fan-out (`comms.message_fanout`): the CRM touch always runs, the
 * RFQ interpretation only for inbound replies in conversations tagged `rfq:*`;
 * a failing receiver does not stop the other one and makes the job retry. The
 * registered handler loads the real receivers on demand (mocked modules here).
 */

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  registerJobHandler: vi.fn(),
  touchConversation: vi.fn(async () => ({ status: 'touched' })),
  interpretRfqReplyIfTagged: vi.fn(async () => ({ enqueued: 1 })),
  knownPermissions: new Set(['crm.view', 'purchases.view']),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { commMessage: { findUnique: h.findUnique, update: vi.fn() } },
}));
vi.mock('@/modules/jobs/job-queue', () => ({
  registerJobHandler: h.registerJobHandler,
  JOB_PRIORITY: { interactive: 10, normal: 100, maintenance: 300, bulk: 500 },
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: vi.fn() }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: vi.fn(),
  REALTIME_CHANNELS: {
    user: (id: string) => `user:${id}`,
    inbox: (scope: string) => `inbox:${scope}`,
  },
}));
vi.mock('@/modules/storage/storage-service', () => ({ saveGeneratedFile: vi.fn() }));
vi.mock('./adapters', () => ({ getChannelAdapter: vi.fn(), hasMediaFetcher: vi.fn(() => false) }));
vi.mock('./commitments-service', () => ({ markOverdueCommitments: vi.fn(async () => []) }));
vi.mock('./comms-service', () => ({
  COMMS_PROCESS_INBOUND_JOB: 'comms.process_inbound',
  COMMS_MESSAGE_FANOUT_JOB: 'comms.message_fanout',
}));
vi.mock('./comms-storage', () => ({}));
vi.mock('@/modules/crm/opportunities-service', () => ({ touchConversation: h.touchConversation }));
vi.mock('@/modules/auth/permissions', () => ({
  isKnownPermission: (key: string) => h.knownPermissions.has(key),
}));
vi.mock('@/modules/purchases/rfq-service', () => ({
  interpretRfqReplyIfTagged: h.interpretRfqReplyIfTagged,
}));

import {
  FANOUT_RECEIVER_NOT_INSTALLED,
  RFQ_CONVERSATION_TAG_PREFIX,
  defaultMessageFanoutDeps,
  runMessageFanout,
  type MessageFanoutDeps,
} from './comms-jobs';
import {
  RFQ_CONVERSATION_TAG_PREFIX as PURCHASES_RFQ_TAG_PREFIX,
  rfqConversationTag,
  rfqIdsFromConversationTags,
} from '@/modules/purchases/purchases-types';

function deps(): MessageFanoutDeps & {
  touchConversation: ReturnType<typeof vi.fn>;
  interpretRfqReplyIfTagged: ReturnType<typeof vi.fn>;
} {
  return {
    touchConversation: vi.fn(async () => undefined),
    interpretRfqReplyIfTagged: vi.fn(async () => undefined),
  };
}

function message(direction: 'inbound' | 'outbound', tags: string[] = []) {
  return { id: 'm1', direction, conversation: { tags } };
}

beforeEach(() => {
  h.findUnique.mockReset();
  h.touchConversation.mockClear();
  h.interpretRfqReplyIfTagged.mockClear();
});

describe('etiqueta rfq:{id}: un solo contrato entre Compras y el fan-out', () => {
  it('el prefijo del fan-out es el MISMO que el de Compras (reexportado, no copiado)', async () => {
    expect(RFQ_CONVERSATION_TAG_PREFIX).toBe(PURCHASES_RFQ_TAG_PREFIX);
    // Guarda contra reintroducir el literal: si alguien vuelve a declararlo aquí,
    // Compras podría cambiar el prefijo y el fan-out dejaría de interpretar EN SILENCIO.
    const source = await readFile(new URL('./comms-jobs.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/RFQ_CONVERSATION_TAG_PREFIX\s*=\s*['"`]/);
  });

  it('el fan-out reacciona a la etiqueta que Compras escribe, y la etiqueta devuelve su rfqId', async () => {
    const tag = rfqConversationTag('rfq_777');
    expect(rfqIdsFromConversationTags(['vip', tag])).toEqual(['rfq_777']);
    h.findUnique.mockResolvedValue(message('inbound', ['vip', tag]));
    const receivers = deps();
    expect(await runMessageFanout('m1', receivers)).toMatchObject({ rfq: 'done' });
    expect(receivers.interpretRfqReplyIfTagged).toHaveBeenCalledWith('m1');
  });

  it('una etiqueta con otro prefijo no encola la interpretación', async () => {
    h.findUnique.mockResolvedValue(message('inbound', ['rfq_rfq_777', 'oc:oc_1']));
    const receivers = deps();
    expect(await runMessageFanout('m1', receivers)).toMatchObject({ rfq: 'not_tagged' });
    expect(receivers.interpretRfqReplyIfTagged).not.toHaveBeenCalled();
  });
});

describe('runMessageFanout', () => {
  it('interprets inbound replies of RFQ conversations and touches the CRM', async () => {
    h.findUnique.mockResolvedValue(message('inbound', ['vip', rfqConversationTag('rfq_123')]));
    const receivers = deps();
    expect(await runMessageFanout('m1', receivers)).toEqual({
      messageId: 'm1',
      crm: 'done',
      rfq: 'done',
    });
    expect(receivers.interpretRfqReplyIfTagged).toHaveBeenCalledWith('m1');
    expect(receivers.touchConversation).toHaveBeenCalledWith('m1');
  });

  it('only touches the CRM for untagged conversations and outbound messages', async () => {
    const receivers = deps();
    h.findUnique.mockResolvedValueOnce(message('inbound', ['vip']));
    expect(await runMessageFanout('m1', receivers)).toMatchObject({
      crm: 'done',
      rfq: 'not_tagged',
    });
    h.findUnique.mockResolvedValueOnce(message('outbound', [rfqConversationTag('rfq_123')]));
    expect(await runMessageFanout('m1', receivers)).toMatchObject({ crm: 'done', rfq: 'outbound' });
    expect(receivers.interpretRfqReplyIfTagged).not.toHaveBeenCalled();
    expect(receivers.touchConversation).toHaveBeenCalledTimes(2);
  });

  it('skips a message that no longer exists', async () => {
    h.findUnique.mockResolvedValue(null);
    const receivers = deps();
    expect(await runMessageFanout('gone', receivers)).toEqual({
      messageId: 'gone',
      skipped: 'missing',
      crm: 'skipped',
      rfq: 'not_tagged',
    });
    expect(receivers.touchConversation).not.toHaveBeenCalled();
  });

  it('runs both receivers when one fails and throws so the job retries', async () => {
    h.findUnique.mockResolvedValue(message('inbound', [rfqConversationTag('rfq_9')]));
    const receivers = deps();
    receivers.interpretRfqReplyIfTagged.mockRejectedValue(new Error('modelo no disponible'));
    await expect(runMessageFanout('m1', receivers)).rejects.toThrow(
      'Fan-out incompleto del mensaje m1: RFQ: modelo no disponible'
    );
    expect(receivers.touchConversation).toHaveBeenCalledWith('m1');

    receivers.interpretRfqReplyIfTagged.mockResolvedValue(undefined);
    receivers.touchConversation.mockRejectedValue(new Error('base ocupada'));
    await expect(runMessageFanout('m1', receivers)).rejects.toThrow('CRM: base ocupada');
  });
});

describe('comms.message_fanout handler', () => {
  it('is registered and calls the CRM and purchases receivers', async () => {
    const registration = h.registerJobHandler.mock.calls.find(
      ([type]) => type === 'comms.message_fanout'
    );
    expect(registration).toBeDefined();
    const handler = registration![1] as (ctx: {
      payload: { messageId: string };
      log: (...args: unknown[]) => void;
    }) => Promise<unknown>;
    h.findUnique.mockResolvedValue(message('inbound', [rfqConversationTag('rfq_1')]));

    await expect(handler({ payload: { messageId: 'm7' }, log: vi.fn() })).resolves.toEqual({
      messageId: 'm7',
      crm: 'done',
      rfq: 'done',
    });
    expect(h.touchConversation).toHaveBeenCalledWith('m7');
    expect(h.interpretRfqReplyIfTagged).toHaveBeenCalledWith('m7');
  });

  it('never loads (nor retries) a receiver whose module permissions are not registered', async () => {
    h.knownPermissions = new Set();
    await expect(defaultMessageFanoutDeps.touchConversation('m8')).resolves.toEqual(
      FANOUT_RECEIVER_NOT_INSTALLED
    );
    await expect(defaultMessageFanoutDeps.interpretRfqReplyIfTagged('m8')).resolves.toEqual(
      FANOUT_RECEIVER_NOT_INSTALLED
    );
    h.findUnique.mockResolvedValue(message('inbound', [rfqConversationTag('rfq_1')]));
    await expect(runMessageFanout('m8')).resolves.toMatchObject({ crm: 'done', rfq: 'done' });
    expect(h.touchConversation).not.toHaveBeenCalled();
    expect(h.interpretRfqReplyIfTagged).not.toHaveBeenCalled();
    h.knownPermissions = new Set(['crm.view', 'purchases.view']);
  });
});
