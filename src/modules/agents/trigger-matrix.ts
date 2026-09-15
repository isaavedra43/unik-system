import type { AgentLlmTrigger } from '@/modules/ai/agent-settings';
import { isAgentKey, agentKeyForArea, ADMIN_AGENT_KEY, type AgentKey } from './identity-catalog';

/**
 * Trigger matrix of the agents layer (plan 5.4). Pure: maps one operational
 * event (plus a small context the dispatcher reads) to the decisions to run.
 *
 * - `rule`: templates and core commands, ZERO model calls.
 * - `llm`: an automatic `⟦auto:…⟧` turn of the agent through `runAssistant`
 *   (or `maybeSummarizeCase` for `case_summary`), gated by the dispatcher
 *   guards (settings, mode, quiet hours, budget, human attending, caps, dedupe).
 *
 * Free text turns a rule into a model turn exactly where the plan says so, and only
 * when a PERSON wrote it (plan 5.3: free text is the one unstructured field written by
 * a person): `request.created` by a person with free text or kind `info` adds
 * `interpret_request` in the destination; `incident.opened` by a person with free text
 * becomes `triage` instead of the announcement; `case.replanned` only reaches the model
 * with a person's note. Text written by the engine (`system`) or by another AI turn
 * (`ai`) never reaches the model: an AI output never triggers another AI turn.
 *
 * Escalation levels of the core are 0-based (backup, area lead, administración,
 * incident): the plan's "level 3" is index ≥ 2 (`WORKITEM_LLM_ESCALATION_LEVEL`).
 */

export type TriggerMode = 'rule' | 'llm';

/** Job priority class: interactive (someone is waiting), normal, maintenance (background). */
export type TriggerPriority = 'normal' | 'interactive' | 'maintenance';

export const AGENT_RULE_TRIGGERS = [
  'ensure_case_room',
  'shortfall_to_purchase_request',
  'announce_request',
  'announce_request_update',
  'notify_workitem_overdue',
  'announce_incident',
  'announce_case_delivered',
] as const;

export type AgentRuleTrigger = (typeof AGENT_RULE_TRIGGERS)[number];

export const AGENT_LLM_DECISION_TRIGGERS = [
  'interpret_request',
  'unblock',
  'triage',
  'replan_check',
  'stuck_review',
  'mention',
  'action_failed',
  'case_summary',
] as const satisfies readonly AgentLlmTrigger[];

export type AgentLlmDecisionTrigger = (typeof AGENT_LLM_DECISION_TRIGGERS)[number];

/** Events that do not live in `OperationalEvent` but enter the matrix the same way. */
export const AGENT_SYNTHETIC_EVENTS = {
  /** From `onBotMentioned`: payload {agentKeys|agentKey, messageId, channelId, channelType, text?}. */
  mention: 'chat.mention_agent',
  /** From a failed approved proposal: payload {agentKey, proposalId, toolName, error}. */
  proposalFailed: 'proposal.failed',
} as const;

/** 0-based escalation level from which an overdue work item reaches the model (`unblock`). */
export const WORKITEM_LLM_ESCALATION_LEVEL = 2;

export interface TriggerEvent {
  /** OperationalEvent id (BigInt serialized) or a synthetic id (e.g. the chat message id). */
  id: string;
  type: string;
  caseId?: string | null;
  areaKey?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface TriggerContext {
  /**
   * Free text of the object, read by the dispatcher (AreaRequest.freeText,
   * incident description, customer note, chat message). Events never carry it.
   */
  freeText?: string | null;
  /** case.delivered: incidents the case had (open or closed). */
  incidentCount?: number | null;
  /** case.delivered: the one-time delivery summary already exists. */
  caseSummaryDone?: boolean;
}

export interface TriggerDetail {
  caseId?: string;
  areaKey?: string;
  requestId?: string;
  incidentId?: string;
  workItemId?: string;
  messageId?: string;
  channelId?: string;
  proposalId?: string;
  tool?: string;
  error?: string;
  /** Human free text (wrap as untrusted before any prompt). */
  text?: string;
  hoursOverdue?: number;
  escalationLevel?: number;
}

export interface TriggerDecision {
  mode: TriggerMode;
  agent: AgentKey;
  trigger: AgentRuleTrigger | AgentLlmDecisionTrigger;
  priority: TriggerPriority;
  /** Stable key for jobs and the 24 h trigger dedupe. */
  dedupeKey: string;
  /** Surface of the model turn: the case room when the event has a case, else the area. */
  surface: 'case' | 'area';
  /** Key of `settings.agents.llmTriggers` (null for rules). */
  llmTrigger: AgentLlmTrigger | null;
  eventId: string;
  eventType: string;
  detail: TriggerDetail;
}

/** Documentation mirror of the plan table (kept in sync by tests). */
export interface TriggerMatrixRow {
  event: string;
  condition: string;
  mode: TriggerMode;
  agent: 'admin' | 'origin' | 'destination' | 'area' | 'ventas' | 'inventario' | 'mentioned' | 'proposer';
  trigger: AgentRuleTrigger | AgentLlmDecisionTrigger;
  priority: TriggerPriority;
}

export const TRIGGER_MATRIX: readonly TriggerMatrixRow[] = [
  { event: 'case.started', condition: 'siempre (también case.created)', mode: 'rule', agent: 'admin', trigger: 'ensure_case_room', priority: 'normal' },
  { event: 'demand.shortfall_confirmed', condition: 'siempre', mode: 'rule', agent: 'inventario', trigger: 'shortfall_to_purchase_request', priority: 'normal' },
  { event: 'request.created', condition: 'siempre', mode: 'rule', agent: 'origin', trigger: 'announce_request', priority: 'normal' },
  { event: 'request.created', condition: 'creada por una persona con texto libre o kind info', mode: 'llm', agent: 'destination', trigger: 'interpret_request', priority: 'normal' },
  { event: 'request.acknowledged|accepted|resolved|rejected|cancelled|expired|blocked', condition: 'siempre', mode: 'rule', agent: 'destination', trigger: 'announce_request_update', priority: 'normal' },
  { event: 'request.overdue', condition: 'siempre', mode: 'llm', agent: 'destination', trigger: 'unblock', priority: 'interactive' },
  { event: 'request.blocked', condition: 'siempre', mode: 'llm', agent: 'origin', trigger: 'replan_check', priority: 'interactive' },
  { event: 'workitem.overdue|escalated', condition: 'nivel 1–2', mode: 'rule', agent: 'area', trigger: 'notify_workitem_overdue', priority: 'normal' },
  { event: 'workitem.escalated', condition: 'nivel ≥ 3 (índice ≥ 2), no por solicitud vencida', mode: 'llm', agent: 'area', trigger: 'unblock', priority: 'interactive' },
  { event: 'incident.opened', condition: 'sin texto libre de una persona', mode: 'rule', agent: 'area', trigger: 'announce_incident', priority: 'interactive' },
  { event: 'incident.opened', condition: 'abierta por una persona con texto libre', mode: 'llm', agent: 'area', trigger: 'triage', priority: 'interactive' },
  { event: 'case.replanned', condition: 'con nota de una persona', mode: 'llm', agent: 'ventas', trigger: 'replan_check', priority: 'normal' },
  { event: 'case.stuck', condition: 'siempre', mode: 'llm', agent: 'admin', trigger: 'stuck_review', priority: 'maintenance' },
  { event: 'chat.mention_agent', condition: 'por bot mencionado', mode: 'llm', agent: 'mentioned', trigger: 'mention', priority: 'interactive' },
  { event: 'proposal.failed', condition: 'siempre', mode: 'llm', agent: 'proposer', trigger: 'action_failed', priority: 'interactive' },
  { event: 'case.delivered', condition: 'siempre', mode: 'rule', agent: 'admin', trigger: 'announce_case_delivered', priority: 'maintenance' },
  { event: 'case.delivered', condition: 'hubo incidencias y aún no hay resumen', mode: 'llm', agent: 'admin', trigger: 'case_summary', priority: 'maintenance' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const num = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};

/** Longest free text carried into a decision (same as AreaRequest.freeText). */
export const TRIGGER_FREE_TEXT_MAX = 800;

/** The event was caused by a person (its free text may be interpreted by the model). */
export function isPersonEvent(event: Pick<TriggerEvent, 'actorType'>): boolean {
  return event.actorType === 'user';
}

/** Free text of the context, or of the payload fields a producer may set. */
export function freeTextOf(event: TriggerEvent, context: TriggerContext = {}): string | null {
  const payload = event.payload ?? {};
  const text =
    str(context.freeText) ?? str(payload.freeText) ?? str(payload.description) ?? str(payload.note) ?? null;
  return text ? text.replace(/\s+/g, ' ').slice(0, TRIGGER_FREE_TEXT_MAX) : null;
}

function compact(detail: TriggerDetail): TriggerDetail {
  const out: TriggerDetail = {};
  for (const [key, value] of Object.entries(detail) as Array<[keyof TriggerDetail, unknown]>) {
    if (value === undefined || value === null || value === '') continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function rule(
  event: TriggerEvent,
  agent: AgentKey,
  trigger: AgentRuleTrigger,
  priority: TriggerPriority,
  detail: TriggerDetail,
  dedupeKey = `rule:${trigger}:${event.id}`
): TriggerDecision {
  return {
    mode: 'rule',
    agent,
    trigger,
    priority,
    dedupeKey,
    surface: event.caseId ? 'case' : 'area',
    llmTrigger: null,
    eventId: event.id,
    eventType: event.type,
    detail: compact(detail),
  };
}

function llm(
  event: TriggerEvent,
  agent: AgentKey,
  trigger: AgentLlmDecisionTrigger,
  priority: TriggerPriority,
  objectRef: string,
  detail: TriggerDetail,
  surface: 'case' | 'area' = event.caseId ? 'case' : 'area'
): TriggerDecision {
  return {
    mode: 'llm',
    agent,
    trigger,
    priority,
    dedupeKey: `llm:${trigger}:${agent}:${objectRef}`,
    surface,
    llmTrigger: trigger,
    eventId: event.id,
    eventType: event.type,
    detail: compact(detail),
  };
}

function hours(minutes: number | null): number | undefined {
  return minutes !== null && minutes > 0 ? Math.round((minutes / 60) * 10) / 10 : undefined;
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

const REQUEST_UPDATE_TYPES = new Set([
  'request.acknowledged',
  'request.accepted',
  'request.resolved',
  'request.rejected',
  'request.cancelled',
  'request.expired',
  'request.blocked',
]);

/**
 * Decisions for one event, rules first. Unknown event types, or events missing
 * the ids a decision needs (case, request, area), yield no decision.
 */
export function matchTriggers(event: TriggerEvent, context: TriggerContext = {}): TriggerDecision[] {
  const payload = event.payload ?? {};
  const caseId = event.caseId ?? str(payload.caseId) ?? undefined;
  const base: TriggerDetail = { caseId: caseId ?? undefined };
  const decisions: TriggerDecision[] = [];

  switch (event.type) {
    case 'case.started':
    case 'case.created': {
      if (!caseId) return [];
      decisions.push(
        rule({ ...event, caseId }, ADMIN_AGENT_KEY, 'ensure_case_room', 'normal', base, `rule:ensure_case_room:case:${caseId}`)
      );
      return decisions;
    }

    case 'demand.shortfall_confirmed': {
      if (!caseId) return [];
      decisions.push(
        rule({ ...event, caseId }, 'area:inventario', 'shortfall_to_purchase_request', 'normal', {
          ...base,
          areaKey: 'inventario',
        })
      );
      return decisions;
    }

    case 'request.created': {
      const requestId = str(payload.requestId) ?? str(event.objectId);
      if (!requestId) return [];
      const fromArea = str(payload.fromAreaKey);
      const toArea = str(payload.toAreaKey) ?? str(event.areaKey);
      const origin = fromArea ? agentKeyForArea(fromArea) : null;
      const destination = toArea ? agentKeyForArea(toArea) : null;
      if (origin) {
        decisions.push(
          rule(event, origin, 'announce_request', 'normal', { ...base, requestId, areaKey: fromArea ?? undefined })
        );
      }
      const text = freeTextOf(event, context);
      if (destination && isPersonEvent(event) && (payload.kind === 'info' || payload.hasFreeText === true || text)) {
        decisions.push(
          llm(event, destination, 'interpret_request', 'normal', `request:${requestId}`, {
            ...base,
            requestId,
            areaKey: toArea ?? undefined,
            text: text ?? undefined,
          })
        );
      }
      return decisions;
    }

    case 'request.overdue': {
      const requestId = str(payload.requestId) ?? str(event.objectId);
      const toArea = str(payload.toAreaKey) ?? str(event.areaKey);
      const destination = toArea ? agentKeyForArea(toArea) : null;
      if (!requestId || !destination) return [];
      decisions.push(
        llm(event, destination, 'unblock', 'interactive', `request:${requestId}`, {
          ...base,
          requestId,
          areaKey: toArea ?? undefined,
          hoursOverdue: hours(num(payload.overdueMinutes)),
        })
      );
      return decisions;
    }

    case 'workitem.overdue':
    case 'workitem.escalated': {
      const workItemId = str(payload.workItemId) ?? str(event.objectId);
      const area = str(event.areaKey);
      const agent = area ? agentKeyForArea(area) : null;
      if (!workItemId || !agent) return [];
      const level = event.type === 'workitem.escalated' ? num(payload.level) : null;
      const detail: TriggerDetail = {
        ...base,
        workItemId,
        areaKey: area ?? undefined,
        hoursOverdue: hours(num(payload.overdueMinutes)),
        escalationLevel: level ?? undefined,
      };
      const fromRequest = payload.reason === 'request_overdue';
      if (level !== null && level >= WORKITEM_LLM_ESCALATION_LEVEL && !fromRequest) {
        decisions.push(llm(event, agent, 'unblock', 'interactive', `workitem:${workItemId}:level:${level}`, detail));
      } else {
        decisions.push(rule(event, agent, 'notify_workitem_overdue', 'normal', detail));
      }
      return decisions;
    }

    case 'incident.opened': {
      const incidentId = str(payload.incidentId) ?? str(event.objectId);
      const area = str(event.areaKey);
      const agent = area ? agentKeyForArea(area) : null;
      if (!incidentId || !agent) return [];
      const text = isPersonEvent(event) ? freeTextOf(event, context) : null;
      const detail: TriggerDetail = { ...base, incidentId, areaKey: area ?? undefined, text: text ?? undefined };
      if (text) {
        decisions.push(llm(event, agent, 'triage', 'interactive', `incident:${incidentId}`, detail));
      } else {
        decisions.push(rule(event, agent, 'announce_incident', 'interactive', detail));
      }
      return decisions;
    }

    case 'case.replanned': {
      if (!caseId) return [];
      const personNote = event.actorType === 'user' ? str(payload.reason) : null;
      const note = str(context.freeText) ?? str(payload.customerNote) ?? personNote;
      if (!note) return [];
      decisions.push(
        llm({ ...event, caseId }, 'area:ventas', 'replan_check', 'normal', `case:${caseId}:${event.id}`, {
          ...base,
          areaKey: 'ventas',
          text: note.replace(/\s+/g, ' ').slice(0, TRIGGER_FREE_TEXT_MAX),
        })
      );
      return decisions;
    }

    case 'case.stuck': {
      if (!caseId) return [];
      decisions.push(
        llm({ ...event, caseId }, ADMIN_AGENT_KEY, 'stuck_review', 'maintenance', `case:${caseId}`, {
          ...base,
          areaKey: 'administracion',
          hoursOverdue: hours(num(payload.idleMinutes)),
        })
      );
      return decisions;
    }

    case AGENT_SYNTHETIC_EVENTS.mention: {
      const messageId = str(payload.messageId) ?? str(event.objectId);
      if (!messageId) return [];
      const listed = Array.isArray(payload.agentKeys) ? payload.agentKeys : [payload.agentKey];
      const agents = [...new Set(listed.filter(isAgentKey))];
      const surface = payload.channelType === 'case' ? 'case' : 'area';
      const text = freeTextOf(event, context) ?? undefined;
      for (const agent of agents) {
        decisions.push(
          llm(
            event,
            agent,
            'mention',
            'interactive',
            `message:${messageId}`,
            {
              ...base,
              messageId,
              channelId: str(payload.channelId) ?? undefined,
              areaKey: str(event.areaKey) ?? undefined,
              text,
            },
            surface
          )
        );
      }
      return decisions;
    }

    case AGENT_SYNTHETIC_EVENTS.proposalFailed: {
      const proposalId = str(payload.proposalId) ?? str(event.objectId);
      const agent = payload.agentKey;
      if (!proposalId || !isAgentKey(agent)) return [];
      decisions.push(
        llm(event, agent, 'action_failed', 'interactive', `proposal:${proposalId}`, {
          ...base,
          proposalId,
          tool: str(payload.toolName) ?? undefined,
          error: str(payload.error)?.slice(0, 600) ?? undefined,
          areaKey: str(event.areaKey) ?? undefined,
        })
      );
      return decisions;
    }

    case 'case.delivered': {
      if (!caseId) return [];
      const scoped = { ...event, caseId };
      decisions.push(rule(scoped, ADMIN_AGENT_KEY, 'announce_case_delivered', 'maintenance', base));
      const incidents = num(context.incidentCount) ?? num(payload.incidentCount) ?? 0;
      if (incidents > 0 && !context.caseSummaryDone) {
        decisions.push(llm(scoped, ADMIN_AGENT_KEY, 'case_summary', 'maintenance', `case:${caseId}`, base));
      }
      return decisions;
    }

    default:
      break;
  }

  if (REQUEST_UPDATE_TYPES.has(event.type)) {
    const requestId = str(payload.requestId) ?? str(event.objectId);
    if (!requestId) return [];
    const toArea = str(payload.toAreaKey) ?? str(event.areaKey);
    const destination = toArea ? agentKeyForArea(toArea) : null;
    if (destination) {
      decisions.push(
        rule(event, destination, 'announce_request_update', 'normal', {
          ...base,
          requestId,
          areaKey: toArea ?? undefined,
          text: event.type === 'request.blocked' ? (freeTextOf(event, context) ?? undefined) : undefined,
        })
      );
    }
    if (event.type === 'request.blocked') {
      const fromArea = str(payload.fromAreaKey);
      const origin = fromArea ? agentKeyForArea(fromArea) : null;
      if (origin) {
        const reason = str(payload.reason) ?? freeTextOf(event, context);
        decisions.push(
          llm(event, origin, 'replan_check', 'interactive', `request:${requestId}`, {
            ...base,
            requestId,
            areaKey: fromArea ?? undefined,
            text: reason ? reason.replace(/\s+/g, ' ').slice(0, TRIGGER_FREE_TEXT_MAX) : undefined,
          })
        );
      }
    }
  }
  return decisions;
}

/** Event types the matrix reacts to (for the dispatcher's cheap pre-filter). */
export const TRIGGER_EVENT_TYPES: ReadonlySet<string> = new Set([
  'case.started',
  'case.created',
  'demand.shortfall_confirmed',
  'request.created',
  'request.overdue',
  ...REQUEST_UPDATE_TYPES,
  'workitem.overdue',
  'workitem.escalated',
  'incident.opened',
  'case.replanned',
  'case.stuck',
  AGENT_SYNTHETIC_EVENTS.mention,
  AGENT_SYNTHETIC_EVENTS.proposalFailed,
  'case.delivered',
]);

export function isTriggerEventType(type: string): boolean {
  return TRIGGER_EVENT_TYPES.has(type);
}
