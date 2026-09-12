import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { MockChannelAdapter } from '@/modules/comms/channel-adapters';

/**
 * Dispatcher: per-send checks (status, opt-out, budget), atomic recipient
 * claim, messages/usage/realtime, batch chaining and idempotent resume.
 */

const { db, jobs, events, usage } = vi.hoisted(() => ({
  db: {
    current: null as null | ReturnType<
      typeof import('./testing/in-memory-prisma').createInMemoryPrisma
    >,
  },
  jobs: { enqueued: [] as Array<Record<string, unknown>> },
  events: [] as Array<{ channel: string; type: string; payload: Record<string, unknown> }>,
  usage: [] as Array<unknown[]>,
}));

vi.mock('@/lib/prisma', async () => {
  const { createInMemoryPrisma } = await import('./testing/in-memory-prisma');
  const { Prisma } = await import('@prisma/client');
  db.current = createInMemoryPrisma({
    campaign: {
      idPrefix: 'c',
      defaults: () => ({
        budgetLimit: null,
        budgetSpent: new Prisma.Decimal(0),
        costPerMessage: new Prisma.Decimal(0),
        batchSize: 500,
        ratePerMinute: 6000,
        scheduledAt: null,
        startedAt: null,
        pausedAt: null,
        completedAt: null,
        stats: null,
        approvedBy: null,
        approvedAt: null,
      }),
    },
    campaignRecipient: {
      idPrefix: 'r',
      uniques: [['campaignId', 'contactId']],
      defaults: () => ({
        status: 'pending',
        batchNo: 0,
        messageId: null,
        error: null,
        sentAt: null,
      }),
    },
    consentRecord: { idPrefix: 'cs', defaults: () => ({ recordedAt: new Date() }) },
    commAccount: { idPrefix: 'acc', defaults: () => ({ status: 'active', teamKeys: [] }) },
    commConversation: { idPrefix: 'cv' },
    commMessage: { idPrefix: 'm' },
    backgroundJob: { idPrefix: 'job' },
  });
  return { prisma: db.current.prisma };
});
vi.mock('@/modules/jobs/job-queue', () => ({
  JOB_PRIORITY: { interactive: 10, normal: 100, maintenance: 300, bulk: 500 },
  enqueueJob: async (input: Record<string, unknown>) => {
    jobs.enqueued.push(input);
    return { id: `job${jobs.enqueued.length}`, status: 'pending', deduplicated: false };
  },
  cancelJobsByGroup: async () => 0,
}));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: async (channel: string, type: string, payload: Record<string, unknown>) => {
    events.push({ channel, type, payload });
    return { id: '1' };
  },
}));
vi.mock('@/modules/extensions/usage-meter', () => ({
  recordUsage: async (...args: unknown[]) => {
    usage.push(args);
  },
}));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: async () => undefined }));

import { dispatchBatch, type DispatchDeps } from './campaign-dispatcher';

const t = () => db.current!.tables;

interface Seeded {
  campaignId: string;
  accountId: string;
  recipients: string[];
}

async function seed(
  opts: {
    recipients: number;
    batchSize?: number;
    budgetLimit?: number | null;
    cost?: number;
    status?: string;
  } = { recipients: 2 }
): Promise<Seeded> {
  const account = await t().commAccount.create({
    data: { provider: 'twilio_whatsapp', label: 'WA', identifier: '+5215500000000' },
  });
  const campaign = await t().campaign.create({
    data: {
      name: 'Promo',
      channel: 'whatsapp',
      accountId: account.id,
      status: opts.status ?? 'running',
      createdBy: 'u1',
      startedAt: new Date(),
      batchSize: opts.batchSize ?? 500,
      budgetLimit:
        opts.budgetLimit === undefined || opts.budgetLimit === null
          ? null
          : new Prisma.Decimal(opts.budgetLimit),
      costPerMessage: new Prisma.Decimal(opts.cost ?? 1),
      audienceSnapshot: {
        filter: { tags: [] },
        count: opts.recipients,
        frozenAt: new Date().toISOString(),
      },
      contentSnapshot: {
        body: 'Hola {{nombre}}',
        variables: {},
        frozenAt: new Date().toISOString(),
      },
      stats: { counts: {}, total: opts.recipients },
    },
  });
  const recipients: string[] = [];
  for (let i = 0; i < opts.recipients; i++) {
    const contactId = `ct${i}`;
    await t().consentRecord.create({
      data: { contactId, channel: 'whatsapp', status: 'opted_in', source: 'test' },
    });
    const r = await t().campaignRecipient.create({
      data: {
        campaignId: campaign.id,
        contactId,
        identifier: `+52155000000${i}`,
        personalization: { nombre: `Persona ${i}` },
        batchNo: Math.floor(i / (opts.batchSize ?? 500)),
        createdAt: new Date(Date.now() + i),
      },
    });
    recipients.push(r.id as string);
  }
  return { campaignId: campaign.id as string, accountId: account.id as string, recipients };
}

function deps(adapter: MockChannelAdapter, overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    getAdapter: () => adapter,
    sleep: async () => undefined,
    now: () => new Date(),
    maxRunMs: 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  db.current!.reset();
  jobs.enqueued.length = 0;
  events.length = 0;
  usage.length = 0;
});

describe('dispatchBatch', () => {
  it('sends a batch, records messages, budget, usage and completes the campaign', async () => {
    const { campaignId, accountId } = await seed({ recipients: 2, cost: 0.25 });
    const adapter = new MockChannelAdapter();
    const res = await dispatchBatch({ campaignId, batchNo: 0, accountId }, deps(adapter));
    expect(res).toMatchObject({ sent: 2, failed: 0, outcome: 'campaign_completed' });
    expect(adapter.sent.map((s) => s.message.body)).toEqual(['Hola Persona 0', 'Hola Persona 1']);
    expect(adapter.sent[0].message.idempotencyKey).toBe(
      `campaign:${campaignId}:recipient:${t().campaignRecipient.rows[0].id}`
    );

    const messages = t().commMessage.rows;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      direction: 'outbound',
      campaignId,
      status: 'sent',
      accountId,
      externalId: 'mock-1',
    });
    expect(t().commConversation.rows).toHaveLength(2);
    expect(t().campaignRecipient.rows.every((r) => r.status === 'sent' && r.messageId)).toBe(true);

    const campaign = t().campaign.rows[0];
    expect(campaign.status).toBe('completed');
    // Adapter reported cost 0.01 per message (mock) → 0.02 spent.
    expect(new Prisma.Decimal(campaign.budgetSpent as never).toFixed(4)).toBe('0.0200');
    expect(usage.filter((u) => u[0] === 'campaign' && u[2] === 'messages')).toHaveLength(2);
    expect(usage.filter((u) => u[0] === 'provider' && u[2] === 'cost')).toHaveLength(2);
    expect(events.some((e) => e.type === 'campaign.progress' && e.payload.completed === true)).toBe(
      true
    );
    expect(
      events.some((e) => e.type === 'campaign.status' && e.payload.status === 'completed')
    ).toBe(true);
  });

  it('an opt-out registered during the campaign prevents the following send', async () => {
    const { campaignId, accountId } = await seed({ recipients: 3 });
    const adapter = new MockChannelAdapter();
    let sends = 0;
    const res = await dispatchBatch(
      { campaignId, batchNo: 0, accountId },
      deps(adapter, {
        sleep: async () => {
          sends++;
          if (sends === 1) {
            await t().consentRecord.create({
              data: {
                contactId: 'ct1',
                channel: 'whatsapp',
                status: 'opted_out',
                source: 'inbound:BAJA',
                recordedAt: new Date(Date.now() + 1000),
              },
            });
          }
        },
      })
    );
    expect(res).toMatchObject({ sent: 2, optedOut: 1, outcome: 'campaign_completed' });
    expect(adapter.sent.map((s) => s.message.to)).toEqual(['+521550000000', '+521550000002']);
    const r1 = t().campaignRecipient.rows.find((r) => r.contactId === 'ct1');
    expect(r1?.status).toBe('opted_out');
    expect(r1?.messageId).toBeNull();
  });

  it('pauses the campaign (with event) when the next send would exceed the budget', async () => {
    const { campaignId, accountId } = await seed({ recipients: 3, cost: 1, budgetLimit: 1.5 });
    const adapter = new MockChannelAdapter(); // reports cost 0.01 but the budget check uses costPerMessage
    // Make the adapter cost equal to the configured cost so the second send breaches the limit.
    adapter.send = async (account, message) => {
      adapter.sent.push({ accountId: account.id, message });
      return { externalId: `mock-${adapter.sent.length}`, status: 'sent', cost: 1 };
    };
    const res = await dispatchBatch({ campaignId, batchNo: 0, accountId }, deps(adapter));
    expect(res).toMatchObject({ sent: 1, outcome: 'paused', reason: 'budget_exceeded' });
    const campaign = t().campaign.rows[0];
    expect(campaign.status).toBe('paused');
    expect((campaign.stats as { pauseReason?: string }).pauseReason).toBe('budget_exceeded');
    expect(new Prisma.Decimal(campaign.budgetSpent as never).toFixed(2)).toBe('1.00');
    expect(t().campaignRecipient.rows.filter((r) => r.status === 'pending')).toHaveLength(2);
    expect(
      events.some((e) => e.type === 'campaign.status' && e.payload.reason === 'budget_exceeded')
    ).toBe(true);
  });

  it('an interrupted batch resumes from pending recipients without re-sending', async () => {
    const { campaignId, accountId } = await seed({ recipients: 3 });
    const adapter = new MockChannelAdapter();
    const controller = new AbortController();
    const first = await dispatchBatch(
      { campaignId, batchNo: 0, accountId },
      deps(adapter, { signal: controller.signal, sleep: async () => controller.abort() })
    );
    expect(first).toMatchObject({ sent: 1, outcome: 'interrupted' });
    expect(t().campaign.rows[0].status).toBe('running');

    const second = await dispatchBatch({ campaignId, batchNo: 0, accountId }, deps(adapter));
    expect(second).toMatchObject({ sent: 2, outcome: 'campaign_completed' });
    expect(adapter.sent.map((s) => s.message.to)).toEqual([
      '+521550000000',
      '+521550000001',
      '+521550000002',
    ]);
    expect(t().commMessage.rows).toHaveLength(3);
    expect(t().campaignRecipient.rows.filter((r) => r.status === 'sent')).toHaveLength(3);
  });

  it('chains the next batch with a per-batch dedupe key and completes on the last one', async () => {
    const { campaignId, accountId } = await seed({ recipients: 3, batchSize: 2 });
    const adapter = new MockChannelAdapter();
    const b0 = await dispatchBatch({ campaignId, batchNo: 0, accountId }, deps(adapter));
    expect(b0).toMatchObject({ sent: 2, outcome: 'next_batch' });
    expect(jobs.enqueued[0]).toMatchObject({
      type: 'campaigns.dispatch_batch',
      priority: 500,
      dedupeKey: `campaign:${campaignId}:batch:1`,
      groupKey: `campaign:${campaignId}`,
      payload: { campaignId, batchNo: 1, accountId },
    });
    const b1 = await dispatchBatch({ campaignId, batchNo: 1, accountId }, deps(adapter));
    expect(b1).toMatchObject({ sent: 1, outcome: 'campaign_completed' });
    expect(t().campaign.rows[0].status).toBe('completed');
  });

  it('does nothing when the campaign is not running and records provider failures', async () => {
    const paused = await seed({ recipients: 1, status: 'paused' });
    const adapter = new MockChannelAdapter();
    const res = await dispatchBatch(
      { campaignId: paused.campaignId, batchNo: 0, accountId: paused.accountId },
      deps(adapter)
    );
    expect(res.outcome).toBe('stopped');
    expect(adapter.sent).toHaveLength(0);

    db.current!.reset();
    const { campaignId, accountId } = await seed({ recipients: 2 });
    const failing = new MockChannelAdapter('twilio_whatsapp', (m) =>
      m.to.endsWith('1') ? 'número inválido' : null
    );
    const out = await dispatchBatch({ campaignId, batchNo: 0, accountId }, deps(failing));
    expect(out).toMatchObject({ sent: 1, failed: 1, outcome: 'campaign_completed' });
    const failedRecipient = t().campaignRecipient.rows.find((r) => r.status === 'failed');
    expect(failedRecipient?.error).toBe('número inválido');
    expect(t().commMessage.rows.find((m) => m.status === 'failed')?.error).toBe('número inválido');
  });
});
