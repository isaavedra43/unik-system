import type { AgentIdentity, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { loadActiveCurrentUser, type CurrentUser } from '@/modules/auth/authorization';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { normalizeAgentSettings, type AgentSettings } from '@/modules/ai/agent-settings';
import { AUTO_PREFIX, autoTurnObjectToken, getOrCreateSurfaceConversation } from '@/modules/ai/copilot-surfaces';
import { onBotMentioned, type BotMentionEvent } from '@/modules/chat/chat-service';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { onCaseStarted, type CaseStartedEvent } from '@/modules/operations/case-service';
import {
  executeCommand,
  registerCommand,
  resolveAreaAssignee,
  versionedAggregate,
  type CreateAreaRequestInput,
} from '@/modules/operations/commands';
import { onOperationalEvents, recordOperationalEvents, type OperationalEventRecord } from '@/modules/operations/events-service';
import { isOpsFlagEnabled } from '@/modules/operations/operations-config';
import { AREA_LABELS, CASE_OPEN_STATUSES, isAreaKey, OPS_EVENTS } from '@/modules/operations/types';
import {
  areaChannelId,
  caseRoomChannelId,
  isAgentTurnTrigger,
  notifySafely,
  postAgentMessageOnce,
  recordAgentTurnEvent,
  runAgentTurn,
  triggerHashOf,
  turnSurfaceRef,
  turnTargetArea,
  type AgentTurnResult,
} from './agent-runner';
import { budgetPeriod, checkAgentBudget, notifyBudgetOnce, recordAgentSkip, type AgentBudgetStatus } from './budget';
import { maybeSummarizeCase } from './case-summary';
import { ensureCaseRoom } from './chat-bridge';
import {
  AgentIdentityError,
  agentKeyForArea,
  buildBotActor,
  coveredAreaOf,
  getAgentIdentity,
  isAgentKey,
  type AgentKey,
} from './identities';
import { userNames } from './prompts/shared';
import { renderAgentMessage, type AgentMessageContext, type AgentMessageKind } from './templates';
import {
  AGENT_SYNTHETIC_EVENTS,
  isTriggerEventType,
  matchTriggers,
  type TriggerContext,
  type TriggerDecision,
  type TriggerEvent,
  type TriggerPriority,
} from './trigger-matrix';

/**
 * Dispatcher of the coordinated AI layer (plan 5.3 steps 1–5 and 5.4).
 *
 * Producers (after the commit, best effort):
 * - `onOperationalEvents` → one `agents.dispatch {eventId}` job per event the
 *   matrix reacts to (`agents:dispatch:{eventId}`, a single attempt).
 * - `onCaseStarted` → the same job and key as its `case.created` event.
 * - `onBotMentioned` → `agents.dispatch {kind:'mention'}` (`agents:mention:{messageId}`).
 * - `enqueueProposalFailed` / `runStuckScan` → synthetic `proposal.failed` / `case.stuck`.
 *
 * `runDispatch` applies the trigger matrix. Rules (templates, core commands)
 * never call a model. Model decisions pass the guards IN ORDER, and every stop
 * is recorded as an `ai.turn_skipped` event with its reason plus a `skipped`
 * unit on the agent usage meter:
 *   1. `settings.agents.enabled` and `llmTriggers[trigger]`;
 *   2. identity mode (`paused` stops; `on_demand` only `mention`/`action_failed`), and for a
 *      mention the person who wrote it must be able to act for the bot's area
 *      (`sender_forbidden`): the bot never lends its permissions to someone who lacks them;
 *   3. quiet hours (the decision is re-enqueued at the end of the window, except `mention`);
 *   4. budget (`degraded` ⇒ on-demand; `exhausted` ⇒ paused, a "paused by budget"
 *      template in the room and one admin notice a day);
 *   5. already handled or a person attending: the bot thread already holds a turn of the SAME
 *      trigger and object after the event (anchored on the trigger, never on any earlier turn
 *      of the shared thread), and, except for mentions, no human message in the room after it;
 *   6. turns per case per day: `ai.turn` + `ai.turn_failed` of every bot on the case today
 *      against `maxTurnsPerCasePerDay`, plus the identity's own (lower) cap;
 *   7. trigger dedupe (`ai.turn` / `ai.turn_failed` with the same hash in 24 h).
 * A guard that throws records `ai.turn_failed` (`dispatch_error`), so no decision is lost unaudited.
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'agents-dispatcher', event, ...extra }));

const warn = (event: string, extra: Record<string, unknown> = {}) =>
  console.warn(JSON.stringify({ component: 'agents-dispatcher', event, ...extra }));

export const AGENTS_DISPATCH_JOB = 'agents.dispatch';
export const AGENTS_SHORTFALL_COMMAND = 'agents.shortfall_request';
const DISPATCHER_ACTOR = 'agents.dispatcher';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
export const TRIGGER_DEDUPE_WINDOW_MS = DAY_MS;
export const STUCK_IDLE_MS = DAY_MS;
export const STUCK_SCAN_BATCH = 100;
/** Pages of idle cases a scan may read to fill its batch after skipping the ones already reviewed today. */
export const STUCK_SCAN_MAX_PAGES = 5;
/** A repeated post of the same template is searched from this long before the event. */
const POST_DEDUPE_LOOKBACK_MS = 10 * 60_000;

/** Triggers an on-demand (or budget-degraded) agent still answers. */
export const ON_DEMAND_TRIGGERS: ReadonlySet<string> = new Set(['mention', 'action_failed']);

export type DispatchSkipReason =
  | 'agents_disabled'
  | 'trigger_disabled'
  | 'identity_missing'
  | 'agent_paused'
  | 'on_demand'
  | 'quiet_hours'
  | 'budget_exhausted'
  | 'budget_degraded'
  | 'already_handled'
  | 'human_handling'
  | 'case_turn_cap'
  | 'duplicate_trigger'
  | 'sender_forbidden';

// ---------------------------------------------------------------------------
// Pure helpers: time windows
// ---------------------------------------------------------------------------

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface QuietWindow {
  /** HH:MM (24 h). */
  start: string;
  /** HH:MM (24 h); earlier than `start` = crosses midnight. */
  end: string;
  tz: string;
  /** Weekdays (0 = Sunday) on which the window STARTS; empty/absent = every day. */
  days?: number[];
}

interface LocalClock {
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function localClock(now: Date, tz: string): LocalClock {
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(tz);
  } catch {
    parts = format('America/Mexico_City');
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

function toMinutes(value: string): number | null {
  const match = HH_MM.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Whether `now` falls inside the quiet window (local time of its zone). Pure. */
export function isWithinQuietHours(now: Date, window: QuietWindow): boolean {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === null || end === null || start === end) return false;
  const clock = localClock(now, window.tz);
  const minutes = clock.hour * 60 + clock.minute;
  const inside = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!inside) return false;
  if (window.days && window.days.length > 0) {
    const startedYesterday = start > end && minutes < end;
    const startDay = startedYesterday ? (clock.weekday + 6) % 7 : clock.weekday;
    return window.days.includes(startDay);
  }
  return true;
}

/** First instant (whole minute) at which the quiet window of `now` ends. Pure. */
export function quietHoursEndAt(now: Date, window: QuietWindow): Date {
  const end = toMinutes(window.end) ?? 0;
  const clock = localClock(now, window.tz);
  const minutes = clock.hour * 60 + clock.minute;
  let delta = end - minutes;
  if (delta <= 0) delta += 24 * 60;
  const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;
  return new Date(minuteStart + delta * 60_000);
}

/** Local midnight of `now` in `tz` (zones without a DST jump that day). Pure. */
export function startOfLocalDay(now: Date, tz: string): Date {
  const clock = localClock(now, tz);
  const elapsed = (clock.hour * 3600 + clock.minute * 60 + clock.second) * 1000 + (now.getTime() % 1000);
  return new Date(now.getTime() - elapsed);
}

/** Quiet window of an identity: its own `quietHours` when valid, else the global setting. Pure. */
export function quietWindowFor(identity: Pick<AgentIdentity, 'quietHours'>, settings: AgentSettings): QuietWindow {
  const own = asRecord(identity.quietHours);
  const start = typeof own.start === 'string' && HH_MM.test(own.start) ? own.start : null;
  const end = typeof own.end === 'string' && HH_MM.test(own.end) ? own.end : null;
  if (!start || !end) return { ...settings.quietHours };
  let tz = settings.quietHours.tz;
  if (typeof own.tz === 'string' && own.tz.trim()) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: own.tz.trim() });
      tz = own.tz.trim();
    } catch {
      tz = settings.quietHours.tz;
    }
  }
  const days = Array.isArray(own.days)
    ? own.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6)
    : [];
  return { start, end, tz, ...(days.length > 0 ? { days } : {}) };
}

export function jobPriorityOf(priority: TriggerPriority): number {
  if (priority === 'interactive') return JOB_PRIORITY.interactive;
  if (priority === 'maintenance') return JOB_PRIORITY.maintenance;
  return JOB_PRIORITY.normal;
}

/** Highest job priority (lowest number) among the decisions. Pure. */
export function dispatchPriority(decisions: readonly TriggerDecision[]): number {
  return decisions.reduce<number>((best, d) => Math.min(best, jobPriorityOf(d.priority)), JOB_PRIORITY.maintenance);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const numeric = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function uniqueIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

function toTriggerEvent(row: {
  id: string | bigint;
  type: string;
  caseId: string | null;
  areaKey: string | null;
  objectType: string | null;
  objectId: string | null;
  actorType: string | null;
  actorId: string | null;
  payload: unknown;
}): TriggerEvent {
  return {
    id: row.id.toString(),
    type: row.type,
    caseId: row.caseId,
    areaKey: row.areaKey,
    objectType: row.objectType,
    objectId: row.objectId,
    actorType: row.actorType,
    actorId: row.actorId,
    payload: asRecord(row.payload),
  };
}

async function loadAgentSettings(): Promise<AgentSettings> {
  try {
    return normalizeAgentSettings((await getAiSettings()).agents);
  } catch {
    return normalizeAgentSettings(undefined);
  }
}

// ---------------------------------------------------------------------------
// Producers
// ---------------------------------------------------------------------------

const idText = z.string().trim().min(1).max(200);
const llmOnlySchema = z.array(z.string().min(1).max(300)).max(20).optional();

const triggerEventSchema = z.object({
  id: idText,
  type: z.string().trim().min(3).max(80),
  caseId: idText.nullish(),
  areaKey: z.string().trim().max(40).nullish(),
  objectType: z.string().trim().max(60).nullish(),
  objectId: idText.nullish(),
  actorType: z.string().trim().max(20).nullish(),
  actorId: idText.nullish(),
  payload: z.record(z.unknown()).nullish(),
  occurredAt: z.string().max(40).optional(),
});

const eventPayloadSchema = z.object({
  kind: z.literal('event').optional(),
  eventId: z.string().regex(/^\d{1,19}$/),
  llmOnly: llmOnlySchema,
  deferred: z.boolean().optional(),
});
const mentionPayloadSchema = z.object({
  kind: z.literal('mention'),
  messageId: idText,
  channelId: idText,
  botUserIds: z.array(idText).min(1).max(20),
  llmOnly: llmOnlySchema,
  deferred: z.boolean().optional(),
});
const syntheticPayloadSchema = z.object({
  kind: z.literal('synthetic'),
  event: triggerEventSchema,
  llmOnly: llmOnlySchema,
  deferred: z.boolean().optional(),
});

export const dispatchPayloadSchema = z.union([mentionPayloadSchema, syntheticPayloadSchema, eventPayloadSchema]);
export type DispatchPayload = z.infer<typeof dispatchPayloadSchema>;

export const dispatchJobKey = (eventId: string) => `agents:dispatch:${eventId}`;

async function enqueueDispatch(
  payload: DispatchPayload,
  options: { priority: number; dedupeKey: string; caseId?: string | null; runAt?: Date }
): Promise<{ id: string; deduplicated: boolean } | null> {
  try {
    const job = await enqueueJob({
      type: AGENTS_DISPATCH_JOB,
      payload,
      priority: options.priority,
      maxAttempts: 1,
      dedupeKey: options.dedupeKey,
      runAt: options.runAt,
      groupKey: options.caseId ? `agents:case:${options.caseId}` : undefined,
      createdBy: DISPATCHER_ACTOR,
    });
    return { id: job.id, deduplicated: job.deduplicated };
  } catch (err) {
    warn('enqueue_failed', { dedupeKey: options.dedupeKey, message: messageOf(err) });
    return null;
  }
}

/** Listener of `onOperationalEvents`: one dispatch job per event with decisions. Returns the jobs enqueued. */
export async function handleOperationalEvents(events: readonly OperationalEventRecord[]): Promise<number> {
  const relevant = events.filter((event) => isTriggerEventType(event.type));
  if (relevant.length === 0) return 0;
  if (!(await isOpsFlagEnabled('agents'))) return 0;
  let enqueued = 0;
  for (const record of relevant) {
    const decisions = matchTriggers(toTriggerEvent(record));
    if (decisions.length === 0) continue;
    const job = await enqueueDispatch(
      { kind: 'event', eventId: record.id },
      { priority: dispatchPriority(decisions), dedupeKey: dispatchJobKey(record.id), caseId: record.caseId }
    );
    if (job && !job.deduplicated) enqueued += 1;
  }
  return enqueued;
}

/** Listener of `onCaseStarted`: same job (and key) as the `case.created` event. */
export async function handleCaseStarted(event: CaseStartedEvent): Promise<boolean> {
  if (!event.eventId || !/^\d{1,19}$/.test(event.eventId)) return false;
  if (!(await isOpsFlagEnabled('agents'))) return false;
  const job = await enqueueDispatch(
    { kind: 'event', eventId: event.eventId },
    { priority: JOB_PRIORITY.normal, dedupeKey: dispatchJobKey(event.eventId), caseId: event.caseId }
  );
  return Boolean(job && !job.deduplicated);
}

/** Listener of `onBotMentioned`: one interactive job per message (one decision per mentioned bot). */
export async function handleBotMentioned(event: BotMentionEvent): Promise<boolean> {
  const botUserIds = uniqueIds(event.bots.map((b) => b.userId)).slice(0, 20);
  if (botUserIds.length === 0) return false;
  if (!(await isOpsFlagEnabled('agents'))) return false;
  const job = await enqueueDispatch(
    { kind: 'mention', messageId: event.messageId, channelId: event.channelId, botUserIds },
    { priority: JOB_PRIORITY.interactive, dedupeKey: `agents:mention:${event.messageId}` }
  );
  return Boolean(job && !job.deduplicated);
}

export interface ProposalFailedInput {
  proposalId: string;
  /** AgentIdentity.key of the bot that proposed. */
  agentKey: string;
  toolName?: string | null;
  error: string;
  caseId?: string | null;
  areaKey?: string | null;
}

/**
 * For the proposal decision routes: an approved proposal of an agent failed to
 * run → `action_failed` turn of the proposer (one per proposal).
 */
export async function enqueueProposalFailed(input: ProposalFailedInput): Promise<boolean> {
  if (!isAgentKey(input.agentKey) || !input.proposalId) return false;
  if (!(await isOpsFlagEnabled('agents'))) return false;
  const job = await enqueueDispatch(
    {
      kind: 'synthetic',
      event: {
        id: `proposal:${input.proposalId}`.slice(0, 200),
        type: AGENT_SYNTHETIC_EVENTS.proposalFailed,
        caseId: input.caseId ?? null,
        areaKey: input.areaKey ?? null,
        objectType: 'ai_proposal',
        objectId: input.proposalId,
        payload: {
          agentKey: input.agentKey,
          proposalId: input.proposalId,
          toolName: input.toolName ?? null,
          error: input.error.slice(0, 600),
        },
        occurredAt: new Date().toISOString(),
      },
    },
    {
      priority: JOB_PRIORITY.interactive,
      dedupeKey: `agents:proposal_failed:${input.proposalId}`,
      caseId: input.caseId ?? null,
    }
  );
  return Boolean(job && !job.deduplicated);
}

type GlobalWithDispatcher = typeof globalThis & { __unikAgentsDispatcherUnsubscribe?: Array<() => void> };

/** Subscribes the dispatcher once per module evaluation (replaces a previous subscription on hot reload). */
export function registerAgentsDispatcher(): void {
  const scope = globalThis as GlobalWithDispatcher;
  for (const unsubscribe of scope.__unikAgentsDispatcherUnsubscribe ?? []) unsubscribe();
  scope.__unikAgentsDispatcherUnsubscribe = [
    onOperationalEvents(async (events) => {
      await handleOperationalEvents(events);
    }),
    onCaseStarted(async (event) => {
      await handleCaseStarted(event);
    }),
    onBotMentioned(async (event) => {
      await handleBotMentioned(event);
    }),
  ];
}

// ---------------------------------------------------------------------------
// Stuck scan
// ---------------------------------------------------------------------------

export interface StuckScanReport {
  scanned: number;
  enqueued: number;
  recentActivity: number;
  delivered: number;
  /** Cases whose `stuck_review` already ran, was skipped or is queued today. */
  alreadyReviewed: number;
  skipped?: 'flag_off';
}

const STUCK_CASE_STATUSES = CASE_OPEN_STATUSES.filter((status) => status !== 'ready_to_close');
const STUCK_REVIEW_TRIGGER = 'stuck_review';
const JOB_ACTIVE_STATUSES = ['pending', 'running'];

/** Dedupe key of the stuck-review decision of a case (same as the trigger matrix). */
const stuckDecisionKey = (caseId: string) => `llm:${STUCK_REVIEW_TRIGGER}:admin:case:${caseId}`;

/**
 * Whether today's `stuck_review` of the case already exists: an `ai.turn*` event of that trigger
 * (ran, failed or skipped, e.g. deferred by quiet hours) or its dispatch/deferred job still queued
 * or running. Such cases leave room in the batch for the next idle ones.
 */
async function stuckReviewedToday(caseId: string, dayStart: Date, day: string): Promise<boolean> {
  const events = await prisma.operationalEvent.findMany({
    where: {
      caseId,
      type: { in: [OPS_EVENTS.ai.turn, OPS_EVENTS.ai.turnFailed, OPS_EVENTS.ai.turnSkipped] },
      occurredAt: { gte: dayStart },
    },
    select: { payload: true },
    orderBy: { occurredAt: 'desc' },
    take: 50,
  });
  if (events.some((row) => asRecord(row.payload).trigger === STUCK_REVIEW_TRIGGER)) return true;
  const job = await prisma.backgroundJob.findFirst({
    where: {
      dedupeKey: { in: [`agents:stuck:${caseId}:${day}`, `agents:deferred:${stuckDecisionKey(caseId)}`] },
      status: { in: JOB_ACTIVE_STATUSES },
    },
    select: { id: true },
  });
  return Boolean(job);
}

/**
 * Open cases without deliveries and without any non-AI event in 24 h → a
 * synthetic `case.stuck` (`stuck_review` of the administrator), one per case per day.
 * Cases already reviewed today are skipped and the scan reads further pages (up to
 * `STUCK_SCAN_MAX_PAGES`) so the cases beyond the oldest batch are reached too.
 */
export async function runStuckScan(options: { now?: Date; limit?: number; signal?: AbortSignal } = {}): Promise<StuckScanReport> {
  const now = options.now ?? new Date();
  const report: StuckScanReport = { scanned: 0, enqueued: 0, recentActivity: 0, delivered: 0, alreadyReviewed: 0 };
  if (!(await isOpsFlagEnabled('agents'))) return { ...report, skipped: 'flag_off' };
  const settings = await loadAgentSettings();
  const cutoff = new Date(now.getTime() - STUCK_IDLE_MS);
  const batch = Math.min(Math.max(options.limit ?? STUCK_SCAN_BATCH, 1), 500);
  const day = budgetPeriod(now, settings.quietHours.tz).day;
  const dayStart = startOfLocalDay(now, settings.quietHours.tz);

  scan: for (let page = 0; page < STUCK_SCAN_MAX_PAGES && report.enqueued < batch; page++) {
    const cases = await prisma.operationalCase.findMany({
      where: { status: { in: [...STUCK_CASE_STATUSES] }, lastActivityAt: { lt: cutoff } },
      select: { id: true, caseNumber: true, lastActivityAt: true },
      orderBy: [{ lastActivityAt: 'asc' }, { id: 'asc' }],
      skip: page * batch,
      take: batch,
    });
    for (const opCase of cases) {
      if (options.signal?.aborted || report.enqueued >= batch) break scan;
      report.scanned += 1;
      const delivered = await prisma.operationalEvent.findFirst({
        where: { caseId: opCase.id, type: OPS_EVENTS.case.delivered },
        select: { id: true },
      });
      if (delivered) {
        report.delivered += 1;
        continue;
      }
      const recent = await prisma.operationalEvent.findFirst({
        where: {
          caseId: opCase.id,
          occurredAt: { gte: cutoff },
          NOT: [{ type: { startsWith: 'ai.' } }, { type: OPS_EVENTS.case.stuck }],
        },
        select: { id: true },
      });
      if (recent) {
        report.recentActivity += 1;
        continue;
      }
      if (await stuckReviewedToday(opCase.id, dayStart, day)) {
        report.alreadyReviewed += 1;
        continue;
      }
      const lastFact = await prisma.operationalEvent.findFirst({
        where: { caseId: opCase.id, NOT: [{ type: { startsWith: 'ai.' } }, { type: OPS_EVENTS.case.stuck }] },
        select: { occurredAt: true },
        orderBy: { occurredAt: 'desc' },
      });
      const idleSince = lastFact?.occurredAt ?? opCase.lastActivityAt;
      const idleMinutes = Math.max(0, Math.floor((now.getTime() - idleSince.getTime()) / 60_000));
      const job = await enqueueDispatch(
        {
          kind: 'synthetic',
          event: {
            id: `stuck:${opCase.id}:${day}`.slice(0, 200),
            type: OPS_EVENTS.case.stuck,
            caseId: opCase.id,
            areaKey: 'administracion',
            objectType: 'operational_case',
            objectId: opCase.id,
            actorType: 'system',
            actorId: DISPATCHER_ACTOR,
            payload: { caseId: opCase.id, caseNumber: opCase.caseNumber, idleMinutes, source: 'agents.stuck_scan' },
            occurredAt: now.toISOString(),
          },
        },
        { priority: JOB_PRIORITY.maintenance, dedupeKey: `agents:stuck:${opCase.id}:${day}`, caseId: opCase.id }
      );
      if (job && !job.deduplicated) report.enqueued += 1;
    }
    if (cases.length < batch) break;
  }
  log('stuck_scan', { ...report });
  return report;
}

// ---------------------------------------------------------------------------
// Loading the event to dispatch
// ---------------------------------------------------------------------------

interface LoadedDispatch {
  event: TriggerEvent;
  occurredAt: Date;
  context: TriggerContext;
}

function incidentFreeText(detail: unknown): string | null {
  const d = asRecord(detail);
  return str(d.description) ?? str(d.freeText) ?? str(d.note) ?? str(d.text);
}

async function triggerContextFor(event: TriggerEvent): Promise<TriggerContext> {
  const context: TriggerContext = {};
  const objectId = event.objectId ?? str(event.payload?.requestId) ?? str(event.payload?.incidentId);
  switch (event.type) {
    case OPS_EVENTS.request.created: {
      if (!objectId) break;
      const request = await prisma.areaRequest.findUnique({ where: { id: objectId }, select: { freeText: true } });
      context.freeText = request?.freeText ?? null;
      break;
    }
    case OPS_EVENTS.incident.opened: {
      if (!objectId) break;
      const incident = await prisma.incident.findUnique({ where: { id: objectId }, select: { detail: true } });
      context.freeText = incident ? incidentFreeText(incident.detail) : null;
      break;
    }
    case OPS_EVENTS.case.delivered: {
      if (!event.caseId) break;
      const [incidentCount, summaries] = await Promise.all([
        prisma.incident.count({ where: { caseId: event.caseId } }),
        prisma.operationalEvent.findMany({
          where: { caseId: event.caseId, type: OPS_EVENTS.ai.turn },
          select: { payload: true },
          take: 200,
        }),
      ]);
      context.incidentCount = incidentCount;
      context.caseSummaryDone = summaries.some((row) => asRecord(row.payload).trigger === 'case_summary');
      break;
    }
    default:
      break;
  }
  return context;
}

async function loadDispatch(payload: DispatchPayload, now: Date): Promise<LoadedDispatch | null> {
  if (payload.kind === 'mention') {
    const message = await prisma.internalChatMessage.findUnique({
      where: { id: payload.messageId },
      select: { id: true, channelId: true, senderId: true, content: true, createdAt: true, deletedAt: true },
    });
    if (!message || message.deletedAt || message.channelId !== payload.channelId) return null;
    const [channel, sender, identities] = await Promise.all([
      prisma.internalChatChannel.findUnique({ where: { id: message.channelId }, select: { type: true } }),
      prisma.user.findUnique({ where: { id: message.senderId }, select: { isBot: true } }),
      prisma.agentIdentity.findMany({ where: { botUserId: { in: payload.botUserIds } }, select: { key: true } }),
    ]);
    if (!channel || !sender || sender.isBot) return null;
    const [opCase, area] = await Promise.all([
      channel.type === 'case'
        ? prisma.operationalCase.findUnique({ where: { chatChannelId: message.channelId }, select: { id: true } })
        : Promise.resolve(null),
      channel.type === 'area'
        ? prisma.area.findUnique({ where: { chatChannelId: message.channelId }, select: { key: true } })
        : Promise.resolve(null),
    ]);
    return {
      event: {
        id: message.id,
        type: AGENT_SYNTHETIC_EVENTS.mention,
        caseId: opCase?.id ?? null,
        areaKey: area?.key ?? null,
        objectType: 'chat_message',
        objectId: message.id,
        actorType: 'user',
        actorId: message.senderId,
        payload: {
          agentKeys: identities.map((i) => i.key).filter((key) => isAgentKey(key)),
          messageId: message.id,
          channelId: message.channelId,
          channelType: channel.type,
        },
      },
      occurredAt: message.createdAt,
      context: { freeText: message.content },
    };
  }

  if (payload.kind === 'synthetic') {
    const { occurredAt, ...event } = payload.event;
    const at = occurredAt ? new Date(occurredAt) : now;
    const trigger: TriggerEvent = { ...event, payload: event.payload ?? {} };
    return {
      event: trigger,
      occurredAt: Number.isNaN(at.getTime()) ? now : at,
      context: await triggerContextFor(trigger),
    };
  }

  const row = await prisma.operationalEvent.findFirst({ where: { id: BigInt(payload.eventId) } });
  if (!row) return null;
  const event = toTriggerEvent(row);
  return { event, occurredAt: row.occurredAt, context: await triggerContextFor(event) };
}

// ---------------------------------------------------------------------------
// Rules (zero model calls)
// ---------------------------------------------------------------------------

export interface DispatchDecisionReport {
  trigger: string;
  agent: string;
  mode: 'rule' | 'llm';
  outcome: 'done' | 'noop' | 'skipped' | 'deferred' | 'failed';
  reason?: string;
  detail?: Record<string, unknown>;
}

interface CaseHeader {
  id: string;
  caseNumber: string;
  salesOrderNumber: string | null;
  customerName: string | null;
  ownerUserId: string;
  promisedAt: Date | null;
  chatChannelId: string | null;
}

async function loadCaseHeader(caseId: string | null | undefined): Promise<CaseHeader | null> {
  if (!caseId) return null;
  return prisma.operationalCase.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      caseNumber: true,
      salesOrderNumber: true,
      customerName: true,
      ownerUserId: true,
      promisedAt: true,
      chatChannelId: true,
    },
  });
}

function caseContext(opCase: CaseHeader | null): Partial<AgentMessageContext> {
  return opCase
    ? { caseNumber: opCase.caseNumber, salesOrderNumber: opCase.salesOrderNumber, customerName: opCase.customerName }
    : {};
}

async function roomOrAreaChannel(caseId: string | null | undefined, areaKey: string | null | undefined): Promise<string | null> {
  if (caseId) return caseRoomChannelId(caseId);
  return isAreaKey(areaKey) ? areaChannelId(areaKey) : null;
}

const postSince = (occurredAt: Date) => new Date(occurredAt.getTime() - POST_DEDUPE_LOOKBACK_MS);

const noop = (decision: TriggerDecision, reason: string, detail?: Record<string, unknown>): DispatchDecisionReport => ({
  trigger: decision.trigger,
  agent: decision.agent,
  mode: decision.mode,
  outcome: 'noop',
  reason,
  ...(detail ? { detail } : {}),
});

const doneReport = (decision: TriggerDecision, detail?: Record<string, unknown>): DispatchDecisionReport => ({
  trigger: decision.trigger,
  agent: decision.agent,
  mode: decision.mode,
  outcome: 'done',
  ...(detail ? { detail } : {}),
});

async function ruleEnsureCaseRoom(decision: TriggerDecision, loaded: LoadedDispatch, now: Date): Promise<DispatchDecisionReport> {
  const opCase = await loadCaseHeader(decision.detail.caseId);
  if (!opCase) return noop(decision, 'case_missing');
  const room = await ensureCaseRoomSafely(opCase);
  const names = await userNames([opCase.ownerUserId]);
  const rendered = renderAgentMessage('case.started', {
    now,
    occurredAt: loaded.occurredAt,
    ...caseContext(opCase),
    ownerName: names.get(opCase.ownerUserId) ?? null,
    promisedAt: opCase.promisedAt,
  });
  const post = await postAgentMessageOnce(
    decision.agent,
    room,
    rendered.text,
    { kind: 'agent_update', caseId: opCase.id, eventType: 'case.started', dedupeKey: `case_started:${opCase.id}` },
    { since: postSince(loaded.occurredAt) }
  );
  return doneReport(decision, { channelId: room, posted: post.posted, messageId: post.messageId });
}

async function ensureCaseRoomSafely(opCase: CaseHeader): Promise<string> {
  return opCase.chatChannelId ?? (await caseRoomChannelId(opCase.id));
}

/**
 * The case room re-synced with the areas involved NOW: a request or an incident can bring a new
 * area, whose responsible, backup and bot must be members to act on the card posted there.
 * Idempotent (chat-bridge); falls back to the known room when the sync fails.
 */
async function syncCaseRoomSafely(opCase: CaseHeader): Promise<string> {
  try {
    return (await ensureCaseRoom(opCase.id)).id;
  } catch (err) {
    warn('case_room_sync_failed', { caseId: opCase.id, message: messageOf(err) });
    return ensureCaseRoomSafely(opCase);
  }
}

const REQUEST_SOURCES = new Set(['purchase', 'direct_supplier', 'manufacture']);
const ENGINE_REQUEST_STEPS = ['solicitar_compra', 'ordenar_produccion', 'coordinar_entrega_directa'];
const CLOSED_ALLOCATION_STATUSES = ['cancelled', 'released'];
const CLOSED_REQUEST_STATUSES = ['rejected', 'cancelled', 'expired'];

export type ShortfallPlan =
  | { kind: 'demand_missing' }
  | { kind: 'case_closed' }
  | { kind: 'no_shortfall' }
  | { kind: 'already_requested'; requestId: string | null }
  | { kind: 'engine_pending'; stepId: string }
  | { kind: 'create'; input: CreateAreaRequestInput };

type Db = Prisma.TransactionClient;

/**
 * Whether the rule must create the purchase request for a confirmed shortfall.
 * The case engine already requests purchases/production for its allocations
 * (steps solicitar_compra / ordenar_produccion / coordinar_entrega_directa):
 * an existing request, a linked allocation or a pending engine step means the
 * engine owns it, so the rule never duplicates.
 */
export async function planShortfallRequest(
  db: Db,
  input: { demandId: string; shortfall?: string | number | null; now: Date }
): Promise<ShortfallPlan> {
  const demand = await db.caseDemand.findUnique({ where: { id: input.demandId } });
  if (!demand) return { kind: 'demand_missing' };
  const opCase = await db.operationalCase.findUnique({
    where: { id: demand.caseId },
    select: { id: true, caseNumber: true, salesOrderNumber: true, status: true, promisedAt: true },
  });
  if (!opCase || !(CASE_OPEN_STATUSES as readonly string[]).includes(opCase.status)) return { kind: 'case_closed' };

  const allocations = await db.demandAllocation.findMany({
    where: { demandId: demand.id },
    select: { id: true, source: true, status: true, quantity: true, linkedType: true, linkedId: true },
  });
  const active = allocations.filter((a) => !CLOSED_ALLOCATION_STATUSES.includes(a.status));
  const allocationIds = new Set(allocations.map((a) => a.id));
  const requests = await db.areaRequest.findMany({
    where: {
      caseId: demand.caseId,
      kind: { in: ['purchase_shortfall', 'direct_delivery', 'transformation'] },
      status: { notIn: CLOSED_REQUEST_STATUSES },
    },
    select: { id: true, objectType: true, objectId: true, payload: true },
    take: 200,
  });
  const existing = requests.find(
    (r) =>
      (r.objectType === 'demand_allocation' && allocationIds.has(r.objectId)) ||
      (r.objectType === 'case_demand' && r.objectId === demand.id) ||
      asRecord(r.payload).demandId === demand.id
  );
  if (existing) return { kind: 'already_requested', requestId: existing.id };
  const linked = active.find((a) => a.linkedType === 'area_request' && a.linkedId);
  if (linked) return { kind: 'already_requested', requestId: linked.linkedId };

  const sourcing = active.filter((a) => REQUEST_SOURCES.has(a.source));
  if (sourcing.length > 0) {
    const step = await db.caseStep.findFirst({
      where: {
        caseId: demand.caseId,
        allocationId: { in: sourcing.map((a) => a.id) },
        stepKey: { in: ENGINE_REQUEST_STEPS },
        status: { notIn: ['skipped', 'cancelled', 'failed'] },
      },
      select: { id: true },
    });
    if (step) return { kind: 'engine_pending', stepId: step.id };
  }

  const base = numeric(demand.baseQuantity) ?? 0;
  const covered = active
    .filter((a) => !REQUEST_SOURCES.has(a.source))
    .reduce((sum, a) => sum + (numeric(a.quantity) ?? 0), 0);
  const missing = numeric(input.shortfall) ?? Math.max(0, base - covered);
  if (!(missing > 0)) return { kind: 'no_shortfall' };

  const neededBy = (opCase.promisedAt ?? demand.requestedAt ?? new Date(input.now.getTime() + 7 * DAY_MS))
    .toISOString()
    .slice(0, 10);
  const quantity = Math.round(missing * 10_000) / 10_000;
  const caseLabel = [opCase.caseNumber, opCase.salesOrderNumber].filter(Boolean).join(' · ');
  return {
    kind: 'create',
    input: {
      caseId: opCase.id,
      fromAreaKey: 'inventario',
      toAreaKey: 'compras',
      kind: 'purchase_shortfall',
      objectType: 'case_demand',
      objectId: demand.id,
      title: `Comprar ${quantity} ${demand.baseUnit} de ${demand.name} (${caseLabel})`.slice(0, 200),
      payload: {
        demandId: demand.id,
        sku: (demand.sku || demand.zohoItemId || demand.lineRef).slice(0, 120),
        productName: demand.name.slice(0, 300),
        missingQty: quantity,
        unit: demand.baseUnit,
        neededBy,
      },
      blocksDelivery: true,
    },
  };
}

const shortfallCommandSchema = z.object({
  demandId: idText,
  shortfall: z.union([z.string().max(40), z.number()]).nullish(),
});

interface ShortfallCommandData {
  outcome: ShortfallPlan['kind'] | 'created';
  requestId: string | null;
}

// Bot command: the IA de Inventario turns a confirmed shortfall into a purchase request.
registerCommand<z.output<typeof shortfallCommandSchema>, ShortfallCommandData>(AGENTS_SHORTFALL_COMMAND, {
  schema: shortfallCommandSchema,
  permission: 'operations.view',
  aggregate: versionedAggregate('case_demand', 'caseDemand'),
  actorTypes: ['ai', 'system'],
  audit: 'always',
  async handler(tx, cmd, ctx) {
    const plan = await planShortfallRequest(tx, {
      demandId: cmd.payload.demandId,
      shortfall: cmd.payload.shortfall ?? null,
      now: ctx.now,
    });
    if (plan.kind !== 'create') {
      return {
        data: {
          outcome: plan.kind,
          requestId: plan.kind === 'already_requested' ? plan.requestId : null,
        },
      };
    }
    const { request } = await ctx.createAreaRequest(plan.input);
    return { data: { outcome: 'created', requestId: request.id } };
  },
});

async function ruleShortfallToPurchaseRequest(decision: TriggerDecision, loaded: LoadedDispatch, now: Date): Promise<DispatchDecisionReport> {
  const demandId = str(loaded.event.payload?.demandId) ?? (loaded.event.objectType === 'case_demand' ? loaded.event.objectId : null);
  if (!demandId) return noop(decision, 'demand_missing');
  const shortfall = str(loaded.event.payload?.shortfall) ?? numeric(loaded.event.payload?.shortfall);
  const plan = await planShortfallRequest(prisma, { demandId, shortfall, now });
  if (plan.kind !== 'create') {
    return noop(decision, plan.kind, plan.kind === 'already_requested' ? { requestId: plan.requestId } : undefined);
  }
  const bot = await buildBotActor('area:inventario');
  const result = await executeCommand<ShortfallCommandData>(
    {
      commandId: `agents:shortfall:${demandId}:${loaded.event.id}`.slice(0, 200),
      type: AGENTS_SHORTFALL_COMMAND,
      actor: { type: 'ai', id: bot.id },
      aggregate: { type: 'case_demand', id: demandId },
      payload: { demandId, shortfall },
    },
    bot,
    { now }
  );
  if (result.status === 'rejected') {
    return { ...noop(decision, result.errorCode ?? 'rejected'), outcome: 'failed', detail: { message: result.message ?? null } };
  }
  const data = result.data;
  return data?.outcome === 'created'
    ? doneReport(decision, { requestId: data.requestId })
    : noop(decision, data?.outcome ?? 'no_result', { requestId: data?.requestId ?? null });
}

const QUICK_ACTIONS = ['accept', 'block', 'open_case'] as const;

async function ruleAnnounceRequest(decision: TriggerDecision, loaded: LoadedDispatch, now: Date): Promise<DispatchDecisionReport> {
  const requestId = decision.detail.requestId;
  if (!requestId) return noop(decision, 'request_missing');
  const request = await prisma.areaRequest.findUnique({ where: { id: requestId } });
  if (!request) return noop(decision, 'request_missing');
  const opCase = await loadCaseHeader(request.caseId);
  if (!opCase) return noop(decision, 'case_missing');
  const names = await userNames([request.ownerUserId, request.backupUserId]);
  const payload = asRecord(request.payload);
  const rendered = renderAgentMessage('request.created', {
    now,
    occurredAt: loaded.occurredAt,
    ...caseContext(opCase),
    fromAreaKey: request.fromAreaKey,
    toAreaKey: request.toAreaKey,
    requestKind: request.kind,
    title: request.title,
    productName: str(payload.productName),
    sku: str(payload.sku) ?? str(payload.sourceSku) ?? str(payload.targetSku),
    quantity: (numeric(payload.missingQty) ?? numeric(payload.qty) ?? null) as number | null,
    unit: str(payload.unit),
    neededBy: str(payload.neededBy) ?? str(payload.dueAt),
    blocksDelivery: request.blocksDelivery,
    ownerName: names.get(request.ownerUserId) ?? null,
    backupName: request.backupUserId ? (names.get(request.backupUserId) ?? null) : null,
    dueAt: request.dueAt,
  });
  const actorUserIds = uniqueIds([request.ownerUserId, request.backupUserId]);
  const since = postSince(loaded.occurredAt);
  const roomId = await syncCaseRoomSafely(opCase);
  const room = await postAgentMessageOnce(
    decision.agent,
    roomId,
    rendered.text,
    {
      kind: 'agent_request',
      requestId: request.id,
      caseId: opCase.id,
      areaKey: request.toAreaKey,
      quickActions: [...QUICK_ACTIONS],
      actorUserIds,
      status: request.status,
      dedupeKey: `request_created:${request.id}`,
    },
    { since, priority: request.blocksDelivery ? 'urgent' : 'normal' }
  );

  // Short copy in the destination area channel, posted by that area's own agent.
  let areaMessageId: string | null = null;
  const destinationAgent = agentKeyForArea(request.toAreaKey);
  if (destinationAgent && isAreaKey(request.toAreaKey)) {
    try {
      const fromLabel = isAreaKey(request.fromAreaKey) ? AREA_LABELS[request.fromAreaKey] : request.fromAreaKey;
      const reference = opCase.salesOrderNumber ?? opCase.caseNumber;
      const copy = `📦 ${fromLabel} pide a ${AREA_LABELS[request.toAreaKey]} · ${reference}: ${request.title}`;
      const areaPost = await postAgentMessageOnce(
        destinationAgent,
        await areaChannelId(request.toAreaKey),
        copy,
        {
          kind: 'agent_request',
          requestId: request.id,
          caseId: opCase.id,
          areaKey: request.toAreaKey,
          // The copy in the area channel informs; the decision is taken on the room card.
          quickActions: [],
          actorUserIds,
          status: request.status,
          copyOf: room.messageId,
          dedupeKey: `request_created:${request.id}:area`,
        },
        { since }
      );
      areaMessageId = areaPost.messageId;
    } catch (err) {
      warn('request_area_copy_failed', { requestId: request.id, message: messageOf(err) });
    }
  }

  // The core already notified the responsible when it created the request (one notice per
  // request, `ops_request`, with the push urgency of a delivery blocker and a link to the work
  // item): the announcement only posts the cards, never a second notice for the same fact.
  return doneReport(decision, { channelId: roomId, messageId: room.messageId, posted: room.posted, areaMessageId });
}

const REQUEST_UPDATE_KINDS: ReadonlySet<string> = new Set([
  'request.acknowledged',
  'request.accepted',
  'request.blocked',
  'request.resolved',
  'request.rejected',
  'request.cancelled',
  'request.expired',
]);

function answerText(answer: unknown): string | null {
  if (typeof answer === 'string') return str(answer);
  const record = asRecord(answer);
  return str(record.answer) ?? str(record.text) ?? str(record.note);
}

async function ruleAnnounceRequestUpdate(decision: TriggerDecision, loaded: LoadedDispatch, now: Date): Promise<DispatchDecisionReport> {
  const kind = loaded.event.type;
  if (!REQUEST_UPDATE_KINDS.has(kind)) return noop(decision, 'unsupported_update');
  // The coordination acknowledges every request right after it is created and the creation card
  // already names the responsible: only an acknowledgement by a person is announced again.
  if (kind === 'request.acknowledged' && loaded.event.actorType !== 'user') {
    return noop(decision, 'auto_acknowledged');
  }
  const requestId = decision.detail.requestId;
  const request = requestId ? await prisma.areaRequest.findUnique({ where: { id: requestId } }) : null;
  if (!request) return noop(decision, 'request_missing');
  const opCase = await loadCaseHeader(request.caseId);
  if (!opCase) return noop(decision, 'case_missing');
  const payload = loaded.event.payload ?? {};
  const actorId = loaded.event.actorType === 'user' ? loaded.event.actorId : null;
  const names = await userNames([request.ownerUserId, request.backupUserId, actorId]);
  const rendered = renderAgentMessage(kind as AgentMessageKind, {
    now,
    occurredAt: loaded.occurredAt,
    ...caseContext(opCase),
    fromAreaKey: request.fromAreaKey,
    toAreaKey: request.toAreaKey,
    requestKind: request.kind,
    title: request.title,
    ownerName: names.get(request.ownerUserId) ?? null,
    backupName: request.backupUserId ? (names.get(request.backupUserId) ?? null) : null,
    actorName: actorId ? (names.get(actorId) ?? null) : null,
    reason: str(payload.reason),
    note: kind === 'request.resolved' ? answerText(request.answer) : str(payload.note),
    dueAt: request.dueAt,
  });
  const roomId = await ensureCaseRoomSafely(opCase);
  const post = await postAgentMessageOnce(
    decision.agent,
    roomId,
    rendered.text,
    {
      kind: 'agent_update',
      requestId: request.id,
      caseId: opCase.id,
      areaKey: request.toAreaKey,
      status: request.status,
      eventType: kind,
      dedupeKey: `${kind}:${request.id}:${loaded.event.id}`,
    },
    { since: postSince(loaded.occurredAt) }
  );
  return doneReport(decision, { channelId: roomId, messageId: post.messageId, posted: post.posted });
}

async function ruleNotifyWorkItemOverdue(decision: TriggerDecision, loaded: LoadedDispatch, now: Date): Promise<DispatchDecisionReport> {
  const workItemId = decision.detail.workItemId;
  const item = workItemId ? await prisma.workItem.findUnique({ where: { id: workItemId } }) : null;
  if (!item) return noop(decision, 'work_item_missing');
  if (item.status === 'done' || item.status === 'cancelled') return noop(decision, 'work_item_closed');
  const opCase = await loadCaseHeader(item.caseId);
  const channelId = await roomOrAreaChannel(item.caseId, item.areaKey);
  if (!channelId) return noop(decision, 'no_channel');
  const names = await userNames([item.ownerUserId, item.backupUserId]);
  const payload = loaded.event.payload ?? {};
  const level = numeric(payload.level) ?? item.escalationLevel;
  const rendered = renderAgentMessage('workitem.overdue', {
    now,
    occurredAt: loaded.occurredAt,
    ...caseContext(opCase),
    areaKey: item.areaKey,
    workItemTitle: item.title,
    overdueMinutes: numeric(payload.overdueMinutes),
    escalationLevel: level,
    ownerName: names.get(item.ownerUserId) ?? null,
    backupName: item.backupUserId ? (names.get(item.backupUserId) ?? null) : null,
    dueAt: item.dueAt,
  });
  const dedupeKey = `workitem_overdue:${item.id}:${level}`;
  const post = await postAgentMessageOnce(
    decision.agent,
    channelId,
    rendered.text,
    { kind: 'agent_update', workItemId: item.id, caseId: item.caseId, areaKey: item.areaKey, level, dedupeKey },
    { since: postSince(loaded.occurredAt) }
  );
  for (const userId of uniqueIds([item.ownerUserId, item.backupUserId])) {
    await notifySafely({
      userId,
      category: 'ops_escalation',
      type: 'agent_workitem_overdue',
      title: `Trabajo vencido: ${item.title}`.slice(0, 200),
      body: rendered.text,
      url: `/app/mywork?workItem=${encodeURIComponent(item.id)}`,
      entityType: 'work_item',
      entityId: item.id,
      metadata: { caseId: item.caseId, level, agentKey: decision.agent },
      dedupeKey: `agent_workitem_overdue:${item.id}:${level}:${userId}`,
    });
  }
  return doneReport(decision, { channelId, messageId: post.messageId, posted: post.posted });
}

async function ruleAnnounceIncident(decision: TriggerDecision, loaded: LoadedDispatch, now: Date): Promise<DispatchDecisionReport> {
  const incidentId = decision.detail.incidentId;
  const incident = incidentId ? await prisma.incident.findUnique({ where: { id: incidentId } }) : null;
  if (!incident) return noop(decision, 'incident_missing');
  const opCase = await loadCaseHeader(incident.caseId);
  const channelId = opCase
    ? await syncCaseRoomSafely(opCase)
    : await roomOrAreaChannel(null, incident.areaKey);
  if (!channelId) return noop(decision, 'no_channel');
  const names = await userNames([incident.ownerUserId]);
  const rendered = renderAgentMessage('incident.opened', {
    now,
    occurredAt: loaded.occurredAt,
    ...caseContext(opCase),
    areaKey: incident.areaKey,
    incidentTitle: incident.title,
    incidentKind: incident.kind,
    severity: incident.severity,
    ownerName: incident.ownerUserId ? (names.get(incident.ownerUserId) ?? null) : null,
  });
  const post = await postAgentMessageOnce(
    decision.agent,
    channelId,
    rendered.text,
    {
      kind: 'agent_update',
      incidentId: incident.id,
      caseId: incident.caseId,
      areaKey: incident.areaKey,
      severity: incident.severity,
      dedupeKey: `incident_opened:${incident.id}`,
    },
    {
      since: postSince(loaded.occurredAt),
      priority: incident.severity === 'critical' || incident.severity === 'high' ? 'urgent' : 'normal',
    }
  );
  return doneReport(decision, { channelId, messageId: post.messageId, posted: post.posted });
}

async function ruleAnnounceCaseDelivered(decision: TriggerDecision, loaded: LoadedDispatch, now: Date): Promise<DispatchDecisionReport> {
  const opCase = await loadCaseHeader(decision.detail.caseId);
  if (!opCase) return noop(decision, 'case_missing');
  const roomId = await ensureCaseRoomSafely(opCase);
  const rendered = renderAgentMessage('case.delivered', {
    now,
    occurredAt: loaded.occurredAt,
    ...caseContext(opCase),
    deliveredAt: loaded.occurredAt,
    incidentCount: loaded.context.incidentCount ?? null,
  });
  const post = await postAgentMessageOnce(
    decision.agent,
    roomId,
    rendered.text,
    { kind: 'agent_update', caseId: opCase.id, eventType: 'case.delivered', dedupeKey: `case_delivered:${opCase.id}:${loaded.event.id}` },
    { since: postSince(loaded.occurredAt) }
  );
  return doneReport(decision, { channelId: roomId, messageId: post.messageId, posted: post.posted });
}

type RuleRunner = (decision: TriggerDecision, loaded: LoadedDispatch, now: Date) => Promise<DispatchDecisionReport>;

const RULES: Record<string, RuleRunner> = {
  ensure_case_room: ruleEnsureCaseRoom,
  shortfall_to_purchase_request: ruleShortfallToPurchaseRequest,
  announce_request: ruleAnnounceRequest,
  announce_request_update: ruleAnnounceRequestUpdate,
  notify_workitem_overdue: ruleNotifyWorkItemOverdue,
  announce_incident: ruleAnnounceIncident,
  announce_case_delivered: ruleAnnounceCaseDelivered,
};

async function runRule(decision: TriggerDecision, loaded: LoadedDispatch, now: Date): Promise<DispatchDecisionReport> {
  const runner = RULES[decision.trigger];
  if (!runner) return noop(decision, 'unknown_rule');
  try {
    return await runner(decision, loaded, now);
  } catch (err) {
    warn('rule_failed', {
      trigger: decision.trigger,
      agent: decision.agent,
      eventId: decision.eventId,
      message: messageOf(err),
    });
    return {
      trigger: decision.trigger,
      agent: decision.agent,
      mode: 'rule',
      outcome: 'failed',
      reason: err instanceof AgentIdentityError ? err.code : 'rule_error',
      detail: { message: messageOf(err).slice(0, 300) },
    };
  }
}

// ---------------------------------------------------------------------------
// Model decisions (guards)
// ---------------------------------------------------------------------------

interface LlmEnv {
  now: Date;
  settings: AgentSettings;
  payload: DispatchPayload;
}

async function recordSkip(
  decision: TriggerDecision,
  identity: AgentIdentity | null,
  reason: DispatchSkipReason,
  triggerHash: string,
  now: Date,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await recordAgentTurnEvent({
    type: OPS_EVENTS.ai.turnSkipped,
    agentKey: decision.agent,
    botUserId: identity?.botUserId ?? null,
    trigger: decision.trigger,
    triggerHash,
    detail: decision.detail,
    eventId: decision.eventId,
    eventType: decision.eventType,
    occurredAt: now,
    payload: { reason, ...extra },
  });
  try {
    await recordAgentSkip(decision.agent, now);
  } catch (err) {
    warn('skip_meter_failed', { agent: decision.agent, message: messageOf(err) });
  }
  log('llm_skipped', { agent: decision.agent, trigger: decision.trigger, reason, eventId: decision.eventId });
}

/** Human (non-bot) messages in the turn's room after the event. */
async function humanWroteAfter(decision: TriggerDecision, occurredAt: Date): Promise<boolean> {
  const caseId = decision.surface === 'case' ? decision.detail.caseId : undefined;
  let channelId: string | null = null;
  if (caseId) {
    channelId = (await prisma.operationalCase.findUnique({ where: { id: caseId }, select: { chatChannelId: true } }))
      ?.chatChannelId ?? null;
  } else {
    const areaKey = isAgentKey(decision.agent) ? turnTargetArea(decision.agent, decision.detail) : null;
    channelId = areaKey
      ? ((await prisma.area.findUnique({ where: { key: areaKey }, select: { chatChannelId: true } }))?.chatChannelId ?? null)
      : null;
  }
  if (!channelId) return false;
  const messages = await prisma.internalChatMessage.findMany({
    where: { channelId, createdAt: { gt: occurredAt }, deletedAt: null },
    select: { senderId: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  const senders = uniqueIds(messages.map((m) => m.senderId));
  if (senders.length === 0) return false;
  const humans = await prisma.user.count({ where: { id: { in: senders }, isBot: false } });
  return humans > 0;
}

/**
 * Model turns of the case today: `ai.turn` and `ai.turn_failed` (a failed turn also spent
 * tokens) written by the AI layer, of every bot, or only of `botUserId` when given.
 */
async function caseTurnsToday(caseId: string, dayStart: Date, botUserId?: string): Promise<number> {
  return prisma.operationalEvent.count({
    where: {
      caseId,
      actorType: 'ai',
      type: { in: [OPS_EVENTS.ai.turn, OPS_EVENTS.ai.turnFailed] },
      occurredAt: { gte: dayStart },
      ...(botUserId ? { actorId: botUserId } : {}),
    },
  });
}

/**
 * Whether the bot thread already holds an automatic turn of the SAME trigger about the SAME object
 * written after `since` (in flight or finished). Anchored on the trigger: an earlier turn of another
 * trigger or object in the shared thread (another mention, another request) never cancels this one.
 */
export async function autoTurnAlreadyStarted(
  conversationId: string,
  decision: Pick<TriggerDecision, 'trigger' | 'detail'>,
  since: Date
): Promise<boolean> {
  const prefix = `${AUTO_PREFIX}${decision.trigger}⟧`;
  const token = autoTurnObjectToken({
    requestId: decision.detail.requestId,
    incidentId: decision.detail.incidentId,
    workItemId: decision.detail.workItemId,
    proposalId: decision.detail.proposalId,
    messageId: decision.detail.messageId,
    caseId: decision.detail.caseId,
    areaKey: decision.detail.areaKey,
  });
  const rows = await prisma.aiMessage.findMany({
    where: { conversationId, role: 'user', createdAt: { gt: since }, content: { startsWith: prefix } },
    select: { content: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.some((row) => {
    if (!token) return true;
    const directive = (row.content ?? '').split('\n')[0];
    return directive.split(/\s+/).includes(token);
  });
}

/**
 * Mention guard: the person who wrote the mention must be an active human who may act for the
 * bot's area (the administrator bot: Administración). Returns the person or the Spanish reason.
 */
async function mentionSender(
  agentKey: AgentKey,
  senderId: string | null | undefined
): Promise<{ sender: CurrentUser } | { reason: string }> {
  if (!senderId) return { reason: 'La mención no tiene autor' };
  const sender = await loadActiveCurrentUser(senderId);
  if (!sender) return { reason: 'Quien mencionó a la IA no está activo' };
  const row = await prisma.user.findUnique({ where: { id: senderId }, select: { isBot: true } });
  if (row?.isBot) return { reason: 'Una IA no puede mencionar a otra IA' };
  const { canActForArea } = await import('@/modules/ai/tools/operations-tool-kit');
  const area = coveredAreaOf(agentKey) ?? 'administracion';
  const reason = await canActForArea(sender, area);
  return reason ? { reason } : { sender };
}

async function triggerRanRecently(botUserId: string, triggerHash: string, now: Date): Promise<boolean> {
  const rows = await prisma.operationalEvent.findMany({
    where: {
      actorId: botUserId,
      type: { in: [OPS_EVENTS.ai.turn, OPS_EVENTS.ai.turnFailed] },
      occurredAt: { gte: new Date(now.getTime() - TRIGGER_DEDUPE_WINDOW_MS) },
    },
    select: { payload: true },
    orderBy: { occurredAt: 'desc' },
    take: 500,
  });
  return rows.some((row) => asRecord(row.payload).triggerHash === triggerHash);
}

async function postBudgetPause(
  decision: TriggerDecision,
  identity: AgentIdentity,
  budget: AgentBudgetStatus,
  now: Date
): Promise<void> {
  if (!isAgentKey(decision.agent)) return;
  try {
    const areaKey = turnTargetArea(decision.agent, decision.detail);
    const channelId = await roomOrAreaChannel(decision.surface === 'case' ? decision.detail.caseId : null, areaKey);
    if (!channelId) return;
    let responsibleName: string | null = null;
    try {
      const assignee = await resolveAreaAssignee(prisma, areaKey);
      responsibleName = (await userNames([assignee.ownerUserId])).get(assignee.ownerUserId) ?? null;
    } catch {
      responsibleName = null;
    }
    const rendered = renderAgentMessage('budget.exhausted', {
      now,
      agentName: identity.displayName,
      responsibleName,
      areaKey,
    });
    const post = await postAgentMessageOnce(
      decision.agent,
      channelId,
      rendered.text,
      {
        kind: 'agent_notice',
        notice: 'budget_exhausted',
        agentKey: decision.agent,
        day: budget.day,
        dedupeKey: `budget_exhausted:${decision.agent}:${budget.day}`,
      },
      { since: new Date(now.getTime() - DAY_MS) }
    );
    // The pause notice is also a fact of the case (or area) timeline, recorded once with the post.
    if (post.posted) {
      await recordOperationalEvents([
        {
          type: OPS_EVENTS.ai.budgetExhausted,
          actorType: 'ai',
          actorId: identity.botUserId,
          caseId: decision.surface === 'case' ? (decision.detail.caseId ?? null) : null,
          areaKey,
          objectType: 'agent_identity',
          objectId: identity.id,
          occurredAt: now,
          payload: { agentKey: decision.agent, day: budget.day, pct: budget.pct, chatMessageId: post.messageId, trigger: decision.trigger },
        },
      ]);
    }
  } catch (err) {
    warn('budget_pause_post_failed', { agent: decision.agent, message: messageOf(err) });
  }
}

async function runLlmDecision(decision: TriggerDecision, loaded: LoadedDispatch, env: LlmEnv): Promise<DispatchDecisionReport> {
  const base = { trigger: decision.trigger, agent: decision.agent, mode: 'llm' as const };
  const triggerHash = triggerHashOf(decision.dedupeKey);
  const identity = isAgentKey(decision.agent) ? await getAgentIdentity(decision.agent) : null;
  const skip = async (reason: DispatchSkipReason, extra: Record<string, unknown> = {}): Promise<DispatchDecisionReport> => {
    await recordSkip(decision, identity, reason, triggerHash, env.now, extra);
    return { ...base, outcome: 'skipped', reason, ...(Object.keys(extra).length > 0 ? { detail: extra } : {}) };
  };

  // 1. Global switch and per-trigger switch.
  if (!env.settings.enabled) return skip('agents_disabled');
  if (decision.llmTrigger && !env.settings.llmTriggers[decision.llmTrigger]) return skip('trigger_disabled');

  // 2. Identity mode.
  if (!identity || !isAgentKey(decision.agent)) return skip('identity_missing');
  const agentKey: AgentKey = decision.agent;
  if (identity.mode === 'paused') return skip('agent_paused');
  if (identity.mode === 'on_demand' && !ON_DEMAND_TRIGGERS.has(decision.trigger)) return skip('on_demand');

  // 2b. A mention runs with the limits of the person who wrote it: someone who cannot act for the
  // bot's area never gets the bot to read or act for them.
  let onBehalfOf: CurrentUser | null = null;
  if (decision.trigger === 'mention') {
    const checked = await mentionSender(agentKey, loaded.event.actorId);
    if ('reason' in checked) return skip('sender_forbidden', { senderId: loaded.event.actorId ?? null, detail: checked.reason.slice(0, 300) });
    onBehalfOf = checked.sender;
  }

  // 3. Quiet hours: deferred to the end of the window (a mention is answered now).
  if (decision.trigger !== 'mention' && env.payload.deferred !== true) {
    const window = quietWindowFor(identity, env.settings);
    if (isWithinQuietHours(env.now, window)) {
      const runAt = quietHoursEndAt(env.now, window);
      const job = await enqueueDispatch(
        { ...env.payload, llmOnly: [decision.dedupeKey], deferred: true },
        {
          priority: jobPriorityOf(decision.priority),
          dedupeKey: `agents:deferred:${decision.dedupeKey}`,
          caseId: decision.detail.caseId ?? null,
          runAt,
        }
      );
      // Only the first deferral is recorded: a repeated scan or event finding the same deferred job
      // already queued adds no event and no skipped unit.
      if (!job?.deduplicated) {
        await recordSkip(decision, identity, 'quiet_hours', triggerHash, env.now, {
          deferredUntil: runAt.toISOString(),
          deferredJobId: job?.id ?? null,
        });
      }
      return { ...base, outcome: 'deferred', reason: 'quiet_hours', detail: { runAt: runAt.toISOString(), jobId: job?.id ?? null } };
    }
  }

  // 4. Budget.
  const budget = await checkAgentBudget(identity, { now: env.now });
  if (budget.state !== 'ok') {
    try {
      await notifyBudgetOnce(identity, budget, { now: env.now });
    } catch (err) {
      warn('budget_notice_failed', { agent: agentKey, message: messageOf(err) });
    }
  }
  if (budget.state === 'exhausted') {
    await postBudgetPause(decision, identity, budget, env.now);
    return skip('budget_exhausted', { pct: budget.pct });
  }
  if (budget.state === 'degraded' && !ON_DEMAND_TRIGGERS.has(decision.trigger)) {
    return skip('budget_degraded', { pct: budget.pct });
  }

  if (decision.trigger === 'case_summary') return runCaseSummaryDecision(decision, identity, triggerHash, env);
  if (!isAgentTurnTrigger(decision.trigger)) return skip('trigger_disabled');

  let actor: CurrentUser;
  try {
    actor = await buildBotActor(agentKey);
  } catch (err) {
    const code = err instanceof AgentIdentityError ? err.code : 'identity_error';
    await recordAgentTurnEvent({
      type: OPS_EVENTS.ai.turnFailed,
      agentKey,
      botUserId: identity.botUserId,
      trigger: decision.trigger,
      triggerHash,
      detail: decision.detail,
      eventId: decision.eventId,
      eventType: decision.eventType,
      occurredAt: env.now,
      payload: { errorCode: code, error: messageOf(err).slice(0, 600) },
    });
    return { ...base, outcome: 'failed', reason: code };
  }

  // 5. Already handled (a turn of this trigger and object is in the bot thread after the event),
  // or a person is attending (someone wrote in the room after the event; mentions are exempt).
  const surfaceRef = turnSurfaceRef(agentKey, decision.surface, decision.detail);
  const conversation = await getOrCreateSurfaceConversation(actor, surfaceRef);
  if (await autoTurnAlreadyStarted(conversation.id, decision, loaded.occurredAt)) return skip('already_handled');
  if (decision.trigger !== 'mention' && (await humanWroteAfter(decision, loaded.occurredAt))) {
    return skip('human_handling');
  }

  // 6. Model turns on the case today: the case cap counts every bot (and failed turns); the
  // identity's own cap applies on top when it is lower.
  const caseId = decision.detail.caseId;
  if (caseId) {
    const dayStart = startOfLocalDay(env.now, env.settings.quietHours.tz);
    const caseCap = Math.max(0, env.settings.maxTurnsPerCasePerDay);
    const caseTurns = await caseTurnsToday(caseId, dayStart);
    if (caseTurns >= caseCap) return skip('case_turn_cap', { turnsToday: caseTurns, cap: caseCap, scope: 'case' });
    const identityCap = Math.max(0, identity.maxTurnsPerCasePerDay);
    if (identityCap < caseCap) {
      const ownTurns = await caseTurnsToday(caseId, dayStart, identity.botUserId);
      if (ownTurns >= identityCap) {
        return skip('case_turn_cap', { turnsToday: ownTurns, cap: identityCap, scope: 'identity' });
      }
    }
  }

  // 7. Same trigger in the last 24 h.
  if (await triggerRanRecently(identity.botUserId, triggerHash, env.now)) return skip('duplicate_trigger');

  const turn: AgentTurnResult = await runAgentTurn({
    agentKey,
    surface: surfaceRef.kind,
    trigger: decision.trigger,
    detail: decision.detail,
    triggerHash,
    eventId: decision.eventId,
    eventType: decision.eventType,
    identity,
    actor,
    conversationId: conversation.id,
    now: env.now,
    ...(onBehalfOf
      ? {
          onBehalfOfUserId: onBehalfOf.id,
          lockedCaseId: decision.surface === 'case' ? (decision.detail.caseId ?? null) : null,
          causedByUserId: onBehalfOf.id,
        }
      : loaded.event.actorType === 'user' && loaded.event.actorId
        ? { causedByUserId: loaded.event.actorId }
        : {}),
  });
  return {
    ...base,
    outcome: turn.status === 'done' ? 'done' : 'failed',
    ...(turn.errorCode ? { reason: turn.errorCode } : {}),
    detail: {
      outcome: turn.outcome,
      proposalIds: turn.proposalIds,
      toolsUsed: turn.toolsUsed,
      promptTokens: turn.promptTokens,
      completionTokens: turn.completionTokens,
      model: turn.model,
      turnEventId: turn.turnEventId,
    },
  };
}

async function runCaseSummaryDecision(
  decision: TriggerDecision,
  identity: AgentIdentity,
  triggerHash: string,
  env: LlmEnv
): Promise<DispatchDecisionReport> {
  const base = { trigger: decision.trigger, agent: decision.agent, mode: 'llm' as const };
  const caseId = decision.detail.caseId;
  if (!caseId) return { ...base, outcome: 'noop', reason: 'case_missing' };
  if (await triggerRanRecently(identity.botUserId, triggerHash, env.now)) {
    await recordSkip(decision, identity, 'duplicate_trigger', triggerHash, env.now);
    return { ...base, outcome: 'skipped', reason: 'duplicate_trigger' };
  }
  const summary = await maybeSummarizeCase(caseId, { force: true, now: env.now });
  if (summary.outcome !== 'updated') {
    return { ...base, outcome: summary.outcome === 'failed' ? 'failed' : 'noop', reason: summary.outcome };
  }
  const turnEventId = await recordAgentTurnEvent({
    type: OPS_EVENTS.ai.turn,
    agentKey: decision.agent,
    botUserId: identity.botUserId,
    trigger: 'case_summary',
    triggerHash,
    detail: decision.detail,
    eventId: decision.eventId,
    eventType: decision.eventType,
    occurredAt: env.now,
    payload: {
      model: summary.model ?? null,
      promptTokens: summary.promptTokens ?? 0,
      completionTokens: summary.completionTokens ?? 0,
      toolsUsed: [],
      proposalIds: [],
      outcome: 'acted',
    },
  });
  return { ...base, outcome: 'done', detail: { turnEventId, lastEventId: summary.lastEventId ?? null } };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchReport {
  status: 'ok' | 'skipped';
  reason?: 'invalid_payload' | 'flag_off' | 'event_not_found';
  eventId?: string;
  eventType?: string;
  decisions: DispatchDecisionReport[];
}

/** Handler body of `agents.dispatch`: rules first, then the guarded model decisions. */
export async function runDispatch(rawPayload: unknown, options: { now?: Date } = {}): Promise<DispatchReport> {
  const now = options.now ?? new Date();
  const parsed = dispatchPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return { status: 'skipped', reason: 'invalid_payload', decisions: [] };
  const payload = parsed.data;
  if (!(await isOpsFlagEnabled('agents'))) return { status: 'skipped', reason: 'flag_off', decisions: [] };
  const loaded = await loadDispatch(payload, now);
  if (!loaded) return { status: 'skipped', reason: 'event_not_found', decisions: [] };

  let decisions = matchTriggers(loaded.event, loaded.context);
  if (payload.llmOnly) {
    const wanted = new Set(payload.llmOnly);
    decisions = decisions.filter((d) => d.mode === 'llm' && wanted.has(d.dedupeKey));
  }
  const settings = await loadAgentSettings();
  const reports: DispatchDecisionReport[] = [];
  for (const decision of decisions) {
    if (decision.mode === 'rule') {
      reports.push(await runRule(decision, loaded, now));
      continue;
    }
    try {
      reports.push(await runLlmDecision(decision, loaded, { now, settings, payload }));
    } catch (err) {
      warn('llm_decision_failed', { trigger: decision.trigger, agent: decision.agent, message: messageOf(err) });
      // A guard that throws (conversation, budget, caps…) still leaves its audit trail.
      let botUserId: string | null = null;
      try {
        botUserId = isAgentKey(decision.agent) ? ((await getAgentIdentity(decision.agent))?.botUserId ?? null) : null;
      } catch {
        botUserId = null;
      }
      await recordAgentTurnEvent({
        type: OPS_EVENTS.ai.turnFailed,
        agentKey: decision.agent,
        botUserId,
        trigger: decision.trigger,
        triggerHash: triggerHashOf(decision.dedupeKey),
        detail: decision.detail,
        eventId: decision.eventId,
        eventType: decision.eventType,
        occurredAt: now,
        payload: { errorCode: 'dispatch_error', error: messageOf(err).slice(0, 600) },
      });
      reports.push({ trigger: decision.trigger, agent: decision.agent, mode: 'llm', outcome: 'failed', reason: 'dispatch_error' });
    }
  }
  log('dispatched', {
    eventId: loaded.event.id,
    eventType: loaded.event.type,
    decisions: reports.map((r) => `${r.trigger}:${r.outcome}${r.reason ? `:${r.reason}` : ''}`),
  });
  return { status: 'ok', eventId: loaded.event.id, eventType: loaded.event.type, decisions: reports };
}
