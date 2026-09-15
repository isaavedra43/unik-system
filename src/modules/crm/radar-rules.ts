import { formatMoney, openObjections, truncateText, type ObjectionActivityLike } from './opportunity-rules';
import { RADAR_KINDS, type RadarKind } from './types';

/**
 * Commercial radar rules (plan 6.5). Pure module: facts in, signal drafts out.
 *
 * score = clamp(round(base × stage weight × value weight), 0, 100)
 *
 * | kind | condition | base |
 * |---|---|---|
 * | no_first_reply | the customer wrote and the conversation never had an outbound reply, ≥ 2 h | 60 + min(30, h/2) |
 * | no_followup | there were replies but the customer wrote last, silence ≥ 24 h | 40 + min(45, h/6) |
 * | quote_expiring | quote sent (or viewed), expires in d ≤ 3 calendar days | 50 + (3−d)·15, +10 if viewed |
 * | next_action_overdue | open opportunity with the next action in the past (d whole days) | 50 + min(40, d·5) |
 * | objection_open | objection without resolution for ≥ 48 h | 55 |
 * | high_intent | probability ≥ .6, inbound message in the last 48 h, no quote | 70 |
 * | repurchase_overdue | ≥ 3 orders, median interval m days, days since last > 1.3·m | 45 + min(40, (days/m − 1.3)·50) |
 * | delivery_incident | high/critical open incident in a case of the customer | 75 |
 *
 * `no_first_reply` and `no_followup` are mutually exclusive: the first one is
 * for conversations nobody has answered yet (new leads), the second one for
 * ongoing conversations where the customer is waiting. Silence is measured from
 * the customer's last message. Calendar days use Mexico City.
 *
 * Every draft carries `subjectKey` (unique with `kind`), the links, the
 * salesperson, a Spanish `reason` with the figures and `expiresAt`: a signal is
 * live for one hour after it was computed (the refresh runs every 15 minutes),
 * capped by the natural end of the condition (quote expiry, 48 h window).
 */

export const RADAR_TIME_ZONE = 'America/Mexico_City';
/** Mexico City has no daylight saving time since 2022 (UTC−6). */
const MEXICO_CITY_OFFSET_MS = 6 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const RADAR_SIGNAL_TTL_MS = HOUR_MS;

export const RADAR_THRESHOLDS = {
  noFirstReplyHours: 2,
  noFollowupHours: 24,
  quoteExpiringDays: 3,
  objectionOpenHours: 48,
  highIntentProbability: 0.6,
  highIntentInboundHours: 48,
  repurchaseMinOrders: 3,
  repurchaseFactor: 1.3,
} as const;

export const DELIVERY_INCIDENT_SEVERITIES: readonly string[] = ['high', 'critical'];

/** Weight by stage key of the default pipeline; other open stages weigh 1. */
export const STAGE_KEY_WEIGHTS: Readonly<Record<string, number>> = {
  nuevo: 1,
  contactado: 1,
  cotizado: 1.1,
  negociacion: 1.2,
};

export const STAGE_KIND_WEIGHTS: Readonly<Record<'open' | 'won' | 'lost', number>> = {
  open: 1,
  won: 0.9,
  lost: 0.6,
};

/** Value bands in MXN (upper bound exclusive). */
export const VALUE_WEIGHT_BANDS: ReadonlyArray<{ below: number; weight: number }> = [
  { below: 10_000, weight: 0.9 },
  { below: 50_000, weight: 1 },
  { below: 200_000, weight: 1.1 },
  { below: Number.POSITIVE_INFINITY, weight: 1.2 },
];

export interface RadarStageRef {
  key: string;
  kind: string;
  name?: string;
}

export interface RadarOpportunityRef {
  id: string;
  number: string;
  salespersonUserId: string;
  stage: RadarStageRef | null;
  estimatedValue: number | null;
}

export interface RadarSignalDraft {
  kind: RadarKind;
  subjectKey: string;
  score: number;
  reason: string;
  data: Record<string, unknown>;
  expiresAt: Date;
  opportunityId: string | null;
  conversationId: string | null;
  quoteId: string | null;
  zohoContactId: string | null;
  commContactId: string | null;
  customerName: string | null;
  salespersonUserId: string | null;
}

// ---------------------------------------------------------------------------
// Weights and score
// ---------------------------------------------------------------------------

export function stageWeight(stage: RadarStageRef | null | undefined): number {
  if (!stage) return 1;
  if (stage.kind === 'won') return STAGE_KIND_WEIGHTS.won;
  if (stage.kind === 'lost') return STAGE_KIND_WEIGHTS.lost;
  return STAGE_KEY_WEIGHTS[stage.key] ?? STAGE_KIND_WEIGHTS.open;
}

export function valueWeight(amount: number | null | undefined): number {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || amount <= 0) return 1;
  for (const band of VALUE_WEIGHT_BANDS) {
    if (amount < band.below) return band.weight;
  }
  return VALUE_WEIGHT_BANDS[VALUE_WEIGHT_BANDS.length - 1].weight;
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function radarScore(base: number, stage: RadarStageRef | null | undefined, amount: number | null | undefined): number {
  return clampScore(base * stageWeight(stage) * valueWeight(amount));
}

// ---------------------------------------------------------------------------
// Time and text helpers
// ---------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;

/** YYYY-MM-DD of an instant in Mexico City. */
export function localDateKey(date: Date, timeZone: string = RADAR_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Date-only columns (`@db.Date`, stored at UTC midnight) → YYYY-MM-DD. */
export function dateOnlyKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole calendar days from `fromKey` to `toKey` (negative when `toKey` is before). */
export function daysBetweenKeys(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / DAY_MS);
}

/** First instant after the local day `key` ends in Mexico City. */
export function endOfLocalDay(key: string): Date {
  return new Date(Date.parse(`${key}T00:00:00Z`) + DAY_MS + MEXICO_CITY_OFFSET_MS);
}

export function formatDays(days: number): string {
  return days === 1 ? '1 día' : `${days} días`;
}

/** 0.4 → "menos de 1 h"; 5.7 → "5 h"; 50 → "2 días". */
export function formatElapsed(hours: number): string {
  if (hours < 1) return 'menos de 1 h';
  if (hours < 48) return `${Math.floor(hours)} h`;
  return formatDays(Math.floor(hours / 24));
}

function quoteDueLabel(days: number): string {
  if (days === 0) return 'vence hoy';
  if (days === 1) return 'vence mañana';
  return `vence en ${formatDays(days)}`;
}

const minDate = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

export function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Weighed {
  base: number;
  stage: RadarStageRef | null | undefined;
  amount: number | null | undefined;
}

function scoreData({ base, stage, amount }: Weighed): { score: number; data: Record<string, unknown> } {
  return {
    score: radarScore(base, stage, amount),
    data: {
      base: round1(base),
      stageWeight: stageWeight(stage),
      valueWeight: valueWeight(amount),
      ...(amount !== null && amount !== undefined ? { amount } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface ConversationFacts {
  conversationId: string;
  commContactId: string | null;
  zohoContactId: string | null;
  customerName: string | null;
  assignedToUserId: string | null;
  /** open | pending | snoozed | resolved */
  status: string;
  snoozedUntil: Date | null;
  firstInboundAt: Date | null;
  lastInboundAt: Date | null;
  /** Last outbound message that did not fail. */
  lastOutboundAt: Date | null;
  opportunity: RadarOpportunityRef | null;
}

function conversationSilenced(facts: ConversationFacts, now: Date): boolean {
  if (facts.status === 'resolved') return true;
  return facts.status === 'snoozed' && facts.snoozedUntil !== null && facts.snoozedUntil.getTime() > now.getTime();
}

function conversationLinks(facts: ConversationFacts) {
  return {
    opportunityId: facts.opportunity?.id ?? null,
    conversationId: facts.conversationId,
    quoteId: null,
    zohoContactId: facts.zohoContactId,
    commContactId: facts.commContactId,
    customerName: facts.customerName,
    salespersonUserId: facts.opportunity?.salespersonUserId ?? facts.assignedToUserId,
  };
}

export function ruleNoFirstReply(facts: ConversationFacts, now: Date): RadarSignalDraft | null {
  if (conversationSilenced(facts, now) || !facts.firstInboundAt || facts.lastOutboundAt) return null;
  const hours = (now.getTime() - facts.firstInboundAt.getTime()) / HOUR_MS;
  if (hours < RADAR_THRESHOLDS.noFirstReplyHours) return null;
  const base = 60 + Math.min(30, hours / 2);
  const { score, data } = scoreData({
    base,
    stage: facts.opportunity?.stage,
    amount: facts.opportunity?.estimatedValue,
  });
  const who = facts.customerName?.trim() || 'El cliente';
  return {
    kind: 'no_first_reply',
    subjectKey: facts.conversationId,
    score,
    reason: `${who} escribió hace ${formatElapsed(hours)} y todavía no recibe una primera respuesta.`,
    data: { ...data, hoursWaiting: round1(hours), firstInboundAt: facts.firstInboundAt.toISOString() },
    expiresAt: new Date(now.getTime() + RADAR_SIGNAL_TTL_MS),
    ...conversationLinks(facts),
  };
}

export function ruleNoFollowup(facts: ConversationFacts, now: Date): RadarSignalDraft | null {
  if (conversationSilenced(facts, now) || !facts.lastInboundAt || !facts.lastOutboundAt) return null;
  if (facts.lastInboundAt.getTime() <= facts.lastOutboundAt.getTime()) return null;
  const hours = (now.getTime() - facts.lastInboundAt.getTime()) / HOUR_MS;
  if (hours < RADAR_THRESHOLDS.noFollowupHours) return null;
  const base = 40 + Math.min(45, hours / 6);
  const { score, data } = scoreData({
    base,
    stage: facts.opportunity?.stage,
    amount: facts.opportunity?.estimatedValue,
  });
  const who = facts.customerName?.trim() || 'El cliente';
  return {
    kind: 'no_followup',
    subjectKey: facts.conversationId,
    score,
    reason: `${who} escribió por última vez hace ${formatElapsed(hours)} y nadie le ha dado seguimiento.`,
    data: { ...data, hoursSilent: round1(hours), lastInboundAt: facts.lastInboundAt.toISOString() },
    expiresAt: new Date(now.getTime() + RADAR_SIGNAL_TTL_MS),
    ...conversationLinks(facts),
  };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface QuoteFacts {
  quoteId: string;
  zohoEstimateId: string;
  estimateNumber: string | null;
  status: string | null;
  /** Date-only column (UTC midnight). */
  expiryDate: Date | null;
  isViewedByClient: boolean | null;
  total: number | null;
  currencyCode: string | null;
  customerName: string | null;
  zohoCustomerId: string | null;
  /** UNIK author of the quote, when it was created from UNIK. */
  ownerUserId: string | null;
  opportunity: RadarOpportunityRef | null;
}

const QUOTE_OPEN_STATUSES = ['sent', 'viewed'];

export function ruleQuoteExpiring(facts: QuoteFacts, now: Date): RadarSignalDraft | null {
  const status = (facts.status ?? '').trim().toLowerCase();
  if (!QUOTE_OPEN_STATUSES.includes(status) || !facts.expiryDate) return null;
  const expiryKey = dateOnlyKey(facts.expiryDate);
  const days = daysBetweenKeys(localDateKey(now), expiryKey);
  if (days < 0 || days > RADAR_THRESHOLDS.quoteExpiringDays) return null;
  const viewed = status === 'viewed' || facts.isViewedByClient === true;
  const base = 50 + (RADAR_THRESHOLDS.quoteExpiringDays - days) * 15 + (viewed ? 10 : 0);
  const amount = facts.opportunity?.estimatedValue ?? facts.total;
  const { score, data } = scoreData({ base, stage: facts.opportunity?.stage, amount });
  const folio = facts.estimateNumber ?? facts.zohoEstimateId;
  const money = facts.total !== null ? ` por ${formatMoney(facts.total, facts.currencyCode)}` : '';
  return {
    kind: 'quote_expiring',
    subjectKey: facts.quoteId,
    score,
    reason: `La cotización ${folio}${money} de ${facts.customerName?.trim() || 'el cliente'} ${quoteDueLabel(days)}${viewed ? ' y el cliente ya la vio' : ''}.`,
    data: { ...data, daysToExpiry: days, expiryDate: expiryKey, viewed, estimateNumber: folio },
    expiresAt: minDate(new Date(now.getTime() + RADAR_SIGNAL_TTL_MS), endOfLocalDay(expiryKey)),
    opportunityId: facts.opportunity?.id ?? null,
    conversationId: null,
    quoteId: facts.quoteId,
    zohoContactId: facts.zohoCustomerId,
    commContactId: null,
    customerName: facts.customerName,
    salespersonUserId: facts.opportunity?.salespersonUserId ?? facts.ownerUserId,
  };
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export interface OpportunityFacts {
  id: string;
  number: string;
  title: string;
  contactName: string;
  salespersonUserId: string;
  zohoContactId: string | null;
  commContactId: string | null;
  /** Most recent linked conversation. */
  conversationId: string | null;
  status: string;
  stage: RadarStageRef | null;
  /** Effective probability 0–1 (own value or stage default). */
  probability: number;
  estimatedValue: number | null;
  currencyCode: string | null;
  nextActionAt: Date | null;
  nextActionText: string | null;
  lastInboundAt: Date | null;
  hasQuote: boolean;
  objectionActivities: ObjectionActivityLike[];
}

export function opportunityRef(facts: OpportunityFacts): RadarOpportunityRef {
  return {
    id: facts.id,
    number: facts.number,
    salespersonUserId: facts.salespersonUserId,
    stage: facts.stage,
    estimatedValue: facts.estimatedValue,
  };
}

function opportunityLinks(facts: OpportunityFacts) {
  return {
    opportunityId: facts.id,
    conversationId: facts.conversationId,
    quoteId: null,
    zohoContactId: facts.zohoContactId,
    commContactId: facts.commContactId,
    customerName: facts.contactName,
    salespersonUserId: facts.salespersonUserId,
  };
}

export function ruleNextActionOverdue(facts: OpportunityFacts, now: Date): RadarSignalDraft | null {
  if (facts.status !== 'open' || !facts.nextActionAt) return null;
  const overdueMs = now.getTime() - facts.nextActionAt.getTime();
  if (overdueMs <= 0) return null;
  const days = Math.floor(overdueMs / DAY_MS);
  const base = 50 + Math.min(40, days * 5);
  const { score, data } = scoreData({ base, stage: facts.stage, amount: facts.estimatedValue });
  const text = truncateText(facts.nextActionText, 80);
  return {
    kind: 'next_action_overdue',
    subjectKey: facts.id,
    score,
    reason: `La siguiente acción de ${facts.number}${text ? ` («${text}»)` : ''} con ${facts.contactName} venció ${days === 0 ? 'hoy' : `hace ${formatDays(days)}`}.`,
    data: { ...data, daysOverdue: days, nextActionAt: facts.nextActionAt.toISOString() },
    expiresAt: new Date(now.getTime() + RADAR_SIGNAL_TTL_MS),
    ...opportunityLinks(facts),
  };
}

export function ruleObjectionOpen(facts: OpportunityFacts, now: Date): RadarSignalDraft | null {
  if (facts.status !== 'open') return null;
  const minAge = RADAR_THRESHOLDS.objectionOpenHours * HOUR_MS;
  const stale = openObjections(facts.objectionActivities).filter(
    (objection) => now.getTime() - objection.at.getTime() >= minAge
  );
  if (stale.length === 0) return null;
  const oldest = stale[0];
  const hours = (now.getTime() - oldest.at.getTime()) / HOUR_MS;
  const { score, data } = scoreData({ base: 55, stage: facts.stage, amount: facts.estimatedValue });
  const count = stale.length === 1 ? 'una objeción' : `${stale.length} objeciones`;
  return {
    kind: 'objection_open',
    subjectKey: facts.id,
    score,
    reason: `${facts.number} con ${facts.contactName} tiene ${count} sin resolver; la más antigua («${truncateText(oldest.summary, 80)}») lleva ${formatElapsed(hours)}.`,
    data: { ...data, openObjections: stale.length, oldestObjectionId: oldest.id, oldestAt: oldest.at.toISOString() },
    expiresAt: new Date(now.getTime() + RADAR_SIGNAL_TTL_MS),
    ...opportunityLinks(facts),
  };
}

export function ruleHighIntent(facts: OpportunityFacts, now: Date): RadarSignalDraft | null {
  if (facts.status !== 'open' || facts.hasQuote || !facts.lastInboundAt) return null;
  if (facts.probability < RADAR_THRESHOLDS.highIntentProbability) return null;
  const sinceMs = now.getTime() - facts.lastInboundAt.getTime();
  const windowMs = RADAR_THRESHOLDS.highIntentInboundHours * HOUR_MS;
  if (sinceMs < 0 || sinceMs > windowMs) return null;
  const { score, data } = scoreData({ base: 70, stage: facts.stage, amount: facts.estimatedValue });
  const pct = Math.round(facts.probability * 100);
  const stageName = facts.stage?.name ? `en ${facts.stage.name} ` : '';
  return {
    kind: 'high_intent',
    subjectKey: facts.id,
    score,
    reason: `${facts.contactName} escribió hace ${formatElapsed(sinceMs / HOUR_MS)}; ${facts.number} está ${stageName}con ${pct} % de probabilidad y aún no tiene cotización.`,
    data: { ...data, probability: facts.probability, lastInboundAt: facts.lastInboundAt.toISOString() },
    expiresAt: minDate(
      new Date(now.getTime() + RADAR_SIGNAL_TTL_MS),
      new Date(facts.lastInboundAt.getTime() + windowMs)
    ),
    ...opportunityLinks(facts),
  };
}

// ---------------------------------------------------------------------------
// Customers (repurchase)
// ---------------------------------------------------------------------------

export interface CustomerOrderFacts {
  zohoContactId: string;
  customerName: string | null;
  /** Order dates (date-only columns) and totals of the customer's valid orders. */
  orders: ReadonlyArray<{ orderDate: Date; total: number | null }>;
  salespersonUserId: string | null;
  commContactId: string | null;
  opportunity: RadarOpportunityRef | null;
}

export interface RepurchaseStats {
  orderCount: number;
  medianIntervalDays: number;
  daysSinceLast: number;
  lastOrderDate: string;
}

/** Distinct order days, their median interval and the days since the last one. */
export function repurchaseStats(orderDates: readonly Date[], now: Date): RepurchaseStats | null {
  const keys = [...new Set(orderDates.map(dateOnlyKey))].sort();
  if (keys.length < RADAR_THRESHOLDS.repurchaseMinOrders) return null;
  const intervals: number[] = [];
  for (let i = 1; i < keys.length; i++) intervals.push(daysBetweenKeys(keys[i - 1], keys[i]));
  const m = Math.max(1, median(intervals) ?? 1);
  const last = keys[keys.length - 1];
  return {
    orderCount: keys.length,
    medianIntervalDays: m,
    daysSinceLast: daysBetweenKeys(last, localDateKey(now)),
    lastOrderDate: last,
  };
}

export function ruleRepurchaseOverdue(facts: CustomerOrderFacts, now: Date): RadarSignalDraft | null {
  const stats = repurchaseStats(
    facts.orders.map((order) => order.orderDate),
    now
  );
  if (!stats) return null;
  const threshold = RADAR_THRESHOLDS.repurchaseFactor * stats.medianIntervalDays;
  if (stats.daysSinceLast <= threshold) return null;
  const ratio = stats.daysSinceLast / stats.medianIntervalDays;
  const base = 45 + Math.min(40, (ratio - RADAR_THRESHOLDS.repurchaseFactor) * 50);
  const totals = facts.orders.map((order) => order.total).filter((t): t is number => t !== null);
  const amount = facts.opportunity?.estimatedValue ?? median(totals);
  const { score, data } = scoreData({ base, stage: facts.opportunity?.stage, amount });
  return {
    kind: 'repurchase_overdue',
    subjectKey: facts.zohoContactId,
    score,
    reason: `${facts.customerName?.trim() || 'El cliente'} suele comprar cada ${Math.round(stats.medianIntervalDays)} días (mediana de ${stats.orderCount} órdenes) y su última orden fue hace ${formatDays(stats.daysSinceLast)}.`,
    data: { ...data, ...stats },
    expiresAt: new Date(now.getTime() + RADAR_SIGNAL_TTL_MS),
    opportunityId: facts.opportunity?.id ?? null,
    conversationId: null,
    quoteId: null,
    zohoContactId: facts.zohoContactId,
    commContactId: facts.commContactId,
    customerName: facts.customerName,
    salespersonUserId: facts.opportunity?.salespersonUserId ?? facts.salespersonUserId,
  };
}

// ---------------------------------------------------------------------------
// Delivery incidents
// ---------------------------------------------------------------------------

export interface DeliveryIncidentFacts {
  incidentId: string;
  severity: string;
  title: string;
  openedAt: Date;
  caseId: string;
  caseNumber: string;
  salesOrderNumber: string | null;
  zohoCustomerId: string | null;
  customerName: string | null;
  salespersonUserId: string | null;
  opportunity: RadarOpportunityRef | null;
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 2, high: 1 };
const SEVERITY_LABEL: Readonly<Record<string, string>> = { critical: 'crítica', high: 'alta' };

export function incidentSubjectKey(facts: Pick<DeliveryIncidentFacts, 'zohoCustomerId' | 'caseId'>): string {
  return facts.zohoCustomerId ?? `case:${facts.caseId}`;
}

/** One signal per customer (or per case without customer) for its most severe, most recent incident. */
export function ruleDeliveryIncident(group: readonly DeliveryIncidentFacts[], now: Date): RadarSignalDraft | null {
  const eligible = group
    .filter((incident) => DELIVERY_INCIDENT_SEVERITIES.includes(incident.severity))
    .sort(
      (a, b) =>
        (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
        b.openedAt.getTime() - a.openedAt.getTime()
    );
  if (eligible.length === 0) return null;
  const top = eligible[0];
  const others = eligible.length - 1;
  const { score, data } = scoreData({ base: 75, stage: top.opportunity?.stage, amount: top.opportunity?.estimatedValue });
  const order = top.salesOrderNumber ? ` (orden ${top.salesOrderNumber})` : '';
  const more = others > 0 ? ` y ${others === 1 ? 'otra más' : `${others} más`}` : '';
  return {
    kind: 'delivery_incident',
    subjectKey: incidentSubjectKey(top),
    score,
    reason: `El expediente ${top.caseNumber}${order} de ${top.customerName?.trim() || 'el cliente'} tiene una incidencia ${SEVERITY_LABEL[top.severity] ?? top.severity}: «${truncateText(top.title, 90)}»${more}. Avisa al cliente antes de que pregunte.`,
    data: {
      ...data,
      incidentId: top.incidentId,
      caseId: top.caseId,
      caseNumber: top.caseNumber,
      severity: top.severity,
      incidents: eligible.length,
    },
    expiresAt: new Date(now.getTime() + RADAR_SIGNAL_TTL_MS),
    opportunityId: top.opportunity?.id ?? null,
    conversationId: null,
    quoteId: null,
    zohoContactId: top.zohoCustomerId,
    commContactId: null,
    customerName: top.customerName,
    salespersonUserId: top.opportunity?.salespersonUserId ?? top.salespersonUserId,
  };
}

// ---------------------------------------------------------------------------
// Batch evaluation
// ---------------------------------------------------------------------------

export interface RadarFacts {
  conversations: readonly ConversationFacts[];
  quotes: readonly QuoteFacts[];
  opportunities: readonly OpportunityFacts[];
  customers: readonly CustomerOrderFacts[];
  incidents: readonly DeliveryIncidentFacts[];
}

export const signalKey = (kind: string, subjectKey: string) => `${kind}|${subjectKey}`;

/** Runs every rule; one draft per kind+subject (highest score wins), sorted by score. */
export function evaluateRadar(facts: RadarFacts, now: Date): RadarSignalDraft[] {
  const drafts: Array<RadarSignalDraft | null> = [];
  for (const conversation of facts.conversations) {
    drafts.push(ruleNoFirstReply(conversation, now), ruleNoFollowup(conversation, now));
  }
  for (const quote of facts.quotes) drafts.push(ruleQuoteExpiring(quote, now));
  for (const opportunity of facts.opportunities) {
    drafts.push(
      ruleNextActionOverdue(opportunity, now),
      ruleObjectionOpen(opportunity, now),
      ruleHighIntent(opportunity, now)
    );
  }
  for (const customer of facts.customers) drafts.push(ruleRepurchaseOverdue(customer, now));
  const groups = new Map<string, DeliveryIncidentFacts[]>();
  for (const incident of facts.incidents) {
    const key = incidentSubjectKey(incident);
    groups.set(key, [...(groups.get(key) ?? []), incident]);
  }
  for (const group of groups.values()) drafts.push(ruleDeliveryIncident(group, now));

  const best = new Map<string, RadarSignalDraft>();
  for (const draft of drafts) {
    if (!draft) continue;
    const key = signalKey(draft.kind, draft.subjectKey);
    const current = best.get(key);
    if (!current || draft.score > current.score) best.set(key, draft);
  }
  return [...best.values()].sort(
    (a, b) => b.score - a.score || RADAR_KINDS.indexOf(a.kind) - RADAR_KINDS.indexOf(b.kind) || a.subjectKey.localeCompare(b.subjectKey)
  );
}

/** The `limit` best signals of each salesperson (unassigned ones are skipped). */
export function topSignalsPerSalesperson<
  T extends { salespersonUserId: string | null; score: number; kind?: string; subjectKey?: string; id?: string },
>(signals: readonly T[], limit: number): Map<string, T[]> {
  const bySalesperson = new Map<string, T[]>();
  const kindRank = (kind: string | undefined) => {
    const index = kind ? (RADAR_KINDS as readonly string[]).indexOf(kind) : -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const ordered = [...signals].sort(
    (a, b) =>
      b.score - a.score ||
      kindRank(a.kind) - kindRank(b.kind) ||
      (a.subjectKey ?? '').localeCompare(b.subjectKey ?? '') ||
      (a.id ?? '').localeCompare(b.id ?? '')
  );
  for (const signal of ordered) {
    if (!signal.salespersonUserId) continue;
    const list = bySalesperson.get(signal.salespersonUserId) ?? [];
    if (list.length < limit) list.push(signal);
    bySalesperson.set(signal.salespersonUserId, list);
  }
  return bySalesperson;
}
