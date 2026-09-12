import { Prisma, type Campaign, type CampaignRecipient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { OutboundMessage } from '@/modules/comms/channel-adapters';
import {
  audienceFilterSchema,
  emptyCounts,
  renderTemplate,
  toSnapshotVariables,
  type AudienceSnapshot,
  type CampaignStats,
  type ContentSnapshot,
  type RecipientStatus,
} from './campaign-contract';

/**
 * Snapshot readers and rendering shared by the service (human actions) and
 * the dispatcher (background sending). Kept free of business decisions so
 * both sides read the frozen data the same way.
 */

export function readAudience(campaign: Campaign): AudienceSnapshot | null {
  const raw = campaign.audienceSnapshot as Partial<AudienceSnapshot> | null;
  if (!raw || !raw.filter) return null;
  const filter = audienceFilterSchema.safeParse(raw.filter);
  return {
    filter: filter.success ? filter.data : { tags: [], tagMode: 'any', excludeTags: [] },
    count: typeof raw.count === 'number' ? raw.count : null,
    frozenAt: typeof raw.frozenAt === 'string' ? raw.frozenAt : null,
    excluded: raw.excluded,
  };
}

export function readContent(campaign: Campaign): ContentSnapshot | null {
  const raw = campaign.contentSnapshot as Partial<ContentSnapshot> | null;
  if (!raw || typeof raw.body !== 'string') return null;
  return {
    body: raw.body,
    templateKey: typeof raw.templateKey === 'string' ? raw.templateKey : undefined,
    variables: toSnapshotVariables(raw.variables),
    frozenAt: typeof raw.frozenAt === 'string' ? raw.frozenAt : null,
  };
}

export function readStats(campaign: Campaign): CampaignStats {
  const raw = (campaign.stats ?? {}) as Partial<CampaignStats>;
  return {
    ...raw,
    counts: { ...emptyCounts(), ...(raw.counts ?? {}) },
    total: typeof raw.total === 'number' ? raw.total : 0,
  };
}

export function isFrozen(campaign: Campaign): boolean {
  return Boolean(readAudience(campaign)?.frozenAt && readContent(campaign)?.frozenAt);
}

export function dec(value: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal {
  if (value === null || value === undefined) return new Prisma.Decimal(0);
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Live counts per recipient status (persisted into `stats` by callers that mutate). */
export async function computeStats(
  campaignId: string,
  base?: CampaignStats
): Promise<CampaignStats> {
  const groups = await prisma.campaignRecipient.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true },
  });
  const counts = emptyCounts();
  let total = 0;
  for (const g of groups) {
    const n = g._count._all;
    counts[g.status as RecipientStatus] = n;
    total += n;
  }
  return { ...(base ?? {}), counts, total };
}

export interface RenderedRecipient {
  recipientId: string;
  contactId: string;
  to: string;
  body: string;
  missing: string[];
  personalization: Record<string, string>;
  templateKey?: string;
  templateVariables: Record<string, string>;
}

/** Exact text a recipient receives: frozen content + personalization captured at freeze time. */
export function renderRecipient(
  content: ContentSnapshot,
  recipient: CampaignRecipient
): RenderedRecipient {
  const personalization = toSnapshotVariables(recipient.personalization);
  const values = { ...content.variables, ...personalization };
  const rendered = renderTemplate(content.body, values);
  return {
    recipientId: recipient.id,
    contactId: recipient.contactId,
    to: recipient.identifier,
    body: rendered.text,
    missing: rendered.missing,
    personalization,
    templateKey: content.templateKey,
    templateVariables: values,
  };
}

export function toOutbound(rendered: RenderedRecipient, campaignId: string): OutboundMessage {
  return {
    to: rendered.to,
    body: rendered.body,
    templateKey: rendered.templateKey,
    templateVariables: rendered.templateKey ? rendered.templateVariables : undefined,
    idempotencyKey: `campaign:${campaignId}:recipient:${rendered.recipientId}`,
  };
}
