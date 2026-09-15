import { Prisma, type Opportunity, type PipelineStage } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { canAccessAccount } from '@/modules/comms/comms-access';
import { getQuoteStatusLabel } from '@/modules/quotes/quotes-helpers';
import {
  toActivityDTO,
  toOpportunityDTO,
  toRadarSignalDTO,
  toStageDTO,
  type OpportunityActivityDTO,
  type OpportunityDTO,
  type PipelineStageDTO,
  type RadarSignalDTO,
} from './crm-dto';
import {
  assertCrmPermission,
  CrmError,
  decimalString,
  decodeCursor,
  encodeCursor,
  isoOrNull,
  loadUserNames,
  visibleSignalsWhere,
} from './crm-helpers';
import { toNumber } from './opportunity-rules';
import { effectiveProbability } from './pipeline-rules';
import { loadPipelineStages } from './pipeline-service';
import {
  ACTIVITY_KINDS,
  OPPORTUNITY_SOURCES,
  OPPORTUNITY_STATUSES,
  RADAR_KINDS,
  RADAR_KIND_LABELS,
  RADAR_STATUSES,
  type RadarKind,
} from './types';

/**
 * Read side of Sales / CRM for the UI of the next phase and the AI tools:
 * pipeline board by stage, paginated opportunities, opportunity detail with its
 * timeline and links, radar by salesperson and kind, and the CRM panel of an
 * inbox conversation. Every function checks its permission on the server.
 *
 * Visibility: `crm.view` sees the whole team's pipeline; radar signals follow
 * `visibleSignalsWhere` (own + unassigned, everything with `crm.manage`);
 * linked quotes, orders, cases and conversations are only described to people
 * who may see them in their own modules (`quotes.view`, `sales_orders.view`,
 * `operations.view`, inbox account access).
 *
 * Pagination is offset-based with an opaque cursor (`nextCursor`), stable for
 * the sort keys used (they always end with the id).
 */

const idSchema = z.string().trim().min(1).max(64);
const cursorSchema = z.string().max(400).optional();
const salespersonFilterSchema = z.union([idSchema, z.literal('me')]);

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  twilio_whatsapp: 'WhatsApp',
  twilio_sms: 'SMS',
  telegram: 'Telegram',
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function offsetOf(cursor: string | undefined): number {
  const parts = decodeCursor(cursor);
  return parts && parts[0] === 'o' && typeof parts[1] === 'number' && Number.isInteger(parts[1]) && parts[1] >= 0
    ? parts[1]
    : 0;
}

function nextCursorFor(offset: number, pageLength: number, total: number): string | null {
  return pageLength > 0 && offset + pageLength < total ? encodeCursor(['o', offset + pageLength]) : null;
}

function salespersonWhere(actor: CurrentUser, value: string | undefined): Prisma.OpportunityWhereInput {
  if (!value) return {};
  return { salespersonUserId: value === 'me' ? actor.id : value };
}

function searchWhere(search: string | undefined): Prisma.OpportunityWhereInput {
  const q = search?.trim();
  if (!q) return {};
  return {
    OR: [
      { number: { contains: q, mode: 'insensitive' } },
      { title: { contains: q, mode: 'insensitive' } },
      { contactName: { contains: q, mode: 'insensitive' } },
    ],
  };
}

async function toOpportunityDTOs(rows: Opportunity[], stages: PipelineStage[], now: Date): Promise<OpportunityDTO[]> {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const names = await loadUserNames(prisma, rows.map((row) => row.salespersonUserId));
  return rows.map((row) =>
    toOpportunityDTO(row, {
      stage: stageById.get(row.stageId) ?? null,
      salespersonName: names.get(row.salespersonUserId) ?? null,
      now,
    })
  );
}

// ---------------------------------------------------------------------------
// Pipeline board
// ---------------------------------------------------------------------------

export const pipelineBoardQuerySchema = z.object({
  salespersonUserId: salespersonFilterSchema.optional(),
  search: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(40).optional(),
  perStage: z.number().int().min(1).max(100).default(25),
  /** Won and lost columns show what closed in the last N days. */
  closedWithinDays: z.number().int().min(1).max(365).default(30),
});
export type PipelineBoardQuery = z.input<typeof pipelineBoardQuerySchema>;

export interface PipelineBoardColumn {
  stage: PipelineStageDTO;
  count: number;
  totalValue: string;
  weightedValue: string;
  opportunities: OpportunityDTO[];
}

export interface PipelineBoard {
  columns: PipelineBoardColumn[];
  totals: { open: number; openValue: string; weightedValue: string };
  closedWithinDays: number;
}

export async function getPipelineBoard(actor: CurrentUser, rawInput: PipelineBoardQuery = {}): Promise<PipelineBoard> {
  assertCrmPermission(actor, 'crm.view');
  const input = pipelineBoardQuerySchema.parse(rawInput);
  const now = new Date();
  const allStages = await loadPipelineStages();
  const stages = allStages.filter((stage) => stage.active);
  const closedSince = new Date(now.getTime() - input.closedWithinDays * 24 * 3_600_000);
  const base: Prisma.OpportunityWhereInput[] = [
    salespersonWhere(actor, input.salespersonUserId),
    searchWhere(input.search),
    input.tag ? { tags: { has: input.tag } } : {},
  ];

  const columns = await Promise.all(
    stages.map(async (stage) => {
      const statusWhere: Prisma.OpportunityWhereInput =
        stage.kind === 'won'
          ? { status: 'won', wonAt: { gte: closedSince } }
          : stage.kind === 'lost'
            ? { status: 'lost', lostAt: { gte: closedSince } }
            : { status: { in: ['open', 'dormant'] } };
      const where: Prisma.OpportunityWhereInput = { AND: [...base, { stageId: stage.id }, statusWhere] };
      const [values, page] = await Promise.all([
        prisma.opportunity.findMany({ where, select: { estimatedValue: true, probability: true } }),
        prisma.opportunity.findMany({ where, orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }], take: input.perStage }),
      ]);
      let total = 0;
      let weighted = 0;
      for (const value of values) {
        const amount = toNumber(value.estimatedValue) ?? 0;
        total += amount;
        weighted += amount * effectiveProbability(value.probability, stage.probabilityDefault);
      }
      return { stage, count: values.length, total, weighted, page };
    })
  );

  const dtos = await toOpportunityDTOs(columns.flatMap((column) => column.page), allStages, now);
  const dtoById = new Map(dtos.map((dto) => [dto.id, dto]));
  const open = columns.filter((column) => column.stage.kind === 'open');
  return {
    columns: columns.map((column) => ({
      stage: toStageDTO(column.stage),
      count: column.count,
      totalValue: round2(column.total).toFixed(2),
      weightedValue: round2(column.weighted).toFixed(2),
      opportunities: column.page
        .map((row) => dtoById.get(row.id))
        .filter((dto): dto is OpportunityDTO => Boolean(dto)),
    })),
    totals: {
      open: open.reduce((sum, column) => sum + column.count, 0),
      openValue: round2(open.reduce((sum, column) => sum + column.total, 0)).toFixed(2),
      weightedValue: round2(open.reduce((sum, column) => sum + column.weighted, 0)).toFixed(2),
    },
    closedWithinDays: input.closedWithinDays,
  };
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export const OPPORTUNITY_SORTS = ['last_activity', 'next_action', 'value', 'created'] as const;

export const opportunityListQuerySchema = z.object({
  status: z.array(z.enum(OPPORTUNITY_STATUSES)).max(4).optional(),
  stageId: idSchema.optional(),
  salespersonUserId: salespersonFilterSchema.optional(),
  search: z.string().trim().max(120).optional(),
  zohoContactId: z.string().trim().max(40).optional(),
  commContactId: idSchema.optional(),
  conversationId: idSchema.optional(),
  source: z.enum(OPPORTUNITY_SOURCES).optional(),
  tag: z.string().trim().max(40).optional(),
  nextActionOverdue: z.boolean().optional(),
  sort: z.enum(OPPORTUNITY_SORTS).default('last_activity'),
  cursor: cursorSchema,
  limit: z.number().int().min(1).max(100).default(30),
});
export type OpportunityListQuery = z.input<typeof opportunityListQuerySchema>;

const OPPORTUNITY_ORDER: Record<(typeof OPPORTUNITY_SORTS)[number], Prisma.OpportunityOrderByWithRelationInput[]> = {
  last_activity: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
  next_action: [{ nextActionAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
  value: [{ estimatedValue: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
  created: [{ createdAt: 'desc' }, { id: 'desc' }],
};

function opportunityWhere(
  actor: CurrentUser,
  input: z.output<typeof opportunityListQuerySchema>,
  now: Date
): Prisma.OpportunityWhereInput {
  const and: Prisma.OpportunityWhereInput[] = [salespersonWhere(actor, input.salespersonUserId), searchWhere(input.search)];
  if (input.status?.length) and.push({ status: { in: input.status } });
  if (input.stageId) and.push({ stageId: input.stageId });
  if (input.zohoContactId) and.push({ zohoContactId: input.zohoContactId });
  if (input.commContactId) and.push({ commContactId: input.commContactId });
  if (input.conversationId) and.push({ conversationIds: { has: input.conversationId } });
  if (input.source) and.push({ source: input.source });
  if (input.tag) and.push({ tags: { has: input.tag } });
  if (input.nextActionOverdue === true) and.push({ status: 'open', nextActionAt: { lt: now } });
  if (input.nextActionOverdue === false) and.push({ OR: [{ nextActionAt: null }, { nextActionAt: { gte: now } }] });
  return { AND: and };
}

export interface OpportunityPage {
  items: OpportunityDTO[];
  nextCursor: string | null;
  total: number;
}

export async function listOpportunities(actor: CurrentUser, rawInput: OpportunityListQuery = {}): Promise<OpportunityPage> {
  assertCrmPermission(actor, 'crm.view');
  const input = opportunityListQuerySchema.parse(rawInput);
  const now = new Date();
  const where = opportunityWhere(actor, input, now);
  const offset = offsetOf(input.cursor);
  const [total, rows, stages] = await Promise.all([
    prisma.opportunity.count({ where }),
    prisma.opportunity.findMany({ where, orderBy: OPPORTUNITY_ORDER[input.sort], skip: offset, take: input.limit }),
    loadPipelineStages(),
  ]);
  return {
    items: await toOpportunityDTOs(rows, stages, now),
    nextCursor: nextCursorFor(offset, rows.length, total),
    total,
  };
}

/** Up to 5000 rows with the same filters (permission `crm.export`). */
export async function getOpportunitiesForExport(
  actor: CurrentUser,
  rawInput: Omit<OpportunityListQuery, 'cursor' | 'limit'> = {}
): Promise<OpportunityDTO[]> {
  assertCrmPermission(actor, 'crm.export');
  const input = opportunityListQuerySchema.parse({ ...rawInput, limit: 100 });
  const now = new Date();
  const [rows, stages] = await Promise.all([
    prisma.opportunity.findMany({
      where: opportunityWhere(actor, input, now),
      orderBy: OPPORTUNITY_ORDER[input.sort],
      take: 5000,
    }),
    loadPipelineStages(),
  ]);
  return toOpportunityDTOs(rows, stages, now);
}

export const activityListQuerySchema = z.object({
  opportunityId: idSchema,
  kinds: z.array(z.enum(ACTIVITY_KINDS)).max(ACTIVITY_KINDS.length).optional(),
  cursor: cursorSchema,
  limit: z.number().int().min(1).max(100).default(50),
});
export type ActivityListQuery = z.input<typeof activityListQuerySchema>;

export interface ActivityPage {
  items: OpportunityActivityDTO[];
  nextCursor: string | null;
  total: number;
}

const MESSAGE_ACTIVITY_KINDS = new Set(['message_in', 'message_out']);

/**
 * Message activities keep up to 160 characters of the message: people without
 * access to that inbox account (the same rule as the inbox) see only that a
 * message happened.
 */
async function redactMessageActivities(actor: CurrentUser, items: OpportunityActivityDTO[]): Promise<OpportunityActivityDTO[]> {
  const messages = items.filter((item) => MESSAGE_ACTIVITY_KINDS.has(item.kind));
  if (messages.length === 0) return items;
  const payloadOf = (item: OpportunityActivityDTO) =>
    item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload) ? (item.payload as Record<string, unknown>) : {};
  const conversationIds = [
    ...new Set(
      messages
        .filter((item) => typeof payloadOf(item).accountId !== 'string')
        .map((item) => payloadOf(item).conversationId)
        .filter((id): id is string => typeof id === 'string')
    ),
  ];
  const conversations = conversationIds.length
    ? await prisma.commConversation.findMany({ where: { id: { in: conversationIds } }, select: { id: true, accountId: true } })
    : [];
  const accountOf = (item: OpportunityActivityDTO): string | null => {
    const payload = payloadOf(item);
    if (typeof payload.accountId === 'string') return payload.accountId;
    return conversations.find((row) => row.id === payload.conversationId)?.accountId ?? null;
  };
  const accountIds = [...new Set(messages.map(accountOf).filter((id): id is string => Boolean(id)))];
  const accounts = accountIds.length
    ? await prisma.commAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, teamKeys: true } })
    : [];
  return items.map((item) => {
    if (!MESSAGE_ACTIVITY_KINDS.has(item.kind)) return item;
    const account = accounts.find((row) => row.id === accountOf(item));
    if (account && canAccessAccount(actor, account)) return item;
    return {
      ...item,
      summary: item.kind === 'message_in' ? 'Mensaje del cliente (sin acceso a esa cuenta de la bandeja)' : 'Mensaje enviado (sin acceso a esa cuenta de la bandeja)',
      payload: null,
    };
  });
}

async function activityPage(actor: CurrentUser, input: z.output<typeof activityListQuerySchema>): Promise<ActivityPage> {
  const where: Prisma.OpportunityActivityWhereInput = {
    opportunityId: input.opportunityId,
    ...(input.kinds?.length ? { kind: { in: input.kinds } } : {}),
  };
  const offset = offsetOf(input.cursor);
  const [total, rows] = await Promise.all([
    prisma.opportunityActivity.count({ where }),
    prisma.opportunityActivity.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], skip: offset, take: input.limit }),
  ]);
  const names = await loadUserNames(prisma, rows.map((row) => row.userId));
  return {
    items: await redactMessageActivities(actor, rows.map((row) => toActivityDTO(row, names))),
    nextCursor: nextCursorFor(offset, rows.length, total),
    total,
  };
}

export async function listOpportunityActivities(actor: CurrentUser, rawInput: ActivityListQuery): Promise<ActivityPage> {
  assertCrmPermission(actor, 'crm.view');
  const input = activityListQuerySchema.parse(rawInput);
  const exists = await prisma.opportunity.findUnique({ where: { id: input.opportunityId }, select: { id: true } });
  if (!exists) throw new CrmError('No se encontró la oportunidad', 'not_found', 404);
  return activityPage(actor, input);
}

export interface QuoteSummaryDTO {
  id: string;
  zohoEstimateId: string;
  estimateNumber: string | null;
  status: string | null;
  statusLabel: string;
  total: string | null;
  currencyCode: string | null;
  date: string | null;
  expiryDate: string | null;
  isViewedByClient: boolean | null;
  /** Accepted and not converted into a sales order from UNIK yet. */
  convertible: boolean;
}

export interface SalesOrderSummaryDTO {
  id: string;
  zohoSalesOrderId: string;
  salesOrderNumber: string | null;
  status: string | null;
  total: string | null;
  currencyCode: string | null;
  orderDate: string | null;
}

export interface ConversationSummaryDTO {
  id: string;
  status: string;
  channel: string;
  accountLabel: string;
  contactName: string;
  lastMessageAt: string;
}

export interface OpportunityDetail {
  opportunity: OpportunityDTO;
  stage: PipelineStageDTO | null;
  activities: ActivityPage;
  quotes: QuoteSummaryDTO[];
  salesOrders: SalesOrderSummaryDTO[];
  cases: Array<{ id: string; caseNumber: string; status: string; phase: string; promisedAt: string | null }>;
  conversations: ConversationSummaryDTO[];
  /** Linked conversations of inbox accounts the actor cannot open. */
  hiddenConversations: number;
  signals: RadarSignalDTO[];
  permissions: { canManage: boolean; canCreateSalesOrder: boolean; canUseRadar: boolean };
}

const QUOTE_SUMMARY_SELECT = {
  id: true,
  zohoEstimateId: true,
  estimateNumber: true,
  status: true,
  total: true,
  currencyCode: true,
  date: true,
  expiryDate: true,
  isViewedByClient: true,
} satisfies Prisma.QuoteSelect;

const SALES_ORDER_SUMMARY_SELECT = {
  id: true,
  zohoSalesOrderId: true,
  salesOrderNumber: true,
  status: true,
  total: true,
  currencyCode: true,
  orderDate: true,
} satisfies Prisma.SalesOrderSelect;

type QuoteSummaryRow = Prisma.QuoteGetPayload<{ select: typeof QUOTE_SUMMARY_SELECT }>;
type SalesOrderSummaryRow = Prisma.SalesOrderGetPayload<{ select: typeof SALES_ORDER_SUMMARY_SELECT }>;

async function toQuoteSummaries(rows: QuoteSummaryRow[]): Promise<QuoteSummaryDTO[]> {
  const accepted = rows.filter((row) => row.status === 'accepted').map((row) => row.id);
  const converted = accepted.length
    ? await prisma.salesOrderWriteRequest.findMany({
        where: { quoteId: { in: accepted }, status: 'completed' },
        select: { quoteId: true },
      })
    : [];
  const convertedIds = new Set(converted.map((row) => row.quoteId));
  return rows.map((row) => ({
    id: row.id,
    zohoEstimateId: row.zohoEstimateId,
    estimateNumber: row.estimateNumber,
    status: row.status,
    statusLabel: getQuoteStatusLabel(row.status),
    total: decimalString(row.total),
    currencyCode: row.currencyCode,
    date: isoOrNull(row.date),
    expiryDate: isoOrNull(row.expiryDate),
    isViewedByClient: row.isViewedByClient,
    convertible: row.status === 'accepted' && !convertedIds.has(row.id),
  }));
}

function toSalesOrderSummary(row: SalesOrderSummaryRow): SalesOrderSummaryDTO {
  return {
    id: row.id,
    zohoSalesOrderId: row.zohoSalesOrderId,
    salesOrderNumber: row.salesOrderNumber,
    status: row.status,
    total: decimalString(row.total),
    currencyCode: row.currencyCode,
    orderDate: isoOrNull(row.orderDate),
  };
}

/** Detail by id or folio (`OPP-000123`). */
export async function getOpportunityDetail(actor: CurrentUser, idOrNumber: string): Promise<OpportunityDetail> {
  assertCrmPermission(actor, 'crm.view');
  const ref = idOrNumber.trim();
  const row = /^OPP-\d+$/i.test(ref)
    ? await prisma.opportunity.findUnique({ where: { number: ref.toUpperCase() } })
    : await prisma.opportunity.findUnique({ where: { id: ref } });
  if (!row) throw new CrmError('No se encontró la oportunidad', 'not_found', 404);
  const now = new Date();
  const canQuotes = hasPermission(actor, 'quotes.view');
  const canOrders = hasPermission(actor, 'sales_orders.view');
  const canCases = hasPermission(actor, 'operations.view');
  const canRadar = hasPermission(actor, 'crm.radar');

  const [stages, activities, quoteRows, orderRows, caseRows, conversationRows, signalRows] = await Promise.all([
    loadPipelineStages(),
    activityPage(actor, { opportunityId: row.id, limit: 50 }),
    canQuotes && row.zohoEstimateIds.length > 0
      ? prisma.quote.findMany({
          where: { zohoEstimateId: { in: row.zohoEstimateIds } },
          select: QUOTE_SUMMARY_SELECT,
          orderBy: { date: 'desc' },
        })
      : Promise.resolve([] as QuoteSummaryRow[]),
    canOrders && row.zohoSalesOrderIds.length > 0
      ? prisma.salesOrder.findMany({
          where: { zohoSalesOrderId: { in: row.zohoSalesOrderIds } },
          select: SALES_ORDER_SUMMARY_SELECT,
          orderBy: { orderDate: 'desc' },
        })
      : Promise.resolve([] as SalesOrderSummaryRow[]),
    canCases && row.caseIds.length > 0
      ? prisma.operationalCase.findMany({
          where: { id: { in: row.caseIds } },
          select: { id: true, caseNumber: true, status: true, phase: true, promisedAt: true },
        })
      : Promise.resolve([]),
    row.conversationIds.length > 0
      ? prisma.commConversation.findMany({
          where: { id: { in: row.conversationIds } },
          include: { account: true, contact: true },
          orderBy: { lastMessageAt: 'desc' },
        })
      : Promise.resolve([]),
    canRadar
      ? prisma.radarSignal.findMany({
          where: { AND: [{ opportunityId: row.id, status: 'active', expiresAt: { gt: now } }, visibleSignalsWhere(actor)] },
          orderBy: { score: 'desc' },
        })
      : Promise.resolve([]),
  ]);

  const stage = stages.find((item) => item.id === row.stageId) ?? null;
  const names = await loadUserNames(prisma, [row.salespersonUserId, ...signalRows.map((signal) => signal.salespersonUserId)]);
  const visibleConversations = conversationRows.filter((conversation) => canAccessAccount(actor, conversation.account));
  return {
    opportunity: toOpportunityDTO(row, { stage, salespersonName: names.get(row.salespersonUserId) ?? null, now }),
    stage: stage ? toStageDTO(stage) : null,
    activities,
    quotes: await toQuoteSummaries(quoteRows),
    salesOrders: orderRows.map(toSalesOrderSummary),
    cases: caseRows.map((opCase) => ({
      id: opCase.id,
      caseNumber: opCase.caseNumber,
      status: opCase.status,
      phase: opCase.phase,
      promisedAt: isoOrNull(opCase.promisedAt),
    })),
    conversations: visibleConversations.map((conversation) => ({
      id: conversation.id,
      status: conversation.status,
      channel: CHANNEL_LABELS[conversation.account.provider] ?? conversation.account.provider,
      accountLabel: conversation.account.label,
      contactName: conversation.contact.displayName,
      lastMessageAt: conversation.lastMessageAt.toISOString(),
    })),
    hiddenConversations: conversationRows.length - visibleConversations.length,
    signals: signalRows.map((signal) => toRadarSignalDTO(signal, names)),
    permissions: {
      canManage: hasPermission(actor, 'crm.manage'),
      canCreateSalesOrder: hasPermission(actor, 'crm.create_sales_order'),
      canUseRadar: canRadar,
    },
  };
}

// ---------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------

export const radarListQuerySchema = z.object({
  salespersonUserId: z.union([idSchema, z.literal('me'), z.literal('unassigned')]).optional(),
  kinds: z.array(z.enum(RADAR_KINDS)).max(RADAR_KINDS.length).optional(),
  status: z.enum(RADAR_STATUSES).default('active'),
  minScore: z.number().int().min(0).max(100).optional(),
  opportunityId: idSchema.optional(),
  conversationId: idSchema.optional(),
  zohoContactId: z.string().trim().max(40).optional(),
  cursor: cursorSchema,
  limit: z.number().int().min(1).max(100).default(30),
});
export type RadarListQuery = z.input<typeof radarListQuerySchema>;

export interface RadarPage {
  items: RadarSignalDTO[];
  nextCursor: string | null;
  total: number;
}

function radarWhere(actor: CurrentUser, input: z.output<typeof radarListQuerySchema>, now: Date): Prisma.RadarSignalWhereInput {
  const and: Prisma.RadarSignalWhereInput[] = [visibleSignalsWhere(actor), { status: input.status }];
  if (input.status === 'active') and.push({ expiresAt: { gt: now } });
  if (input.salespersonUserId === 'me') and.push({ salespersonUserId: actor.id });
  else if (input.salespersonUserId === 'unassigned') and.push({ salespersonUserId: null });
  else if (input.salespersonUserId) and.push({ salespersonUserId: input.salespersonUserId });
  if (input.kinds?.length) and.push({ kind: { in: input.kinds } });
  if (input.minScore !== undefined) and.push({ score: { gte: input.minScore } });
  if (input.opportunityId) and.push({ opportunityId: input.opportunityId });
  if (input.conversationId) and.push({ conversationId: input.conversationId });
  if (input.zohoContactId) and.push({ zohoContactId: input.zohoContactId });
  return { AND: and };
}

export async function listRadarSignals(actor: CurrentUser, rawInput: RadarListQuery = {}): Promise<RadarPage> {
  assertCrmPermission(actor, 'crm.radar');
  const input = radarListQuerySchema.parse(rawInput);
  const now = new Date();
  const where = radarWhere(actor, input, now);
  const offset = offsetOf(input.cursor);
  const [total, rows] = await Promise.all([
    prisma.radarSignal.count({ where }),
    prisma.radarSignal.findMany({
      where,
      orderBy: [{ score: 'desc' }, { computedAt: 'desc' }, { id: 'asc' }],
      skip: offset,
      take: input.limit,
    }),
  ]);
  const names = await loadUserNames(prisma, rows.map((row) => row.salespersonUserId));
  return {
    items: rows.map((row) => toRadarSignalDTO(row, names)),
    nextCursor: nextCursorFor(offset, rows.length, total),
    total,
  };
}

export interface RadarSummary {
  active: number;
  byKind: Array<{ kind: RadarKind; label: string; count: number }>;
  bySalesperson: Array<{ userId: string | null; name: string | null; count: number; topScore: number }>;
  top: RadarSignalDTO[];
}

export async function getRadarSummary(actor: CurrentUser): Promise<RadarSummary> {
  assertCrmPermission(actor, 'crm.radar');
  const now = new Date();
  const where: Prisma.RadarSignalWhereInput = { AND: [visibleSignalsWhere(actor), { status: 'active', expiresAt: { gt: now } }] };
  const [rows, topRows] = await Promise.all([
    prisma.radarSignal.findMany({ where, select: { kind: true, salespersonUserId: true, score: true }, take: 5000 }),
    prisma.radarSignal.findMany({ where, orderBy: [{ score: 'desc' }, { computedAt: 'desc' }], take: 5 }),
  ]);
  const byKind = new Map<string, number>();
  const bySalesperson = new Map<string, { userId: string | null; count: number; topScore: number }>();
  for (const row of rows) {
    byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
    const key = row.salespersonUserId ?? '';
    const current = bySalesperson.get(key) ?? { userId: row.salespersonUserId, count: 0, topScore: 0 };
    bySalesperson.set(key, { ...current, count: current.count + 1, topScore: Math.max(current.topScore, row.score) });
  }
  const names = await loadUserNames(prisma, [...rows.map((row) => row.salespersonUserId), ...topRows.map((row) => row.salespersonUserId)]);
  return {
    active: rows.length,
    byKind: RADAR_KINDS.map((kind) => ({ kind, label: RADAR_KIND_LABELS[kind], count: byKind.get(kind) ?? 0 })),
    bySalesperson: [...bySalesperson.values()]
      .map((entry) => ({ ...entry, name: entry.userId ? (names.get(entry.userId) ?? null) : null }))
      .sort((a, b) => b.count - a.count || b.topScore - a.topScore),
    top: topRows.map((row) => toRadarSignalDTO(row, names)),
  };
}

// ---------------------------------------------------------------------------
// CRM panel of an inbox conversation
// ---------------------------------------------------------------------------

export interface ConversationCrmPanel {
  conversation: {
    id: string;
    status: string;
    channel: string;
    accountLabel: string;
    assignedToUserId: string | null;
    assignedToName: string | null;
  };
  contact: {
    commContactId: string;
    displayName: string;
    phone: string | null;
    email: string | null;
    zohoContactId: string | null;
  };
  customer: { name: string | null; paymentTermsLabel: string | null } | null;
  opportunities: OpportunityDTO[];
  /** Live opportunity already linked to this conversation (null = one can be created). */
  liveOpportunityId: string | null;
  quotes: QuoteSummaryDTO[];
  salesOrders: SalesOrderSummaryDTO[];
  signals: RadarSignalDTO[];
  permissions: { canCreateOpportunity: boolean; canManage: boolean; canCreateSalesOrder: boolean; canUseRadar: boolean };
}

export async function getConversationCrmPanel(actor: CurrentUser, conversationId: string): Promise<ConversationCrmPanel> {
  assertCrmPermission(actor, 'crm.view');
  const conversation = await prisma.commConversation.findUnique({
    where: { id: conversationId },
    include: { account: true, contact: true },
  });
  // Not leaking whether a conversation of another team exists.
  if (!conversation || !canAccessAccount(actor, conversation.account)) {
    throw new CrmError('No se encontró la conversación', 'not_found', 404);
  }
  const now = new Date();
  const zohoContactId = conversation.contact.zohoContactId;
  const canQuotes = hasPermission(actor, 'quotes.view');
  const canOrders = hasPermission(actor, 'sales_orders.view');
  const canRadar = hasPermission(actor, 'crm.radar');
  const canManage = hasPermission(actor, 'crm.manage');

  const opportunityOr: Prisma.OpportunityWhereInput[] = [
    { conversationIds: { has: conversation.id } },
    { commContactId: conversation.contactId },
    ...(zohoContactId ? [{ zohoContactId }] : []),
  ];
  const signalOr: Prisma.RadarSignalWhereInput[] = [
    { conversationId: conversation.id },
    { commContactId: conversation.contactId },
    ...(zohoContactId ? [{ zohoContactId }] : []),
  ];

  const [opportunityRows, customer, quoteRows, orderRows, signalRows, stages] = await Promise.all([
    prisma.opportunity.findMany({ where: { OR: opportunityOr }, orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }], take: 20 }),
    zohoContactId
      ? prisma.contact.findUnique({ where: { zohoContactId }, select: { contactName: true, companyName: true, paymentTermsLabel: true } })
      : Promise.resolve(null),
    canQuotes && zohoContactId
      ? prisma.quote.findMany({ where: { zohoCustomerId: zohoContactId }, select: QUOTE_SUMMARY_SELECT, orderBy: [{ date: 'desc' }], take: 5 })
      : Promise.resolve([] as QuoteSummaryRow[]),
    canOrders && zohoContactId
      ? prisma.salesOrder.findMany({ where: { zohoCustomerId: zohoContactId }, select: SALES_ORDER_SUMMARY_SELECT, orderBy: [{ orderDate: 'desc' }], take: 5 })
      : Promise.resolve([] as SalesOrderSummaryRow[]),
    canRadar
      ? prisma.radarSignal.findMany({
          where: { AND: [visibleSignalsWhere(actor), { status: 'active', expiresAt: { gt: now } }, { OR: signalOr }] },
          orderBy: { score: 'desc' },
          take: 10,
        })
      : Promise.resolve([]),
    loadPipelineStages(),
  ]);

  const live = (status: string) => status === 'open' || status === 'dormant';
  const sorted = [...opportunityRows].sort((a, b) => Number(live(b.status)) - Number(live(a.status))).slice(0, 10);
  const liveLinked = opportunityRows.find((row) => live(row.status) && row.conversationIds.includes(conversation.id)) ?? null;
  const names = await loadUserNames(prisma, [conversation.assignedToUserId, ...signalRows.map((row) => row.salespersonUserId)]);
  return {
    conversation: {
      id: conversation.id,
      status: conversation.status,
      channel: CHANNEL_LABELS[conversation.account.provider] ?? conversation.account.provider,
      accountLabel: conversation.account.label,
      assignedToUserId: conversation.assignedToUserId,
      assignedToName: conversation.assignedToUserId ? (names.get(conversation.assignedToUserId) ?? null) : null,
    },
    contact: {
      commContactId: conversation.contact.id,
      displayName: conversation.contact.displayName,
      phone: conversation.contact.phone,
      email: conversation.contact.email,
      zohoContactId,
    },
    customer: customer ? { name: customer.contactName ?? customer.companyName, paymentTermsLabel: customer.paymentTermsLabel } : null,
    opportunities: await toOpportunityDTOs(sorted, stages, now),
    liveOpportunityId: liveLinked?.id ?? null,
    quotes: await toQuoteSummaries(quoteRows),
    salesOrders: orderRows.map(toSalesOrderSummary),
    signals: signalRows.map((row) => toRadarSignalDTO(row, names)),
    permissions: {
      canCreateOpportunity: canManage && !liveLinked,
      canManage,
      canCreateSalesOrder: hasPermission(actor, 'crm.create_sales_order'),
      canUseRadar: canRadar,
    },
  };
}
