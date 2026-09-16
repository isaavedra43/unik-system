import { Prisma, type Opportunity, type RadarSignal } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { checkAgentBudget, recordAgentUsage } from '@/modules/agents/budget';
import { agentKeyForArea } from '@/modules/agents/identity-catalog';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { chatCompletion } from '@/modules/ai/ai-client';
import { modelForTask } from '@/modules/ai/model-policy';
import { radarLink } from '@/modules/areas/area-links';
import { isNotificationCategory, type NotificationCategory } from '@/modules/notifications/catalog';
import { notifyUser } from '@/modules/notifications/notification-service';
import {
  OperationsError,
  registerCommand,
  type CommandContext,
} from '@/modules/operations/commands';
import { toOperationalJson } from '@/modules/operations/events-service';
import { isOpsFlagEnabled } from '@/modules/operations/operations-config';
import { publishRealtime, REALTIME_CHANNELS } from '@/modules/realtime/realtime-service';
import { toRadarSignalDTO, type RadarSignalDTO } from './crm-dto';
import {
  assertAggregateTarget,
  assertCrmPermission,
  commandUserId,
  CrmError,
  isSignalVisibleTo,
  radarSignalAggregate,
  runCrmCommand,
  runCrmSystemCommand,
  unwrapCrmResult,
  visibleSignalsWhere,
  type CrmCommandOptions,
} from './crm-helpers';
import { FAILED_OUTBOUND_STATUSES, toNumber, truncateText } from './opportunity-rules';
import { effectiveProbability } from './pipeline-rules';
import { loadPipelineStages } from './pipeline-service';
import { supplierConversationIds } from './supplier-conversations';
import {
  buildExplanationMessages,
  EXPLANATION_MAX_TOKENS,
  parseExplanation,
  type ExplanationContext,
} from './radar-explain';
import {
  DELIVERY_INCIDENT_SEVERITIES,
  evaluateRadar,
  localDateKey,
  signalKey,
  topSignalsPerSalesperson,
  type ConversationFacts,
  type CustomerOrderFacts,
  type DeliveryIncidentFacts,
  type OpportunityFacts,
  type QuoteFacts,
  type RadarFacts,
  type RadarOpportunityRef,
  type RadarSignalDraft,
  type RadarStageRef,
} from './radar-rules';
import {
  ACTIVITY_REF_TYPES,
  CRM_AREA_KEY,
  CRM_COMMANDS,
  CRM_EVENTS,
  CRM_OBJECT_TYPES,
  CRM_RADAR_CHANNEL,
  RADAR_KIND_LABELS,
  isRadarKind,
} from './types';

/**
 * Commercial radar (plan 6.5).
 *
 * - `refreshRadar()` (job `crm.radar_refresh`, every 15 minutes) loads bounded
 *   facts in batch (live opportunities, recent conversations with message
 *   statistics, quotes expiring soon, 2 years of orders per customer, high and
 *   critical incidents), runs the pure rules and reconciles `RadarSignal`: new
 *   subjects are created, resolved ones reactivated, live ones refreshed
 *   (snoozed ones wake up when their time passes, dismissed ones stay dismissed
 *   while the condition lasts) and signals whose condition disappeared are
 *   resolved. The radar is a projection: it writes directly, like a dashboard
 *   snapshot; user decisions on a signal are commands.
 * - Commands (`crm.radar`): snooze, dismiss, convert to a work item of Ventas
 *   (the signal is snoozed until the task is due) and store the AI explanation. A person sees their own and unassigned
 *   signals; `crm.manage` and the AI identities see every salesperson's.
 * - `explainSignal` (on demand) and `explainTopSignals` (job `crm.radar_explain`,
 *   daily, 5 best per salesperson) make one `utility` model call per signal,
 *   outside any transaction, charged to the Ventas AI identity budget.
 */

const DAY_MS = 24 * 3_600_000;
const CONVERSATION_LOOKBACK_MS = 30 * DAY_MS;
const ORDER_LOOKBACK_MS = 730 * DAY_MS;
const MAX_CONVERSATIONS = 2000;
const MAX_OPPORTUNITIES = 5000;
const MAX_QUOTES = 2000;
const MAX_ORDERS = 50_000;
const MAX_INCIDENTS = 500;
const EXCLUDED_ORDER_STATUSES = ['void', 'draft', 'cancelled'];
const LIVE_SIGNAL_STATUSES = ['active', 'snoozed', 'dismissed'];
const ACTIONABLE_SIGNAL_STATUSES = ['active', 'snoozed'];
const EXPLANATION_FRESH_MS = 12 * 3_600_000;
const DAILY_EXPLANATION_STALE_MS = 20 * 3_600_000;
const SNOOZE_MIN_MS = 5 * 60_000;
const SNOOZE_MAX_MS = 30 * DAY_MS;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'crm-radar', event, ...extra }));

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

// The rules live in crm-helpers so the CRM queries do not load the AI stack.
export { isSignalVisibleTo, visibleSignalsWhere };

function assertVisibleInCommand(ctx: CommandContext, signal: RadarSignal): void {
  if (ctx.user && !isSignalVisibleTo(ctx.user, signal)) {
    throw new OperationsError('forbidden', 'Esta señal pertenece a otro vendedor');
  }
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

function firstBy<T>(
  rows: readonly T[],
  keys: (row: T) => ReadonlyArray<string | null | undefined>
): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    for (const key of keys(row)) {
      if (key && !map.has(key)) map.set(key, row);
    }
  }
  return map;
}

/** Bounded batch load of every fact the rules need. */
export async function loadRadarFacts(now: Date): Promise<RadarFacts> {
  const stages = await loadPipelineStages();
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const stageRef = (stageId: string): RadarStageRef | null => {
    const stage = stageById.get(stageId);
    return stage ? { key: stage.key, kind: stage.kind, name: stage.name } : null;
  };
  const refOf = (row: Opportunity): RadarOpportunityRef => ({
    id: row.id,
    number: row.number,
    salespersonUserId: row.salespersonUserId,
    stage: stageRef(row.stageId),
    estimatedValue: toNumber(row.estimatedValue),
  });

  const liveOpportunities = await prisma.opportunity.findMany({
    where: { status: { in: ['open', 'dormant'] } },
    orderBy: [{ lastActivityAt: 'desc' }, { id: 'asc' }],
    take: MAX_OPPORTUNITIES,
  });
  const byConversation = firstBy(liveOpportunities, (row) => row.conversationIds);
  const byCommContact = firstBy(liveOpportunities, (row) => [row.commContactId]);
  const byZohoContact = firstBy(liveOpportunities, (row) => [row.zohoContactId]);
  const openOpportunities = liveOpportunities.filter((row) => row.status === 'open');

  // Opportunities: objections, next actions and intent.
  const objectionRows = openOpportunities.length
    ? await prisma.opportunityActivity.findMany({
        where: {
          opportunityId: { in: openOpportunities.map((row) => row.id) },
          kind: { in: ['objection', 'objection_resolved'] },
        },
        select: {
          id: true,
          opportunityId: true,
          kind: true,
          refType: true,
          refId: true,
          at: true,
          summary: true,
        },
      })
    : [];
  const objectionsByOpportunity = new Map<string, typeof objectionRows>();
  for (const row of objectionRows) {
    objectionsByOpportunity.set(row.opportunityId, [
      ...(objectionsByOpportunity.get(row.opportunityId) ?? []),
      row,
    ]);
  }
  const opportunities: OpportunityFacts[] = openOpportunities.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    contactName: row.contactName,
    salespersonUserId: row.salespersonUserId,
    zohoContactId: row.zohoContactId,
    commContactId: row.commContactId,
    conversationId:
      row.conversationIds.length > 0 ? row.conversationIds[row.conversationIds.length - 1] : null,
    status: row.status,
    stage: stageRef(row.stageId),
    probability: effectiveProbability(
      row.probability,
      stageById.get(row.stageId)?.probabilityDefault ?? null
    ),
    estimatedValue: toNumber(row.estimatedValue),
    currencyCode: row.currency,
    nextActionAt: row.nextActionAt,
    nextActionText: row.nextActionText,
    lastInboundAt: row.lastInboundAt,
    hasQuote: row.zohoEstimateIds.length > 0,
    objectionActivities: objectionsByOpportunity.get(row.id) ?? [],
  }));

  // Conversations with recent customer messages (suppliers and RFQs excluded below).
  const recentConversations = await prisma.commConversation.findMany({
    where: {
      status: { not: 'resolved' },
      lastInboundAt: { gte: new Date(now.getTime() - CONVERSATION_LOOKBACK_MS) },
    },
    select: {
      id: true,
      status: true,
      snoozedUntil: true,
      assignedToUserId: true,
      contactId: true,
      tags: true,
      contact: { select: { displayName: true, zohoContactId: true } },
    },
    orderBy: { lastInboundAt: 'desc' },
    take: MAX_CONVERSATIONS,
  });
  const supplierIds = await supplierConversationIds(
    prisma,
    recentConversations.map((row) => ({
      id: row.id,
      tags: row.tags,
      contactId: row.contactId,
      zohoContactId: row.contact.zohoContactId,
    }))
  );
  const conversationRows = recentConversations.filter((row) => !supplierIds.has(row.id));
  const messageStats = conversationRows.length
    ? await prisma.commMessage.groupBy({
        by: ['conversationId', 'direction'],
        where: {
          conversationId: { in: conversationRows.map((row) => row.id) },
          NOT: { direction: 'outbound', status: { in: [...FAILED_OUTBOUND_STATUSES] } },
        },
        _min: { createdAt: true },
        _max: { createdAt: true },
      })
    : [];
  const firstInbound = new Map<string, Date>();
  const lastInbound = new Map<string, Date>();
  const lastOutbound = new Map<string, Date>();
  for (const stat of messageStats) {
    if (stat.direction === 'inbound') {
      if (stat._min.createdAt) firstInbound.set(stat.conversationId, stat._min.createdAt);
      if (stat._max.createdAt) lastInbound.set(stat.conversationId, stat._max.createdAt);
    } else if (stat.direction === 'outbound' && stat._max.createdAt) {
      lastOutbound.set(stat.conversationId, stat._max.createdAt);
    }
  }
  const conversations: ConversationFacts[] = conversationRows.map((row) => {
    const opportunity = byConversation.get(row.id) ?? byCommContact.get(row.contactId) ?? null;
    return {
      conversationId: row.id,
      commContactId: row.contactId,
      zohoContactId: row.contact.zohoContactId,
      customerName: row.contact.displayName,
      assignedToUserId: row.assignedToUserId,
      status: row.status,
      snoozedUntil: row.snoozedUntil,
      firstInboundAt: firstInbound.get(row.id) ?? null,
      lastInboundAt: lastInbound.get(row.id) ?? null,
      lastOutboundAt: lastOutbound.get(row.id) ?? null,
      opportunity: opportunity ? refOf(opportunity) : null,
    };
  });

  // Quotes that expire around today.
  const todayStart = Date.parse(`${localDateKey(now)}T00:00:00Z`);
  const quoteRows = await prisma.quote.findMany({
    where: {
      status: { in: ['sent', 'viewed'] },
      expiryDate: { gte: new Date(todayStart - DAY_MS), lte: new Date(todayStart + 4 * DAY_MS) },
    },
    select: {
      id: true,
      zohoEstimateId: true,
      estimateNumber: true,
      status: true,
      expiryDate: true,
      isViewedByClient: true,
      total: true,
      currencyCode: true,
      customerName: true,
      zohoCustomerId: true,
      createdByUserId: true,
    },
    take: MAX_QUOTES,
  });
  const quoteOpportunities = quoteRows.length
    ? await prisma.opportunity.findMany({
        where: { zohoEstimateIds: { hasSome: quoteRows.map((row) => row.zohoEstimateId) } },
        orderBy: { lastActivityAt: 'desc' },
      })
    : [];
  const byEstimate = firstBy(quoteOpportunities, (row) => row.zohoEstimateIds);
  const quotes: QuoteFacts[] = quoteRows.map((row) => {
    const opportunity = byEstimate.get(row.zohoEstimateId) ?? null;
    return {
      quoteId: row.id,
      zohoEstimateId: row.zohoEstimateId,
      estimateNumber: row.estimateNumber,
      status: row.status,
      expiryDate: row.expiryDate,
      isViewedByClient: row.isViewedByClient,
      total: toNumber(row.total),
      currencyCode: row.currencyCode,
      customerName: row.customerName,
      zohoCustomerId: row.zohoCustomerId,
      ownerUserId: row.createdByUserId,
      opportunity: opportunity ? refOf(opportunity) : null,
    };
  });

  // Order history per customer (repurchase).
  const orderRows = await prisma.salesOrder.findMany({
    where: {
      zohoCustomerId: { not: null },
      orderDate: { gte: new Date(now.getTime() - ORDER_LOOKBACK_MS) },
      OR: [{ status: null }, { status: { notIn: EXCLUDED_ORDER_STATUSES } }],
    },
    select: { zohoCustomerId: true, customerName: true, orderDate: true, total: true },
    orderBy: { orderDate: 'asc' },
    take: MAX_ORDERS,
  });
  const ordersByCustomer = new Map<string, typeof orderRows>();
  for (const row of orderRows) {
    if (!row.zohoCustomerId || !row.orderDate) continue;
    ordersByCustomer.set(row.zohoCustomerId, [
      ...(ordersByCustomer.get(row.zohoCustomerId) ?? []),
      row,
    ]);
  }
  const customers: CustomerOrderFacts[] = [];
  for (const [zohoContactId, rows] of ordersByCustomer) {
    if (rows.length < 3) continue;
    const opportunity = byZohoContact.get(zohoContactId) ?? null;
    customers.push({
      zohoContactId,
      customerName: rows[rows.length - 1].customerName,
      orders: rows.map((row) => ({ orderDate: row.orderDate as Date, total: toNumber(row.total) })),
      salespersonUserId: opportunity?.salespersonUserId ?? null,
      commContactId: opportunity?.commContactId ?? null,
      opportunity: opportunity ? refOf(opportunity) : null,
    });
  }

  // High and critical incidents of the customers' cases.
  const incidentRows = await prisma.incident.findMany({
    where: {
      status: { in: ['open', 'acknowledged'] },
      severity: { in: [...DELIVERY_INCIDENT_SEVERITIES] },
      caseId: { not: null },
    },
    select: { id: true, severity: true, title: true, openedAt: true, caseId: true },
    orderBy: { openedAt: 'desc' },
    take: MAX_INCIDENTS,
  });
  const caseIds = [
    ...new Set(incidentRows.map((row) => row.caseId).filter((id): id is string => Boolean(id))),
  ];
  const caseRows = caseIds.length
    ? await prisma.operationalCase.findMany({
        where: { id: { in: caseIds } },
        select: {
          id: true,
          caseNumber: true,
          salesOrderNumber: true,
          zohoCustomerId: true,
          customerName: true,
          zohoSalesOrderId: true,
        },
      })
    : [];
  const caseById = new Map(caseRows.map((row) => [row.id, row]));
  const salesOrderIds = [
    ...new Set(
      caseRows.map((row) => row.zohoSalesOrderId).filter((id): id is string => Boolean(id))
    ),
  ];
  const caseOpportunities = salesOrderIds.length
    ? await prisma.opportunity.findMany({
        where: { zohoSalesOrderIds: { hasSome: salesOrderIds } },
        orderBy: { lastActivityAt: 'desc' },
      })
    : [];
  const bySalesOrder = firstBy(caseOpportunities, (row) => row.zohoSalesOrderIds);
  const incidents: DeliveryIncidentFacts[] = [];
  for (const row of incidentRows) {
    const opCase = row.caseId ? caseById.get(row.caseId) : undefined;
    if (!opCase) continue;
    const opportunity =
      (opCase.zohoSalesOrderId ? bySalesOrder.get(opCase.zohoSalesOrderId) : undefined) ??
      (opCase.zohoCustomerId ? byZohoContact.get(opCase.zohoCustomerId) : undefined) ??
      null;
    incidents.push({
      incidentId: row.id,
      severity: row.severity,
      title: row.title,
      openedAt: row.openedAt,
      caseId: opCase.id,
      caseNumber: opCase.caseNumber,
      salesOrderNumber: opCase.salesOrderNumber,
      zohoCustomerId: opCase.zohoCustomerId,
      customerName: opCase.customerName,
      salespersonUserId: opportunity?.salespersonUserId ?? null,
      opportunity: opportunity ? refOf(opportunity) : null,
    });
  }

  return { conversations, quotes, opportunities, customers, incidents };
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export interface RefreshRadarResult {
  evaluated: number;
  created: number;
  reactivated: number;
  updated: number;
  resolved: number;
  active: number;
  /** People told about a new high-scoring signal of theirs (plan 6.6). */
  notified: number;
  skipped?: 'disabled';
}

interface NewSignalSummary {
  count: number;
  topScore: number;
  /** Best of the new drafts of this salesperson (what the notification talks about). */
  top: RadarSignalDraft | null;
}

/**
 * Score from which a NEW signal is worth an interruption (plan 6.6: "señal del
 * radar de alto puntaje"). Below it the signal is still on the board and in the
 * realtime counter; it just does not ring.
 */
export const RADAR_NOTIFY_MIN_SCORE = 70;

/**
 * One notification per salesperson per refresh, about the best of their NEW
 * signals (`radar_signal`, push off by default in the catalogue). The dedupe key
 * carries the subject and the local day, so the same signal never rings twice
 * the same day even if it is resolved and reactivated.
 */
async function notifyNewSignals(
  newBySalesperson: Map<string, NewSignalSummary>,
  now: Date
): Promise<number> {
  const category: NotificationCategory = isNotificationCategory('radar_signal')
    ? 'radar_signal'
    : 'entity_change';
  const dayKey = localDateKey(now);
  let notified = 0;
  for (const [userId, summary] of newBySalesperson) {
    const top = summary.top;
    if (!top || top.score < RADAR_NOTIFY_MIN_SCORE) continue;
    const kindLabel = isRadarKind(top.kind) ? RADAR_KIND_LABELS[top.kind] : top.kind;
    const others = summary.count - 1;
    try {
      const outcome = await notifyUser({
        userId,
        category,
        type: 'crm_radar_signal',
        title: `${kindLabel}: ${top.customerName ?? 'cliente sin nombre'} (${top.score})`,
        body: truncateText(
          `${top.reason}${others > 0 ? ` · ${others} señal(es) nueva(s) más en tu radar` : ''}`,
          400
        ),
        url: radarLink(),
        entityType: CRM_OBJECT_TYPES.radarSignal,
        entityId: null,
        metadata: { kind: top.kind, score: top.score, newSignals: summary.count },
        dedupeKey: `crm_radar:${userId}:${top.kind}:${top.subjectKey}:${dayKey}`,
      });
      if (!outcome.suppressed) notified += 1;
    } catch (error) {
      // A radar refresh never fails because of a notification.
      log('notify_failed', {
        userId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return notified;
}

function draftColumns(draft: RadarSignalDraft) {
  return {
    opportunityId: draft.opportunityId,
    conversationId: draft.conversationId,
    quoteId: draft.quoteId,
    zohoContactId: draft.zohoContactId,
    commContactId: draft.commContactId,
    customerName: draft.customerName,
    salespersonUserId: draft.salespersonUserId,
    score: draft.score,
    reason: draft.reason,
    data: toOperationalJson(draft.data),
    expiresAt: draft.expiresAt,
  };
}

/** Keys a person wrote on a signal (snooze, dismiss, conversion): a refresh never erases them. */
const DECISION_DATA_KEYS = [
  'snoozedBy',
  'snoozeNote',
  'dismissedBy',
  'dismissReason',
  'workItemId',
  'convertedBy',
] as const;

function withDecisionData(
  existing: Prisma.JsonValue | null,
  draftData: Record<string, unknown>
): Prisma.InputJsonValue {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const kept = Object.fromEntries(
    DECISION_DATA_KEYS.filter((key) => key in base).map((key) => [key, base[key]])
  );
  return toOperationalJson({ ...draftData, ...kept });
}

function materiallyChanged(existing: RadarSignal, draft: RadarSignalDraft): boolean {
  return (
    existing.score !== draft.score ||
    existing.reason !== draft.reason ||
    existing.salespersonUserId !== draft.salespersonUserId ||
    existing.opportunityId !== draft.opportunityId ||
    existing.conversationId !== draft.conversationId ||
    existing.quoteId !== draft.quoteId
  );
}

/** Recomputes every signal (see module comment). */
export async function refreshRadar(options: { now?: Date } = {}): Promise<RefreshRadarResult> {
  const now = options.now ?? new Date();
  const result: RefreshRadarResult = {
    evaluated: 0,
    created: 0,
    reactivated: 0,
    updated: 0,
    resolved: 0,
    active: 0,
    notified: 0,
  };
  if (!(await isOpsFlagEnabled('crm'))) return { ...result, skipped: 'disabled' };

  const drafts = evaluateRadar(await loadRadarFacts(now), now);
  result.evaluated = drafts.length;
  const live = await prisma.radarSignal.findMany({
    where: { status: { in: LIVE_SIGNAL_STATUSES } },
  });
  const liveByKey = new Map(
    live.map((signal) => [signalKey(signal.kind, signal.subjectKey), signal])
  );
  const seen = new Set<string>();
  const newBySalesperson = new Map<string, NewSignalSummary>();

  for (const draft of drafts) {
    const key = signalKey(draft.kind, draft.subjectKey);
    seen.add(key);
    const existing = liveByKey.get(key);
    if (!existing) {
      // New subject, or one that had been resolved: (re)activate it without the old AI text.
      const row = await prisma.radarSignal.upsert({
        where: { kind_subjectKey: { kind: draft.kind, subjectKey: draft.subjectKey } },
        create: {
          kind: draft.kind,
          subjectKey: draft.subjectKey,
          ...draftColumns(draft),
          computedAt: now,
          status: 'active',
        },
        update: {
          ...draftColumns(draft),
          computedAt: now,
          status: 'active',
          snoozedUntil: null,
          aiExplanation: null,
          aiSuggestedMessage: null,
          aiGeneratedAt: null,
          version: { increment: 1 },
        },
      });
      if (row.version === 1) result.created++;
      else result.reactivated++;
      if (draft.salespersonUserId) {
        const current = newBySalesperson.get(draft.salespersonUserId) ?? {
          count: 0,
          topScore: 0,
          top: null,
        };
        newBySalesperson.set(draft.salespersonUserId, {
          count: current.count + 1,
          topScore: Math.max(current.topScore, draft.score),
          top: !current.top || draft.score > current.top.score ? draft : current.top,
        });
      }
      continue;
    }
    const wakes =
      existing.status === 'snoozed' &&
      (!existing.snoozedUntil || existing.snoozedUntil.getTime() <= now.getTime());
    const changed = wakes || materiallyChanged(existing, draft);
    await prisma.radarSignal.update({
      where: { id: existing.id },
      data: {
        ...draftColumns(draft),
        data: withDecisionData(existing.data, draft.data),
        computedAt: now,
        ...(wakes ? { status: 'active', snoozedUntil: null } : {}),
        ...(changed ? { version: { increment: 1 } } : {}),
      },
    });
    if (changed) result.updated++;
  }

  const stale = live.filter((signal) => !seen.has(signalKey(signal.kind, signal.subjectKey)));
  if (stale.length > 0) {
    const resolved = await prisma.radarSignal.updateMany({
      where: { id: { in: stale.map((signal) => signal.id) }, status: { in: LIVE_SIGNAL_STATUSES } },
      data: { status: 'resolved', version: { increment: 1 } },
    });
    result.resolved = resolved.count;
  }
  result.active = await prisma.radarSignal.count({
    where: { status: 'active', expiresAt: { gt: now } },
  });

  result.notified = await notifyNewSignals(newBySalesperson, now);

  try {
    await publishRealtime(CRM_RADAR_CHANNEL, 'radar_refreshed', {
      ...result,
      computedAt: now.toISOString(),
    });
    for (const [userId, summary] of newBySalesperson) {
      await publishRealtime(REALTIME_CHANNELS.user(userId), 'crm_radar_new', {
        count: summary.count,
        topScore: summary.topScore,
      });
    }
  } catch (error) {
    log('realtime_failed', { message: error instanceof Error ? error.message : String(error) });
  }
  log('refreshed', { ...result });
  return result;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const RADAR = CRM_OBJECT_TYPES.radarSignal;
const idSchema = z.string().trim().min(1).max(64);
const isoInstantSchema = z
  .string()
  .trim()
  .min(10)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Fecha inválida (usa formato ISO)');

export const snoozeSignalSchema = z.object({
  signalId: idSchema,
  until: isoInstantSchema,
  note: z.string().trim().max(500).optional(),
});
export const dismissSignalSchema = z.object({
  signalId: idSchema,
  reason: z.string().trim().max(500).optional(),
});
export const convertSignalToTaskSchema = z.object({
  signalId: idSchema,
  title: z.string().trim().min(2).max(160).optional(),
  dueAt: isoInstantSchema.optional(),
  ownerUserId: idSchema.optional(),
});
const setExplanationSchema = z.object({
  signalId: idSchema,
  explanation: z.string().trim().min(10).max(1200),
  suggestedMessage: z.string().trim().min(5).max(700),
  model: z.string().trim().max(120),
});

export type SnoozeSignalInput = z.input<typeof snoozeSignalSchema>;
export type DismissSignalInput = z.input<typeof dismissSignalSchema>;
export type ConvertSignalToTaskInput = z.input<typeof convertSignalToTaskSchema>;

async function loadSignal(tx: Prisma.TransactionClient, id: string): Promise<RadarSignal> {
  const signal = await tx.radarSignal.findUnique({ where: { id } });
  if (!signal) throw new OperationsError('not_found', 'No se encontró la señal del radar');
  return signal;
}

function assertActionable(signal: RadarSignal): void {
  if (!ACTIONABLE_SIGNAL_STATUSES.includes(signal.status)) {
    throw new OperationsError('invalid_state', 'La señal ya no está activa');
  }
}

function mergeData(
  data: Prisma.JsonValue | null,
  patch: Record<string, unknown>
): Prisma.InputJsonValue {
  const base =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return toOperationalJson({ ...base, ...patch });
}

const radarEventOptions = (signal: RadarSignal) => ({
  areaKey: CRM_AREA_KEY,
  objectType: RADAR,
  objectId: signal.id,
});

registerCommand<z.output<typeof snoozeSignalSchema>, { signalId: string; snoozedUntil: string }>(
  CRM_COMMANDS.radarSnooze,
  {
    schema: snoozeSignalSchema,
    permission: 'crm.radar',
    aggregate: radarSignalAggregate,
    async handler(tx, cmd, ctx) {
      const input = cmd.payload;
      assertAggregateTarget(cmd, input.signalId, 'señal');
      const signal = await loadSignal(tx, input.signalId);
      assertVisibleInCommand(ctx, signal);
      assertActionable(signal);
      const until = new Date(input.until);
      if (until.getTime() < ctx.now.getTime() + SNOOZE_MIN_MS) {
        throw new OperationsError('invalid_payload', 'Pospón la señal al menos 5 minutos');
      }
      if (until.getTime() > ctx.now.getTime() + SNOOZE_MAX_MS) {
        throw new OperationsError('invalid_payload', 'Una señal se pospone como máximo 30 días');
      }
      await tx.radarSignal.update({
        where: { id: signal.id },
        data: {
          status: 'snoozed',
          snoozedUntil: until,
          data: mergeData(signal.data, {
            snoozedBy: commandUserId(ctx),
            snoozeNote: input.note ?? null,
          }),
        },
      });
      ctx.emit(
        CRM_EVENTS.radarSnoozed,
        { signalId: signal.id, kind: signal.kind, until: until.toISOString() },
        radarEventOptions(signal)
      );
      ctx.realtime(CRM_RADAR_CHANNEL, 'signal_changed', { signalId: signal.id, status: 'snoozed' });
      return { data: { signalId: signal.id, snoozedUntil: until.toISOString() } };
    },
  }
);

registerCommand<z.output<typeof dismissSignalSchema>, { signalId: string }>(
  CRM_COMMANDS.radarDismiss,
  {
    schema: dismissSignalSchema,
    permission: 'crm.radar',
    aggregate: radarSignalAggregate,
    async handler(tx, cmd, ctx) {
      const input = cmd.payload;
      assertAggregateTarget(cmd, input.signalId, 'señal');
      const signal = await loadSignal(tx, input.signalId);
      assertVisibleInCommand(ctx, signal);
      assertActionable(signal);
      await tx.radarSignal.update({
        where: { id: signal.id },
        data: {
          status: 'dismissed',
          snoozedUntil: null,
          data: mergeData(signal.data, {
            dismissedBy: commandUserId(ctx),
            dismissReason: input.reason ?? null,
          }),
        },
      });
      ctx.emit(
        CRM_EVENTS.radarDismissed,
        { signalId: signal.id, kind: signal.kind, reason: input.reason ?? null },
        radarEventOptions(signal)
      );
      ctx.realtime(CRM_RADAR_CHANNEL, 'signal_changed', {
        signalId: signal.id,
        status: 'dismissed',
      });
      return { data: { signalId: signal.id } };
    },
  }
);

registerCommand<
  z.output<typeof convertSignalToTaskSchema>,
  { signalId: string; workItemId: string }
>(CRM_COMMANDS.radarConvertToTask, {
  schema: convertSignalToTaskSchema,
  permission: 'crm.radar',
  aggregate: radarSignalAggregate,
  async handler(tx, cmd, ctx) {
    const input = cmd.payload;
    assertAggregateTarget(cmd, input.signalId, 'señal');
    const signal = await loadSignal(tx, input.signalId);
    assertVisibleInCommand(ctx, signal);
    assertActionable(signal);
    const ownerUserId = input.ownerUserId ?? signal.salespersonUserId ?? commandUserId(ctx);
    if (ownerUserId) {
      const owner = await tx.user.findUnique({
        where: { id: ownerUserId },
        select: { isActive: true, isBot: true },
      });
      if (!owner?.isActive || owner.isBot) {
        throw new OperationsError(
          'invalid_payload',
          'El responsable de la tarea no existe, está inactivo o es una identidad de IA'
        );
      }
    }
    const label = isRadarKind(signal.kind) ? RADAR_KIND_LABELS[signal.kind] : signal.kind;
    const title =
      input.title ?? truncateText(`${label}: ${signal.customerName ?? signal.subjectKey}`, 160);
    const dueAt = input.dueAt ? new Date(input.dueAt) : undefined;
    const workItem = await ctx.createWorkItem({
      areaKey: CRM_AREA_KEY,
      kind: 'action',
      title,
      description: signal.reason,
      objectType: RADAR,
      objectId: signal.id,
      ...(ownerUserId ? { ownerUserId } : {}),
      ...(dueAt ? { dueAt } : {}),
    });
    // Snoozed until the task is due: the radar stays quiet while the task is open and the
    // subject resurfaces if the condition still holds after the due date.
    const snoozedUntil = workItem.dueAt ?? new Date(ctx.now.getTime() + DAY_MS);
    await tx.radarSignal.update({
      where: { id: signal.id },
      data: {
        status: 'snoozed',
        snoozedUntil,
        data: mergeData(signal.data, { workItemId: workItem.id, convertedBy: commandUserId(ctx) }),
      },
    });
    if (signal.opportunityId) {
      const opportunity = await tx.opportunity.findUnique({
        where: { id: signal.opportunityId },
        select: { id: true },
      });
      if (opportunity) {
        await tx.opportunityActivity.create({
          data: {
            opportunityId: opportunity.id,
            kind: 'task',
            summary: `Tarea creada desde el radar: ${title}`,
            refType: ACTIVITY_REF_TYPES.workItem,
            refId: workItem.id,
            payload: toOperationalJson({ signalId: signal.id, kind: signal.kind }),
            userId: commandUserId(ctx),
            at: ctx.now,
          },
        });
        await tx.opportunity.updateMany({
          where: { id: opportunity.id, nextActionAt: null },
          data: { nextActionAt: workItem.dueAt, nextActionText: title },
        });
      }
    }
    ctx.emit(
      CRM_EVENTS.radarConverted,
      { signalId: signal.id, kind: signal.kind, workItemId: workItem.id },
      radarEventOptions(signal)
    );
    ctx.realtime(CRM_RADAR_CHANNEL, 'signal_changed', {
      signalId: signal.id,
      status: 'snoozed',
      workItemId: workItem.id,
    });
    return { data: { signalId: signal.id, workItemId: workItem.id } };
  },
});

registerCommand<z.output<typeof setExplanationSchema>, { signalId: string }>(
  CRM_COMMANDS.radarSetExplanation,
  {
    schema: setExplanationSchema,
    permission: 'crm.radar',
    aggregate: 'none',
    audit: 'never',
    async handler(tx, cmd, ctx) {
      const input = cmd.payload;
      const signal = await loadSignal(tx, input.signalId);
      assertVisibleInCommand(ctx, signal);
      await tx.radarSignal.update({
        where: { id: signal.id },
        data: {
          aiExplanation: input.explanation,
          aiSuggestedMessage: input.suggestedMessage,
          aiGeneratedAt: ctx.now,
        },
      });
      const requestedBy = commandUserId(ctx);
      if (requestedBy && signal.opportunityId) {
        const opportunity = await tx.opportunity.findUnique({
          where: { id: signal.opportunityId },
          select: { id: true },
        });
        if (opportunity) {
          await tx.opportunityActivity.create({
            data: {
              opportunityId: opportunity.id,
              kind: 'ai_suggestion',
              summary: truncateText(input.explanation, 300),
              refType: ACTIVITY_REF_TYPES.radarSignal,
              refId: signal.id,
              payload: toOperationalJson({ kind: signal.kind, model: input.model }),
              userId: requestedBy,
              at: ctx.now,
            },
          });
        }
      }
      ctx.emit(
        CRM_EVENTS.radarExplained,
        { signalId: signal.id, kind: signal.kind, model: input.model },
        radarEventOptions(signal)
      );
      return { data: { signalId: signal.id } };
    },
  }
);

export const snoozeSignal = (
  actor: CurrentUser,
  input: SnoozeSignalInput,
  options?: CrmCommandOptions
) =>
  runCrmCommand<{ signalId: string; snoozedUntil: string }>(
    actor,
    CRM_COMMANDS.radarSnooze,
    { type: RADAR, id: input.signalId },
    input,
    options
  );

export const dismissSignal = (
  actor: CurrentUser,
  input: DismissSignalInput,
  options?: CrmCommandOptions
) =>
  runCrmCommand<{ signalId: string }>(
    actor,
    CRM_COMMANDS.radarDismiss,
    { type: RADAR, id: input.signalId },
    input,
    options
  );

export const convertSignalToTask = (
  actor: CurrentUser,
  input: ConvertSignalToTaskInput,
  options?: CrmCommandOptions
) =>
  runCrmCommand<{ signalId: string; workItemId: string }>(
    actor,
    CRM_COMMANDS.radarConvertToTask,
    { type: RADAR, id: input.signalId },
    input,
    options
  );

// ---------------------------------------------------------------------------
// AI explanation
// ---------------------------------------------------------------------------

async function loadExplanationContext(signal: RadarSignal): Promise<ExplanationContext> {
  const [opportunity, quote, salesperson] = await Promise.all([
    signal.opportunityId
      ? prisma.opportunity.findUnique({
          where: { id: signal.opportunityId },
          select: {
            number: true,
            title: true,
            stageId: true,
            status: true,
            estimatedValue: true,
            currency: true,
            nextActionText: true,
            conversationIds: true,
          },
        })
      : null,
    signal.quoteId
      ? prisma.quote.findUnique({
          where: { id: signal.quoteId },
          select: {
            estimateNumber: true,
            zohoEstimateId: true,
            status: true,
            total: true,
            currencyCode: true,
            expiryDate: true,
          },
        })
      : null,
    signal.salespersonUserId
      ? prisma.user.findUnique({ where: { id: signal.salespersonUserId }, select: { name: true } })
      : null,
  ]);
  const stage = opportunity
    ? await prisma.pipelineStage.findUnique({
        where: { id: opportunity.stageId },
        select: { name: true },
      })
    : null;
  const conversationId =
    signal.conversationId ??
    (opportunity && opportunity.conversationIds.length > 0
      ? opportunity.conversationIds[opportunity.conversationIds.length - 1]
      : null);
  const messages = conversationId
    ? await prisma.commMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { direction: true, body: true, createdAt: true },
      })
    : [];
  return {
    signal: {
      kind: signal.kind,
      score: signal.score,
      reason: signal.reason,
      data: signal.data,
      customerName: signal.customerName,
    },
    salespersonName: salesperson?.name ?? null,
    opportunity: opportunity
      ? {
          number: opportunity.number,
          title: opportunity.title,
          stageName: stage?.name ?? null,
          status: opportunity.status,
          estimatedValue: toNumber(opportunity.estimatedValue),
          currency: opportunity.currency,
          nextActionText: opportunity.nextActionText,
        }
      : null,
    quote: quote
      ? {
          folio: quote.estimateNumber ?? quote.zohoEstimateId,
          status: quote.status,
          total: toNumber(quote.total),
          currencyCode: quote.currencyCode,
          expiryDate: quote.expiryDate ? quote.expiryDate.toISOString().slice(0, 10) : null,
        }
      : null,
    messages,
  };
}

export interface GeneratedExplanation {
  explanation: string;
  suggestedMessage: string;
  model: string;
}

/**
 * One `utility` model call (never inside a transaction), braked and metered on
 * the Ventas AI identity. Throws `CrmError` with `ai_disabled`, `ai_paused`,
 * `ai_budget` or `ai_invalid`.
 */
export async function generateSignalExplanation(
  signal: RadarSignal,
  options: { chargeUserId: string | null; now?: Date }
): Promise<GeneratedExplanation> {
  const now = options.now ?? new Date();
  const settings = await getAiSettings();
  if (!settings.isEnabled)
    throw new CrmError('La IA está desactivada en la configuración', 'ai_disabled', 503);
  const agentKey = agentKeyForArea(CRM_AREA_KEY);
  const identity = agentKey
    ? await prisma.agentIdentity.findUnique({ where: { key: agentKey } })
    : null;
  if (identity?.mode === 'paused')
    throw new CrmError('La IA de Ventas está en pausa', 'ai_paused', 503);
  if (identity) {
    const budget = await checkAgentBudget(identity, { now });
    if (budget.state === 'exhausted') {
      throw new CrmError(
        'Se agotó el presupuesto de IA de Ventas; intenta más tarde',
        'ai_budget',
        429
      );
    }
  }
  const context = await loadExplanationContext(signal);
  const model = modelForTask(settings, 'utility');
  const completion = await chatCompletion({
    model,
    temperature: 0.2,
    maxTokens: EXPLANATION_MAX_TOKENS,
    userId: options.chargeUserId ?? identity?.botUserId ?? undefined,
    messages: buildExplanationMessages(context),
  });
  const usedModel = completion.model || model;
  await recordAgentUsage({
    ...(identity && agentKey ? { agentKey } : {}),
    areaKey: CRM_AREA_KEY,
    userId: options.chargeUserId ?? identity?.botUserId ?? '',
    promptTokens: completion.promptTokens,
    completionTokens: completion.completionTokens,
    model: usedModel,
    now,
  });
  const parsed = parseExplanation(completion.content);
  if (!parsed)
    throw new CrmError(
      'La IA no devolvió una explicación válida; intenta de nuevo',
      'ai_invalid',
      502
    );
  return { ...parsed, model: usedModel };
}

/** On demand (`crm.radar`): returns the cached explanation for 12 hours unless `force`. */
/** A signal as it is stored (no model call): the cached explanation and suggested message, if any. */
export async function getRadarSignal(
  actor: CurrentUser,
  signalId: string
): Promise<RadarSignalDTO> {
  assertCrmPermission(actor, 'crm.radar');
  const signal = await prisma.radarSignal.findUnique({ where: { id: signalId } });
  if (!signal || !isSignalVisibleTo(actor, signal))
    throw new CrmError('No se encontró la señal del radar', 'not_found', 404);
  return toRadarSignalDTO(signal);
}

export async function explainSignal(
  actor: CurrentUser,
  input: { signalId: string; force?: boolean },
  options: { now?: Date } = {}
): Promise<RadarSignalDTO> {
  assertCrmPermission(actor, 'crm.radar');
  const now = options.now ?? new Date();
  const signal = await prisma.radarSignal.findUnique({ where: { id: input.signalId } });
  if (!signal || !isSignalVisibleTo(actor, signal))
    throw new CrmError('No se encontró la señal del radar', 'not_found', 404);
  const fresh =
    signal.aiExplanation &&
    signal.aiGeneratedAt &&
    now.getTime() - signal.aiGeneratedAt.getTime() < EXPLANATION_FRESH_MS;
  if (fresh && !input.force) return toRadarSignalDTO(signal);
  const generated = await generateSignalExplanation(signal, { chargeUserId: actor.id, now });
  unwrapCrmResult(
    await runCrmCommand(
      actor,
      CRM_COMMANDS.radarSetExplanation,
      { type: RADAR, id: `explain:${signal.id}` },
      { signalId: signal.id, ...generated },
      { now }
    )
  );
  const updated = await prisma.radarSignal.findUnique({ where: { id: signal.id } });
  return toRadarSignalDTO(updated ?? signal);
}

export interface ExplainTopSignalsResult {
  explained: number;
  failed: number;
  stopped: string | null;
  skipped?: 'disabled';
}

/** Daily job: the 5 best active signals of each salesperson without a recent explanation. */
export async function explainTopSignals(
  options: { now?: Date; perSalesperson?: number } = {}
): Promise<ExplainTopSignalsResult> {
  const now = options.now ?? new Date();
  const result: ExplainTopSignalsResult = { explained: 0, failed: 0, stopped: null };
  if (!(await isOpsFlagEnabled('crm'))) return { ...result, skipped: 'disabled' };
  const candidates = await prisma.radarSignal.findMany({
    where: {
      status: 'active',
      expiresAt: { gt: now },
      salespersonUserId: { not: null },
      OR: [
        { aiGeneratedAt: null },
        { aiGeneratedAt: { lt: new Date(now.getTime() - DAILY_EXPLANATION_STALE_MS) } },
      ],
    },
    // Stable order: ties never change which signals are explained (and charged) from one run to the next.
    orderBy: [{ score: 'desc' }, { kind: 'asc' }, { subjectKey: 'asc' }, { id: 'asc' }],
    take: 2000,
  });
  const top = topSignalsPerSalesperson(candidates, options.perSalesperson ?? 5);
  const day = localDateKey(now);
  for (const signals of top.values()) {
    for (const signal of signals) {
      try {
        const generated = await generateSignalExplanation(signal, {
          chargeUserId: signal.salespersonUserId,
          now,
        });
        const stored = await runCrmSystemCommand(
          CRM_COMMANDS.radarSetExplanation,
          { type: RADAR, id: `explain:${signal.id}` },
          { signalId: signal.id, ...generated },
          `crm:radar_explain:${signal.id}:${day}`,
          { now }
        );
        if (stored.status === 'completed') result.explained++;
        else result.failed++;
      } catch (error) {
        if (
          error instanceof CrmError &&
          ['ai_disabled', 'ai_paused', 'ai_budget'].includes(error.code)
        ) {
          result.stopped = error.code;
          return result;
        }
        result.failed++;
        log('explain_failed', {
          signalId: signal.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return result;
}
