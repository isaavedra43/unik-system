import { createHash } from 'node:crypto';
import type { AgentIdentity } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { isKnownPermission } from '@/modules/auth/permissions';
import { estimateCost, isFlatRateModel } from '@/modules/ai/ai-admin-service';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import type { OrchestratorAgentContext, OrchestratorContext } from '@/modules/ai/ai-orchestrator';
import {
  autoTriggerMessage,
  getOrCreateSurfaceConversation,
  type AutoTrigger,
  type SurfaceRef,
} from '@/modules/ai/copilot-surfaces';
import type { ChatMessageDTO, ChatMessageMeta } from '@/modules/chat/chat-events';
import type { ApproverScope } from '@/modules/extensions/proposals-service';
import { notifyUser, type NotifyInput } from '@/modules/notifications/notification-service';
import { resolveAreaAssignee } from '@/modules/operations/commands';
import { recordOperationalEvents } from '@/modules/operations/events-service';
import { isAreaKey, OPS_EVENTS, type AreaKey } from '@/modules/operations/types';
import { ensureAreaChannel, ensureCaseRoom, postAsAgent, type PostAsAgentOptions } from './chat-bridge';
import {
  AgentIdentityError,
  buildBotActor,
  coveredAreaOf,
  getAgentIdentity,
  isAgentKey,
  type AgentKey,
} from './identities';
import { userNames } from './prompts/shared';
import { neutralizeMentions, renderAgentMessage } from './templates';
import type { AgentLlmDecisionTrigger, TriggerDetail } from './trigger-matrix';

/**
 * Runner of ONE automatic turn of an agent identity (plan 5.4). It does not
 * call any model by itself: the turn is an ordinary `⟦auto:…⟧` message of the
 * bot user through the existing orchestrator (`runAssistant`), on the bot's
 * surface conversation (case room or area), with `context.agent` so the
 * orchestrator applies the identity's tool allowlist, the iteration cap, the
 * forced tool output and the usage metering.
 *
 * - `proposal` events → the approval card is posted in the room
 *   (`meta.kind = 'agent_proposal'`) and every human of the approver scope is
 *   notified (`agent_proposal`).
 * - `done` → `ai.turn` event (tokens, cost, model, tools, proposals, trigger
 *   hash) and, only when `concludeAgentTurn.outcome !== 'no_action'`, its
 *   message as one line of the bot (`agent_reply`).
 * - `error` or an exception → `ai.turn_failed`, never retried: templates were
 *   already posted by the dispatcher and the core never depends on a turn.
 * - When the provider rejects `tool_choice: 'required'`, the turn is retried
 *   once asking for `concludeAgentTurn` by name (`agent.forceToolName`).
 *
 * Usage is NOT recorded here: the orchestrator already calls `recordAgentUsage`.
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'agents-runner', event, ...extra }));

const warn = (event: string, extra: Record<string, unknown> = {}) =>
  console.warn(JSON.stringify({ component: 'agents-runner', event, ...extra }));

export const CONCLUDE_TOOL = 'concludeAgentTurn';

/** Longest line the runner publishes from `concludeAgentTurn.message`. */
export const AGENT_TURN_MESSAGE_MAX = 300;

/** UI chips of the orchestrator that are not tools. */
const UI_CHIP_TOOLS = new Set(['draftAnswer', 'reviewAnswer']);

export const AGENT_TURN_OUTCOMES = ['acted', 'no_action', 'needs_human'] as const;
export type AgentTurnOutcome = (typeof AGENT_TURN_OUTCOMES)[number];

/** Model triggers that run as a turn (`case_summary` runs through `maybeSummarizeCase`). */
export type AgentTurnTrigger = Exclude<AgentLlmDecisionTrigger, 'case_summary'> & AutoTrigger;

const AGENT_TURN_TRIGGERS: readonly AgentTurnTrigger[] = [
  'interpret_request',
  'unblock',
  'triage',
  'replan_check',
  'stuck_review',
  'mention',
  'action_failed',
];

export function isAgentTurnTrigger(value: unknown): value is AgentTurnTrigger {
  return typeof value === 'string' && (AGENT_TURN_TRIGGERS as readonly string[]).includes(value);
}

/**
 * Agent context accepted by the orchestrator plus the named-tool fallback.
 * `forceToolName` asks the first model call for that tool by name instead of
 * `tool_choice: 'required'` (providers that reject 'required').
 */
export type AgentContextWithForcedTool = OrchestratorAgentContext & { forceToolName?: string };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Stable 32-hex hash of a trigger dedupe key (stored in `ai.turn*` events). Pure. */
export function triggerHashOf(dedupeKey: string): string {
  return createHash('sha256').update(dedupeKey).digest('hex').slice(0, 32);
}

/** One line of at most `max` characters (whitespace collapsed). Pure. */
export function oneLine(value: unknown, max = AGENT_TURN_MESSAGE_MAX): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

export interface AgentTurnConclusion {
  outcome: AgentTurnOutcome;
  message: string | null;
}

const conclusionSchema = z.object({
  outcome: z.enum(AGENT_TURN_OUTCOMES),
  message: z.string().max(4000).nullish(),
});

/** Arguments of `concludeAgentTurn` (JSON text or object) → conclusion; null when invalid. Pure. */
export function parseConclusion(args: unknown): AgentTurnConclusion | null {
  let value: unknown = args;
  if (typeof args === 'string') {
    try {
      value = JSON.parse(args);
    } catch {
      return null;
    }
  }
  const parsed = conclusionSchema.safeParse(value);
  if (!parsed.success) return null;
  const message = oneLine(parsed.data.message ?? '');
  return { outcome: parsed.data.outcome, message: message || null };
}

/**
 * True when a provider error says the tool-choice policy is not supported
 * (e.g. "tool_choice 'required' is not supported by this model"). Pure.
 */
export function isToolChoiceUnsupportedError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : str(asRecord(err).message) ?? '';
  const text = message.toLowerCase();
  if (!/tool[_\s-]?choice|function[_\s-]?calling[_\s-]?(mode|config)/.test(text)) return false;
  return /(not\s+supported|unsupported|not\s+support|invalid|not\s+allowed|unknown|not\s+available|only\s+(supports?\s+)?["'`]?auto|must\s+be|does\s+not\s+accept|cannot)/.test(
    text
  );
}

/** Object the turn is about, for the `ai.turn*` event columns. Pure. */
export function turnObjectRef(detail: TriggerDetail): { objectType: string | null; objectId: string | null } {
  if (detail.requestId) return { objectType: 'area_request', objectId: detail.requestId };
  if (detail.incidentId) return { objectType: 'incident', objectId: detail.incidentId };
  if (detail.workItemId) return { objectType: 'work_item', objectId: detail.workItemId };
  if (detail.proposalId) return { objectType: 'ai_proposal', objectId: detail.proposalId };
  if (detail.messageId) return { objectType: 'chat_message', objectId: detail.messageId };
  if (detail.caseId) return { objectType: 'operational_case', objectId: detail.caseId };
  return { objectType: null, objectId: null };
}

/** Area the turn works on: the detail's area, else the area the identity covers. Pure. */
export function turnTargetArea(agentKey: AgentKey, detail: TriggerDetail): AreaKey {
  return isAreaKey(detail.areaKey) ? detail.areaKey : (coveredAreaOf(agentKey) ?? 'administracion');
}

/**
 * Surface conversation of a turn: the case room thread when the decision is on
 * the case surface and has a case, else the area thread. Pure.
 */
export function turnSurfaceRef(
  agentKey: AgentKey,
  surface: 'case' | 'area',
  detail: TriggerDetail
): SurfaceRef & { kind: 'case' | 'area' } {
  if (surface === 'case' && detail.caseId) return { kind: 'case', id: detail.caseId };
  return { kind: 'area', id: turnTargetArea(agentKey, detail) };
}

// ---------------------------------------------------------------------------
// Channels and posts (shared with the dispatcher rules)
// ---------------------------------------------------------------------------

/** Chat room of a case (created when missing). */
export async function caseRoomChannelId(caseId: string): Promise<string> {
  const row = await prisma.operationalCase.findUnique({
    where: { id: caseId },
    select: { chatChannelId: true },
  });
  return row?.chatChannelId ?? (await ensureCaseRoom(caseId)).id;
}

/** Chat channel of an area (created when missing). */
export async function areaChannelId(areaKey: AreaKey): Promise<string> {
  const row = await prisma.area.findUnique({ where: { key: areaKey }, select: { chatChannelId: true } });
  return row?.chatChannelId ?? (await ensureAreaChannel(areaKey)).id;
}

/** Room of a turn: the mention's channel, the case room or the area channel. */
export async function resolveTurnChannel(input: {
  surface: 'case' | 'area';
  caseId?: string | null;
  areaKey: AreaKey;
  channelId?: string | null;
}): Promise<string> {
  if (input.channelId) return input.channelId;
  if (input.surface === 'case' && input.caseId) return caseRoomChannelId(input.caseId);
  return areaChannelId(input.areaKey);
}

/** How far back a repeated post of the same dedupe key is looked for. */
const POST_DEDUPE_SCAN = 200;

/** Id of a message of this channel created since `since` whose `meta.dedupeKey` matches. */
export async function findPostedMessage(
  channelId: string,
  dedupeKey: string,
  since: Date
): Promise<string | null> {
  const recent = await prisma.internalChatMessage.findMany({
    where: { channelId, createdAt: { gte: since } },
    select: { id: true, meta: true },
    orderBy: { createdAt: 'desc' },
    take: POST_DEDUPE_SCAN,
  });
  return recent.find((m) => asRecord(m.meta).dedupeKey === dedupeKey)?.id ?? null;
}

export interface PostOnceResult {
  posted: boolean;
  messageId: string;
  dto: ChatMessageDTO | null;
}

/**
 * Posts as the agent unless a message with the same `meta.dedupeKey` already
 * exists in the channel since `since` (a re-delivered job or a second listener
 * never posts twice).
 */
export async function postAgentMessageOnce(
  agentKey: AgentKey,
  channelId: string,
  text: string,
  meta: ChatMessageMeta & { dedupeKey: string },
  options: PostAsAgentOptions & { since: Date }
): Promise<PostOnceResult> {
  const existing = await findPostedMessage(channelId, meta.dedupeKey, options.since);
  if (existing) return { posted: false, messageId: existing, dto: null };
  const dto = await postAsAgent(agentKey, channelId, text, meta, {
    replyToId: options.replyToId ?? null,
    priority: options.priority ?? 'normal',
  });
  return { posted: true, messageId: dto.id, dto };
}

/** Notification that never breaks the caller. */
export async function notifySafely(input: NotifyInput): Promise<void> {
  try {
    await notifyUser(input);
  } catch (err) {
    warn('notify_failed', {
      userId: input.userId,
      category: input.category,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export const chatChannelUrl = (channelId: string) => `/app/chat?channel=${encodeURIComponent(channelId)}`;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AgentTurnEventType =
  | typeof OPS_EVENTS.ai.turn
  | typeof OPS_EVENTS.ai.turnSkipped
  | typeof OPS_EVENTS.ai.turnFailed;

export interface AgentTurnEventInput {
  type: AgentTurnEventType;
  agentKey: string;
  botUserId: string | null;
  trigger: string;
  triggerHash?: string | null;
  detail: TriggerDetail;
  eventId?: string | null;
  eventType?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

/** Appends an `ai.turn*` event (audit, caps, dedupe). Failures are logged, never thrown. */
export async function recordAgentTurnEvent(input: AgentTurnEventInput): Promise<string | null> {
  const areaKey = isAreaKey(input.detail.areaKey)
    ? input.detail.areaKey
    : (coveredAreaOf(input.agentKey) ?? null);
  const { objectType, objectId } = turnObjectRef(input.detail);
  try {
    const [record] = await recordOperationalEvents([
      {
        type: input.type,
        actorType: 'ai',
        actorId: input.botUserId,
        caseId: input.detail.caseId ?? null,
        areaKey,
        objectType,
        objectId,
        occurredAt: input.occurredAt,
        payload: {
          agentKey: input.agentKey,
          trigger: input.trigger,
          triggerHash: input.triggerHash ?? null,
          eventId: input.eventId ?? null,
          eventType: input.eventType ?? null,
          ...input.payload,
        },
      },
    ]);
    return record?.id ?? null;
  } catch (err) {
    warn('turn_event_failed', {
      type: input.type,
      agentKey: input.agentKey,
      trigger: input.trigger,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Approver scope
// ---------------------------------------------------------------------------

/**
 * Module approval permissions that make a person an approver of the area's
 * proposals (first key present in the registry wins). Areas without an approval
 * permission of their own use the key that holds the area's decisions; when no
 * candidate exists the scope is the responsible and backup of the area.
 */
export const AREA_APPROVER_PERMISSION_CANDIDATES: Readonly<Record<AreaKey, readonly string[]>> = {
  ventas: ['crm.manage'],
  compras: ['purchases.approve'],
  inventario: ['inventory.manage'],
  manufactura: ['manufacturing.approve_incidents'],
  logistica: ['logistics.manage_fleet'],
  contabilidad: ['finance.approve'],
  administracion: [],
};

/**
 * Who approves the proposals of a turn: responsible and backup of the target
 * area (active humans only; a bot is never an approver), plus the area's
 * registered approval permission when one exists.
 */
export async function resolveTurnApproverScope(input: {
  areaKey: AreaKey;
  caseId?: string | null;
}): Promise<ApproverScope> {
  const scope: ApproverScope = {
    ...(input.caseId ? { caseId: input.caseId } : {}),
    areaKey: input.areaKey,
    userIds: [],
  };
  const permission = AREA_APPROVER_PERMISSION_CANDIDATES[input.areaKey].find((key) => isKnownPermission(key));
  if (permission) scope.permission = permission;
  try {
    const assignee = await resolveAreaAssignee(prisma, input.areaKey);
    const candidates = [assignee.ownerUserId, assignee.backupUserId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0
    );
    if (candidates.length > 0) {
      const humans = await prisma.user.findMany({
        where: { id: { in: candidates }, isActive: true, isBot: false },
        select: { id: true },
      });
      const allowed = new Set(humans.map((h) => h.id));
      scope.userIds = [...new Set(candidates.filter((id) => allowed.has(id)))];
    }
  } catch (err) {
    warn('approver_scope_unresolved', {
      areaKey: input.areaKey,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

export interface AgentTurnInput {
  agentKey: string;
  surface: 'case' | 'area';
  trigger: AgentTurnTrigger;
  detail: TriggerDetail;
  /** Hash of the decision dedupe key (the dispatcher's 24 h dedupe reads it back). */
  triggerHash?: string;
  eventId?: string | null;
  eventType?: string | null;
  /** Already loaded by the dispatcher (avoids reading them twice). */
  identity?: AgentIdentity;
  actor?: CurrentUser;
  conversationId?: string;
  now?: Date;
  /** Mention turns: the person who mentioned the bot (tools act and read with that person's limits). */
  onBehalfOfUserId?: string | null;
  /** Mention turns in a case room: the room's case. */
  lockedCaseId?: string | null;
  /** Human who caused the turn (mention sender or human actor of the event). */
  causedByUserId?: string | null;
}

export interface AgentTurnResult {
  status: 'done' | 'failed';
  outcome: AgentTurnOutcome | null;
  /** Line published in the room (conclusion message), if any. */
  message: string | null;
  postedMessageId: string | null;
  proposalIds: string[];
  toolsUsed: string[];
  promptTokens: number;
  completionTokens: number;
  model: string | null;
  costUsd: number;
  flatRate: boolean;
  retriedWithNamedTool: boolean;
  conversationId: string | null;
  turnEventId: string | null;
  errorCode?: string;
  error?: string;
}

interface StreamEvent {
  type: string;
  data?: unknown;
}

interface CostSettings {
  providerConfigs?: Awaited<ReturnType<typeof getAiSettings>>['providerConfigs'];
}

async function costOf(model: string, promptTokens: number, completionTokens: number): Promise<{ usd: number; flatRate: boolean }> {
  let ctx: CostSettings = {};
  try {
    ctx = { providerConfigs: (await getAiSettings()).providerConfigs };
  } catch {
    ctx = {};
  }
  const flatRate = isFlatRateModel(model, ctx);
  const usd = flatRate ? 0 : Math.round(estimateCost(promptTokens, completionTokens, model, ctx) * 1e6) / 1e6;
  return { usd, flatRate };
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const now = input.now ?? new Date();
  const detail: TriggerDetail = { ...input.detail };
  const triggerHash =
    input.triggerHash ?? triggerHashOf(`llm:${input.trigger}:${input.agentKey}:${input.eventId ?? now.toISOString()}`);
  const result: AgentTurnResult = {
    status: 'failed',
    outcome: null,
    message: null,
    postedMessageId: null,
    proposalIds: [],
    toolsUsed: [],
    promptTokens: 0,
    completionTokens: 0,
    model: null,
    costUsd: 0,
    flatRate: false,
    retriedWithNamedTool: false,
    conversationId: null,
    turnEventId: null,
  };
  const eventBase = {
    agentKey: input.agentKey,
    trigger: input.trigger,
    triggerHash,
    eventId: input.eventId ?? null,
    eventType: input.eventType ?? null,
    occurredAt: now,
  };

  const fail = async (errorCode: string, error: string, botUserId: string | null, extra: Record<string, unknown> = {}) => {
    result.status = 'failed';
    result.errorCode = errorCode;
    result.error = error;
    result.turnEventId = await recordAgentTurnEvent({
      ...eventBase,
      type: OPS_EVENTS.ai.turnFailed,
      botUserId,
      detail,
      payload: {
        errorCode,
        error: oneLine(error, 600),
        surface: input.surface,
        conversationId: result.conversationId,
        toolsUsed: result.toolsUsed,
        proposalIds: result.proposalIds,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        model: result.model,
        retriedWithNamedTool: result.retriedWithNamedTool,
        ...extra,
      },
    });
    log('turn_failed', { agentKey: input.agentKey, trigger: input.trigger, errorCode, error: oneLine(error, 300) });
    return result;
  };

  if (!isAgentKey(input.agentKey)) return fail('unknown_agent', `Agente desconocido: ${input.agentKey}`, null);
  if (!isAgentTurnTrigger(input.trigger)) return fail('invalid_trigger', `Disparo inválido: ${String(input.trigger)}`, null);
  const agentKey = input.agentKey;
  const identity = input.identity ?? (await getAgentIdentity(agentKey));
  if (!identity) return fail('identity_missing', `No existe la identidad ${agentKey}`, null);

  let actor: CurrentUser;
  try {
    actor = input.actor ?? (await buildBotActor(agentKey));
  } catch (err) {
    const code = err instanceof AgentIdentityError ? err.code : 'identity_error';
    return fail(code, err instanceof Error ? err.message : String(err), identity.botUserId);
  }

  const caseId = detail.caseId ?? null;
  const targetArea = turnTargetArea(agentKey, detail);
  detail.areaKey = targetArea;
  const surfaceRef = turnSurfaceRef(agentKey, input.surface, detail);
  const surface = surfaceRef.kind;

  try {
    result.conversationId = input.conversationId ?? (await getOrCreateSurfaceConversation(actor, surfaceRef)).id;
  } catch (err) {
    return fail('conversation_failed', err instanceof Error ? err.message : String(err), identity.botUserId);
  }
  const conversationId = result.conversationId;

  const approverScope = await resolveTurnApproverScope({ areaKey: targetArea, caseId });
  const agentContext: AgentContextWithForcedTool = {
    identityId: identity.id,
    areaKey: identity.areaKey ?? null,
    trigger: input.trigger,
    botUserId: identity.botUserId,
    agentKey,
    approverScope,
    ...(input.onBehalfOfUserId ? { onBehalfOfUserId: input.onBehalfOfUserId } : {}),
    ...(input.lockedCaseId ? { lockedCaseId: input.lockedCaseId } : {}),
    ...(input.causedByUserId ? { causedByUserId: input.causedByUserId } : {}),
  };
  const message = autoTriggerMessage(input.trigger, surface, {
    tool: detail.tool,
    error: detail.error,
    requestId: detail.requestId,
    incidentId: detail.incidentId,
    workItemId: detail.workItemId,
    proposalId: detail.proposalId,
    caseId: caseId ?? undefined,
    messageId: detail.messageId,
    text: detail.text,
    hoursOverdue: detail.hoursOverdue,
    areaKey: targetArea,
  });
  const contextFor = (agent: AgentContextWithForcedTool): OrchestratorContext =>
    surface === 'case' && caseId ? { caseId, agent } : { areaKey: targetArea, agent };

  let channelPromise: Promise<string> | null = null;
  const channel = () =>
    (channelPromise ??= resolveTurnChannel({ surface, caseId, areaKey: targetArea, channelId: detail.channelId }));
  let casePromise: Promise<{ caseNumber: string; salesOrderNumber: string | null } | null> | null = null;
  const caseRef = () =>
    (casePromise ??= caseId
      ? prisma.operationalCase.findUnique({
          where: { id: caseId },
          select: { caseNumber: true, salesOrderNumber: true },
        })
      : Promise.resolve(null));

  const toolsUsed: string[] = [];
  let toolCalls = 0;
  let pendingConclusion: AgentTurnConclusion | null = null;
  let conclusion: AgentTurnConclusion | null = null;
  let done: Record<string, unknown> | null = null;
  let streamError: string | null = null;

  const publishProposal = async (data: Record<string, unknown>) => {
    const proposalId = str(data.id);
    if (!proposalId || result.proposalIds.includes(proposalId)) return;
    result.proposalIds.push(proposalId);
    try {
      const [channelId, ref, names] = await Promise.all([channel(), caseRef(), userNames(approverScope.userIds)]);
      const approverName = approverScope.userIds
        .map((id) => names.get(id))
        .filter((name): name is string => Boolean(name))
        .join(' o ');
      const summary = oneLine(data.summary, 400);
      const toolName = str(data.toolName);
      const expiresAt = str(data.expiresAt) ?? (data.expiresAt instanceof Date ? data.expiresAt.toISOString() : null);
      const rendered = renderAgentMessage('proposal.created', {
        now,
        agentName: identity.displayName,
        proposalSummary: summary,
        toolName,
        expiresAt,
        approverName: approverName || null,
        caseNumber: ref?.caseNumber ?? null,
        salesOrderNumber: ref?.salesOrderNumber ?? null,
      });
      const dto = await postAsAgent(agentKey, channelId, rendered.text, {
        kind: 'agent_proposal',
        proposalId,
        caseId,
        areaKey: targetArea,
        toolName,
        summary,
        effect: str(data.effect),
        expiresAt,
        status: 'pending',
        approverUserIds: approverScope.userIds,
      });
      // Same fact in the case timeline as in the room (the card itself is only a chat message).
      try {
        await recordOperationalEvents([
          {
            type: OPS_EVENTS.ai.proposalCreated,
            actorType: 'ai',
            actorId: identity.botUserId,
            caseId,
            areaKey: targetArea,
            objectType: 'ai_proposal',
            objectId: proposalId,
            occurredAt: new Date(),
            payload: { agentKey, toolName, summary, chatMessageId: dto.id, approverUserIds: approverScope.userIds, trigger: input.trigger },
          },
        ]);
      } catch (err) {
        warn('proposal_event_failed', { agentKey, proposalId, message: err instanceof Error ? err.message : String(err) });
      }
      for (const userId of approverScope.userIds) {
        await notifySafely({
          userId,
          category: 'agent_proposal',
          type: 'agent_proposal_created',
          title: `${identity.displayName} propone: ${summary || toolName || 'una acción'}`.slice(0, 200),
          body: rendered.text,
          url: chatChannelUrl(channelId),
          entityType: 'ai_proposal',
          entityId: proposalId,
          metadata: { agentKey, caseId, areaKey: targetArea, chatMessageId: dto.id },
          dedupeKey: `agent_proposal:${proposalId}:${userId}`,
        });
      }
    } catch (err) {
      warn('proposal_card_failed', {
        agentKey,
        proposalId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handle = async (event: StreamEvent) => {
    const data = asRecord(event.data);
    switch (event.type) {
      case 'tool_call_start':
        if (data.name === CONCLUDE_TOOL) pendingConclusion = parseConclusion(data.args);
        break;
      case 'tool_call_end': {
        const name = str(data.name);
        if (!name || UI_CHIP_TOOLS.has(name)) break;
        toolCalls += 1;
        if (!toolsUsed.includes(name)) toolsUsed.push(name);
        if (name === CONCLUDE_TOOL && data.success === true && pendingConclusion) conclusion = pendingConclusion;
        break;
      }
      case 'proposal':
        await publishProposal(data);
        break;
      case 'done':
        done = data;
        break;
      case 'error':
        streamError = str(data.message) ?? 'El asistente no pudo completar el turno';
        break;
      default:
        break;
    }
  };

  const { runAssistant } = await import('@/modules/ai/ai-orchestrator');
  let thrown: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // The retry reuses the directive the failed attempt already wrote in the bot thread.
    const agent: AgentContextWithForcedTool =
      attempt === 0 ? agentContext : { ...agentContext, forceToolName: CONCLUDE_TOOL, reuseUserMessage: true };
    try {
      for await (const event of runAssistant({ conversationId, message, actor, context: contextFor(agent) })) {
        await handle(event as StreamEvent);
      }
      thrown = null;
      break;
    } catch (err) {
      thrown = err;
      const untouched = toolCalls === 0 && result.proposalIds.length === 0 && !done;
      if (attempt === 0 && untouched && isToolChoiceUnsupportedError(err)) {
        result.retriedWithNamedTool = true;
        log('tool_choice_fallback', { agentKey, trigger: input.trigger });
        continue;
      }
      break;
    }
  }
  result.toolsUsed = toolsUsed;

  const finished = done as Record<string, unknown> | null;
  if (finished) {
    result.promptTokens = num(finished.promptTokens);
    result.completionTokens = num(finished.completionTokens);
    result.model = str(finished.model);
  }
  const concluded = conclusion as AgentTurnConclusion | null;
  if (thrown && !concluded) {
    return fail('provider_error', thrown instanceof Error ? thrown.message : String(thrown), identity.botUserId);
  }
  // A turn that already concluded is finished even if the stream ended with an error afterwards
  // (e.g. a provider cut): its proposals and conclusion are real and must be published and counted.
  if (streamError && !concluded) return fail('turn_error', streamError, identity.botUserId);
  if (!finished && !concluded) return fail('no_result', 'El turno terminó sin respuesta', identity.botUserId);

  if (result.model) {
    const cost = await costOf(result.model, result.promptTokens, result.completionTokens);
    result.costUsd = cost.usd;
    result.flatRate = cost.flatRate;
  }
  result.outcome = concluded?.outcome ?? null;
  let line: string | null = null;
  if (concluded && concluded.outcome !== 'no_action') line = concluded.message;
  // A person mentioned the bot and expects an answer even if the model forgot to conclude.
  if (!concluded && input.trigger === 'mention' && finished) line = oneLine(finished.content) || null;
  // Model-written text never resolves @mentions of the room (no pings nor pushes to its members).
  if (line) line = neutralizeMentions(line);
  if (line) {
    try {
      const dto = await postAsAgent(
        agentKey,
        await channel(),
        line,
        {
          kind: 'agent_reply',
          agentKey,
          trigger: input.trigger,
          outcome: result.outcome,
          caseId,
          areaKey: targetArea,
          eventId: input.eventId ?? null,
        },
        { replyToId: input.trigger === 'mention' ? (detail.messageId ?? null) : null }
      );
      result.message = line;
      result.postedMessageId = dto.id;
    } catch (err) {
      warn('conclusion_post_failed', { agentKey, message: err instanceof Error ? err.message : String(err) });
    }
  }

  result.status = 'done';
  result.turnEventId = await recordAgentTurnEvent({
    ...eventBase,
    type: OPS_EVENTS.ai.turn,
    botUserId: identity.botUserId,
    detail,
    payload: {
      surface,
      conversationId,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: result.costUsd,
      flatRate: result.flatRate,
      toolsUsed: result.toolsUsed,
      proposalIds: result.proposalIds,
      outcome: result.outcome,
      chatMessageId: result.postedMessageId,
      retriedWithNamedTool: result.retriedWithNamedTool,
      ...(streamError ? { streamError: oneLine(streamError, 300) } : {}),
      ...(input.causedByUserId ? { causedByUserId: input.causedByUserId } : {}),
    },
  });
  log('turn_done', {
    agentKey,
    trigger: input.trigger,
    outcome: result.outcome,
    tools: result.toolsUsed.length,
    proposals: result.proposalIds.length,
    tokens: result.promptTokens + result.completionTokens,
  });
  return result;
}
