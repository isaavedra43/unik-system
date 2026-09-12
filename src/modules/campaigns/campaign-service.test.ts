import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Campaign service: frozen audience (consent, identifiers, batches) that
 * ignores later tag changes, frozen content, rehearsal through the mock
 * adapter, exact preview, budget-checked approval and lifecycle control.
 */

const { db, jobs, events } = vi.hoisted(() => ({
  db: {
    current: null as null | ReturnType<
      typeof import('./testing/in-memory-prisma').createInMemoryPrisma
    >,
  },
  jobs: { enqueued: [] as Array<Record<string, unknown>>, cancelledGroups: [] as string[] },
  events: [] as Array<{ channel: string; type: string; payload: unknown }>,
}));

vi.mock('@/lib/prisma', async () => {
  const { createInMemoryPrisma } = await import('./testing/in-memory-prisma');
  const { Prisma } = await import('@prisma/client');
  db.current = createInMemoryPrisma({
    campaign: {
      idPrefix: 'c',
      defaults: () => ({
        audienceSnapshot: null,
        contentSnapshot: null,
        budgetLimit: null,
        budgetSpent: new Prisma.Decimal(0),
        costPerMessage: new Prisma.Decimal(0),
        batchSize: 500,
        ratePerMinute: 60,
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
        personalization: null,
        status: 'pending',
        batchNo: 0,
        messageId: null,
        error: null,
        sentAt: null,
      }),
    },
    commContact: {
      idPrefix: 'ct',
      defaults: () => ({
        phone: null,
        telegramId: null,
        email: null,
        tags: [],
        duplicateOfId: null,
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
  cancelJobsByGroup: async (group: string) => {
    jobs.cancelledGroups.push(group);
    return 0;
  },
}));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: async (channel: string, type: string, payload: unknown) => {
    events.push({ channel, type, payload });
    return { id: '1' };
  },
}));
vi.mock('@/modules/extensions/usage-meter', () => ({ recordUsage: async () => undefined }));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: async () => undefined }));

import {
  approveCampaign,
  cancelCampaign,
  createCampaign,
  freezeCampaign,
  getCampaign,
  pauseCampaign,
  previewAudience,
  rehearseCampaign,
  renderForRecipient,
  resumeCampaign,
  submitForApproval,
  unfreezeCampaign,
  updateCampaign,
  CampaignError,
} from './campaign-service';

const user = (perms: string[], id = 'u1'): CurrentUser => ({
  id,
  username: id,
  name: id,
  email: null,
  mustChangePassword: false,
  roleKeys: [],
  permissionKeys: perms as never,
  isSuperAdmin: false,
});
const manager = user(['campaigns.manage', 'campaigns.view']);
const approver = user(['campaigns.approve', 'campaigns.view'], 'u2');
const viewer = user(['campaigns.view'], 'u3');

const t = () => db.current!.tables;

async function seedAccount(provider = 'twilio_whatsapp') {
  return t().commAccount.create({
    data: { provider, label: 'WA Ventas', identifier: '+5215500000000' },
  });
}
async function contact(displayName: string, data: Record<string, unknown> = {}) {
  return t().commContact.create({ data: { displayName, ...data } });
}
async function consent(
  contactId: string,
  status: 'opted_in' | 'opted_out',
  channel = 'whatsapp',
  at = new Date()
) {
  return t().consentRecord.create({
    data: { contactId, channel, status, source: 'test', recordedAt: at },
  });
}

async function readyCampaign(overrides: Record<string, unknown> = {}) {
  const account = await seedAccount();
  const a = await contact('Ana Pérez', { phone: '+5215511111111', tags: ['vip'] });
  const b = await contact('Bruno Díaz', { phone: '55 2222 2222', tags: ['vip'] });
  await consent(a.id as string, 'opted_in');
  await consent(b.id as string, 'opted_in');
  const campaign = await createCampaign(manager, {
    name: 'Promo',
    channel: 'whatsapp',
    accountId: account.id,
    audienceFilter: { tags: ['vip'] },
    content: {
      body: 'Hola {{nombre}}, tenemos {{oferta}} para ti',
      variables: { oferta: '10% de descuento' },
    },
    costPerMessage: 0.5,
    ...overrides,
  });
  return { account, campaign, a, b };
}

beforeEach(() => {
  db.current!.reset();
  jobs.enqueued.length = 0;
  jobs.cancelledGroups.length = 0;
  events.length = 0;
});

describe('drafting', () => {
  it('requires campaigns.manage and an account of the same channel', async () => {
    const account = await seedAccount('twilio_sms');
    await expect(
      createCampaign(viewer, { name: 'x', channel: 'sms', accountId: account.id })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createCampaign(manager, { name: 'x', channel: 'whatsapp', accountId: account.id })
    ).rejects.toMatchObject({ status: 400 });
    const c = await createCampaign(manager, { name: 'x', channel: 'sms', accountId: account.id });
    expect(c.status).toBe('draft');
    expect(c.frozen).toBe(false);
  });
});

describe('frozen audience', () => {
  it('applies consent, opt-out, identifier rules and does not change when tags change afterwards', async () => {
    const account = await seedAccount();
    const ana = await contact('Ana', { phone: '+5215511111111', tags: ['vip'] });
    const sinTelefono = await contact('Beto', { phone: '123', tags: ['vip'] }); // invalid format
    const baja = await contact('Caro', { phone: '+5215533333333', tags: ['vip'] });
    const sinConsent = await contact('Dani', { phone: '+5215544444444', tags: ['vip'] });
    const otro = await contact('Eli', { phone: '+5215555555555', tags: ['regular'] });
    await consent(ana.id as string, 'opted_in');
    await consent(sinTelefono.id as string, 'opted_in');
    await consent(baja.id as string, 'opted_in', 'whatsapp', new Date(Date.now() - 10_000));
    await consent(baja.id as string, 'opted_out'); // latest wins
    await consent(otro.id as string, 'opted_in');
    void sinConsent;

    const preview = await previewAudience(manager, {
      channel: 'whatsapp',
      filter: { tags: ['vip'], tagMode: 'any', excludeTags: [] },
    });
    expect(preview.count).toBe(1);
    expect(preview.excluded).toEqual({ noConsent: 1, optedOut: 1, noIdentifier: 1 });
    expect(preview.sample[0].identifier).toMatch(/^•+1111$/);

    const c = await createCampaign(manager, {
      name: 'VIP',
      channel: 'whatsapp',
      accountId: account.id,
      audienceFilter: { tags: ['vip'] },
      content: { body: 'Hola {{nombre}}' },
    });
    const frozen = await freezeCampaign(manager, c.id);
    expect(frozen.status).toBe('rehearsal');
    expect(frozen.audience?.count).toBe(1);
    expect(frozen.audience?.frozenAt).toBeTruthy();
    expect(frozen.content?.frozenAt).toBeTruthy();
    expect(t().campaignRecipient.rows.map((r) => r.contactId)).toEqual([ana.id]);

    // Tags change AFTER freezing: audience must stay identical.
    await t().commContact.update({ where: { id: otro.id }, data: { tags: ['vip'] } });
    await t().commContact.update({ where: { id: ana.id }, data: { tags: [] } });
    const again = await freezeCampaign(manager, c.id); // idempotent
    expect(again.audience?.count).toBe(1);
    expect(t().campaignRecipient.rows.map((r) => r.contactId)).toEqual([ana.id]);
    const detail = await getCampaign(viewer, c.id);
    expect(detail.stats.counts.pending).toBe(1);

    await expect(
      updateCampaign(manager, c.id, { audienceFilter: { tags: ['regular'] } })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      updateCampaign(manager, c.id, { content: { body: 'otro' } })
    ).rejects.toMatchObject({ status: 409 });

    const thawed = await unfreezeCampaign(manager, c.id);
    expect(thawed.status).toBe('draft');
    expect(thawed.frozen).toBe(false);
    expect(t().campaignRecipient.rows).toHaveLength(0);
    // Now the new tag set applies.
    const refrozen = await freezeCampaign(manager, c.id);
    expect(t().campaignRecipient.rows.map((r) => r.contactId)).toEqual([otro.id]);
    expect(refrozen.audience?.count).toBe(1);
  });

  it('assigns batch numbers by batchSize', async () => {
    const account = await seedAccount();
    for (let i = 0; i < 5; i++) {
      const ct = await contact(`C${i}`, { phone: `+521551111111${i}`, tags: ['t'] });
      await consent(ct.id as string, 'opted_in');
    }
    const c = await createCampaign(manager, {
      name: 'B',
      channel: 'whatsapp',
      accountId: account.id,
      batchSize: 2,
      audienceFilter: { tags: ['t'] },
      content: { body: 'x' },
    });
    await freezeCampaign(manager, c.id);
    expect(t().campaignRecipient.rows.map((r) => r.batchNo)).toEqual([0, 0, 1, 1, 2]);
  });
});

describe('rehearsal and exact preview', () => {
  it('renders the exact personalized text and simulates through the mock adapter without creating messages', async () => {
    const { campaign } = await readyCampaign();
    await expect(rehearseCampaign(manager, campaign.id, 5)).rejects.toMatchObject({ status: 409 });
    await freezeCampaign(manager, campaign.id);
    const rehearsal = await rehearseCampaign(manager, campaign.id, 5);
    expect(rehearsal.sampleSize).toBe(2);
    expect(rehearsal.results.map((r) => r.body)).toEqual([
      'Hola Ana Pérez, tenemos 10% de descuento para ti',
      'Hola Bruno Díaz, tenemos 10% de descuento para ti',
    ]);
    expect(rehearsal.results[1].to).toBe('+5522222222');
    expect(rehearsal.failed).toBe(0);
    expect(rehearsal.campaign.stats.rehearsal?.sampleSize).toBe(2);
    expect(t().commMessage.rows).toHaveLength(0);

    const recipient = t().campaignRecipient.rows[0];
    const exact = await renderForRecipient(viewer, campaign.id, recipient.id as string);
    expect(exact.body).toBe('Hola Ana Pérez, tenemos 10% de descuento para ti');
    expect(exact.missing).toEqual([]);
    expect(exact.templateVariables.nombre).toBe('Ana Pérez');
  });
});

describe('approval and lifecycle', () => {
  it('requires rehearsal, checks the budget and starts immediately when due', async () => {
    const { campaign } = await readyCampaign({ budgetLimit: 0.5 });
    await freezeCampaign(manager, campaign.id);
    await expect(submitForApproval(manager, campaign.id)).rejects.toMatchObject({ status: 409 });
    await rehearseCampaign(manager, campaign.id, 2);
    await submitForApproval(manager, campaign.id);
    await expect(approveCampaign(manager, campaign.id, {})).rejects.toMatchObject({ status: 403 });
    // 2 recipients x 0.5 = 1.0 > budget 0.5
    await expect(approveCampaign(approver, campaign.id, {})).rejects.toMatchObject({ status: 409 });
    const approved = await approveCampaign(approver, campaign.id, { allowPartialBudget: true });
    expect(approved.status).toBe('running');
    expect(approved.approvedBy).toBe('u2');
    expect(jobs.enqueued).toHaveLength(1);
    expect(jobs.enqueued[0]).toMatchObject({
      type: 'campaigns.dispatch_batch',
      priority: 500,
      groupKey: `campaign:${campaign.id}`,
      dedupeKey: `campaign:${campaign.id}:batch:0`,
      payload: { campaignId: campaign.id, batchNo: 0 },
    });
    expect(
      events.some((e) => e.channel === `campaign:${campaign.id}` && e.type === 'campaign.status')
    ).toBe(true);
  });

  it('schedules for later and pause/resume/cancel control the jobs', async () => {
    const { campaign } = await readyCampaign();
    await freezeCampaign(manager, campaign.id);
    await rehearseCampaign(manager, campaign.id, 1);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await approveCampaign(approver, campaign.id, { scheduledAt: future });
    expect(scheduled.status).toBe('scheduled');
    expect(jobs.enqueued).toHaveLength(0);

    const paused = await pauseCampaign(manager, campaign.id, 'revisión');
    expect(paused.status).toBe('paused');
    expect(jobs.cancelledGroups).toEqual([`campaign:${campaign.id}`]);

    const resumed = await resumeCampaign(manager, campaign.id);
    expect(resumed.status).toBe('running'); // never started → scheduled → started right away
    expect(jobs.enqueued).toHaveLength(1);

    const cancelled = await cancelCampaign(manager, campaign.id);
    expect(cancelled.status).toBe('cancelled');
    expect(t().campaignRecipient.rows.every((r) => r.status === 'skipped')).toBe(true);
    await expect(cancelCampaign(manager, campaign.id)).rejects.toBeInstanceOf(CampaignError);
  });
});
