import { Prisma, type Campaign, type CampaignRecipient, type CommAccount } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { publishRealtime } from '@/modules/realtime/realtime-service';
import { recordUsage } from '@/modules/extensions/usage-meter';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { getChannelAdapter, type ChannelAdapter } from '@/modules/comms/channel-adapters';
import {
  computeStats,
  dec,
  readContent,
  readStats,
  renderRecipient,
  toJson,
  toOutbound,
} from './campaign-snapshots';

/**
 * Batch dispatcher. One job sends one batch of a campaign at `ratePerMinute`
 * and re-checks BEFORE EVERY message that:
 *   - the campaign is still `running` (pause/cancel take effect immediately);
 *   - the recipient has not opted out since the audience was frozen;
 *   - budgetSpent + cost stays within budgetLimit (otherwise the campaign
 *     pauses itself and emits an event).
 * Each send claims the recipient atomically (pending → queued), so an
 * interrupted batch resumes from the pending rows without re-sending.
 * When a batch is exhausted it enqueues the next one; when no pending
 * recipients remain the campaign completes.
 */

export const CAMPAIGN_DISPATCH_JOB = 'campaigns.dispatch_batch';
export const CAMPAIGN_SCHEDULER_JOB = 'campaigns.scheduler';

export interface DispatchPayload {
  campaignId: string;
  batchNo: number;
  accountId: string;
}

export function campaignGroupKey(campaignId: string): string {
  return `campaign:${campaignId}`;
}

export function batchDedupeKey(campaignId: string, batchNo: number): string {
  return `campaign:${campaignId}:batch:${batchNo}`;
}

export async function enqueueBatch(
  input: DispatchPayload & { createdBy: string | null; runAt?: Date }
) {
  return enqueueJob<DispatchPayload>({
    type: CAMPAIGN_DISPATCH_JOB,
    payload: { campaignId: input.campaignId, batchNo: input.batchNo, accountId: input.accountId },
    priority: JOB_PRIORITY.bulk,
    groupKey: campaignGroupKey(input.campaignId),
    dedupeKey: batchDedupeKey(input.campaignId, input.batchNo),
    maxAttempts: 5,
    createdBy: input.createdBy ?? undefined,
    runAt: input.runAt,
  });
}

/** Lowest batch number that still has pending recipients, or null when the campaign is done. */
export async function findNextBatchNo(
  campaignId: string,
  afterBatchNo?: number
): Promise<number | null> {
  const row = await prisma.campaignRecipient.findFirst({
    where: {
      campaignId,
      status: 'pending',
      ...(afterBatchNo !== undefined ? { batchNo: { gt: afterBatchNo } } : {}),
    },
    orderBy: { batchNo: 'asc' },
    select: { batchNo: true },
  });
  return row?.batchNo ?? null;
}

export async function hasActiveBatchJob(campaignId: string): Promise<boolean> {
  const job = await prisma.backgroundJob.findFirst({
    where: {
      type: CAMPAIGN_DISPATCH_JOB,
      groupKey: campaignGroupKey(campaignId),
      status: { in: ['pending', 'running'] },
    },
    select: { id: true },
  });
  return Boolean(job);
}

/** True when another dispatch job for the same account is running (human attention and provider limits first). */
export async function isAccountBusy(accountId: string, excludeJobId: string): Promise<boolean> {
  const job = await prisma.backgroundJob.findFirst({
    where: {
      type: CAMPAIGN_DISPATCH_JOB,
      status: 'running',
      id: { not: excludeJobId },
      payload: { path: ['accountId'], equals: accountId },
    },
    select: { id: true },
  });
  return Boolean(job);
}

export interface DispatchDeps {
  getAdapter: (provider: string) => ChannelAdapter;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Stop after this wall-clock budget so the job never hits its timeout mid-send. */
  maxRunMs: number;
  signal?: AbortSignal;
}

export const defaultDispatchDeps: DispatchDeps = {
  getAdapter: getChannelAdapter,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  maxRunMs: 50 * 60 * 1000,
};

export interface DispatchResult {
  campaignId: string;
  batchNo: number;
  sent: number;
  failed: number;
  optedOut: number;
  skipped: number;
  outcome: 'completed' | 'next_batch' | 'campaign_completed' | 'paused' | 'stopped' | 'interrupted';
  reason?: string;
}

const PROGRESS_EVERY = 10;
const PAGE = 100;

async function latestConsent(contactId: string, channel: string): Promise<string | null> {
  const row = await prisma.consentRecord.findFirst({
    where: { contactId, channel },
    orderBy: { recordedAt: 'desc' },
    select: { status: true },
  });
  return row?.status ?? null;
}

async function ensureConversation(
  account: CommAccount,
  contactId: string,
  at: Date
): Promise<string> {
  const existing = await prisma.commConversation.findFirst({
    where: { accountId: account.id, contactId },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });
  if (existing) {
    await prisma.commConversation.update({
      where: { id: existing.id },
      data: { lastMessageAt: at },
    });
    return existing.id;
  }
  const created = await prisma.commConversation.create({
    data: { accountId: account.id, contactId, status: 'open', lastMessageAt: at },
    select: { id: true },
  });
  return created.id;
}

async function publishProgress(
  campaign: Campaign,
  batchNo: number,
  extra: Record<string, unknown> = {}
) {
  try {
    const stats = await computeStats(campaign.id);
    const fresh = await prisma.campaign.findUnique({
      where: { id: campaign.id },
      select: { budgetSpent: true, status: true },
    });
    await publishRealtime(`campaign:${campaign.id}`, 'campaign.progress', {
      campaignId: campaign.id,
      batchNo,
      status: fresh?.status ?? campaign.status,
      counts: stats.counts,
      total: stats.total,
      budgetSpent: dec(fresh?.budgetSpent).toFixed(4),
      ...extra,
    });
    return stats;
  } catch {
    return null;
  }
}

async function pauseForBudget(
  campaign: Campaign,
  batchNo: number,
  cost: Prisma.Decimal
): Promise<void> {
  const stats = {
    ...(await computeStats(campaign.id, readStats(campaign))),
    pauseReason: 'budget_exceeded',
    lastBatchNo: batchNo,
  };
  await prisma.campaign.updateMany({
    where: { id: campaign.id, status: 'running' },
    data: { status: 'paused', pausedAt: new Date(), stats: toJson(stats) },
  });
  await recordAuditEvent({
    actorUserId: null,
    action: 'campaigns.paused_budget',
    targetType: 'campaign',
    targetId: campaign.id,
    metadata: {
      batchNo,
      budgetLimit: dec(campaign.budgetLimit).toFixed(4),
      nextCost: cost.toFixed(6),
    },
  });
  try {
    await publishRealtime(`campaign:${campaign.id}`, 'campaign.status', {
      campaignId: campaign.id,
      status: 'paused',
      reason: 'budget_exceeded',
    });
  } catch {
    // best-effort
  }
}

/**
 * Sends one batch. Safe to call again for the same batch after an
 * interruption: only `pending` recipients are touched.
 */
export async function dispatchBatch(
  payload: DispatchPayload,
  deps: DispatchDeps = defaultDispatchDeps
): Promise<DispatchResult> {
  const { campaignId, batchNo } = payload;
  const result: DispatchResult = {
    campaignId,
    batchNo,
    sent: 0,
    failed: 0,
    optedOut: 0,
    skipped: 0,
    outcome: 'completed',
  };
  const startedAt = deps.now().getTime();

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.status !== 'running') {
    return {
      ...result,
      outcome: 'stopped',
      reason: campaign ? `campaña ${campaign.status}` : 'campaña inexistente',
    };
  }
  const content = readContent(campaign);
  if (!content?.frozenAt)
    return { ...result, outcome: 'stopped', reason: 'contenido no congelado' };
  const account = await prisma.commAccount.findUnique({ where: { id: campaign.accountId } });
  if (!account || account.status !== 'active') {
    return { ...result, outcome: 'stopped', reason: 'cuenta de envío no disponible' };
  }
  const adapter = deps.getAdapter(account.provider);
  const intervalMs = Math.ceil(60_000 / Math.max(1, campaign.ratePerMinute));

  // Recipients left `queued` by a crash mid-send: the provider outcome is unknown.
  await prisma.campaignRecipient.updateMany({
    where: { campaignId, batchNo, status: 'queued' },
    data: {
      status: 'failed',
      error: 'Envío interrumpido: resultado incierto, verificar en el proveedor',
    },
  });

  let processed = 0;
  for (;;) {
    const pending = await prisma.campaignRecipient.findMany({
      where: { campaignId, batchNo, status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: PAGE,
    });
    if (pending.length === 0) break;

    for (const recipient of pending) {
      if (deps.signal?.aborted || deps.now().getTime() - startedAt > deps.maxRunMs) {
        await publishProgress(campaign, batchNo);
        return {
          ...result,
          outcome: 'interrupted',
          reason: deps.signal?.aborted ? 'cancelado' : 'tiempo máximo del lote',
        };
      }

      // 1. Campaign still running? (pause/cancel win immediately)
      const live = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { status: true, budgetSpent: true, budgetLimit: true, costPerMessage: true },
      });
      if (!live || live.status !== 'running') {
        await publishProgress(campaign, batchNo);
        return {
          ...result,
          outcome: 'stopped',
          reason: `campaña ${live?.status ?? 'inexistente'}`,
        };
      }

      // 2. Consent may have changed since the freeze.
      const consent = await latestConsent(recipient.contactId, campaign.channel);
      if (consent === 'opted_out') {
        await prisma.campaignRecipient.updateMany({
          where: { id: recipient.id, status: 'pending' },
          data: { status: 'opted_out', error: 'Baja registrada durante la campaña' },
        });
        result.optedOut++;
        continue;
      }

      // 3. Budget before sending.
      const cost = dec(live.costPerMessage);
      if (live.budgetLimit !== null && dec(live.budgetSpent).plus(cost).gt(dec(live.budgetLimit))) {
        await pauseForBudget(campaign, batchNo, cost);
        await publishProgress(campaign, batchNo, { reason: 'budget_exceeded' });
        return { ...result, outcome: 'paused', reason: 'budget_exceeded' };
      }

      // 4. Atomic claim: a concurrent worker never sends the same recipient.
      const claimed = await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, status: 'pending' },
        data: { status: 'queued' },
      });
      if (claimed.count === 0) {
        result.skipped++;
        continue;
      }

      const sentAt = deps.now();
      const rendered = renderRecipient(content, recipient as CampaignRecipient);
      const conversationId = await ensureConversation(account, recipient.contactId, sentAt);
      const message = await prisma.commMessage.create({
        data: {
          accountId: account.id,
          conversationId,
          direction: 'outbound',
          body: rendered.body,
          status: 'queued',
          campaignId,
          templateKey: rendered.templateKey ?? null,
        },
        select: { id: true },
      });

      let outcome: Awaited<ReturnType<ChannelAdapter['send']>>;
      try {
        outcome = await adapter.send(account, toOutbound(rendered, campaignId));
      } catch (err) {
        outcome = {
          externalId: null,
          status: 'failed',
          error: err instanceof Error ? err.message : 'error de envío',
        };
      }
      const failed = outcome.status === 'failed';
      const actualCost = failed
        ? new Prisma.Decimal(0)
        : outcome.cost !== undefined
          ? dec(outcome.cost)
          : cost;

      await prisma.commMessage.update({
        where: { id: message.id },
        data: {
          status: outcome.status,
          externalId: outcome.externalId,
          error: outcome.error ?? null,
          sentAt: failed ? null : sentAt,
          providerMeta: outcome.providerMeta
            ? toJson({ ...outcome.providerMeta, uncertain: outcome.uncertain ?? false })
            : outcome.uncertain
              ? { uncertain: true }
              : Prisma.JsonNull,
        },
      });
      await prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: failed ? 'failed' : 'sent',
          messageId: message.id,
          error: outcome.error ?? null,
          sentAt: failed ? null : sentAt,
        },
      });
      if (!actualCost.isZero()) {
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { budgetSpent: { increment: actualCost } },
        });
      }
      if (failed) result.failed++;
      else result.sent++;

      try {
        await recordUsage('campaign', campaignId, 'messages', 1);
        if (!actualCost.isZero())
          await recordUsage('provider', account.provider, 'cost', Number(actualCost.toFixed(6)));
      } catch {
        // metering must never stop a campaign
      }

      processed++;
      if (processed % PROGRESS_EVERY === 0) await publishProgress(campaign, batchNo);
      if (intervalMs > 0) await deps.sleep(intervalMs);
    }
  }

  // Batch exhausted: persist stats and chain the next batch or complete.
  const stats = await computeStats(campaignId, { ...readStats(campaign), lastBatchNo: batchNo });
  const next = await findNextBatchNo(campaignId);
  if (next === null) {
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: 'running' },
      data: { status: 'completed', completedAt: deps.now(), stats: toJson(stats) },
    });
    await publishProgress(campaign, batchNo, { completed: true });
    try {
      await publishRealtime(`campaign:${campaignId}`, 'campaign.status', {
        campaignId,
        status: 'completed',
      });
    } catch {
      // best-effort
    }
    return { ...result, outcome: 'campaign_completed' };
  }
  await prisma.campaign.update({ where: { id: campaignId }, data: { stats: toJson(stats) } });
  await enqueueBatch({ campaignId, batchNo: next, accountId: account.id, createdBy: null });
  await publishProgress(campaign, batchNo, { nextBatchNo: next });
  return { ...result, outcome: 'next_batch' };
}
