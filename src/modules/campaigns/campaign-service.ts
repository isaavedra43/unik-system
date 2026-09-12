import { Prisma, type Campaign, type CommAccount, type CommContact } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { cancelJobsByGroup } from '@/modules/jobs/job-queue';
import { publishRealtime } from '@/modules/realtime/realtime-service';
import { MockChannelAdapter } from '@/modules/comms/channel-adapters';
import {
  approveCampaignSchema,
  CHANNEL_PROVIDER,
  createCampaignSchema,
  emptyCounts,
  identifierFor,
  maskIdentifier,
  personalizationFor,
  TERMINAL_CAMPAIGN_STATUSES,
  toSnapshotVariables,
  updateCampaignSchema,
  type AudienceFilter,
  type AudienceSnapshot,
  type CampaignChannel,
  type CampaignStats,
  type CampaignStatus,
  type ContentSnapshot,
  type CreateCampaignInput,
  type RecipientStatus,
  type UpdateCampaignInput,
} from './campaign-contract';
import {
  campaignGroupKey,
  enqueueBatch,
  findNextBatchNo,
  hasActiveBatchJob,
} from './campaign-dispatcher';
import {
  computeStats,
  dec,
  isFrozen,
  readAudience,
  readContent,
  readStats,
  renderRecipient,
  toJson,
  toOutbound,
  type RenderedRecipient,
} from './campaign-snapshots';

export { computeStats, readAudience, readContent, readStats, renderRecipient, toOutbound };
export type { RenderedRecipient };

/**
 * Campaign service — draft, frozen audience/content, rehearsal, exact
 * per-recipient preview, budget, human approval and lifecycle control.
 *
 * Freezing is what makes a campaign auditable: recipients are materialized
 * (CampaignRecipient rows in batches of 1000) with the personalization
 * captured at that moment, so later tag or contact edits never change who
 * receives what. Changing anything after freezing requires unfreezing,
 * which drops the recipients and returns the campaign to draft.
 */

export class CampaignError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'CampaignError';
  }
}

const FREEZE_PAGE = 1000;
const PREVIEW_MAX_PAGES = 50;

/* ------------------------------------------------------------------ */
/* Authorization (deny by default)                                    */
/* ------------------------------------------------------------------ */

function canView(actor: CurrentUser): boolean {
  return (
    hasPermission(actor, 'campaigns.view') ||
    hasPermission(actor, 'campaigns.manage') ||
    hasPermission(actor, 'campaigns.approve')
  );
}
function assertView(actor: CurrentUser): void {
  if (!canView(actor)) throw new CampaignError('Sin permiso para ver campañas', 403);
}
function assertManage(actor: CurrentUser): void {
  if (!hasPermission(actor, 'campaigns.manage')) {
    throw new CampaignError('Sin permiso para gestionar campañas', 403);
  }
}
function assertApprove(actor: CurrentUser): void {
  if (!hasPermission(actor, 'campaigns.approve')) {
    throw new CampaignError('Sin permiso para aprobar campañas', 403);
  }
}

/* ------------------------------------------------------------------ */
/* Snapshots and DTO                                                  */
/* ------------------------------------------------------------------ */

export interface CampaignDTO {
  id: string;
  name: string;
  channel: CampaignChannel;
  accountId: string;
  accountLabel: string | null;
  status: CampaignStatus;
  audience: AudienceSnapshot | null;
  content: ContentSnapshot | null;
  frozen: boolean;
  budgetLimit: string | null;
  budgetSpent: string;
  costPerMessage: string;
  estimatedCost: string | null;
  batchSize: number;
  ratePerMinute: number;
  scheduledAt: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  stats: CampaignStats;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toCampaignDTO(
  campaign: Campaign,
  account?: Pick<CommAccount, 'label'> | null,
  liveStats?: CampaignStats
): CampaignDTO {
  const audience = readAudience(campaign);
  const stats = liveStats ?? readStats(campaign);
  const estimated =
    audience?.count !== null && audience?.count !== undefined
      ? dec(campaign.costPerMessage).mul(audience.count).toFixed(4)
      : null;
  return {
    id: campaign.id,
    name: campaign.name,
    channel: campaign.channel as CampaignChannel,
    accountId: campaign.accountId,
    accountLabel: account?.label ?? null,
    status: campaign.status as CampaignStatus,
    audience,
    content: readContent(campaign),
    frozen: isFrozen(campaign),
    budgetLimit: campaign.budgetLimit === null ? null : dec(campaign.budgetLimit).toFixed(4),
    budgetSpent: dec(campaign.budgetSpent).toFixed(4),
    costPerMessage: dec(campaign.costPerMessage).toFixed(6),
    estimatedCost: estimated,
    batchSize: campaign.batchSize,
    ratePerMinute: campaign.ratePerMinute,
    scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
    startedAt: campaign.startedAt?.toISOString() ?? null,
    pausedAt: campaign.pausedAt?.toISOString() ?? null,
    completedAt: campaign.completedAt?.toISOString() ?? null,
    stats,
    createdBy: campaign.createdBy,
    approvedBy: campaign.approvedBy,
    approvedAt: campaign.approvedAt?.toISOString() ?? null,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
  };
}

async function loadCampaign(id: string): Promise<Campaign> {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign) throw new CampaignError('Campaña no encontrada', 404);
  return campaign;
}

async function publishStatus(
  campaign: Campaign,
  extra: Record<string, unknown> = {}
): Promise<void> {
  try {
    await publishRealtime(`campaign:${campaign.id}`, 'campaign.status', {
      campaignId: campaign.id,
      status: campaign.status,
      budgetSpent: dec(campaign.budgetSpent).toFixed(4),
      ...extra,
    });
  } catch {
    // realtime is best-effort
  }
}

/* ------------------------------------------------------------------ */
/* Queries                                                            */
/* ------------------------------------------------------------------ */

export async function listCampaignAccounts(
  actor: CurrentUser
): Promise<
  Array<{ id: string; provider: string; label: string; identifier: string; status: string }>
> {
  assertView(actor);
  const accounts = await prisma.commAccount.findMany({
    orderBy: { label: 'asc' },
    select: { id: true, provider: true, label: true, identifier: true, status: true },
  });
  return accounts;
}

export async function listAudienceTags(
  actor: CurrentUser
): Promise<Array<{ tag: string; count: number }>> {
  assertView(actor);
  const rows = await prisma.commContact.findMany({ select: { tags: true }, take: 20_000 });
  const counts = new Map<string, number>();
  for (const row of rows) for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 200);
}

export async function listCampaigns(
  actor: CurrentUser,
  options: { status?: string; limit?: number } = {}
): Promise<CampaignDTO[]> {
  assertView(actor);
  const rows = await prisma.campaign.findMany({
    where: options.status ? { status: options.status } : undefined,
    orderBy: { updatedAt: 'desc' },
    take: Math.min(Math.max(options.limit ?? 100, 1), 500),
  });
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const accounts = accountIds.length
    ? await prisma.commAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, label: true },
      })
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return rows.map((row) => toCampaignDTO(row, byId.get(row.accountId) ?? null));
}

export async function getCampaign(actor: CurrentUser, id: string): Promise<CampaignDTO> {
  assertView(actor);
  const campaign = await loadCampaign(id);
  const account = await prisma.commAccount.findUnique({
    where: { id: campaign.accountId },
    select: { label: true },
  });
  const live = isFrozen(campaign) ? await computeStats(id, readStats(campaign)) : undefined;
  return toCampaignDTO(campaign, account, live);
}

/* ------------------------------------------------------------------ */
/* Drafting                                                           */
/* ------------------------------------------------------------------ */

async function assertAccountForChannel(
  channel: CampaignChannel,
  accountId: string
): Promise<CommAccount> {
  const account = await prisma.commAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new CampaignError('Cuenta de envío no encontrada', 404);
  if (account.provider !== CHANNEL_PROVIDER[channel]) {
    throw new CampaignError(`La cuenta ${account.label} no es del canal ${channel}`, 400);
  }
  if (account.status !== 'active') throw new CampaignError('La cuenta de envío está pausada', 409);
  return account;
}

export async function createCampaign(actor: CurrentUser, rawInput: unknown): Promise<CampaignDTO> {
  assertManage(actor);
  const input: CreateCampaignInput = createCampaignSchema.parse(rawInput);
  const account = await assertAccountForChannel(input.channel, input.accountId);
  const audience: AudienceSnapshot = {
    filter: input.audienceFilter ?? { tags: [], tagMode: 'any', excludeTags: [] },
    count: null,
    frozenAt: null,
  };
  const content: ContentSnapshot | null = input.content
    ? { ...input.content, frozenAt: null }
    : null;
  const campaign = await prisma.campaign.create({
    data: {
      name: input.name,
      channel: input.channel,
      accountId: input.accountId,
      status: 'draft',
      audienceSnapshot: toJson(audience),
      contentSnapshot: content ? toJson(content) : Prisma.JsonNull,
      budgetLimit:
        input.budgetLimit === undefined || input.budgetLimit === null
          ? null
          : new Prisma.Decimal(input.budgetLimit),
      costPerMessage: new Prisma.Decimal(input.costPerMessage ?? 0),
      batchSize: input.batchSize ?? 500,
      ratePerMinute: input.ratePerMinute ?? 60,
      stats: toJson({ counts: emptyCounts(), total: 0 }),
      createdBy: actor.id,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'campaigns.created',
    targetType: 'campaign',
    targetId: campaign.id,
    metadata: { channel: input.channel, accountId: input.accountId },
  });
  return toCampaignDTO(campaign, account);
}

export async function updateCampaign(
  actor: CurrentUser,
  id: string,
  rawPatch: unknown
): Promise<CampaignDTO> {
  assertManage(actor);
  const patch: UpdateCampaignInput = updateCampaignSchema.parse(rawPatch);
  const campaign = await loadCampaign(id);
  if (!['draft', 'rehearsal', 'pending_approval'].includes(campaign.status)) {
    throw new CampaignError(`La campaña no se puede editar en estado ${campaign.status}`, 409);
  }
  const audience = readAudience(campaign);
  const content = readContent(campaign);
  const frozenAudience = Boolean(audience?.frozenAt);
  const frozenContent = Boolean(content?.frozenAt);
  if (frozenAudience && (patch.audienceFilter || patch.channel || patch.accountId)) {
    throw new CampaignError('La audiencia está congelada: descongela antes de cambiarla', 409);
  }
  if (frozenContent && patch.content) {
    throw new CampaignError('El contenido está congelado: descongela antes de cambiarlo', 409);
  }
  const channel = (patch.channel ?? campaign.channel) as CampaignChannel;
  const accountId = patch.accountId ?? campaign.accountId;
  if (patch.channel || patch.accountId) await assertAccountForChannel(channel, accountId);

  const nextAudience: AudienceSnapshot | null = patch.audienceFilter
    ? { filter: patch.audienceFilter, count: null, frozenAt: null }
    : audience;
  const nextContent: ContentSnapshot | null = patch.content
    ? { ...patch.content, frozenAt: null }
    : content;
  const updated = await prisma.campaign.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      channel,
      accountId,
      ...(nextAudience ? { audienceSnapshot: toJson(nextAudience) } : {}),
      ...(patch.content ? { contentSnapshot: toJson(nextContent) } : {}),
      ...(patch.budgetLimit !== undefined
        ? { budgetLimit: patch.budgetLimit === null ? null : new Prisma.Decimal(patch.budgetLimit) }
        : {}),
      ...(patch.costPerMessage !== undefined
        ? { costPerMessage: new Prisma.Decimal(patch.costPerMessage) }
        : {}),
      ...(patch.batchSize !== undefined ? { batchSize: patch.batchSize } : {}),
      ...(patch.ratePerMinute !== undefined ? { ratePerMinute: patch.ratePerMinute } : {}),
      // Any edit after submission needs a fresh review.
      ...(campaign.status === 'pending_approval' ? { status: 'rehearsal' } : {}),
    },
  });
  return toCampaignDTO(updated);
}

/* ------------------------------------------------------------------ */
/* Audience                                                           */
/* ------------------------------------------------------------------ */

interface EligibleContact {
  contactId: string;
  identifier: string;
  personalization: Record<string, string>;
  displayName: string;
}

interface AudienceScan {
  eligible: EligibleContact[];
  excluded: { noConsent: number; optedOut: number; noIdentifier: number };
  scanned: number;
  truncated: boolean;
}

function contactWhere(
  channel: CampaignChannel,
  filter: AudienceFilter
): Prisma.CommContactWhereInput {
  return {
    duplicateOfId: null,
    ...(filter.tags.length
      ? filter.tagMode === 'all'
        ? { tags: { hasEvery: filter.tags } }
        : { tags: { hasSome: filter.tags } }
      : {}),
    ...(filter.excludeTags.length ? { NOT: { tags: { hasSome: filter.excludeTags } } } : {}),
    ...(channel === 'telegram' ? { telegramId: { not: null } } : { phone: { not: null } }),
  };
}

/**
 * Walks the contacts matching the filter in pages of 1000 and applies the
 * consent rule: latest ConsentRecord for the channel must be `opted_in`
 * (no record = no consent; `opted_out` wins). `onPage` receives each page of
 * eligible contacts so the caller can persist without holding 500k rows.
 */
async function scanAudience(
  channel: CampaignChannel,
  filter: AudienceFilter,
  options: {
    maxPages?: number;
    onPage?: (eligible: EligibleContact[]) => Promise<void>;
    collect?: boolean;
  } = {}
): Promise<AudienceScan> {
  const result: AudienceScan = {
    eligible: [],
    excluded: { noConsent: 0, optedOut: 0, noIdentifier: 0 },
    scanned: 0,
    truncated: false,
  };
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    if (options.maxPages !== undefined && pages >= options.maxPages) {
      result.truncated = true;
      break;
    }
    const contacts: CommContact[] = await prisma.commContact.findMany({
      where: contactWhere(channel, filter),
      orderBy: { id: 'asc' },
      take: FREEZE_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (contacts.length === 0) break;
    pages++;
    result.scanned += contacts.length;
    cursor = contacts[contacts.length - 1].id;

    const consents = await prisma.consentRecord.findMany({
      where: { contactId: { in: contacts.map((c) => c.id) }, channel },
      orderBy: { recordedAt: 'desc' },
      select: { contactId: true, status: true },
    });
    const latest = new Map<string, string>();
    for (const c of consents) if (!latest.has(c.contactId)) latest.set(c.contactId, c.status);

    const page: EligibleContact[] = [];
    for (const contact of contacts) {
      const consent = latest.get(contact.id);
      if (consent === 'opted_out') {
        result.excluded.optedOut++;
        continue;
      }
      if (consent !== 'opted_in') {
        result.excluded.noConsent++;
        continue;
      }
      const identifier = identifierFor(channel, contact);
      if (!identifier) {
        result.excluded.noIdentifier++;
        continue;
      }
      page.push({
        contactId: contact.id,
        identifier,
        personalization: personalizationFor(contact, identifier),
        displayName: contact.displayName,
      });
    }
    if (options.onPage) await options.onPage(page);
    if (options.collect !== false) result.eligible.push(...page);
    if (contacts.length < FREEZE_PAGE) break;
  }
  return result;
}

export interface AudiencePreview {
  count: number;
  excluded: AudienceScan['excluded'];
  scanned: number;
  truncated: boolean;
  sample: Array<{ contactId: string; displayName: string; identifier: string }>;
}

export async function previewAudience(
  actor: CurrentUser,
  input: { channel: CampaignChannel; filter: AudienceFilter }
): Promise<AudiencePreview> {
  assertView(actor);
  let count = 0;
  const sample: AudiencePreview['sample'] = [];
  const scan = await scanAudience(input.channel, input.filter, {
    maxPages: PREVIEW_MAX_PAGES,
    collect: false,
    onPage: async (page) => {
      count += page.length;
      for (const c of page) {
        if (sample.length >= 5) break;
        sample.push({
          contactId: c.contactId,
          displayName: c.displayName,
          identifier: maskIdentifier(c.identifier),
        });
      }
    },
  });
  return {
    count,
    excluded: scan.excluded,
    scanned: scan.scanned,
    truncated: scan.truncated,
    sample,
  };
}

/**
 * Materializes the audience (CampaignRecipient rows, 1000 per insert, batchNo
 * by batchSize) and freezes the content. Idempotent: a frozen campaign is
 * returned unchanged.
 */
export async function freezeCampaign(actor: CurrentUser, id: string): Promise<CampaignDTO> {
  assertManage(actor);
  const campaign = await loadCampaign(id);
  if (campaign.status !== 'draft' && campaign.status !== 'rehearsal') {
    throw new CampaignError(`No se puede congelar en estado ${campaign.status}`, 409);
  }
  const audience = readAudience(campaign);
  const content = readContent(campaign);
  if (!audience) throw new CampaignError('Define la audiencia antes de congelar', 400);
  if (!content) throw new CampaignError('Define el contenido antes de congelar', 400);
  if (audience.frozenAt && content.frozenAt) return toCampaignDTO(campaign);
  await assertAccountForChannel(campaign.channel as CampaignChannel, campaign.accountId);

  const frozenAt = new Date().toISOString();
  let index = 0;
  if (!audience.frozenAt) {
    await prisma.campaignRecipient.deleteMany({ where: { campaignId: id } });
    const scan = await scanAudience(campaign.channel as CampaignChannel, audience.filter, {
      collect: false,
      onPage: async (page) => {
        if (page.length === 0) return;
        await prisma.campaignRecipient.createMany({
          data: page.map((c) => ({
            campaignId: id,
            contactId: c.contactId,
            identifier: c.identifier,
            personalization: toJson(c.personalization),
            status: 'pending',
            batchNo: Math.floor(index++ / campaign.batchSize),
          })),
          skipDuplicates: true,
        });
      },
    });
    audience.count = index;
    audience.excluded = scan.excluded;
    audience.frozenAt = frozenAt;
  }
  if (!content.frozenAt) content.frozenAt = frozenAt;

  const stats = await computeStats(id, readStats(campaign));
  const updated = await prisma.campaign.update({
    where: { id },
    data: {
      status: 'rehearsal',
      audienceSnapshot: toJson(audience),
      contentSnapshot: toJson(content),
      stats: toJson({ ...stats, rehearsal: undefined }),
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'campaigns.frozen',
    targetType: 'campaign',
    targetId: id,
    metadata: { count: audience.count, excluded: audience.excluded ?? null, frozenAt },
  });
  return toCampaignDTO(updated);
}

export async function unfreezeCampaign(actor: CurrentUser, id: string): Promise<CampaignDTO> {
  assertManage(actor);
  const campaign = await loadCampaign(id);
  if (!['rehearsal', 'pending_approval', 'scheduled'].includes(campaign.status)) {
    throw new CampaignError(`No se puede descongelar en estado ${campaign.status}`, 409);
  }
  if (campaign.status === 'scheduled') await cancelJobsByGroup(campaignGroupKey(id));
  const audience = readAudience(campaign);
  const content = readContent(campaign);
  await prisma.campaignRecipient.deleteMany({ where: { campaignId: id } });
  const updated = await prisma.campaign.update({
    where: { id },
    data: {
      status: 'draft',
      audienceSnapshot: audience
        ? toJson({ ...audience, count: null, frozenAt: null, excluded: undefined })
        : Prisma.JsonNull,
      contentSnapshot: content ? toJson({ ...content, frozenAt: null }) : Prisma.JsonNull,
      stats: toJson({ counts: emptyCounts(), total: 0 }),
      scheduledAt: null,
      approvedBy: null,
      approvedAt: null,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'campaigns.unfrozen',
    targetType: 'campaign',
    targetId: id,
  });
  return toCampaignDTO(updated);
}

/* ------------------------------------------------------------------ */
/* Rendering, rehearsal and exact preview                             */
/* ------------------------------------------------------------------ */

export async function renderForRecipient(
  actor: CurrentUser,
  campaignId: string,
  recipientId: string
): Promise<RenderedRecipient & { status: string }> {
  assertView(actor);
  const campaign = await loadCampaign(campaignId);
  const content = readContent(campaign);
  if (!content) throw new CampaignError('La campaña no tiene contenido', 400);
  const recipient = await prisma.campaignRecipient.findFirst({
    where: { id: recipientId, campaignId },
  });
  if (!recipient) throw new CampaignError('Destinatario no encontrado', 404);
  return { ...renderRecipient(content, recipient), status: recipient.status };
}

export interface RehearsalResult {
  sampleSize: number;
  results: Array<RenderedRecipient & { status: 'sent' | 'failed'; error?: string }>;
  failed: number;
  campaign: CampaignDTO;
}

/** Renders N frozen recipients exactly as they would be sent and pushes them through the mock adapter. */
export async function rehearseCampaign(
  actor: CurrentUser,
  id: string,
  sampleSize: number
): Promise<RehearsalResult> {
  assertManage(actor);
  const campaign = await loadCampaign(id);
  if (!['rehearsal', 'pending_approval'].includes(campaign.status) || !isFrozen(campaign)) {
    throw new CampaignError('Congela audiencia y contenido antes de ensayar', 409);
  }
  const content = readContent(campaign)!;
  const account = await prisma.commAccount.findUnique({ where: { id: campaign.accountId } });
  if (!account) throw new CampaignError('Cuenta de envío no encontrada', 404);
  const recipients = await prisma.campaignRecipient.findMany({
    where: { campaignId: id },
    orderBy: [{ batchNo: 'asc' }, { createdAt: 'asc' }],
    take: sampleSize,
  });
  if (recipients.length === 0) throw new CampaignError('La audiencia congelada está vacía', 400);

  const mock = new MockChannelAdapter(CHANNEL_PROVIDER[campaign.channel as CampaignChannel], (m) =>
    m.body.trim().length === 0 ? 'Mensaje vacío tras personalizar' : null
  );
  const results: RehearsalResult['results'] = [];
  for (const recipient of recipients) {
    const rendered = renderRecipient(content, recipient);
    const outcome = await mock.send(account, toOutbound(rendered, id));
    results.push({
      ...rendered,
      status: outcome.status === 'failed' ? 'failed' : 'sent',
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }
  const failed = results.filter((r) => r.status === 'failed').length;
  const stats: CampaignStats = {
    ...(await computeStats(id, readStats(campaign))),
    rehearsal: {
      at: new Date().toISOString(),
      sampleSize: results.length,
      byUserId: actor.id,
      failed,
    },
  };
  const updated = await prisma.campaign.update({ where: { id }, data: { stats: toJson(stats) } });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'campaigns.rehearsed',
    targetType: 'campaign',
    targetId: id,
    metadata: { sampleSize: results.length, failed },
  });
  return {
    sampleSize: results.length,
    results,
    failed,
    campaign: toCampaignDTO(updated, account, stats),
  };
}

/* ------------------------------------------------------------------ */
/* Approval and lifecycle                                             */
/* ------------------------------------------------------------------ */

export async function submitForApproval(actor: CurrentUser, id: string): Promise<CampaignDTO> {
  assertManage(actor);
  const campaign = await loadCampaign(id);
  if (campaign.status !== 'rehearsal' || !isFrozen(campaign)) {
    throw new CampaignError('Congela y ensaya la campaña antes de solicitar aprobación', 409);
  }
  if (!readStats(campaign).rehearsal) {
    throw new CampaignError('Ensaya la campaña con una muestra antes de solicitar aprobación', 409);
  }
  const updated = await prisma.campaign.update({
    where: { id },
    data: { status: 'pending_approval' },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'campaigns.submitted',
    targetType: 'campaign',
    targetId: id,
  });
  await publishStatus(updated);
  return toCampaignDTO(updated);
}

/** Starts a scheduled campaign: running + first pending batch enqueued. */
export async function startCampaign(
  id: string,
  actorUserId: string | null
): Promise<Campaign | null> {
  const claimed = await prisma.campaign.updateMany({
    where: { id, status: 'scheduled' },
    data: { status: 'running', startedAt: new Date(), pausedAt: null },
  });
  if (claimed.count === 0) return null;
  const campaign = await loadCampaign(id);
  const next = await findNextBatchNo(id);
  if (next === null) {
    const done = await prisma.campaign.update({
      where: { id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        stats: toJson(await computeStats(id, readStats(campaign))),
      },
    });
    await publishStatus(done);
    return done;
  }
  await enqueueBatch({
    campaignId: id,
    batchNo: next,
    accountId: campaign.accountId,
    createdBy: actorUserId,
  });
  await publishStatus(campaign, { batchNo: next });
  return campaign;
}

export async function approveCampaign(
  actor: CurrentUser,
  id: string,
  rawInput: unknown
): Promise<CampaignDTO> {
  assertApprove(actor);
  const input = approveCampaignSchema.parse(rawInput ?? {});
  const campaign = await loadCampaign(id);
  if (!['pending_approval', 'rehearsal'].includes(campaign.status) || !isFrozen(campaign)) {
    throw new CampaignError(
      `La campaña no está lista para aprobar (estado: ${campaign.status})`,
      409
    );
  }
  const stats = readStats(campaign);
  if (!stats.rehearsal)
    throw new CampaignError('La campaña debe ensayarse antes de aprobarse', 409);
  const audience = readAudience(campaign)!;
  if (!audience.count) throw new CampaignError('La audiencia congelada está vacía', 400);
  await assertAccountForChannel(campaign.channel as CampaignChannel, campaign.accountId);
  const estimated = dec(campaign.costPerMessage).mul(audience.count);
  if (
    campaign.budgetLimit !== null &&
    estimated.gt(dec(campaign.budgetLimit)) &&
    !input.allowPartialBudget
  ) {
    throw new CampaignError(
      `El presupuesto (${dec(campaign.budgetLimit).toFixed(2)}) no cubre la audiencia (${estimated.toFixed(2)}). Ajusta el presupuesto o acepta un envío parcial.`,
      409
    );
  }
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
  const updated = await prisma.campaign.update({
    where: { id },
    data: { status: 'scheduled', scheduledAt, approvedBy: actor.id, approvedAt: new Date() },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'campaigns.approved',
    targetType: 'campaign',
    targetId: id,
    metadata: {
      scheduledAt: scheduledAt.toISOString(),
      audienceCount: audience.count,
      estimatedCost: estimated.toFixed(4),
      budgetLimit: campaign.budgetLimit === null ? null : dec(campaign.budgetLimit).toFixed(4),
      allowPartialBudget: input.allowPartialBudget,
    },
  });
  await publishStatus(updated);
  if (scheduledAt.getTime() <= Date.now()) {
    const started = await startCampaign(id, actor.id);
    if (started) return toCampaignDTO(started);
  }
  return toCampaignDTO(updated);
}

export async function pauseCampaign(
  actor: CurrentUser,
  id: string,
  reason?: string
): Promise<CampaignDTO> {
  assertManage(actor);
  const campaign = await loadCampaign(id);
  if (campaign.status !== 'running' && campaign.status !== 'scheduled') {
    throw new CampaignError(`No se puede pausar en estado ${campaign.status}`, 409);
  }
  await cancelJobsByGroup(campaignGroupKey(id));
  const stats = {
    ...(await computeStats(id, readStats(campaign))),
    pauseReason: reason ?? 'manual',
  };
  const updated = await prisma.campaign.update({
    where: { id },
    data: { status: 'paused', pausedAt: new Date(), stats: toJson(stats) },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'campaigns.paused',
    targetType: 'campaign',
    targetId: id,
    metadata: { reason: reason ?? 'manual' },
  });
  await publishStatus(updated, { reason: reason ?? 'manual' });
  return toCampaignDTO(updated, null, stats);
}

export async function resumeCampaign(actor: CurrentUser, id: string): Promise<CampaignDTO> {
  assertManage(actor);
  const campaign = await loadCampaign(id);
  if (campaign.status !== 'paused') throw new CampaignError('La campaña no está pausada', 409);
  const stats = readStats(campaign);
  if (stats.pauseReason === 'budget_exceeded' && campaign.budgetLimit !== null) {
    const remaining = dec(campaign.budgetLimit).minus(dec(campaign.budgetSpent));
    if (remaining.lt(dec(campaign.costPerMessage))) {
      throw new CampaignError('Presupuesto agotado: amplía el presupuesto antes de reanudar', 409);
    }
  }
  const next = await findNextBatchNo(id);
  const updated = await prisma.campaign.update({
    where: { id },
    data:
      next === null
        ? { status: 'completed', completedAt: new Date(), pausedAt: null }
        : {
            status: campaign.startedAt ? 'running' : 'scheduled',
            pausedAt: null,
            stats: toJson({ ...stats, pauseReason: null }),
          },
  });
  let final = updated;
  if (next !== null && updated.status === 'running') {
    await enqueueBatch({
      campaignId: id,
      batchNo: next,
      accountId: campaign.accountId,
      createdBy: actor.id,
    });
  } else if (updated.status === 'scheduled') {
    final = (await startCampaign(id, actor.id)) ?? updated;
  }
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'campaigns.resumed',
    targetType: 'campaign',
    targetId: id,
  });
  await publishStatus(final);
  return toCampaignDTO(final);
}

export async function cancelCampaign(actor: CurrentUser, id: string): Promise<CampaignDTO> {
  assertManage(actor);
  const campaign = await loadCampaign(id);
  if (TERMINAL_CAMPAIGN_STATUSES.has(campaign.status)) {
    throw new CampaignError(`La campaña ya está ${campaign.status}`, 409);
  }
  await cancelJobsByGroup(campaignGroupKey(id));
  await prisma.campaignRecipient.updateMany({
    where: { campaignId: id, status: { in: ['pending', 'queued'] } },
    data: { status: 'skipped', error: 'Campaña cancelada' },
  });
  const stats = {
    ...(await computeStats(id, readStats(campaign))),
    cancelledAt: new Date().toISOString(),
  };
  const updated = await prisma.campaign.update({
    where: { id },
    data: { status: 'cancelled', completedAt: new Date(), stats: toJson(stats) },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'campaigns.cancelled',
    targetType: 'campaign',
    targetId: id,
  });
  await publishStatus(updated);
  return toCampaignDTO(updated, null, stats);
}

/* ------------------------------------------------------------------ */
/* Recipients                                                         */
/* ------------------------------------------------------------------ */

export interface RecipientListItem {
  id: string;
  contactId: string;
  displayName: string;
  identifier: string;
  status: RecipientStatus;
  batchNo: number;
  messageId: string | null;
  error: string | null;
  sentAt: string | null;
}

export async function listRecipients(
  actor: CurrentUser,
  campaignId: string,
  options: { status?: string; page?: number; pageSize?: number } = {}
): Promise<{ items: RecipientListItem[]; total: number; page: number; pageSize: number }> {
  assertView(actor);
  await loadCampaign(campaignId);
  const page = Math.max(options.page ?? 1, 1);
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 200);
  const where = { campaignId, ...(options.status ? { status: options.status } : {}) };
  const [rows, total] = await Promise.all([
    prisma.campaignRecipient.findMany({
      where,
      orderBy: [{ batchNo: 'asc' }, { createdAt: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.campaignRecipient.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      displayName: toSnapshotVariables(r.personalization).nombre ?? '',
      identifier: maskIdentifier(r.identifier),
      status: r.status as RecipientStatus,
      batchNo: r.batchNo,
      messageId: r.messageId,
      error: r.error,
      sentAt: r.sentAt?.toISOString() ?? null,
    })),
    total,
    page,
    pageSize,
  };
}

/* ------------------------------------------------------------------ */
/* Scheduler entry points (used by campaigns-jobs)                    */
/* ------------------------------------------------------------------ */

/** scheduled → running when due; running campaigns without an active batch job get one (crash recovery). */
export async function tickScheduler(
  now: Date = new Date()
): Promise<{ started: string[]; recovered: string[] }> {
  const started: string[] = [];
  const recovered: string[] = [];
  const due = await prisma.campaign.findMany({
    where: { status: 'scheduled', scheduledAt: { lte: now } },
    select: { id: true },
    take: 100,
  });
  for (const { id } of due) {
    const c = await startCampaign(id, null);
    if (c) started.push(id);
  }
  const running = await prisma.campaign.findMany({
    where: { status: 'running' },
    select: { id: true, accountId: true },
    take: 500,
  });
  for (const { id, accountId } of running) {
    if (await hasActiveBatchJob(id)) continue;
    const next = await findNextBatchNo(id);
    if (next === null) {
      const campaign = await loadCampaign(id);
      const done = await prisma.campaign.update({
        where: { id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          stats: toJson(await computeStats(id, readStats(campaign))),
        },
      });
      await publishStatus(done);
      continue;
    }
    await enqueueBatch({ campaignId: id, batchNo: next, accountId, createdBy: null });
    recovered.push(id);
  }
  return { started, recovered };
}
