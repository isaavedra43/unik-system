import { ACTIVITY_REF_TYPES, type ActivityKind } from './types';

/**
 * Pure rules of opportunities (plan 6.5): stage moves and the status they
 * imply, what a message does to an opportunity, activity kinds of quotes,
 * open objections and small formatting helpers shared by services and radar.
 */

export interface StageRef {
  id: string;
  key: string;
  name: string;
  order: number;
  kind: string;
  active: boolean;
}

export interface OpportunityStageState {
  status: string;
  stageId: string;
}

export interface StageMoveData {
  stageId: string;
  stageEnteredAt: Date;
  status: 'open' | 'won' | 'lost';
  wonAt: Date | null;
  lostAt: Date | null;
  lostReason: string | null;
}

export type StageMovePlan =
  | {
      ok: true;
      data: StageMoveData;
      /** won | lost | reopened (from won, lost or dormant) | null (open → open) */
      transition: 'won' | 'lost' | 'reopened' | null;
    }
  | { ok: false; code: 'invalid_state' | 'invalid_payload'; message: string };

const LOST_REASON_MIN = 3;
const LOST_REASON_MAX = 500;

/**
 * Moving to a stage sets the status from the stage kind: `won` stamps `wonAt`,
 * `lost` requires a reason and stamps `lostAt`, an open stage reopens a won,
 * lost or dormant opportunity (clearing the closing fields).
 */
export function planStageMove(
  current: OpportunityStageState,
  target: StageRef,
  input: { lostReason?: string | null; now: Date }
): StageMovePlan {
  if (!target.active) {
    return { ok: false, code: 'invalid_state', message: `La etapa «${target.name}» está desactivada` };
  }
  if (target.id === current.stageId && (target.kind !== 'open' || current.status === 'open')) {
    return { ok: false, code: 'invalid_state', message: `La oportunidad ya está en la etapa «${target.name}»` };
  }
  const base = { stageId: target.id, stageEnteredAt: input.now };
  if (target.kind === 'won') {
    return {
      ok: true,
      transition: 'won',
      data: { ...base, status: 'won', wonAt: input.now, lostAt: null, lostReason: null },
    };
  }
  if (target.kind === 'lost') {
    const reason = (input.lostReason ?? '').replace(/\s+/g, ' ').trim();
    if (reason.length < LOST_REASON_MIN) {
      return { ok: false, code: 'invalid_payload', message: 'Indica el motivo por el que se perdió la oportunidad' };
    }
    return {
      ok: true,
      transition: 'lost',
      data: { ...base, status: 'lost', wonAt: null, lostAt: input.now, lostReason: reason.slice(0, LOST_REASON_MAX) },
    };
  }
  return {
    ok: true,
    transition: current.status === 'open' ? null : 'reopened',
    data: { ...base, status: 'open', wonAt: null, lostAt: null, lostReason: null },
  };
}

/** Activity kind that describes a quote in a given Zoho status. */
export function quoteStatusActivityKind(status: string | null | undefined): ActivityKind {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'sent':
      return 'quote_sent';
    case 'viewed':
      return 'quote_viewed';
    case 'accepted':
    case 'invoiced':
      return 'quote_accepted';
    case 'declined':
      return 'quote_declined';
    default:
      return 'note';
  }
}

/** An open opportunity before the quoted stage advances to it when a quote is linked. */
export function shouldAdvanceToQuoted(
  opportunityStatus: string,
  current: Pick<StageRef, 'order' | 'kind'> | null,
  quoted: Pick<StageRef, 'order' | 'kind' | 'active'> | null
): boolean {
  if (opportunityStatus !== 'open' || !current || !quoted) return false;
  if (!quoted.active || quoted.kind !== 'open' || current.kind !== 'open') return false;
  return current.order < quoted.order;
}

// ---------------------------------------------------------------------------
// Conversation touches
// ---------------------------------------------------------------------------

export interface TouchMessage {
  direction: string;
  status: string;
  createdAt: Date;
}

export interface TouchOpportunityState {
  status: string;
  lastActivityAt: Date;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  conversationIds: readonly string[];
}

export const FAILED_OUTBOUND_STATUSES: readonly string[] = ['failed', 'undelivered'];

export type TouchPlan =
  | { skip: 'failed_outbound' | 'closed' | 'unknown_direction' }
  | {
      skip: null;
      activityKind: 'message_in' | 'message_out';
      reactivate: boolean;
      data: {
        lastActivityAt: Date;
        lastInboundAt?: Date;
        lastOutboundAt?: Date;
        conversationIds?: string[];
        status?: 'open';
      };
    };

const later = (a: Date | null, b: Date): Date => (a && a.getTime() > b.getTime() ? a : b);

/**
 * What a stored message does to an opportunity: timestamps only move forward
 * (out-of-order deliveries never rewind them), the conversation is linked, a
 * failed outbound message is not a touch and an inbound message wakes a dormant
 * opportunity. Won and lost opportunities are not touched.
 */
export function planConversationTouch(
  state: TouchOpportunityState,
  message: TouchMessage,
  conversationId: string
): TouchPlan {
  if (state.status !== 'open' && state.status !== 'dormant') return { skip: 'closed' };
  const inbound = message.direction === 'inbound';
  if (!inbound && message.direction !== 'outbound') return { skip: 'unknown_direction' };
  if (!inbound && FAILED_OUTBOUND_STATUSES.includes(message.status)) return { skip: 'failed_outbound' };
  const data: Extract<TouchPlan, { skip: null }>['data'] = {
    lastActivityAt: later(state.lastActivityAt, message.createdAt),
  };
  if (inbound) data.lastInboundAt = later(state.lastInboundAt, message.createdAt);
  else data.lastOutboundAt = later(state.lastOutboundAt, message.createdAt);
  if (!state.conversationIds.includes(conversationId)) {
    data.conversationIds = [...state.conversationIds, conversationId];
  }
  const reactivate = inbound && state.status === 'dormant';
  if (reactivate) data.status = 'open';
  return { skip: null, activityKind: inbound ? 'message_in' : 'message_out', reactivate, data };
}

/** One-line preview of a message for the timeline. */
export function messageActivitySummary(direction: string, body: string | null | undefined, mediaCount = 0): string {
  const text = truncateText(body, 160);
  const inbound = direction === 'inbound';
  if (!text) {
    if (mediaCount > 0) return inbound ? 'El cliente envió un adjunto' : 'Se envió un adjunto';
    return inbound ? 'Mensaje del cliente' : 'Mensaje enviado';
  }
  return inbound ? `Cliente: «${text}»` : `Enviado: «${text}»`;
}

// ---------------------------------------------------------------------------
// Objections
// ---------------------------------------------------------------------------

export interface ObjectionActivityLike {
  id: string;
  kind: string;
  refType?: string | null;
  refId?: string | null;
  at: Date;
  summary: string;
}

/**
 * Objections still open, oldest first. An `objection_resolved` that references
 * an objection (`refType = opportunity_activity`) closes that one; without a
 * reference it closes every objection recorded before it.
 */
export function openObjections<T extends ObjectionActivityLike>(activities: readonly T[]): T[] {
  const sorted = [...activities].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  const open = new Map<string, T>();
  for (const activity of sorted) {
    if (activity.kind === 'objection') {
      open.set(activity.id, activity);
    } else if (activity.kind === 'objection_resolved') {
      if (activity.refType === ACTIVITY_REF_TYPES.activity && activity.refId) {
        open.delete(activity.refId);
      } else {
        for (const [id, objection] of open) {
          if (objection.at.getTime() <= activity.at.getTime()) open.delete(id);
        }
      }
    }
  }
  return [...open.values()];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Stable union of ids (existing order first, blanks dropped). */
export function mergeIds(existing: readonly string[], add: ReadonlyArray<string | null | undefined>): string[] {
  const out = [...existing];
  for (const id of add) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function truncateText(text: string | null | undefined, max: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** 12500 → "$12,500.00" (es-MX); an unknown currency falls back to the amount with its code. */
export function formatMoney(amount: number | string | null | undefined, currency: string | null | undefined = 'MXN'): string {
  const n = typeof amount === 'number' ? amount : Number(amount ?? 0);
  const value = Number.isFinite(n) ? n : 0;
  const code = (currency || 'MXN').toUpperCase();
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: code }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

/** Decimal | number | string | null → finite number or null. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}
