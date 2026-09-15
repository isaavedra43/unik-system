import { Prisma, type Opportunity, type PipelineStage } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { canAccessAccount } from '@/modules/comms/comms-access';
import {
  OperationsError,
  registerCommand,
  resolveAreaAssignee,
  type CommandContext,
} from '@/modules/operations/commands';
import { toOperationalJson } from '@/modules/operations/events-service';
import { isOpsFlagEnabled } from '@/modules/operations/operations-config';
import { nextNumber } from '@/modules/operations/sequence-service';
import { QUOTE_ENTITY_TYPE } from '@/modules/quotes/permissions';
import { getQuoteStatusLabel } from '@/modules/quotes/quotes-helpers';
import {
  assertAggregateTarget,
  commandUserId,
  decimalString,
  opportunityAggregate,
  runCrmCommand,
  runCrmSystemCommand,
  toDecimal,
  type CrmCommandOptions,
} from './crm-helpers';
import {
  FAILED_OUTBOUND_STATUSES,
  formatMoney,
  mergeIds,
  messageActivitySummary,
  planConversationTouch,
  planStageMove,
  quoteStatusActivityKind,
  shouldAdvanceToQuoted,
  toNumber,
  truncateText,
} from './opportunity-rules';
import { firstActiveStageOfKind, QUOTED_STAGE_KEY } from './pipeline-rules';
import { loadPipelineStages } from './pipeline-service';
import { supplierConversationIds } from './supplier-conversations';
import {
  ACTIVITY_REF_TYPES,
  CRM_AREA_KEY,
  CRM_COMMANDS,
  CRM_EVENTS,
  CRM_OBJECT_TYPES,
  MANUAL_ACTIVITY_KINDS,
  OPPORTUNITY_NUMBER_PREFIX,
  OPPORTUNITY_SEQUENCE_KEY,
  OPPORTUNITY_SOURCES,
  type ActivityKind,
  type OpportunitySource,
} from './types';

/**
 * Opportunities of the sales pipeline (plan 6.5), on top of the existing inbox,
 * calls, quotes and sales orders. Every mutation is an operational command:
 *
 * | command | aggregate | permission / actor |
 * |---|---|---|
 * | crm.opportunity.create | none | crm.manage (manual, from a call or a conversation id) |
 * | crm.opportunity.create_from_conversation | none (`opportunity:conversation:{id}`) | crm.manage; returns the live one if the conversation already has it |
 * | crm.opportunity.update / move_stage / link_quote / mark_won / mark_lost / mark_dormant | opportunity (version) | crm.manage |
 * | crm.opportunity.record_activity | none | crm.manage |
 * | crm.opportunity.link_sales_order | none | crm.manage (system: from the sales order writer, may create the opportunity) |
 * | crm.opportunity.link_case / crm.conversation.touch / crm.quote.changed | none | system only |
 *
 * Rules: the contact comes from `CommContact.zohoContactId` and the salesperson
 * is the conversation assignee (then the call initiator, the person creating it
 * and finally the responsible of Ventas); a new opportunity starts in an open
 * stage; stage moves set the status (planStageMove); timestamps from messages
 * only move forward; message and quote activities are deduplicated by their
 * reference, so the fan-out and the quote change sweep are idempotent.
 */

type Tx = Prisma.TransactionClient;

const OPP = CRM_OBJECT_TYPES.opportunity;
const LIVE_STATUSES = ['open', 'dormant'];
const SYSTEM_ONLY = ['system'] as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const idSchema = z.string().trim().min(1).max(64);
const isoInstantSchema = z
  .string()
  .trim()
  .min(10)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Fecha inválida (usa formato ISO)');
const moneySchema = z.number().finite().min(0).max(1_000_000_000_000);
const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'Moneda inválida (código de 3 letras)')
  .transform((value) => value.toUpperCase());
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(20);
const titleSchema = z.string().trim().min(2).max(160);
const contactNameSchema = z.string().trim().min(1).max(160);
const noteSchema = z.string().trim().min(1).max(2000);
const nextActionTextSchema = z.string().trim().min(1).max(240);
const zohoContactIdSchema = z.string().trim().min(1).max(40);
const stageKeySchema = z.string().trim().min(1).max(40);

export const createOpportunitySchema = z
  .object({
    title: titleSchema.optional(),
    contactName: contactNameSchema.optional(),
    commContactId: idSchema.optional(),
    zohoContactId: zohoContactIdSchema.optional(),
    conversationId: idSchema.optional(),
    voiceCallId: idSchema.optional(),
    salespersonUserId: idSchema.optional(),
    stageId: idSchema.optional(),
    stageKey: stageKeySchema.optional(),
    estimatedValue: moneySchema.optional(),
    currency: currencySchema.optional(),
    probability: z.number().min(0).max(1).optional(),
    expectedCloseAt: isoInstantSchema.optional(),
    nextActionAt: isoInstantSchema.optional(),
    nextActionText: nextActionTextSchema.optional(),
    source: z.enum(OPPORTUNITY_SOURCES).optional(),
    tags: tagsSchema.optional(),
    note: noteSchema.optional(),
  })
  .refine(
    (value) => Boolean(value.contactName || value.commContactId || value.zohoContactId || value.conversationId || value.voiceCallId),
    { message: 'Indica el cliente: nombre, contacto, cliente de Zoho, conversación o llamada' }
  );
export type CreateOpportunityInput = z.input<typeof createOpportunitySchema>;

export const createOpportunityFromConversationSchema = z.object({
  conversationId: idSchema,
  title: titleSchema.optional(),
  salespersonUserId: idSchema.optional(),
  stageId: idSchema.optional(),
  stageKey: stageKeySchema.optional(),
  estimatedValue: moneySchema.optional(),
  currency: currencySchema.optional(),
  expectedCloseAt: isoInstantSchema.optional(),
  nextActionAt: isoInstantSchema.optional(),
  nextActionText: nextActionTextSchema.optional(),
  tags: tagsSchema.optional(),
  note: noteSchema.optional(),
});
export type CreateOpportunityFromConversationInput = z.input<typeof createOpportunityFromConversationSchema>;

export const updateOpportunitySchema = z
  .object({
    opportunityId: idSchema,
    title: titleSchema.optional(),
    contactName: contactNameSchema.optional(),
    zohoContactId: zohoContactIdSchema.nullable().optional(),
    salespersonUserId: idSchema.optional(),
    estimatedValue: moneySchema.nullable().optional(),
    currency: currencySchema.optional(),
    probability: z.number().min(0).max(1).nullable().optional(),
    expectedCloseAt: isoInstantSchema.nullable().optional(),
    nextActionAt: isoInstantSchema.nullable().optional(),
    nextActionText: nextActionTextSchema.nullable().optional(),
    tags: tagsSchema.optional(),
  })
  .refine(
    (value) =>
      Object.entries(value).some(([key, field]) => key !== 'opportunityId' && field !== undefined),
    { message: 'Indica al menos un cambio' }
  );
export type UpdateOpportunityInput = z.input<typeof updateOpportunitySchema>;

export const moveOpportunityStageSchema = z
  .object({
    opportunityId: idSchema,
    stageId: idSchema.optional(),
    stageKey: stageKeySchema.optional(),
    lostReason: z.string().trim().max(500).optional(),
    note: noteSchema.optional(),
  })
  .refine((value) => Boolean(value.stageId || value.stageKey), { message: 'Indica la etapa destino' });
export type MoveOpportunityStageInput = z.input<typeof moveOpportunityStageSchema>;

export const markWonSchema = z.object({ opportunityId: idSchema, note: noteSchema.optional() });
export const markLostSchema = z.object({
  opportunityId: idSchema,
  lostReason: z.string().trim().min(3, 'Indica el motivo por el que se perdió la oportunidad').max(500),
  note: noteSchema.optional(),
});
export const markDormantSchema = z.object({ opportunityId: idSchema, reason: z.string().trim().max(500).optional() });

export const linkQuoteSchema = z.object({ opportunityId: idSchema, quoteId: idSchema });
export type LinkQuoteInput = z.input<typeof linkQuoteSchema>;

export const linkSalesOrderSchema = z
  .object({
    opportunityId: idSchema.optional(),
    quoteId: idSchema.optional(),
    salesOrderId: idSchema,
    requestedByUserId: idSchema.optional(),
    requestKey: z.string().trim().max(160).optional(),
    markWon: z.boolean().default(true),
    createIfMissing: z.boolean().default(false),
  })
  .refine((value) => Boolean(value.opportunityId || value.quoteId), { message: 'Indica la oportunidad o la cotización' });
export type LinkSalesOrderInput = z.input<typeof linkSalesOrderSchema>;

export const recordActivitySchema = z
  .object({
    opportunityId: idSchema,
    kind: z.enum(MANUAL_ACTIVITY_KINDS),
    summary: z.string().trim().min(1).max(2000),
    resolvesActivityId: idSchema.optional(),
    at: isoInstantSchema.optional(),
    nextActionAt: isoInstantSchema.optional(),
    nextActionText: nextActionTextSchema.optional(),
  })
  .refine((value) => !value.resolvesActivityId || value.kind === 'objection_resolved', {
    message: 'Sólo una objeción resuelta puede referirse a otra actividad',
  });
export type RecordActivityInput = z.input<typeof recordActivitySchema>;

const linkCaseSchema = z.object({ opportunityId: idSchema, caseId: idSchema });
const touchSchema = z.object({ messageId: idSchema, opportunityId: idSchema });
const quoteChangedSchema = z.object({ changeEventId: idSchema, opportunityId: idSchema });

// ---------------------------------------------------------------------------
// Result data
// ---------------------------------------------------------------------------

export interface CreateOpportunityData {
  opportunityId: string;
  number: string;
  status: string;
  stageId: string;
  created: boolean;
}

export interface UpdateOpportunityData {
  opportunityId: string;
  changed: string[];
}

export interface StageMoveData {
  opportunityId: string;
  stageId: string;
  status: string;
  transition: 'won' | 'lost' | 'reopened' | null;
}

export interface LinkQuoteData {
  opportunityId: string;
  quoteId: string;
  alreadyLinked: boolean;
  stageAdvanced: boolean;
}

export interface LinkSalesOrderData {
  linked: boolean;
  opportunityId: string | null;
  number: string | null;
  created: boolean;
  alreadyLinked: boolean;
  won: boolean;
}

export interface RecordActivityData {
  opportunityId: string;
  activityId: string;
}

interface TouchData {
  touched: boolean;
  reason?: string;
  activityKind?: string;
  reactivated?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers inside commands
// ---------------------------------------------------------------------------

async function assertCrmEnabled(): Promise<void> {
  if (!(await isOpsFlagEnabled('crm'))) {
    throw new OperationsError('module_disabled', 'El CRM está desactivado en la configuración de operaciones');
  }
}

const dateTimeFormatter = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatDateTime(date: Date): string {
  try {
    return dateTimeFormatter.format(date);
  } catch {
    return date.toISOString();
  }
}

const eventOptions = (opportunityId: string) => ({ areaKey: CRM_AREA_KEY, objectType: OPP, objectId: opportunityId });

async function loadOpportunity(tx: Tx, id: string): Promise<Opportunity> {
  const row = await tx.opportunity.findUnique({ where: { id } });
  if (!row) throw new OperationsError('not_found', 'No se encontró la oportunidad');
  return row;
}

function resolveStage(stages: PipelineStage[], ref: { stageId?: string; stageKey?: string }): PipelineStage {
  const stage = ref.stageId
    ? stages.find((row) => row.id === ref.stageId)
    : stages.find((row) => row.key === ref.stageKey);
  if (!stage) throw new OperationsError('not_found', 'No se encontró la etapa del embudo');
  return stage;
}

function stageOfKind(stages: PipelineStage[], kind: 'open' | 'won' | 'lost'): PipelineStage {
  const stage = firstActiveStageOfKind(stages, kind);
  if (!stage) {
    const label = kind === 'open' ? 'abierta' : kind === 'won' ? 'ganada' : 'perdida';
    throw new OperationsError('invalid_config', `El embudo no tiene una etapa ${label} activa`);
  }
  return stage;
}

function assertStartStage(stage: PipelineStage): void {
  if (!stage.active || stage.kind !== 'open') {
    throw new OperationsError('invalid_state', `Una oportunidad nueva empieza en una etapa abierta; «${stage.name}» no lo es`);
  }
}

async function assertSalesperson(tx: Tx, userId: string): Promise<void> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { isActive: true, isBot: true } });
  if (!user || !user.isActive || user.isBot) {
    throw new OperationsError('invalid_payload', 'El vendedor indicado no existe, está inactivo o es una identidad de IA');
  }
}

/** First active person among the candidates, then the responsible of Ventas. */
async function defaultSalesperson(tx: Tx, candidates: Array<string | null | undefined>): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const user = await tx.user.findUnique({ where: { id: candidate }, select: { isActive: true, isBot: true } });
    if (user?.isActive && !user.isBot) return candidate;
  }
  return (await resolveAreaAssignee(tx, CRM_AREA_KEY)).ownerUserId;
}

const humanActorId = (ctx: CommandContext): string | null => (ctx.actor.type === 'user' ? ctx.actor.id : null);

interface ActivityInput {
  opportunityId: string;
  kind: ActivityKind;
  summary: string;
  refType?: string | null;
  refId?: string | null;
  payload?: Record<string, unknown> | null;
  /** Defaults to the command's person or bot (null for system). */
  userId?: string | null;
  at?: Date;
}

async function addActivity(tx: Tx, ctx: CommandContext, input: ActivityInput) {
  return tx.opportunityActivity.create({
    data: {
      opportunityId: input.opportunityId,
      kind: input.kind,
      summary: truncateText(input.summary, 1000),
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      ...(input.payload ? { payload: toOperationalJson(input.payload) } : {}),
      userId: input.userId !== undefined ? input.userId : commandUserId(ctx),
      at: input.at ?? ctx.now,
    },
  });
}

interface ResolvedContact {
  commContactId: string | null;
  zohoContactId: string | null;
  contactName: string | null;
}

async function resolveContact(
  tx: Tx,
  input: { commContactId?: string | null; zohoContactId?: string | null; contactName?: string | null }
): Promise<ResolvedContact> {
  let commContact: { id: string; displayName: string; zohoContactId: string | null } | null = null;
  if (input.commContactId) {
    commContact = await tx.commContact.findUnique({
      where: { id: input.commContactId },
      select: { id: true, displayName: true, zohoContactId: true },
    });
    if (!commContact) throw new OperationsError('not_found', 'No se encontró el contacto de la bandeja');
  }
  const zohoContactId = input.zohoContactId ?? commContact?.zohoContactId ?? null;
  let zohoName: string | null = null;
  if (zohoContactId) {
    const contact = await tx.contact.findUnique({
      where: { zohoContactId },
      select: { contactName: true, companyName: true },
    });
    if (input.zohoContactId && !contact) throw new OperationsError('not_found', 'No se encontró el cliente de Zoho');
    zohoName = contact?.contactName ?? contact?.companyName ?? null;
  }
  return {
    commContactId: commContact?.id ?? null,
    zohoContactId,
    contactName: input.contactName?.trim() || commContact?.displayName?.trim() || zohoName,
  };
}

async function loadConversation(tx: Tx, ctx: CommandContext, conversationId: string) {
  const conversation = await tx.commConversation.findUnique({
    where: { id: conversationId },
    include: { account: true, contact: true },
  });
  if (!conversation) throw new OperationsError('not_found', 'No se encontró la conversación');
  if (ctx.actor.type === 'user' && ctx.user && !canAccessAccount(ctx.user, conversation.account)) {
    throw new OperationsError('forbidden', 'No tienes acceso a esta conversación de la bandeja');
  }
  const supplier = await supplierConversationIds(tx, [
    { id: conversation.id, tags: conversation.tags, contactId: conversation.contactId, zohoContactId: conversation.contact.zohoContactId },
  ]);
  if (supplier.has(conversation.id)) {
    throw new OperationsError('invalid_state', 'La conversación es con un proveedor o de una cotización de compra: no es una oportunidad de venta');
  }
  const lastOutbound = await tx.commMessage.findFirst({
    where: { conversationId, direction: 'outbound', status: { notIn: [...FAILED_OUTBOUND_STATUSES] } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return { conversation, lastOutboundAt: lastOutbound?.createdAt ?? null };
}

function callSummary(call: { type: string; durationSec: number | null; summary: string | null }): string {
  const kind = call.type === 'inbound' ? 'entrante' : call.type === 'outbound' ? 'saliente' : 'interna';
  const minutes = call.durationSec ? ` de ${Math.max(1, Math.round(call.durationSec / 60))} min` : '';
  const summary = call.summary ? `: ${truncateText(call.summary, 300)}` : '';
  return `Llamada ${kind}${minutes}${summary}`;
}

interface NewOpportunity {
  title: string;
  contact: ResolvedContact & { contactName: string };
  salespersonUserId: string;
  stage: PipelineStage;
  estimatedValue: number | null;
  currency: string;
  probability: number | null;
  expectedCloseAt: Date | null;
  nextActionAt: Date | null;
  nextActionText: string | null;
  source: OpportunitySource;
  conversationIds: string[];
  voiceCallIds: string[];
  zohoEstimateIds: string[];
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  tags: string[];
  origin: Omit<ActivityInput, 'opportunityId'>;
  note?: string | null;
}

async function insertOpportunity(tx: Tx, ctx: CommandContext, input: NewOpportunity): Promise<Opportunity> {
  assertStartStage(input.stage);
  const number = await nextNumber(tx, OPPORTUNITY_SEQUENCE_KEY, OPPORTUNITY_NUMBER_PREFIX);
  const row = await tx.opportunity.create({
    data: {
      number,
      title: input.title,
      commContactId: input.contact.commContactId,
      zohoContactId: input.contact.zohoContactId,
      contactName: input.contact.contactName,
      salespersonUserId: input.salespersonUserId,
      stageId: input.stage.id,
      stageEnteredAt: ctx.now,
      estimatedValue: toDecimal(input.estimatedValue),
      currency: input.currency,
      probability: toDecimal(input.probability),
      expectedCloseAt: input.expectedCloseAt,
      nextActionAt: input.nextActionAt,
      nextActionText: input.nextActionText,
      source: input.source,
      conversationIds: input.conversationIds,
      voiceCallIds: input.voiceCallIds,
      zohoEstimateIds: input.zohoEstimateIds,
      zohoSalesOrderIds: [],
      caseIds: [],
      status: 'open',
      lastActivityAt: ctx.now,
      lastInboundAt: input.lastInboundAt,
      lastOutboundAt: input.lastOutboundAt,
      tags: input.tags,
    },
  });
  await addActivity(tx, ctx, { ...input.origin, opportunityId: row.id });
  if (input.note) await addActivity(tx, ctx, { opportunityId: row.id, kind: 'note', summary: input.note });
  if (input.nextActionAt || input.nextActionText) {
    await addActivity(tx, ctx, {
      opportunityId: row.id,
      kind: 'task',
      summary: nextActionSummary(input.nextActionText, input.nextActionAt),
    });
  }
  for (const conversationId of input.conversationIds) {
    await ctx.relate({ type: ACTIVITY_REF_TYPES.conversation, id: conversationId }, { type: OPP, id: row.id }, 'originated');
  }
  for (const voiceCallId of input.voiceCallIds) {
    await ctx.relate({ type: ACTIVITY_REF_TYPES.voiceCall, id: voiceCallId }, { type: OPP, id: row.id }, 'originated');
  }
  ctx.emit(
    CRM_EVENTS.opportunityCreated,
    {
      opportunityId: row.id,
      number,
      title: row.title,
      contactName: row.contactName,
      salespersonUserId: row.salespersonUserId,
      stageKey: input.stage.key,
      source: row.source,
      estimatedValue: decimalString(row.estimatedValue),
    },
    eventOptions(row.id)
  );
  if (row.salespersonUserId !== commandUserId(ctx)) {
    ctx.realtime(`user:${row.salespersonUserId}`, 'crm_opportunity_assigned', {
      opportunityId: row.id,
      number,
      title: row.title,
      contactName: row.contactName,
    });
  }
  return row;
}

function nextActionSummary(text: string | null | undefined, at: Date | null | undefined): string {
  const what = text ? `: «${truncateText(text, 200)}»` : '';
  const when = at ? ` para el ${formatDateTime(at)}` : '';
  return `Siguiente acción${what}${when}`;
}

interface StageMoveOutcome {
  opportunity: Opportunity;
  transition: 'won' | 'lost' | 'reopened' | null;
}

async function applyStageMove(
  tx: Tx,
  ctx: CommandContext,
  opportunity: Opportunity,
  stages: PipelineStage[],
  target: PipelineStage,
  options: { lostReason?: string | null; note?: string | null; reason?: string; refType?: string; refId?: string } = {}
): Promise<StageMoveOutcome> {
  const plan = planStageMove({ status: opportunity.status, stageId: opportunity.stageId }, target, {
    lostReason: options.lostReason,
    now: ctx.now,
  });
  if (!plan.ok) throw new OperationsError(plan.code, plan.message);
  const from = stages.find((stage) => stage.id === opportunity.stageId) ?? null;
  const updated = await tx.opportunity.update({
    where: { id: opportunity.id },
    data: { ...plan.data, lastActivityAt: ctx.now },
  });
  const reason = plan.data.lostReason ? ` (motivo: ${plan.data.lostReason})` : '';
  await addActivity(tx, ctx, {
    opportunityId: opportunity.id,
    kind: 'stage_change',
    summary: `Etapa: ${from?.name ?? 'sin etapa'} → ${target.name}${reason}`,
    refType: options.refType ?? ACTIVITY_REF_TYPES.stage,
    refId: options.refId ?? target.id,
    payload: {
      fromStageId: from?.id ?? null,
      fromStageKey: from?.key ?? null,
      toStageId: target.id,
      toStageKey: target.key,
      transition: plan.transition,
      ...(options.reason ? { reason: options.reason } : {}),
    },
  });
  if (options.note) await addActivity(tx, ctx, { opportunityId: opportunity.id, kind: 'note', summary: options.note });
  const payload = {
    opportunityId: opportunity.id,
    number: opportunity.number,
    fromStageKey: from?.key ?? null,
    toStageKey: target.key,
    status: plan.data.status,
  };
  ctx.emit(CRM_EVENTS.opportunityStageChanged, payload, eventOptions(opportunity.id));
  if (plan.transition === 'won') {
    ctx.emit(CRM_EVENTS.opportunityWon, { ...payload, estimatedValue: decimalString(updated.estimatedValue) }, eventOptions(opportunity.id));
  } else if (plan.transition === 'lost') {
    ctx.emit(CRM_EVENTS.opportunityLost, { ...payload, lostReason: plan.data.lostReason }, eventOptions(opportunity.id));
  } else if (plan.transition === 'reopened') {
    ctx.emit(CRM_EVENTS.opportunityReactivated, payload, eventOptions(opportunity.id));
  }
  return { opportunity: updated, transition: plan.transition };
}

function sameDate(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

registerCommand<z.output<typeof createOpportunitySchema>, CreateOpportunityData>(CRM_COMMANDS.opportunityCreate, {
  schema: createOpportunitySchema,
  permission: 'crm.manage',
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    await assertCrmEnabled();
    const input = cmd.payload;
    const stages = await loadPipelineStages(tx);
    const stage = input.stageId || input.stageKey ? resolveStage(stages, input) : stageOfKind(stages, 'open');
    assertStartStage(stage);

    let commContactId = input.commContactId ?? null;
    let assignee: string | null = null;
    let conversationIds: string[] = [];
    let voiceCallIds: string[] = [];
    let lastInboundAt: Date | null = null;
    let lastOutboundAt: Date | null = null;
    let origin: NewOpportunity['origin'] = { kind: 'note', summary: 'Oportunidad creada' };

    if (input.conversationId) {
      const loaded = await loadConversation(tx, ctx, input.conversationId);
      conversationIds = [loaded.conversation.id];
      lastInboundAt = loaded.conversation.lastInboundAt;
      lastOutboundAt = loaded.lastOutboundAt;
      assignee = loaded.conversation.assignedToUserId;
      commContactId = commContactId ?? loaded.conversation.contactId;
      origin = {
        kind: 'note',
        summary: `Oportunidad creada desde la conversación con ${loaded.conversation.contact.displayName}`,
        refType: ACTIVITY_REF_TYPES.conversation,
        refId: loaded.conversation.id,
      };
    }
    if (input.voiceCallId) {
      const call = await tx.voiceCall.findUnique({
        where: { id: input.voiceCallId },
        select: { id: true, type: true, contactId: true, initiatedByUserId: true, summary: true, durationSec: true },
      });
      if (!call) throw new OperationsError('not_found', 'No se encontró la llamada');
      voiceCallIds = [call.id];
      commContactId = commContactId ?? call.contactId;
      assignee = assignee ?? call.initiatedByUserId;
      origin = {
        kind: 'call',
        summary: callSummary(call),
        refType: ACTIVITY_REF_TYPES.voiceCall,
        refId: call.id,
        payload: { type: call.type, durationSec: call.durationSec },
      };
    }

    const contact = await resolveContact(tx, {
      commContactId,
      zohoContactId: input.zohoContactId,
      contactName: input.contactName,
    });
    if (!contact.contactName) throw new OperationsError('invalid_payload', 'Indica el nombre del cliente');

    let salespersonUserId: string;
    if (input.salespersonUserId) {
      await assertSalesperson(tx, input.salespersonUserId);
      salespersonUserId = input.salespersonUserId;
    } else {
      salespersonUserId = await defaultSalesperson(tx, [assignee, humanActorId(ctx)]);
    }

    const row = await insertOpportunity(tx, ctx, {
      title: input.title ?? `Oportunidad con ${contact.contactName}`,
      contact: { ...contact, contactName: contact.contactName },
      salespersonUserId,
      stage,
      estimatedValue: input.estimatedValue ?? null,
      currency: input.currency ?? 'MXN',
      probability: input.probability ?? null,
      expectedCloseAt: input.expectedCloseAt ? new Date(input.expectedCloseAt) : null,
      nextActionAt: input.nextActionAt ? new Date(input.nextActionAt) : null,
      nextActionText: input.nextActionText ?? null,
      source: input.source ?? (input.voiceCallId ? 'call' : input.conversationId ? 'inbox' : 'manual'),
      conversationIds,
      voiceCallIds,
      zohoEstimateIds: [],
      lastInboundAt,
      lastOutboundAt,
      tags: input.tags ?? [],
      origin,
      note: input.note ?? null,
    });
    return {
      aggregateVersion: row.version,
      data: { opportunityId: row.id, number: row.number, status: row.status, stageId: row.stageId, created: true },
    };
  },
});

registerCommand<z.output<typeof createOpportunityFromConversationSchema>, CreateOpportunityData>(
  CRM_COMMANDS.opportunityCreateFromConversation,
  {
    schema: createOpportunityFromConversationSchema,
    permission: 'crm.manage',
    aggregate: 'none',
    async handler(tx, cmd, ctx) {
      await assertCrmEnabled();
      const input = cmd.payload;
      const { conversation, lastOutboundAt } = await loadConversation(tx, ctx, input.conversationId);
      const existing = await tx.opportunity.findFirst({
        where: { conversationIds: { has: conversation.id }, status: { in: LIVE_STATUSES } },
        orderBy: { lastActivityAt: 'desc' },
      });
      if (existing) {
        return {
          aggregateVersion: existing.version,
          data: { opportunityId: existing.id, number: existing.number, status: existing.status, stageId: existing.stageId, created: false },
        };
      }
      const stages = await loadPipelineStages(tx);
      const stage = input.stageId || input.stageKey ? resolveStage(stages, input) : stageOfKind(stages, 'open');
      const contact = await resolveContact(tx, { commContactId: conversation.contactId });
      const contactName = contact.contactName ?? conversation.contact.displayName;
      let salespersonUserId: string;
      if (input.salespersonUserId) {
        await assertSalesperson(tx, input.salespersonUserId);
        salespersonUserId = input.salespersonUserId;
      } else {
        salespersonUserId = await defaultSalesperson(tx, [conversation.assignedToUserId, humanActorId(ctx)]);
      }
      const row = await insertOpportunity(tx, ctx, {
        title: input.title ?? `Oportunidad con ${contactName}`,
        contact: { ...contact, contactName },
        salespersonUserId,
        stage,
        estimatedValue: input.estimatedValue ?? null,
        currency: input.currency ?? 'MXN',
        probability: null,
        expectedCloseAt: input.expectedCloseAt ? new Date(input.expectedCloseAt) : null,
        nextActionAt: input.nextActionAt ? new Date(input.nextActionAt) : null,
        nextActionText: input.nextActionText ?? null,
        source: 'inbox',
        conversationIds: [conversation.id],
        voiceCallIds: [],
        zohoEstimateIds: [],
        lastInboundAt: conversation.lastInboundAt,
        lastOutboundAt,
        tags: input.tags ?? [],
        origin: {
          kind: 'note',
          summary: `Oportunidad creada desde la conversación con ${conversation.contact.displayName}`,
          refType: ACTIVITY_REF_TYPES.conversation,
          refId: conversation.id,
        },
        note: input.note ?? null,
      });
      return {
        aggregateVersion: row.version,
        data: { opportunityId: row.id, number: row.number, status: row.status, stageId: row.stageId, created: true },
      };
    },
  }
);

// ---------------------------------------------------------------------------
// Edition and stages
// ---------------------------------------------------------------------------

registerCommand<z.output<typeof updateOpportunitySchema>, UpdateOpportunityData>(CRM_COMMANDS.opportunityUpdate, {
  schema: updateOpportunitySchema,
  permission: 'crm.manage',
  aggregate: opportunityAggregate,
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    assertAggregateTarget(cmd, input.opportunityId, 'oportunidad');
    await assertCrmEnabled();
    const opportunity = await loadOpportunity(tx, input.opportunityId);
    const data: Prisma.OpportunityUpdateInput = {};
    const changed: string[] = [];
    const labels: string[] = [];

    if (input.title !== undefined && input.title !== opportunity.title) {
      data.title = input.title;
      changed.push('title');
      labels.push('título');
    }
    if (input.contactName !== undefined && input.contactName !== opportunity.contactName) {
      data.contactName = input.contactName;
      changed.push('contactName');
      labels.push('cliente');
    }
    if (input.zohoContactId !== undefined && input.zohoContactId !== opportunity.zohoContactId) {
      data.zohoContactId = input.zohoContactId;
      changed.push('zohoContactId');
      labels.push('cliente de Zoho');
    }
    if (input.salespersonUserId !== undefined && input.salespersonUserId !== opportunity.salespersonUserId) {
      await assertSalesperson(tx, input.salespersonUserId);
      data.salespersonUserId = input.salespersonUserId;
      changed.push('salespersonUserId');
      labels.push('vendedor');
      ctx.realtime(`user:${input.salespersonUserId}`, 'crm_opportunity_assigned', {
        opportunityId: opportunity.id,
        number: opportunity.number,
        title: opportunity.title,
        contactName: opportunity.contactName,
      });
    }
    if (input.estimatedValue !== undefined && input.estimatedValue !== toNumber(opportunity.estimatedValue)) {
      data.estimatedValue = toDecimal(input.estimatedValue);
      changed.push('estimatedValue');
      labels.push('valor estimado');
    }
    if (input.currency !== undefined && input.currency !== opportunity.currency) {
      data.currency = input.currency;
      changed.push('currency');
      labels.push('moneda');
    }
    if (input.probability !== undefined && input.probability !== toNumber(opportunity.probability)) {
      data.probability = toDecimal(input.probability);
      changed.push('probability');
      labels.push('probabilidad');
    }
    if (input.expectedCloseAt !== undefined) {
      const next = input.expectedCloseAt ? new Date(input.expectedCloseAt) : null;
      if (!sameDate(next, opportunity.expectedCloseAt)) {
        data.expectedCloseAt = next;
        changed.push('expectedCloseAt');
        labels.push('cierre esperado');
      }
    }
    let nextActionChanged = false;
    if (input.nextActionAt !== undefined) {
      const next = input.nextActionAt ? new Date(input.nextActionAt) : null;
      if (!sameDate(next, opportunity.nextActionAt)) {
        data.nextActionAt = next;
        changed.push('nextActionAt');
        nextActionChanged = true;
      }
    }
    if (input.nextActionText !== undefined && input.nextActionText !== opportunity.nextActionText) {
      data.nextActionText = input.nextActionText;
      changed.push('nextActionText');
      nextActionChanged = true;
    }
    if (input.tags !== undefined && [...input.tags].sort().join('|') !== [...opportunity.tags].sort().join('|')) {
      data.tags = input.tags;
      changed.push('tags');
      labels.push('etiquetas');
    }

    if (changed.length === 0) return { data: { opportunityId: opportunity.id, changed } };
    data.lastActivityAt = ctx.now;
    const updated = await tx.opportunity.update({ where: { id: opportunity.id }, data });
    if (nextActionChanged && (updated.nextActionAt || updated.nextActionText)) {
      await addActivity(tx, ctx, {
        opportunityId: opportunity.id,
        kind: 'task',
        summary: nextActionSummary(updated.nextActionText, updated.nextActionAt),
        payload: { nextActionAt: updated.nextActionAt?.toISOString() ?? null },
      });
    }
    if (labels.length > 0) {
      await addActivity(tx, ctx, {
        opportunityId: opportunity.id,
        kind: 'note',
        summary: `Se actualizó ${labels.join(', ')}`,
        payload: { changed },
      });
    }
    ctx.emit(CRM_EVENTS.opportunityUpdated, { opportunityId: opportunity.id, number: opportunity.number, changed }, eventOptions(opportunity.id));
    return { data: { opportunityId: opportunity.id, changed } };
  },
});

registerCommand<z.output<typeof moveOpportunityStageSchema>, StageMoveData>(CRM_COMMANDS.opportunityMoveStage, {
  schema: moveOpportunityStageSchema,
  permission: 'crm.manage',
  aggregate: opportunityAggregate,
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    assertAggregateTarget(cmd, input.opportunityId, 'oportunidad');
    await assertCrmEnabled();
    const opportunity = await loadOpportunity(tx, input.opportunityId);
    const stages = await loadPipelineStages(tx);
    const target = resolveStage(stages, input);
    const outcome = await applyStageMove(tx, ctx, opportunity, stages, target, {
      lostReason: input.lostReason,
      note: input.note,
    });
    return {
      data: {
        opportunityId: opportunity.id,
        stageId: target.id,
        status: outcome.opportunity.status,
        transition: outcome.transition,
      },
    };
  },
});

registerCommand<z.output<typeof markWonSchema>, StageMoveData>(CRM_COMMANDS.opportunityMarkWon, {
  schema: markWonSchema,
  permission: 'crm.manage',
  aggregate: opportunityAggregate,
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    assertAggregateTarget(cmd, input.opportunityId, 'oportunidad');
    await assertCrmEnabled();
    const opportunity = await loadOpportunity(tx, input.opportunityId);
    if (opportunity.status === 'won') throw new OperationsError('invalid_state', `${opportunity.number} ya está ganada`);
    const stages = await loadPipelineStages(tx);
    const target = stageOfKind(stages, 'won');
    const outcome = await applyStageMove(tx, ctx, opportunity, stages, target, { note: input.note });
    return { data: { opportunityId: opportunity.id, stageId: target.id, status: outcome.opportunity.status, transition: outcome.transition } };
  },
});

registerCommand<z.output<typeof markLostSchema>, StageMoveData>(CRM_COMMANDS.opportunityMarkLost, {
  schema: markLostSchema,
  permission: 'crm.manage',
  aggregate: opportunityAggregate,
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    assertAggregateTarget(cmd, input.opportunityId, 'oportunidad');
    await assertCrmEnabled();
    const opportunity = await loadOpportunity(tx, input.opportunityId);
    if (opportunity.status === 'lost') throw new OperationsError('invalid_state', `${opportunity.number} ya está perdida`);
    const stages = await loadPipelineStages(tx);
    const target = stageOfKind(stages, 'lost');
    const outcome = await applyStageMove(tx, ctx, opportunity, stages, target, {
      lostReason: input.lostReason,
      note: input.note,
    });
    return { data: { opportunityId: opportunity.id, stageId: target.id, status: outcome.opportunity.status, transition: outcome.transition } };
  },
});

registerCommand<z.output<typeof markDormantSchema>, StageMoveData>(CRM_COMMANDS.opportunityMarkDormant, {
  schema: markDormantSchema,
  permission: 'crm.manage',
  aggregate: opportunityAggregate,
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    assertAggregateTarget(cmd, input.opportunityId, 'oportunidad');
    await assertCrmEnabled();
    const opportunity = await loadOpportunity(tx, input.opportunityId);
    if (opportunity.status !== 'open') {
      throw new OperationsError('invalid_state', 'Sólo una oportunidad abierta puede marcarse como dormida');
    }
    await tx.opportunity.update({ where: { id: opportunity.id }, data: { status: 'dormant' } });
    await addActivity(tx, ctx, {
      opportunityId: opportunity.id,
      kind: 'note',
      summary: `Oportunidad marcada como dormida${input.reason ? `: ${input.reason}` : ''}`,
    });
    ctx.emit(
      CRM_EVENTS.opportunityDormant,
      { opportunityId: opportunity.id, number: opportunity.number, reason: input.reason ?? null },
      eventOptions(opportunity.id)
    );
    return { data: { opportunityId: opportunity.id, stageId: opportunity.stageId, status: 'dormant', transition: null } };
  },
});

// ---------------------------------------------------------------------------
// Links: quotes, sales orders, cases
// ---------------------------------------------------------------------------

registerCommand<z.output<typeof linkQuoteSchema>, LinkQuoteData>(CRM_COMMANDS.opportunityLinkQuote, {
  schema: linkQuoteSchema,
  permission: 'crm.manage',
  aggregate: opportunityAggregate,
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    assertAggregateTarget(cmd, input.opportunityId, 'oportunidad');
    await assertCrmEnabled();
    const opportunity = await loadOpportunity(tx, input.opportunityId);
    const quote = await tx.quote.findUnique({
      where: { id: input.quoteId },
      select: {
        id: true,
        zohoEstimateId: true,
        estimateNumber: true,
        status: true,
        total: true,
        currencyCode: true,
        zohoCustomerId: true,
        customerName: true,
      },
    });
    if (!quote) throw new OperationsError('not_found', 'No se encontró la cotización');
    const folio = quote.estimateNumber ?? quote.zohoEstimateId;
    if (opportunity.zohoEstimateIds.includes(quote.zohoEstimateId)) {
      return { data: { opportunityId: opportunity.id, quoteId: quote.id, alreadyLinked: true, stageAdvanced: false } };
    }
    if (opportunity.zohoContactId && quote.zohoCustomerId && opportunity.zohoContactId !== quote.zohoCustomerId) {
      throw new OperationsError(
        'invalid_state',
        `La cotización ${folio} es de ${quote.customerName ?? 'otro cliente'}, no de ${opportunity.contactName}`
      );
    }
    const total = toNumber(quote.total);
    await tx.opportunity.update({
      where: { id: opportunity.id },
      data: {
        zohoEstimateIds: mergeIds(opportunity.zohoEstimateIds, [quote.zohoEstimateId]),
        zohoContactId: opportunity.zohoContactId ?? quote.zohoCustomerId,
        ...(opportunity.estimatedValue === null && total !== null
          ? { estimatedValue: toDecimal(total), currency: quote.currencyCode ?? opportunity.currency }
          : {}),
        lastActivityAt: ctx.now,
      },
    });
    await addActivity(tx, ctx, {
      opportunityId: opportunity.id,
      kind: quoteStatusActivityKind(quote.status),
      summary: `Cotización ${folio} vinculada${total !== null ? ` por ${formatMoney(total, quote.currencyCode)}` : ''} (${getQuoteStatusLabel(quote.status)})`,
      refType: ACTIVITY_REF_TYPES.quote,
      refId: quote.id,
      payload: { zohoEstimateId: quote.zohoEstimateId, status: quote.status },
    });
    await ctx.relate({ type: OPP, id: opportunity.id }, { type: ACTIVITY_REF_TYPES.quote, id: quote.id }, 'quoted');

    let stageAdvanced = false;
    const stages = await loadPipelineStages(tx);
    const current = stages.find((stage) => stage.id === opportunity.stageId) ?? null;
    const quoted = stages.find((stage) => stage.key === QUOTED_STAGE_KEY) ?? null;
    if (quoted && shouldAdvanceToQuoted(opportunity.status, current, quoted)) {
      const fresh = await loadOpportunity(tx, opportunity.id);
      await applyStageMove(tx, ctx, fresh, stages, quoted, {
        reason: 'quote_linked',
        refType: ACTIVITY_REF_TYPES.quote,
        refId: quote.id,
      });
      stageAdvanced = true;
    }
    ctx.emit(
      CRM_EVENTS.quoteLinked,
      { opportunityId: opportunity.id, number: opportunity.number, quoteId: quote.id, estimateNumber: folio, status: quote.status },
      eventOptions(opportunity.id)
    );
    return { data: { opportunityId: opportunity.id, quoteId: quote.id, alreadyLinked: false, stageAdvanced } };
  },
});

registerCommand<z.output<typeof linkSalesOrderSchema>, LinkSalesOrderData>(CRM_COMMANDS.opportunityLinkSalesOrder, {
  schema: linkSalesOrderSchema,
  permission: 'crm.manage',
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    const order = await tx.salesOrder.findUnique({
      where: { id: input.salesOrderId },
      select: {
        id: true,
        zohoSalesOrderId: true,
        salesOrderNumber: true,
        total: true,
        currencyCode: true,
        customerName: true,
        zohoCustomerId: true,
      },
    });
    if (!order) throw new OperationsError('not_found', 'No se encontró la orden de venta');
    const quote = input.quoteId
      ? await tx.quote.findUnique({
          where: { id: input.quoteId },
          select: {
            id: true,
            zohoEstimateId: true,
            estimateNumber: true,
            status: true,
            total: true,
            currencyCode: true,
            zohoCustomerId: true,
            customerName: true,
            createdByUserId: true,
          },
        })
      : null;
    if (input.quoteId && !quote) throw new OperationsError('not_found', 'No se encontró la cotización');
    const actorUserId = commandUserId(ctx) ?? input.requestedByUserId ?? null;

    let opportunity = input.opportunityId ? await loadOpportunity(tx, input.opportunityId) : null;
    if (!opportunity && quote) {
      opportunity = await tx.opportunity.findFirst({
        where: { zohoEstimateIds: { has: quote.zohoEstimateId } },
        orderBy: { lastActivityAt: 'desc' },
      });
    }
    const stages = await loadPipelineStages(tx);
    let created = false;
    if (!opportunity) {
      if (!input.createIfMissing || !quote) {
        return { data: { linked: false, opportunityId: null, number: null, created: false, alreadyLinked: false, won: false } };
      }
      const zohoContactId = quote.zohoCustomerId ?? order.zohoCustomerId;
      const commContact = zohoContactId
        ? await tx.commContact.findFirst({ where: { zohoContactId }, select: { id: true } })
        : null;
      const contactName = quote.customerName ?? order.customerName ?? 'Cliente';
      const folio = quote.estimateNumber ?? quote.zohoEstimateId;
      opportunity = await insertOpportunity(tx, ctx, {
        title: `Cotización ${folio} · ${contactName}`,
        contact: { commContactId: commContact?.id ?? null, zohoContactId, contactName },
        salespersonUserId: await defaultSalesperson(tx, [input.requestedByUserId, quote.createdByUserId, humanActorId(ctx)]),
        stage: stageOfKind(stages, 'open'),
        estimatedValue: toNumber(quote.total),
        currency: quote.currencyCode ?? 'MXN',
        probability: null,
        expectedCloseAt: null,
        nextActionAt: null,
        nextActionText: null,
        source: 'quote',
        conversationIds: [],
        voiceCallIds: [],
        zohoEstimateIds: [quote.zohoEstimateId],
        lastInboundAt: null,
        lastOutboundAt: null,
        tags: [],
        origin: {
          kind: quoteStatusActivityKind(quote.status),
          summary: `Oportunidad creada desde la cotización ${folio}`,
          refType: ACTIVITY_REF_TYPES.quote,
          refId: quote.id,
          userId: actorUserId,
        },
      });
      created = true;
    }

    if (opportunity.zohoSalesOrderIds.includes(order.zohoSalesOrderId)) {
      return {
        data: { linked: true, opportunityId: opportunity.id, number: opportunity.number, created, alreadyLinked: true, won: opportunity.status === 'won' },
      };
    }
    const cases = await tx.operationalCase.findMany({
      where: { zohoSalesOrderId: order.zohoSalesOrderId },
      select: { id: true },
    });
    await tx.opportunity.update({
      where: { id: opportunity.id },
      data: {
        zohoSalesOrderIds: mergeIds(opportunity.zohoSalesOrderIds, [order.zohoSalesOrderId]),
        caseIds: mergeIds(opportunity.caseIds, cases.map((row) => row.id)),
        ...(quote ? { zohoEstimateIds: mergeIds(opportunity.zohoEstimateIds, [quote.zohoEstimateId]) } : {}),
        lastActivityAt: ctx.now,
      },
    });
    const total = toNumber(order.total);
    await addActivity(tx, ctx, {
      opportunityId: opportunity.id,
      kind: 'order_created',
      summary: `Orden de venta ${order.salesOrderNumber ?? order.zohoSalesOrderId} creada${total !== null ? ` por ${formatMoney(total, order.currencyCode)}` : ''}`,
      refType: ACTIVITY_REF_TYPES.salesOrder,
      refId: order.id,
      payload: { zohoSalesOrderId: order.zohoSalesOrderId, requestKey: input.requestKey ?? null, quoteId: quote?.id ?? null },
      userId: actorUserId,
    });
    await ctx.relate({ type: OPP, id: opportunity.id }, { type: ACTIVITY_REF_TYPES.salesOrder, id: order.id }, 'resulted_in');

    let won = opportunity.status === 'won';
    if (input.markWon && (opportunity.status === 'open' || opportunity.status === 'dormant')) {
      const wonStage = firstActiveStageOfKind(stages, 'won');
      if (wonStage) {
        const fresh = await loadOpportunity(tx, opportunity.id);
        await applyStageMove(tx, ctx, fresh, stages, wonStage, {
          reason: 'sales_order_created',
          refType: ACTIVITY_REF_TYPES.salesOrder,
          refId: order.id,
        });
        won = true;
      }
    }
    ctx.emit(
      CRM_EVENTS.salesOrderLinked,
      {
        opportunityId: opportunity.id,
        number: opportunity.number,
        salesOrderId: order.id,
        zohoSalesOrderId: order.zohoSalesOrderId,
        salesOrderNumber: order.salesOrderNumber,
        created,
        won,
      },
      eventOptions(opportunity.id)
    );
    return { data: { linked: true, opportunityId: opportunity.id, number: opportunity.number, created, alreadyLinked: false, won } };
  },
});

registerCommand<z.output<typeof linkCaseSchema>, { linked: boolean }>(CRM_COMMANDS.opportunityLinkCase, {
  schema: linkCaseSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    const opportunity = await loadOpportunity(tx, input.opportunityId);
    if (opportunity.caseIds.includes(input.caseId)) return { data: { linked: false } };
    const opCase = await tx.operationalCase.findUnique({
      where: { id: input.caseId },
      select: { id: true, caseNumber: true, salesOrderNumber: true },
    });
    if (!opCase) throw new OperationsError('not_found', 'No se encontró el expediente');
    await tx.opportunity.update({
      where: { id: opportunity.id },
      data: { caseIds: mergeIds(opportunity.caseIds, [opCase.id]) },
    });
    await addActivity(tx, ctx, {
      opportunityId: opportunity.id,
      kind: 'note',
      summary: `Expediente ${opCase.caseNumber} abierto${opCase.salesOrderNumber ? ` para la orden ${opCase.salesOrderNumber}` : ''}`,
      refType: ACTIVITY_REF_TYPES.case,
      refId: opCase.id,
    });
    ctx.emit(
      CRM_EVENTS.caseLinked,
      { opportunityId: opportunity.id, number: opportunity.number, caseId: opCase.id, caseNumber: opCase.caseNumber },
      { ...eventOptions(opportunity.id), caseId: opCase.id }
    );
    return { data: { linked: true } };
  },
});

// ---------------------------------------------------------------------------
// Activities, touches and quote changes
// ---------------------------------------------------------------------------

registerCommand<z.output<typeof recordActivitySchema>, RecordActivityData>(CRM_COMMANDS.opportunityRecordActivity, {
  schema: recordActivitySchema,
  permission: 'crm.manage',
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    await assertCrmEnabled();
    const opportunity = await loadOpportunity(tx, input.opportunityId);
    const at = input.at ? new Date(input.at) : ctx.now;
    if (at.getTime() > ctx.now.getTime() + 5 * 60_000) {
      throw new OperationsError('invalid_payload', 'La actividad no puede registrarse en el futuro');
    }
    if (input.resolvesActivityId) {
      const objection = await tx.opportunityActivity.findFirst({
        where: { id: input.resolvesActivityId, opportunityId: opportunity.id, kind: 'objection' },
        select: { id: true },
      });
      if (!objection) throw new OperationsError('not_found', 'No se encontró la objeción de esta oportunidad');
    }
    const row = await addActivity(tx, ctx, {
      opportunityId: opportunity.id,
      kind: input.kind,
      summary: input.summary,
      refType: input.resolvesActivityId ? ACTIVITY_REF_TYPES.activity : null,
      refId: input.resolvesActivityId ?? null,
      at,
    });
    await tx.opportunity.updateMany({
      where: { id: opportunity.id, lastActivityAt: { lt: at } },
      data: { lastActivityAt: at },
    });
    if (input.kind === 'task' && (input.nextActionAt || input.nextActionText)) {
      await tx.opportunity.update({
        where: { id: opportunity.id },
        data: {
          ...(input.nextActionAt ? { nextActionAt: new Date(input.nextActionAt) } : {}),
          nextActionText: input.nextActionText ?? input.summary.slice(0, 240),
        },
      });
    }
    ctx.emit(
      CRM_EVENTS.activityRecorded,
      { opportunityId: opportunity.id, number: opportunity.number, activityId: row.id, kind: input.kind },
      eventOptions(opportunity.id)
    );
    return { data: { opportunityId: opportunity.id, activityId: row.id } };
  },
});

registerCommand<z.output<typeof touchSchema>, TouchData>(CRM_COMMANDS.conversationTouch, {
  schema: touchSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    const message = await tx.commMessage.findUnique({
      where: { id: input.messageId },
      select: {
        id: true,
        conversationId: true,
        direction: true,
        status: true,
        body: true,
        mediaObjectIds: true,
        sentByUserId: true,
        createdAt: true,
        conversation: { select: { accountId: true } },
      },
    });
    if (!message) return { data: { touched: false, reason: 'message_not_found' } };
    const opportunity = await tx.opportunity.findUnique({ where: { id: input.opportunityId } });
    if (!opportunity) return { data: { touched: false, reason: 'opportunity_not_found' } };
    const duplicate = await tx.opportunityActivity.findFirst({
      where: { opportunityId: opportunity.id, refType: ACTIVITY_REF_TYPES.message, refId: message.id },
      select: { id: true },
    });
    if (duplicate) return { data: { touched: false, reason: 'duplicate' } };
    const plan = planConversationTouch(opportunity, message, message.conversationId);
    if (plan.skip) return { data: { touched: false, reason: plan.skip } };

    await addActivity(tx, ctx, {
      opportunityId: opportunity.id,
      kind: plan.activityKind,
      summary: messageActivitySummary(message.direction, message.body, message.mediaObjectIds.length),
      refType: ACTIVITY_REF_TYPES.message,
      refId: message.id,
      // The account lets the timeline hide the text from people without access to that inbox account.
      payload: { conversationId: message.conversationId, accountId: message.conversation.accountId, status: message.status },
      userId: message.direction === 'outbound' ? message.sentByUserId : null,
      at: message.createdAt,
    });
    // Conditional writes: concurrent touches never move the timestamps backwards.
    await tx.opportunity.updateMany({
      where: { id: opportunity.id, lastActivityAt: { lt: message.createdAt } },
      data: { lastActivityAt: message.createdAt },
    });
    if (plan.activityKind === 'message_in') {
      await tx.opportunity.updateMany({
        where: { id: opportunity.id, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: message.createdAt } }] },
        data: { lastInboundAt: message.createdAt },
      });
    } else {
      await tx.opportunity.updateMany({
        where: { id: opportunity.id, OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: message.createdAt } }] },
        data: { lastOutboundAt: message.createdAt },
      });
    }
    if (plan.data.conversationIds) {
      await tx.opportunity.update({ where: { id: opportunity.id }, data: { conversationIds: plan.data.conversationIds } });
    }
    let reactivated = false;
    if (plan.reactivate) {
      const woke = await tx.opportunity.updateMany({
        where: { id: opportunity.id, status: 'dormant' },
        data: { status: 'open' },
      });
      reactivated = woke.count === 1;
      if (reactivated) {
        await addActivity(tx, ctx, {
          opportunityId: opportunity.id,
          kind: 'note',
          summary: 'La oportunidad se reactivó porque el cliente volvió a escribir',
          refType: ACTIVITY_REF_TYPES.message,
          refId: message.id,
          userId: null,
        });
        ctx.emit(
          CRM_EVENTS.opportunityReactivated,
          { opportunityId: opportunity.id, number: opportunity.number, messageId: message.id },
          eventOptions(opportunity.id)
        );
      }
    }
    return { data: { touched: true, activityKind: plan.activityKind, reactivated } };
  },
});

interface QuoteChangeFields {
  fields?: Record<string, { before?: unknown; after?: unknown }>;
  items?: unknown;
}

registerCommand<z.output<typeof quoteChangedSchema>, { recorded: boolean; reason?: string }>(CRM_COMMANDS.quoteChanged, {
  schema: quoteChangedSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    const event = await tx.entityChangeEvent.findUnique({ where: { id: input.changeEventId } });
    if (!event || event.entityType !== QUOTE_ENTITY_TYPE) return { data: { recorded: false, reason: 'event_not_found' } };
    const opportunity = await tx.opportunity.findUnique({ where: { id: input.opportunityId } });
    if (!opportunity) return { data: { recorded: false, reason: 'opportunity_not_found' } };
    const duplicate = await tx.opportunityActivity.findFirst({
      where: { opportunityId: opportunity.id, refType: ACTIVITY_REF_TYPES.changeEvent, refId: event.id },
      select: { id: true },
    });
    if (duplicate) return { data: { recorded: false, reason: 'duplicate' } };
    const quote = await tx.quote.findUnique({
      where: { id: event.entityId },
      select: { id: true, zohoEstimateId: true, estimateNumber: true, currencyCode: true },
    });
    if (!quote || !opportunity.zohoEstimateIds.includes(quote.zohoEstimateId)) {
      return { data: { recorded: false, reason: 'not_linked' } };
    }
    const changes = (event.changes ?? {}) as QuoteChangeFields;
    const fields = changes.fields ?? {};
    const folio = quote.estimateNumber ?? quote.zohoEstimateId;
    const parts: string[] = [];
    let kind: ActivityKind = 'note';
    const statusChange = fields.status;
    if (statusChange) {
      const after = typeof statusChange.after === 'string' ? statusChange.after : null;
      kind = quoteStatusActivityKind(after);
      parts.push(`pasó a «${getQuoteStatusLabel(after)}»`);
    }
    const totalChange = fields.total;
    const beforeTotal = toNumber(totalChange?.before ?? null);
    const afterTotal = toNumber(totalChange?.after ?? null);
    if (totalChange) {
      parts.push(`total ${formatMoney(beforeTotal, quote.currencyCode)} → ${formatMoney(afterTotal, quote.currencyCode)}`);
    }
    const otherCount = Object.keys(fields).filter((field) => field !== 'status' && field !== 'total').length + (changes.items ? 1 : 0);
    if (parts.length === 0) parts.push(`se actualizó en Zoho (${otherCount} ${otherCount === 1 ? 'cambio' : 'cambios'})`);
    await addActivity(tx, ctx, {
      opportunityId: opportunity.id,
      kind,
      summary: `Cotización ${folio} ${parts.join('; ')}`,
      refType: ACTIVITY_REF_TYPES.changeEvent,
      refId: event.id,
      payload: { quoteId: quote.id, fields: Object.keys(fields) },
      userId: null,
      at: event.createdAt,
    });
    // The estimated value follows the quote while nobody changed it by hand.
    if (totalChange && afterTotal !== null && beforeTotal !== null && toNumber(opportunity.estimatedValue) === beforeTotal) {
      await tx.opportunity.update({ where: { id: opportunity.id }, data: { estimatedValue: toDecimal(afterTotal) } });
    }
    await tx.opportunity.updateMany({
      where: { id: opportunity.id, lastActivityAt: { lt: event.createdAt } },
      data: { lastActivityAt: event.createdAt },
    });
    if (kind !== 'note') {
      ctx.emit(
        CRM_EVENTS.activityRecorded,
        { opportunityId: opportunity.id, number: opportunity.number, kind, quoteId: quote.id },
        eventOptions(opportunity.id)
      );
    }
    return { data: { recorded: true } };
  },
});

// ---------------------------------------------------------------------------
// Service signatures (routes, server actions, tools)
// ---------------------------------------------------------------------------

export const createOpportunity = (actor: CurrentUser, input: CreateOpportunityInput, options?: CrmCommandOptions) =>
  runCrmCommand<CreateOpportunityData>(actor, CRM_COMMANDS.opportunityCreate, { type: OPP, id: 'opportunity:new' }, input, options);

/** Opportunity from a voice call (contact of the call, salesperson = who took it). */
export const createOpportunityFromCall = (
  actor: CurrentUser,
  input: Omit<CreateOpportunityInput, 'voiceCallId' | 'source'> & { voiceCallId: string },
  options?: CrmCommandOptions
) => createOpportunity(actor, { ...input, source: 'call' }, options);

export const createOpportunityFromConversation = (
  actor: CurrentUser,
  input: CreateOpportunityFromConversationInput,
  options?: CrmCommandOptions
) =>
  runCrmCommand<CreateOpportunityData>(
    actor,
    CRM_COMMANDS.opportunityCreateFromConversation,
    { type: OPP, id: `opportunity:conversation:${input.conversationId}` },
    input,
    options
  );

export const updateOpportunity = (actor: CurrentUser, input: UpdateOpportunityInput, options?: CrmCommandOptions) =>
  runCrmCommand<UpdateOpportunityData>(actor, CRM_COMMANDS.opportunityUpdate, { type: OPP, id: input.opportunityId }, input, options);

export const moveStage = (actor: CurrentUser, input: MoveOpportunityStageInput, options?: CrmCommandOptions) =>
  runCrmCommand<StageMoveData>(actor, CRM_COMMANDS.opportunityMoveStage, { type: OPP, id: input.opportunityId }, input, options);

export const markWon = (actor: CurrentUser, input: z.input<typeof markWonSchema>, options?: CrmCommandOptions) =>
  runCrmCommand<StageMoveData>(actor, CRM_COMMANDS.opportunityMarkWon, { type: OPP, id: input.opportunityId }, input, options);

export const markLost = (actor: CurrentUser, input: z.input<typeof markLostSchema>, options?: CrmCommandOptions) =>
  runCrmCommand<StageMoveData>(actor, CRM_COMMANDS.opportunityMarkLost, { type: OPP, id: input.opportunityId }, input, options);

export const markDormant = (actor: CurrentUser, input: z.input<typeof markDormantSchema>, options?: CrmCommandOptions) =>
  runCrmCommand<StageMoveData>(actor, CRM_COMMANDS.opportunityMarkDormant, { type: OPP, id: input.opportunityId }, input, options);

export const linkQuote = (actor: CurrentUser, input: LinkQuoteInput, options?: CrmCommandOptions) =>
  runCrmCommand<LinkQuoteData>(actor, CRM_COMMANDS.opportunityLinkQuote, { type: OPP, id: input.opportunityId }, input, options);

export const linkSalesOrder = (actor: CurrentUser, input: LinkSalesOrderInput, options?: CrmCommandOptions) =>
  runCrmCommand<LinkSalesOrderData>(
    actor,
    CRM_COMMANDS.opportunityLinkSalesOrder,
    { type: OPP, id: `opportunity:sales_order:${input.salesOrderId}` },
    input,
    options
  );

/** For the sales order writer: links the order (creating the opportunity from the quote if needed) as the CRM system actor. */
export const linkSalesOrderAsSystem = (input: LinkSalesOrderInput, commandId: string, options: { now?: Date } = {}) =>
  runCrmSystemCommand<LinkSalesOrderData>(
    CRM_COMMANDS.opportunityLinkSalesOrder,
    { type: OPP, id: `opportunity:sales_order:${input.salesOrderId}` },
    input,
    commandId,
    options
  );

export const recordActivity = (actor: CurrentUser, input: RecordActivityInput, options?: CrmCommandOptions) =>
  runCrmCommand<RecordActivityData>(
    actor,
    CRM_COMMANDS.opportunityRecordActivity,
    { type: OPP, id: `activity:${input.opportunityId}` },
    input,
    options
  );

export interface TouchConversationResult {
  messageId: string;
  status: 'touched' | 'skipped';
  reason?: string;
  opportunities: Array<{ opportunityId: string; status: 'touched' | 'skipped'; reason?: string }>;
}

/**
 * Fan-out of a stored message (inbound or outbound) to the live opportunities of
 * its conversation or contact: timeline activity, `lastInboundAt` /
 * `lastOutboundAt`, conversation link and wake-up of dormant opportunities.
 * Idempotent per message (system command id `crm:touch:{messageId}:{opportunityId}`
 * plus deduplication by reference). Called by `comms.message_fanout`.
 */
export async function touchConversation(messageId: string, options: { now?: Date } = {}): Promise<TouchConversationResult> {
  if (!(await isOpsFlagEnabled('crm'))) return { messageId, status: 'skipped', reason: 'disabled', opportunities: [] };
  const message = await prisma.commMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      conversationId: true,
      direction: true,
      status: true,
      conversation: { select: { contactId: true, tags: true, contact: { select: { zohoContactId: true } } } },
    },
  });
  if (!message) return { messageId, status: 'skipped', reason: 'message_not_found', opportunities: [] };
  const supplier = await supplierConversationIds(prisma, [
    {
      id: message.conversationId,
      tags: message.conversation.tags,
      contactId: message.conversation.contactId,
      zohoContactId: message.conversation.contact.zohoContactId,
    },
  ]);
  if (supplier.has(message.conversationId)) {
    return { messageId, status: 'skipped', reason: 'supplier_conversation', opportunities: [] };
  }
  if (message.direction === 'outbound' && FAILED_OUTBOUND_STATUSES.includes(message.status)) {
    return { messageId, status: 'skipped', reason: 'failed_outbound', opportunities: [] };
  }
  const opportunities = await prisma.opportunity.findMany({
    where: {
      status: { in: LIVE_STATUSES },
      OR: [{ conversationIds: { has: message.conversationId } }, { commContactId: message.conversation.contactId }],
    },
    orderBy: { lastActivityAt: 'desc' },
    select: { id: true },
    take: 20,
  });
  if (opportunities.length === 0) return { messageId, status: 'skipped', reason: 'no_opportunity', opportunities: [] };
  const results: TouchConversationResult['opportunities'] = [];
  for (const opportunity of opportunities) {
    const result = await runCrmSystemCommand<TouchData>(
      CRM_COMMANDS.conversationTouch,
      { type: OPP, id: `touch:${opportunity.id}` },
      { messageId, opportunityId: opportunity.id },
      `crm:touch:${messageId}:${opportunity.id}`,
      options
    );
    if (result.status === 'completed' && result.data?.touched) {
      results.push({ opportunityId: opportunity.id, status: 'touched' });
    } else {
      results.push({
        opportunityId: opportunity.id,
        status: 'skipped',
        reason: result.data?.reason ?? result.errorCode ?? result.status,
      });
    }
  }
  return {
    messageId,
    status: results.some((row) => row.status === 'touched') ? 'touched' : 'skipped',
    opportunities: results,
  };
}

export interface QuoteChangesResult {
  events: number;
  recorded: number;
  skipped: number;
}

async function applyQuoteChangeEvents(
  events: Array<{ id: string; entityId: string }>,
  options: { now?: Date }
): Promise<QuoteChangesResult> {
  const result: QuoteChangesResult = { events: events.length, recorded: 0, skipped: 0 };
  if (events.length === 0) return result;
  const quotes = await prisma.quote.findMany({
    where: { id: { in: [...new Set(events.map((event) => event.entityId))] } },
    select: { id: true, zohoEstimateId: true },
  });
  const estimateByQuote = new Map(quotes.map((quote) => [quote.id, quote.zohoEstimateId]));
  const estimateIds = [...new Set(quotes.map((quote) => quote.zohoEstimateId))];
  if (estimateIds.length === 0) return result;
  const opportunities = await prisma.opportunity.findMany({
    where: { zohoEstimateIds: { hasSome: estimateIds } },
    select: { id: true, zohoEstimateIds: true },
  });
  if (opportunities.length === 0) return result;
  const done = await prisma.opportunityActivity.findMany({
    where: { refType: ACTIVITY_REF_TYPES.changeEvent, refId: { in: events.map((event) => event.id) } },
    select: { opportunityId: true, refId: true },
  });
  const doneKeys = new Set(done.map((row) => `${row.opportunityId}|${row.refId}`));
  for (const event of events) {
    const estimateId = estimateByQuote.get(event.entityId);
    if (!estimateId) continue;
    for (const opportunity of opportunities) {
      if (!opportunity.zohoEstimateIds.includes(estimateId) || doneKeys.has(`${opportunity.id}|${event.id}`)) continue;
      const outcome = await runCrmSystemCommand<{ recorded: boolean }>(
        CRM_COMMANDS.quoteChanged,
        { type: OPP, id: `quote_change:${opportunity.id}` },
        { changeEventId: event.id, opportunityId: opportunity.id },
        `crm:quote_changed:${event.id}:${opportunity.id}`,
        options
      );
      if (outcome.status === 'completed' && outcome.data?.recorded) result.recorded++;
      else result.skipped++;
    }
  }
  return result;
}

/** One quote change event (job `crm.quote_changed` with `changeEventId`). */
export async function processQuoteChangeEvent(changeEventId: string, options: { now?: Date } = {}): Promise<QuoteChangesResult> {
  const event = await prisma.entityChangeEvent.findUnique({
    where: { id: changeEventId },
    select: { id: true, entityId: true, entityType: true },
  });
  if (!event || event.entityType !== QUOTE_ENTITY_TYPE) return { events: 0, recorded: 0, skipped: 0 };
  return applyQuoteChangeEvents([event], options);
}

export const QUOTE_CHANGES_WINDOW_HOURS = 48;
const QUOTE_CHANGES_BATCH = 500;

/**
 * Sweep of the quote change events recorded by the existing quote normalizer
 * (`EntityChangeEvent`, sync from Zoho or writes from UNIK) in the last 48 hours:
 * events of quotes linked to opportunities become timeline activities. No cursor
 * is needed: already recorded events are skipped by reference and the commands
 * are idempotent, so a worker outage shorter than the window loses nothing.
 */
export async function processRecentQuoteChanges(options: { now?: Date } = {}): Promise<QuoteChangesResult> {
  if (!(await isOpsFlagEnabled('crm'))) return { events: 0, recorded: 0, skipped: 0 };
  const now = options.now ?? new Date();
  const events = await prisma.entityChangeEvent.findMany({
    where: {
      entityType: QUOTE_ENTITY_TYPE,
      createdAt: { gte: new Date(now.getTime() - QUOTE_CHANGES_WINDOW_HOURS * 3_600_000) },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, entityId: true },
    take: QUOTE_CHANGES_BATCH,
  });
  return applyQuoteChangeEvents(events, options);
}

/**
 * Re-links every case of a sales order to its opportunities (job
 * `crm.link_cases`, enqueued after an order is created from a quote): closes
 * the window where `case.start` committed while the order link was not
 * committed yet, so neither side saw the other. Idempotent.
 */
export async function relinkCasesOfSalesOrder(zohoSalesOrderId: string): Promise<number> {
  const cases = await prisma.operationalCase.findMany({ where: { zohoSalesOrderId }, select: { id: true }, take: 20 });
  let linked = 0;
  for (const opCase of cases) linked += await linkCaseToOpportunities({ caseId: opCase.id, zohoSalesOrderId });
  return linked;
}

/** A new case of a sales order is linked to the opportunities that produced the order. */
export async function linkCaseToOpportunities(input: { caseId: string; zohoSalesOrderId: string | null }): Promise<number> {
  if (!input.zohoSalesOrderId) return 0;
  const opportunities = await prisma.opportunity.findMany({
    where: { zohoSalesOrderIds: { has: input.zohoSalesOrderId } },
    select: { id: true },
  });
  let linked = 0;
  for (const opportunity of opportunities) {
    const result = await runCrmSystemCommand<{ linked: boolean }>(
      CRM_COMMANDS.opportunityLinkCase,
      { type: OPP, id: `case:${opportunity.id}` },
      { opportunityId: opportunity.id, caseId: input.caseId },
      `crm:link_case:${input.caseId}:${opportunity.id}`
    );
    if (result.status === 'completed' && result.data?.linked) linked++;
  }
  return linked;
}
