import type { Opportunity, OpportunityActivity, PipelineStage, RadarSignal } from '@prisma/client';
import { decimalString, isoOrNull } from './crm-helpers';
import { effectiveProbability, toProbability } from './pipeline-rules';
import {
  ACTIVITY_KIND_LABELS,
  OPPORTUNITY_STATUS_LABELS,
  RADAR_KIND_LABELS,
  RADAR_STATUS_LABELS,
  isOpportunityStatus,
  isRadarKind,
  type ActivityKind,
  type RadarStatus,
} from './types';

/**
 * JSON-safe DTOs of the CRM (money as strings, dates as ISO) shared by routes,
 * server actions, AI tools and the UI of the next phase.
 */

export interface PipelineStageDTO {
  id: string;
  key: string;
  name: string;
  order: number;
  probabilityDefault: number;
  kind: string;
  slaHours: number | null;
  active: boolean;
}

export interface OpportunityDTO {
  id: string;
  number: string;
  title: string;
  commContactId: string | null;
  zohoContactId: string | null;
  contactName: string;
  salespersonUserId: string;
  salespersonName: string | null;
  stageId: string;
  stageKey: string | null;
  stageName: string | null;
  stageKind: string | null;
  stageEnteredAt: string;
  /** Hours in the current stage above its SLA (null when the stage has no SLA or is within it). */
  stageSlaExceededHours: number | null;
  estimatedValue: string | null;
  currency: string;
  probability: number | null;
  effectiveProbability: number;
  expectedCloseAt: string | null;
  nextActionAt: string | null;
  nextActionText: string | null;
  nextActionOverdue: boolean;
  source: string;
  conversationIds: string[];
  voiceCallIds: string[];
  zohoEstimateIds: string[];
  zohoSalesOrderIds: string[];
  caseIds: string[];
  status: string;
  statusLabel: string;
  lostReason: string | null;
  wonAt: string | null;
  lostAt: string | null;
  lastActivityAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface OpportunityActivityDTO {
  id: string;
  opportunityId: string;
  kind: string;
  kindLabel: string;
  refType: string | null;
  refId: string | null;
  summary: string;
  payload: unknown;
  userId: string | null;
  userName: string | null;
  at: string;
}

export interface RadarSignalDTO {
  id: string;
  kind: string;
  kindLabel: string;
  subjectKey: string;
  opportunityId: string | null;
  conversationId: string | null;
  quoteId: string | null;
  zohoContactId: string | null;
  commContactId: string | null;
  customerName: string | null;
  salespersonUserId: string | null;
  salespersonName: string | null;
  score: number;
  reason: string;
  data: unknown;
  computedAt: string;
  expiresAt: string;
  status: string;
  statusLabel: string;
  snoozedUntil: string | null;
  aiExplanation: string | null;
  aiSuggestedMessage: string | null;
  aiGeneratedAt: string | null;
  version: number;
}

export function toStageDTO(stage: PipelineStage): PipelineStageDTO {
  return {
    id: stage.id,
    key: stage.key,
    name: stage.name,
    order: stage.order,
    probabilityDefault: toProbability(stage.probabilityDefault) ?? 0,
    kind: stage.kind,
    slaHours: stage.slaHours,
    active: stage.active,
  };
}

export function toOpportunityDTO(
  row: Opportunity,
  context: { stage?: PipelineStage | null; salespersonName?: string | null; now?: Date } = {}
): OpportunityDTO {
  const now = context.now ?? new Date();
  const stage = context.stage ?? null;
  const hoursInStage = (now.getTime() - row.stageEnteredAt.getTime()) / 3_600_000;
  const slaExceeded =
    stage?.slaHours && row.status === 'open' && hoursInStage > stage.slaHours
      ? Math.floor(hoursInStage - stage.slaHours)
      : null;
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    commContactId: row.commContactId,
    zohoContactId: row.zohoContactId,
    contactName: row.contactName,
    salespersonUserId: row.salespersonUserId,
    salespersonName: context.salespersonName ?? null,
    stageId: row.stageId,
    stageKey: stage?.key ?? null,
    stageName: stage?.name ?? null,
    stageKind: stage?.kind ?? null,
    stageEnteredAt: row.stageEnteredAt.toISOString(),
    stageSlaExceededHours: slaExceeded,
    estimatedValue: decimalString(row.estimatedValue),
    currency: row.currency,
    probability: toProbability(row.probability),
    effectiveProbability: effectiveProbability(row.probability, stage?.probabilityDefault ?? null),
    expectedCloseAt: isoOrNull(row.expectedCloseAt),
    nextActionAt: isoOrNull(row.nextActionAt),
    nextActionText: row.nextActionText,
    nextActionOverdue: Boolean(row.status === 'open' && row.nextActionAt && row.nextActionAt.getTime() < now.getTime()),
    source: row.source,
    conversationIds: row.conversationIds,
    voiceCallIds: row.voiceCallIds,
    zohoEstimateIds: row.zohoEstimateIds,
    zohoSalesOrderIds: row.zohoSalesOrderIds,
    caseIds: row.caseIds,
    status: row.status,
    statusLabel: isOpportunityStatus(row.status) ? OPPORTUNITY_STATUS_LABELS[row.status] : row.status,
    lostReason: row.lostReason,
    wonAt: isoOrNull(row.wonAt),
    lostAt: isoOrNull(row.lostAt),
    lastActivityAt: row.lastActivityAt.toISOString(),
    lastInboundAt: isoOrNull(row.lastInboundAt),
    lastOutboundAt: isoOrNull(row.lastOutboundAt),
    tags: row.tags,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toActivityDTO(row: OpportunityActivity, names: ReadonlyMap<string, string> = new Map()): OpportunityActivityDTO {
  return {
    id: row.id,
    opportunityId: row.opportunityId,
    kind: row.kind,
    kindLabel: ACTIVITY_KIND_LABELS[row.kind as ActivityKind] ?? row.kind,
    refType: row.refType,
    refId: row.refId,
    summary: row.summary,
    payload: row.payload ?? null,
    userId: row.userId,
    userName: row.userId ? (names.get(row.userId) ?? null) : null,
    at: row.at.toISOString(),
  };
}

export function toRadarSignalDTO(row: RadarSignal, names: ReadonlyMap<string, string> = new Map()): RadarSignalDTO {
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: isRadarKind(row.kind) ? RADAR_KIND_LABELS[row.kind] : row.kind,
    subjectKey: row.subjectKey,
    opportunityId: row.opportunityId,
    conversationId: row.conversationId,
    quoteId: row.quoteId,
    zohoContactId: row.zohoContactId,
    commContactId: row.commContactId,
    customerName: row.customerName,
    salespersonUserId: row.salespersonUserId,
    salespersonName: row.salespersonUserId ? (names.get(row.salespersonUserId) ?? null) : null,
    score: row.score,
    reason: row.reason,
    data: row.data ?? null,
    computedAt: row.computedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: row.status,
    statusLabel: RADAR_STATUS_LABELS[row.status as RadarStatus] ?? row.status,
    snoozedUntil: isoOrNull(row.snoozedUntil),
    aiExplanation: row.aiExplanation,
    aiSuggestedMessage: row.aiSuggestedMessage,
    aiGeneratedAt: isoOrNull(row.aiGeneratedAt),
    version: row.version,
  };
}
