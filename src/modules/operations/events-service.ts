import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { enqueueJob, wakeJobWorker } from '@/modules/jobs/job-queue';
import { publishRealtime, REALTIME_CHANNELS } from '@/modules/realtime/realtime-service';
import { OperationsError } from './errors';
import {
  EVENT_TYPE_PATTERN,
  WORK_ITEM_OPEN_STATUSES,
  isAreaKey,
  type ActorType,
  type OperationalEventTypeInput,
} from './types';

/**
 * Append-only operational log (`OperationalEvent`), its read side and the
 * realtime channels of the core.
 *
 * - `appendEvents(tx, events)` is used by `executeCommand` inside the command
 *   transaction; ids are assigned at insert time.
 * - `publishEventsRealtime` and `dispatchOperationalEvents` run only after the
 *   commit (never for a rolled-back transaction).
 * - `onOperationalEvents(listener)` is the extension hook: the agents layer
 *   registers its dispatcher here. With no listeners nothing happens. These
 *   listeners are best effort (a restart right after the commit skips them).
 * - `onOperationalEventsInTransaction(listener)` is for reactions that must
 *   never be lost (advance a case, acknowledge a request): they run inside the
 *   same transaction and enqueue durable jobs with it.
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-events', event, ...extra }));

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** Serializes to plain JSON: Date → ISO, Decimal → string, bigint → string, undefined dropped. */
export function toOperationalJson(value: unknown): Prisma.InputJsonValue {
  const text = JSON.stringify(value ?? {}, (_key, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v
  );
  return JSON.parse(text ?? '{}') as Prisma.InputJsonValue;
}

function asPayload(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Write side
// ---------------------------------------------------------------------------

export interface OperationalEventInput {
  type: OperationalEventTypeInput;
  actorType: ActorType;
  actorId?: string | null;
  commandId?: string | null;
  caseId?: string | null;
  areaKey?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface OperationalEventRecord {
  /** BigInt serialized. */
  id: string;
  type: string;
  actorType: string;
  actorId: string | null;
  commandId: string | null;
  caseId: string | null;
  areaKey: string | null;
  objectType: string | null;
  objectId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  recordedAt: string;
}

export function assertEventType(type: string): void {
  if (!EVENT_TYPE_PATTERN.test(type) || type.length > 80) {
    throw new Error(`Invalid operational event type "${type}"`);
  }
}

/** Inserts the events in order and returns them with their ids. */
export async function appendEvents(
  tx: Prisma.TransactionClient,
  events: OperationalEventInput[]
): Promise<OperationalEventRecord[]> {
  if (events.length === 0) return [];
  const now = new Date();
  const data = events.map((event) => {
    assertEventType(event.type);
    return {
      type: event.type,
      actorType: event.actorType,
      actorId: event.actorId ?? null,
      commandId: event.commandId ?? null,
      caseId: event.caseId ?? null,
      areaKey: event.areaKey ?? null,
      objectType: event.objectType ?? null,
      objectId: event.objectId ?? null,
      payload: toOperationalJson(event.payload ?? {}),
      occurredAt: event.occurredAt ?? now,
    };
  });
  const created = await tx.operationalEvent.createManyAndReturn({
    data,
    select: { id: true, occurredAt: true, recordedAt: true },
  });
  return created.map((row, index) => {
    const input = data[index];
    return {
      id: row.id.toString(),
      type: input.type,
      actorType: input.actorType,
      actorId: input.actorId,
      commandId: input.commandId,
      caseId: input.caseId,
      areaKey: input.areaKey,
      objectType: input.objectType,
      objectId: input.objectId,
      payload: asPayload(input.payload as Prisma.JsonValue),
      occurredAt: row.occurredAt.toISOString(),
      recordedAt: row.recordedAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Read side (callers check `operations.view` or case access first)
// ---------------------------------------------------------------------------

export interface ListEventsOptions {
  /** Events strictly after this id, oldest first (live tail / resume). */
  afterId?: string;
  /** Events strictly before this id (older pages). */
  beforeId?: string;
  limit?: number;
  types?: string[];
  /** Event types left out (e.g. the AI turn audit events in a business timeline). */
  excludeTypes?: readonly string[];
}

export interface EventPage {
  events: OperationalEventRecord[];
  /** Pass as `beforeId` to load older events; null when the page reached the start. */
  olderCursor: string | null;
  /** Pass as `afterId` to poll for newer events. */
  newerCursor: string | null;
}

type EventRow = {
  id: bigint;
  type: string;
  actorType: string;
  actorId: string | null;
  commandId: string | null;
  caseId: string | null;
  areaKey: string | null;
  objectType: string | null;
  objectId: string | null;
  payload: Prisma.JsonValue;
  occurredAt: Date;
  recordedAt: Date;
};

function toRecord(row: EventRow): OperationalEventRecord {
  return {
    id: row.id.toString(),
    type: row.type,
    actorType: row.actorType,
    actorId: row.actorId,
    commandId: row.commandId,
    caseId: row.caseId,
    areaKey: row.areaKey,
    objectType: row.objectType,
    objectId: row.objectId,
    payload: asPayload(row.payload),
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  };
}

function parseCursor(value: string | undefined, name: string): bigint | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d{1,19}$/.test(value)) {
    throw new OperationsError('invalid_payload', `Cursor inválido (${name})`);
  }
  return BigInt(value);
}

async function listEvents(
  where: Prisma.OperationalEventWhereInput,
  options: ListEventsOptions
): Promise<EventPage> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const afterId = parseCursor(options.afterId, 'afterId');
  const beforeId = parseCursor(options.beforeId, 'beforeId');
  const filter: Prisma.OperationalEventWhereInput = { ...where };
  if (options.types && options.types.length > 0) filter.type = { in: options.types.slice(0, 50) };
  if (options.excludeTypes && options.excludeTypes.length > 0) {
    filter.NOT = { type: { in: [...options.excludeTypes].slice(0, 50) } };
  }

  let rows: EventRow[];
  if (afterId !== undefined) {
    rows = await prisma.operationalEvent.findMany({
      where: { ...filter, id: { gt: afterId } },
      orderBy: { id: 'asc' },
      take: limit,
    });
  } else {
    const newestFirst = await prisma.operationalEvent.findMany({
      where: beforeId !== undefined ? { ...filter, id: { lt: beforeId } } : filter,
      orderBy: { id: 'desc' },
      take: limit,
    });
    rows = newestFirst.reverse();
  }
  const events = rows.map(toRecord);
  const oldest = events[0]?.id ?? null;
  const newest = events[events.length - 1]?.id ?? options.afterId ?? null;
  return {
    events,
    olderCursor: afterId === undefined && events.length === limit ? oldest : null,
    newerCursor: newest,
  };
}

export async function listCaseEvents(
  caseId: string,
  options: ListEventsOptions = {}
): Promise<EventPage> {
  return listEvents({ caseId }, options);
}

export async function listAreaEvents(
  areaKey: string,
  options: ListEventsOptions = {}
): Promise<EventPage> {
  if (!isAreaKey(areaKey)) throw new OperationsError('invalid_payload', 'Área inválida');
  return listEvents({ areaKey }, options);
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

export const caseChannel = (caseId: string) => `case:${caseId}`;
export const areaChannel = (areaKey: string) => `area:${areaKey}`;
export const userChannel = (userId: string) => REALTIME_CHANNELS.user(userId);

export const OPS_REALTIME_TYPES = {
  /** Payload: `{commandId, commandType, events: [{id, type, objectType, objectId}]}`. */
  events: 'ops.events',
  /** Payload: `{commandId, commandType, workItemIds}` on `user:{id}`. */
  workItems: 'ops.workitems',
} as const;

/**
 * Groups the events of one commit per channel (`case:{id}`, `area:{key}`) and
 * publishes one realtime message per channel. Failures are logged, never thrown.
 */
export async function publishEventsRealtime(
  events: OperationalEventRecord[],
  meta: { commandId?: string | null; commandType?: string | null } = {}
): Promise<void> {
  const byChannel = new Map<string, OperationalEventRecord[]>();
  const add = (channel: string, event: OperationalEventRecord) => {
    const list = byChannel.get(channel);
    if (list) list.push(event);
    else byChannel.set(channel, [event]);
  };
  for (const event of events) {
    if (event.caseId) add(caseChannel(event.caseId), event);
    if (event.areaKey) add(areaChannel(event.areaKey), event);
  }
  for (const [channel, list] of byChannel) {
    try {
      await publishRealtime(channel, OPS_REALTIME_TYPES.events, {
        commandId: meta.commandId ?? null,
        commandType: meta.commandType ?? null,
        events: list.map((e) => ({
          id: e.id,
          type: e.type,
          caseId: e.caseId,
          areaKey: e.areaKey,
          objectType: e.objectType,
          objectId: e.objectId,
          occurredAt: e.occurredAt,
        })),
      });
    } catch (err) {
      log('realtime_failed', {
        channel,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Channel authorization (SSE endpoint, case copilot, case snapshot, case evidence):
 * - `area:{key}`: `operations.view`, or active member of the area chat channel.
 * - `case:{id}` (plan 5.8): `operations.admin`, an active member of the case room,
 *   the case owner or the owner/backup of one of its work items. `operations.view`
 *   alone does not open every case.
 */
export async function authorizeOperationsChannel(
  user: CurrentUser,
  kind: 'area' | 'case',
  id: string
): Promise<boolean> {
  if (kind === 'area') {
    if (!isAreaKey(id)) return false;
    if (hasPermission(user, 'operations.view')) return true;
    const area = await prisma.area.findUnique({
      where: { key: id },
      select: { chatChannelId: true },
    });
    return area?.chatChannelId ? isActiveChatMember(area.chatChannelId, user.id) : false;
  }

  // Plan 5.8: a case is open to its room members and operations.admin, plus the people who take
  // part in it (owner, owner/backup of its work). `operations.view` alone never opens every case.
  if (hasPermission(user, 'operations.admin')) return true;
  const operationalCase = await prisma.operationalCase.findUnique({
    where: { id },
    select: { ownerUserId: true, chatChannelId: true },
  });
  if (!operationalCase) return false;
  if (operationalCase.ownerUserId === user.id) return true;
  const workItem = await prisma.workItem.findFirst({
    where: {
      caseId: id,
      status: { in: [...WORK_ITEM_OPEN_STATUSES, 'done'] },
      OR: [{ ownerUserId: user.id }, { backupUserId: user.id }],
    },
    select: { id: true },
  });
  if (workItem) return true;
  return operationalCase.chatChannelId
    ? isActiveChatMember(operationalCase.chatChannelId, user.id)
    : false;
}

async function isActiveChatMember(channelId: string, userId: string): Promise<boolean> {
  const member = await prisma.internalChatMember.findFirst({
    where: { channelId, userId, leftAt: null },
    select: { id: true },
  });
  return Boolean(member);
}

// ---------------------------------------------------------------------------
// Extension hook
// ---------------------------------------------------------------------------

export type OperationalEventsListener = (events: OperationalEventRecord[]) => void | Promise<void>;

type GlobalWithListeners = typeof globalThis & {
  __unikOperationalEventListeners?: Set<OperationalEventsListener>;
};

function listeners(): Set<OperationalEventsListener> {
  const scope = globalThis as GlobalWithListeners;
  if (!scope.__unikOperationalEventListeners) scope.__unikOperationalEventListeners = new Set();
  return scope.__unikOperationalEventListeners;
}

/** Registers a listener invoked after each commit with the events it emitted. Returns the unsubscribe. */
export function onOperationalEvents(listener: OperationalEventsListener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

// ---------------------------------------------------------------------------
// In-transaction reactions (durable)
// ---------------------------------------------------------------------------

export type OperationalOutboxJob = Omit<Parameters<typeof enqueueJob>[0], 'tx'>;

export interface OperationalEventsTxSink {
  /** Buffers a job written with the transaction (`enqueueJob({tx})`). */
  outbox(job: OperationalOutboxJob): void;
}

export type OperationalEventsTxListener = (
  tx: Prisma.TransactionClient,
  events: OperationalEventRecord[],
  sink: OperationalEventsTxSink
) => Promise<void>;

type GlobalWithTxListeners = typeof globalThis & {
  __unikOperationalEventTxListeners?: Set<OperationalEventsTxListener>;
};

function txListeners(): Set<OperationalEventsTxListener> {
  const scope = globalThis as GlobalWithTxListeners;
  if (!scope.__unikOperationalEventTxListeners) scope.__unikOperationalEventTxListeners = new Set();
  return scope.__unikOperationalEventTxListeners;
}

/**
 * Registers a reaction that runs INSIDE the transaction that appends the
 * events (after `appendEvents`, before the outbox rows are written). It reads
 * only with `tx` and buffers jobs through `sink.outbox`, so whatever it
 * enqueues commits or rolls back together with the state: a restart between
 * the commit and a post-commit listener can never lose it. Errors are not
 * swallowed: in PostgreSQL a failed statement already aborted the transaction,
 * so the command fails (retryable) instead of committing without its reaction.
 */
export function onOperationalEventsInTransaction(
  listener: OperationalEventsTxListener
): () => void {
  txListeners().add(listener);
  return () => {
    txListeners().delete(listener);
  };
}

/** Runs the in-transaction reactions in registration order. */
export async function runOperationalEventsTxListeners(
  tx: Prisma.TransactionClient,
  events: OperationalEventRecord[],
  sink: OperationalEventsTxSink
): Promise<void> {
  if (events.length === 0) return;
  for (const listener of [...txListeners()]) {
    await listener(tx, events, sink);
  }
}

/** Runs every listener; a failing listener is logged and never affects the others. */
export async function dispatchOperationalEvents(events: OperationalEventRecord[]): Promise<void> {
  if (events.length === 0) return;
  for (const listener of [...listeners()]) {
    try {
      await listener(events);
    } catch (err) {
      log('listener_failed', {
        count: events.length,
        firstType: events[0]?.type,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * For producers outside a command (e.g. the agent runner's `ai.turn`):
 * appends atomically, then publishes realtime and runs the listeners.
 */
export async function recordOperationalEvents(
  events: OperationalEventInput[]
): Promise<OperationalEventRecord[]> {
  if (events.length === 0) return [];
  const jobs: OperationalOutboxJob[] = [];
  const records = await prisma.$transaction(async (tx) => {
    const appended = await appendEvents(tx, events);
    await runOperationalEventsTxListeners(tx, appended, { outbox: (job) => jobs.push(job) });
    for (const job of jobs) await enqueueJob({ ...job, tx });
    return appended;
  });
  if (jobs.length > 0) wakeJobWorker();
  await publishEventsRealtime(records);
  await dispatchOperationalEvents(records);
  return records;
}
