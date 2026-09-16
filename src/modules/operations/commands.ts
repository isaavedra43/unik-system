import { createHash } from 'crypto';
import { Prisma, type AreaRequest, type Incident, type WorkItem } from '@prisma/client';
import type { ZodType, ZodTypeDef } from 'zod';
import { prisma } from '@/lib/prisma';
import {
  hasPermission,
  isAuthorizationError,
  type CurrentUser,
} from '@/modules/auth/authorization';
import { assertKnownPermission } from '@/modules/auth/permissions';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import { resolveResponsible } from '@/modules/comms/responsibles-service';
import { canonicalJson } from '@/modules/extensions/json-schema-to-zod';
import { enqueueJob, isJobDedupeConflictError, wakeJobWorker } from '@/modules/jobs/job-queue';
import type { NotificationCategory } from '@/modules/notifications/catalog';
import { notifyUser, type NotifyInput } from '@/modules/notifications/notification-service';
import { publishRealtime } from '@/modules/realtime/realtime-service';
import { OperationsError, isOperationsError } from './errors';
import {
  appendEvents,
  dispatchOperationalEvents,
  OPS_REALTIME_TYPES,
  publishEventsRealtime,
  runOperationalEventsTxListeners,
  toOperationalJson,
  userChannel,
  assertEventType,
  type OperationalEventInput,
  type OperationalEventRecord,
} from './events-service';
import { getOperationsConfig, withPinnedOperationsConfig } from './operations-config';
import { validateAreaRequest } from './request-kinds';
import {
  ACTOR_TYPES,
  AREA_LABELS,
  OPS_EVENTS,
  PRIORITIES,
  isAreaKey,
  type ActorType,
  type AreaKey,
  type ExternalSyncStatus,
  type IncidentKind,
  type IncidentSeverity,
  type OperationalEventTypeInput,
  type OperationsActor,
  type Priority,
  type WorkItemKind,
} from './types';

export { OperationsError, isOperationsError } from './errors';

/**
 * Idempotent command engine of the operations core (plan section 2.2).
 *
 * Every mutation of an operational module goes through `executeCommand`:
 *
 * 1. Validation outside any transaction: registered type, actor/session,
 *    permission and Zod payload. These rejections are not stored.
 * 2. Claim of `commandId` in the `OperationalCommand` ledger with
 *    `INSERT … ON CONFLICT DO NOTHING` (autocommit, wall clock). A repeated id
 *    replays the stored result; a claim still running returns `accepted` (in
 *    flight); a claim abandoned for more than a minute or marked `failed` is
 *    reclaimed with a conditional update. The same id with a different payload
 *    or from another actor is rejected (`command_id_conflict`): nobody replays
 *    or takes over someone else's command.
 * 3. One PostgreSQL transaction with the operations configuration pinned
 *    (loaded before; no second pool connection inside): optimistic version
 *    check and bump of the aggregate (before the handler, so the row lock is
 *    taken first), handler, then — from the buffers the handler filled —
 *    `OperationalEvent` rows, the in-transaction reactions
 *    (`onOperationalEventsInTransaction`: case advances, request
 *    acknowledgements), outbox jobs (`enqueueJob({tx})`), notifications
 *    (`notifyUser({tx})`), audit and the final ledger status. A lost version
 *    race retries the whole transaction once (also after
 *    `JobDedupeConflictError`).
 * 4. After the commit only: `wakeJobWorker()`, realtime on `case:{id}`,
 *    `area:{key}` and `user:{id}`, and the best-effort `onOperationalEvents`
 *    listeners. Nothing is published for a rolled-back transaction.
 *
 * Business rejections (`OperationsError` or `AuthorizationError` thrown by the
 * handler, version conflicts against the client's `expectedVersion`) are
 * stored as `rejected` and replayed on repetition. Transient losses
 * (`concurrency_conflict` after the retry) and unexpected errors mark the claim
 * `failed`, so the same id runs again later; the first is returned as a
 * rejection, the second is re-thrown.
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-commands', event, ...extra }));

const IN_FLIGHT_STALE_MS = 60_000;
const TRANSACTION_TIMEOUT_MS = 20_000;
const TRANSACTION_MAX_WAIT_MS = 10_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.\-]{0,159}$/;
const COMMAND_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

export interface DomainCommand<P = unknown> {
  /** Client-generated UUID (or deterministic key such as `sup:{kind}:{id}:{bucket}`). */
  commandId: string;
  type: string;
  actor: OperationsActor;
  /** Aggregate whose version guards the command; for creations, a stable natural key. */
  aggregate: { type: string; id: string };
  expectedVersion?: number;
  payload: P;
  deviceId?: string;
  /** ISO instant when it happened on the device (offline queue). Defaults to now. */
  occurredAt?: string;
}

export type CommandResultStatus = 'accepted' | 'completed' | 'pending_external' | 'rejected';

export interface CommandResult<D = unknown> {
  commandId: string;
  type: string;
  status: CommandResultStatus;
  errorCode?: string;
  /** Spanish, safe for the user (rejections). */
  message?: string;
  aggregateVersion: number;
  emittedEventIds: string[];
  createdWorkItemIds: string[];
  externalSyncStatus?: ExternalSyncStatus;
  /** JSON data returned by the handler (e.g. created ids). */
  data?: D;
  /** True when the result comes from the ledger instead of this execution. */
  replayed?: boolean;
}

export interface CommandHandlerOutput<D = unknown> {
  /** `pending_external` when part of the work waits for an external system. */
  status?: 'completed' | 'pending_external';
  externalSyncStatus?: ExternalSyncStatus;
  data?: D;
  /** For aggregate 'none' commands that create a versioned row. */
  aggregateVersion?: number;
}

/** Version guard of an aggregate. */
export interface AggregateAdapter {
  type: string;
  /** Current version, or null when the aggregate does not exist. */
  loadVersion(tx: Prisma.TransactionClient, id: string): Promise<number | null>;
  /** `UPDATE … SET version = version + 1 WHERE id AND version = expected`; false when 0 rows. */
  bumpVersion(tx: Prisma.TransactionClient, id: string, expected: number): Promise<boolean>;
}

export type CommandAuditMode = 'user' | 'always' | 'never';

export interface CommandDefinition<P = unknown, D = unknown> {
  schema: ZodType<P, ZodTypeDef, unknown>;
  /** Checked with `hasPermission` whenever a user is present (humans and bots). */
  permission?: string;
  aggregate: AggregateAdapter | 'none';
  /** Actor types allowed to issue it (default: all). Bots never approve: `['user']`. */
  actorTypes?: readonly ActorType[];
  /** Audit log entry per command: only for human actors (default), always or never. */
  audit?: CommandAuditMode;
  /** Handlers must not touch the aggregate's `version` column (the engine bumps it). */
  handler(
    tx: Prisma.TransactionClient,
    cmd: DomainCommand<P>,
    ctx: CommandContext
  ): Promise<CommandHandlerOutput<D> | void>;
}

export type OutboxJobInput = Omit<Parameters<typeof enqueueJob>[0], 'tx'>;

export type OpsNotifyInput = Omit<NotifyInput, 'tx'>;

export interface CreateWorkItemInput {
  areaKey: AreaKey;
  kind: WorkItemKind;
  title: string;
  description?: string | null;
  caseId?: string | null;
  stepId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  /** Explicit owner; otherwise the area responsible (with backup). */
  ownerUserId?: string;
  backupUserId?: string | null;
  /** Explicit due date; otherwise now + slaMinutes (default: config.slaDefaults[kind]). */
  dueAt?: Date;
  slaMinutes?: number;
  status?: 'open' | 'waiting';
  waitReason?: string | null;
  waitUntil?: Date | null;
  requiredEvidence?: string[];
  /** Defaults to true (category `ops_workitem`). */
  notify?: boolean;
  notification?: {
    category?: Extract<
      NotificationCategory,
      'ops_workitem' | 'approval_requested' | 'ops_request' | 'ops_escalation'
    >;
    title?: string;
    body?: string;
    url?: string;
  };
}

export interface OpenIncidentInput {
  kind: IncidentKind;
  areaKey: AreaKey;
  title: string;
  /** Idempotency key: the same key returns the existing incident. */
  dedupeKey: string;
  severity?: IncidentSeverity;
  detail?: Record<string, unknown>;
  caseId?: string | null;
  ownerUserId?: string | null;
  notify?: boolean;
}

export interface CreateAreaRequestInput {
  caseId: string;
  fromAreaKey: string;
  toAreaKey: string;
  kind: string;
  objectType: string;
  objectId: string;
  title: string;
  payload: unknown;
  freeText?: string | null;
  priority?: Priority;
  blocksDelivery?: boolean;
  dueAt?: Date;
  slaMinutes?: number;
  ownerUserId?: string;
  backupUserId?: string | null;
}

export interface ObjectRef {
  type: string;
  id: string;
}

export interface CommandContext {
  readonly commandId: string;
  readonly commandType: string;
  /** Server time of this execution (injectable in tests). */
  readonly now: Date;
  readonly actor: OperationsActor;
  /** Session user (humans) or bot actor; null for system/zoho commands. */
  readonly user: CurrentUser | null;
  readonly tx: Prisma.TransactionClient;
  /** Buffers an event; written in the same transaction after the handler. */
  emit(
    type: OperationalEventTypeInput,
    payload?: Record<string, unknown>,
    options?: {
      caseId?: string | null;
      areaKey?: string | null;
      objectType?: string | null;
      objectId?: string | null;
    }
  ): void;
  /** Buffers an outbox job (`enqueueJob({tx})`); the worker is woken after the commit. */
  outbox(job: OutboxJobInput): void;
  /** Buffers a notification (`notifyUser({tx})`); the actor is never notified of their own action. */
  notify(input: OpsNotifyInput): void;
  /** Buffers a realtime message published only after the commit. */
  realtime(channel: string, type: string, payload: unknown): void;
  /** Buffers an extra audit entry written in the transaction. */
  audit(event: {
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  }): void;
  createWorkItem(input: CreateWorkItemInput): Promise<WorkItem>;
  openIncident(input: OpenIncidentInput): Promise<{ incident: Incident; created: boolean }>;
  createAreaRequest(
    input: CreateAreaRequestInput
  ): Promise<{ request: AreaRequest; workItem: WorkItem }>;
  /** Upserts an `ObjectRelation` (reopens it if it had been closed). */
  relate(from: ObjectRef, to: ObjectRef, relation: string): Promise<void>;
}

export interface ExecuteCommandOptions {
  /** Server clock for this execution (tests). */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type AnyDefinition = CommandDefinition<unknown, unknown>;

type GlobalWithCommands = typeof globalThis & {
  __unikOperationalCommands?: Map<string, AnyDefinition>;
  __unikOperationalCommandContexts?: WeakMap<object, CommandContext>;
};

function registry(): Map<string, AnyDefinition> {
  const scope = globalThis as GlobalWithCommands;
  if (!scope.__unikOperationalCommands) scope.__unikOperationalCommands = new Map();
  return scope.__unikOperationalCommands;
}

/** Registers (or replaces, e.g. on hot reload) a command type. */
export function registerCommand<P, D = unknown>(
  type: string,
  definition: CommandDefinition<P, D>
): void {
  if (!COMMAND_TYPE_PATTERN.test(type)) throw new Error(`Invalid command type "${type}"`);
  if (definition.permission) assertKnownPermission(definition.permission);
  registry().set(type, definition as unknown as AnyDefinition);
}

export function hasCommand(type: string): boolean {
  return registry().has(type);
}

export function listCommandTypes(): string[] {
  return [...registry().keys()].sort();
}

type VersionDelegate = {
  findUnique(args: {
    where: { id: string };
    select: { version: true };
  }): Promise<{ version: number } | null>;
  updateMany(args: {
    where: { id: string; version: number };
    data: { version: { increment: number } };
  }): Promise<{ count: number }>;
};

/** Adapter for any model with `id` + `version Int` (e.g. `versionedAggregate('work_item', 'workItem')`). */
export function versionedAggregate(type: string, model: string): AggregateAdapter {
  const delegate = (tx: Prisma.TransactionClient): VersionDelegate => {
    const found = (tx as unknown as Record<string, VersionDelegate | undefined>)[model];
    if (!found || typeof found.updateMany !== 'function') {
      throw new Error(`Unknown versioned model "${model}"`);
    }
    return found;
  };
  return {
    type,
    async loadVersion(tx, id) {
      const row = await delegate(tx).findUnique({ where: { id }, select: { version: true } });
      return row ? row.version : null;
    },
    async bumpVersion(tx, id, expected) {
      const res = await delegate(tx).updateMany({
        where: { id, version: expected },
        data: { version: { increment: 1 } },
      });
      return res.count === 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Ambient context (lets domain helpers called with `tx` reach the command context)
// ---------------------------------------------------------------------------

/**
 * The running context, keyed by the transaction client.
 *
 * It lives on `globalThis`, like the command registry, and for the same
 * reason: Next.js compiles a server module ONCE PER WEBPACK LAYER, so
 * `src/modules/operations/commands.ts` is instantiated several times in the
 * same process (route handlers, server components and the instrumentation hook
 * each get their own copy). The registry is shared, so a handler registered by
 * one copy runs under the `executeCommand` of another; with a module-local
 * WeakMap that handler could not see the context its own command had just
 * opened and every work-item and request action failed with `outside_command`.
 * Verified against `next start`: `workitem.start` threw from a different chunk
 * than the one running the command.
 */
function contexts(): WeakMap<object, CommandContext> {
  const scope = globalThis as GlobalWithCommands;
  if (!scope.__unikOperationalCommandContexts) {
    scope.__unikOperationalCommandContexts = new WeakMap();
  }
  return scope.__unikOperationalCommandContexts;
}

export function getCommandContext(tx: Prisma.TransactionClient): CommandContext | null {
  return contexts().get(tx as object) ?? null;
}

/** For helpers such as `requestApproval(tx, …)` that must run inside a command. */
export function requireCommandContext(tx: Prisma.TransactionClient): CommandContext {
  const ctx = getCommandContext(tx);
  if (!ctx) {
    throw new OperationsError(
      'outside_command',
      'Esta operación sólo puede ejecutarse dentro de un comando de operaciones'
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Assignment of owners
// ---------------------------------------------------------------------------

export interface AreaAssignee {
  ownerUserId: string;
  backupUserId: string | null;
  /** responsible | backup | area_lead | administracion | super_admin */
  source: 'responsible' | 'backup' | 'area_lead' | 'administracion' | 'super_admin';
}

async function responsibleOf(tx: Prisma.TransactionClient, areaKey: AreaKey) {
  const area = await tx.area.findUnique({
    where: { key: areaKey },
    select: { responsibleArea: true, leadUserId: true },
  });
  const resolved = await resolveResponsible(area?.responsibleArea || areaKey, tx);
  return { area, resolved };
}

async function isActiveUser(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  return Boolean(user?.isActive);
}

/**
 * Who owns new work of an area: the `Responsible` of the area (primary, or the
 * backup when the primary is inactive), then the area lead, then the
 * responsible of Administración, then the oldest active super admin.
 */
export async function resolveAreaAssignee(
  tx: Prisma.TransactionClient,
  areaKey: AreaKey
): Promise<AreaAssignee> {
  const { area, resolved } = await responsibleOf(tx, areaKey);
  if (resolved) {
    const backup =
      resolved.backupUserId && resolved.backupUserId !== resolved.userId
        ? resolved.backupUserId
        : null;
    return {
      ownerUserId: resolved.userId,
      backupUserId: resolved.isBackup ? null : backup,
      source: resolved.isBackup ? 'backup' : 'responsible',
    };
  }
  if (area?.leadUserId && (await isActiveUser(tx, area.leadUserId))) {
    return { ownerUserId: area.leadUserId, backupUserId: null, source: 'area_lead' };
  }
  if (areaKey !== 'administracion') {
    const admin = await responsibleOf(tx, 'administracion');
    if (admin.resolved) {
      return { ownerUserId: admin.resolved.userId, backupUserId: null, source: 'administracion' };
    }
    if (admin.area?.leadUserId && (await isActiveUser(tx, admin.area.leadUserId))) {
      return { ownerUserId: admin.area.leadUserId, backupUserId: null, source: 'administracion' };
    }
  }
  const superAdmin = await tx.user.findFirst({
    where: {
      isActive: true,
      isBot: false,
      roles: { some: { role: { key: SUPER_ADMIN_ROLE_KEY, isActive: true } } },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (superAdmin) return { ownerUserId: superAdmin.id, backupUserId: null, source: 'super_admin' };
  throw new OperationsError(
    'no_responsible',
    `No hay responsable configurado para ${AREA_LABELS[areaKey]} ni para Administración`
  );
}

// ---------------------------------------------------------------------------
// Context implementation
// ---------------------------------------------------------------------------

interface BufferedEvent extends OperationalEventInput {
  type: string;
}

const dueFormatter = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatDue(date: Date): string {
  try {
    return dueFormatter.format(date);
  } catch {
    return date.toISOString();
  }
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function requireText(value: string, field: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new OperationsError('invalid_payload', `Falta ${field}`);
  return text.slice(0, max);
}

function caseUrl(caseId: string | null | undefined): string {
  return caseId ? `/app/operations/cases/${caseId}` : '/app/operations';
}

class OperationsCommandContext implements CommandContext {
  readonly events: BufferedEvent[] = [];
  readonly jobs: OutboxJobInput[] = [];
  readonly notifications: OpsNotifyInput[] = [];
  readonly realtimeMessages: Array<{ channel: string; type: string; payload: unknown }> = [];
  readonly audits: Array<{
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  }> = [];
  readonly createdWorkItems: Array<{
    id: string;
    ownerUserId: string;
    backupUserId: string | null;
  }> = [];
  private readonly assignees = new Map<AreaKey, AreaAssignee>();

  constructor(
    readonly tx: Prisma.TransactionClient,
    readonly commandId: string,
    readonly commandType: string,
    readonly actor: OperationsActor,
    readonly user: CurrentUser | null,
    readonly now: Date,
    private readonly occurredAt: Date
  ) {}

  private get actorUserId(): string | null {
    return this.actor.type === 'user' || this.actor.type === 'ai' ? this.actor.id : null;
  }

  emit(
    type: OperationalEventTypeInput,
    payload: Record<string, unknown> = {},
    options: {
      caseId?: string | null;
      areaKey?: string | null;
      objectType?: string | null;
      objectId?: string | null;
    } = {}
  ): void {
    assertEventType(type);
    this.events.push({
      type,
      payload,
      caseId: options.caseId ?? null,
      areaKey: options.areaKey ?? null,
      objectType: options.objectType ?? null,
      objectId: options.objectId ?? null,
      actorType: this.actor.type,
      actorId: this.actor.id,
      commandId: this.commandId,
      occurredAt: this.occurredAt,
    });
  }

  outbox(job: OutboxJobInput): void {
    this.jobs.push(job);
  }

  notify(input: OpsNotifyInput): void {
    this.notifications.push({ actorUserId: this.actorUserId, ...input });
  }

  realtime(channel: string, type: string, payload: unknown): void {
    this.realtimeMessages.push({ channel, type, payload });
  }

  audit(event: {
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  }): void {
    this.audits.push(event);
  }

  private async assigneeFor(areaKey: AreaKey): Promise<AreaAssignee> {
    const cached = this.assignees.get(areaKey);
    if (cached) return cached;
    const resolved = await resolveAreaAssignee(this.tx, areaKey);
    this.assignees.set(areaKey, resolved);
    return resolved;
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
    if (!isAreaKey(input.areaKey)) throw new OperationsError('invalid_payload', 'Área inválida');
    const title = requireText(input.title, 'el título del trabajo', 200);
    const assignee = input.ownerUserId
      ? { ownerUserId: input.ownerUserId, backupUserId: input.backupUserId ?? null }
      : await this.assigneeFor(input.areaKey);
    const backupUserId =
      input.backupUserId !== undefined && input.ownerUserId === undefined
        ? input.backupUserId
        : assignee.backupUserId;
    let dueAt = input.dueAt;
    if (!dueAt) {
      const minutes = input.slaMinutes ?? (await getOperationsConfig()).slaDefaults[input.kind];
      dueAt = addMinutes(this.now, Math.max(0, minutes));
    }
    const row = await this.tx.workItem.create({
      data: {
        caseId: input.caseId ?? null,
        stepId: input.stepId ?? null,
        areaKey: input.areaKey,
        kind: input.kind,
        title,
        description: input.description ?? null,
        status: input.status ?? 'open',
        ownerUserId: assignee.ownerUserId,
        backupUserId: backupUserId && backupUserId !== assignee.ownerUserId ? backupUserId : null,
        dueAt,
        waitReason: input.waitReason ?? null,
        waitUntil: input.waitUntil ?? null,
        objectType: input.objectType ?? null,
        objectId: input.objectId ?? null,
        requiredEvidence: input.requiredEvidence ?? [],
      },
    });
    this.createdWorkItems.push({
      id: row.id,
      ownerUserId: row.ownerUserId,
      backupUserId: row.backupUserId,
    });
    this.emit(
      OPS_EVENTS.workitem.created,
      {
        workItemId: row.id,
        kind: row.kind,
        title: row.title,
        ownerUserId: row.ownerUserId,
        backupUserId: row.backupUserId,
        dueAt: row.dueAt.toISOString(),
        stepId: row.stepId,
        objectType: row.objectType,
        objectId: row.objectId,
      },
      { caseId: row.caseId, areaKey: row.areaKey, objectType: 'work_item', objectId: row.id }
    );
    if (input.notify !== false) {
      this.notify({
        userId: row.ownerUserId,
        category: input.notification?.category ?? 'ops_workitem',
        type: 'ops_workitem_created',
        title: input.notification?.title ?? `Nuevo trabajo: ${row.title}`,
        body:
          input.notification?.body ??
          `${AREA_LABELS[input.areaKey]} · vence ${formatDue(row.dueAt)}`,
        url: input.notification?.url ?? `/app/mywork?workItem=${row.id}`,
        entityType: 'work_item',
        entityId: row.id,
      });
    }
    return row;
  }

  async openIncident(input: OpenIncidentInput): Promise<{ incident: Incident; created: boolean }> {
    if (!isAreaKey(input.areaKey)) throw new OperationsError('invalid_payload', 'Área inválida');
    const dedupeKey = requireText(input.dedupeKey, 'la llave de la incidencia', 300);
    const title = requireText(input.title, 'el título de la incidencia', 200);
    let ownerUserId = input.ownerUserId ?? null;
    if (!ownerUserId) {
      try {
        ownerUserId = (await this.assigneeFor(input.areaKey)).ownerUserId;
      } catch (err) {
        // An incident must always be recorded, even without a responsible.
        if (!isOperationsError(err) || err.code !== 'no_responsible') throw err;
      }
    }
    // ON CONFLICT DO NOTHING: a duplicate never aborts the command transaction.
    const [inserted] = await this.tx.incident.createManyAndReturn({
      data: [
        {
          caseId: input.caseId ?? null,
          areaKey: input.areaKey,
          kind: input.kind,
          severity: input.severity ?? 'medium',
          status: 'open',
          title,
          detail: toOperationalJson(input.detail ?? {}),
          ownerUserId,
          dedupeKey,
          openedAt: this.now,
        },
      ],
      skipDuplicates: true,
    });
    if (!inserted) {
      const existing = await this.tx.incident.findUnique({ where: { dedupeKey } });
      if (!existing) throw new Error(`Incident "${dedupeKey}" conflicted but could not be read`);
      return { incident: existing, created: false };
    }
    this.emit(
      OPS_EVENTS.incident.opened,
      {
        incidentId: inserted.id,
        kind: inserted.kind,
        severity: inserted.severity,
        title: inserted.title,
        ownerUserId: inserted.ownerUserId,
        dedupeKey,
      },
      {
        caseId: inserted.caseId,
        areaKey: inserted.areaKey,
        objectType: 'incident',
        objectId: inserted.id,
      }
    );
    if (inserted.ownerUserId && input.notify !== false) {
      const severe = inserted.severity === 'high' || inserted.severity === 'critical';
      this.notify({
        userId: inserted.ownerUserId,
        category: 'ops_incident',
        type: 'ops_incident_opened',
        title: `Incidencia: ${inserted.title}`,
        body: `${AREA_LABELS[input.areaKey]} · severidad ${inserted.severity}`,
        url: caseUrl(inserted.caseId),
        entityType: 'incident',
        entityId: inserted.id,
        push: severe
          ? { urgency: 'high', requireInteraction: inserted.severity === 'critical' }
          : undefined,
      });
    }
    return { incident: inserted, created: true };
  }

  async createAreaRequest(
    input: CreateAreaRequestInput
  ): Promise<{ request: AreaRequest; workItem: WorkItem }> {
    const validation = validateAreaRequest(
      input.kind,
      input.fromAreaKey,
      input.toAreaKey,
      input.payload,
      input.freeText
    );
    if (!validation.ok) {
      throw new OperationsError('invalid_request', validation.message, {
        details: { reason: validation.code, issues: validation.issues },
      });
    }
    const caseId = requireText(input.caseId, 'el expediente', 120);
    const objectType = requireText(input.objectType, 'el tipo de objeto', 60);
    const objectId = requireText(input.objectId, 'el objeto', 120);
    const title = requireText(input.title, 'el título de la solicitud', 200);
    const priority = input.priority ?? validation.defaultPriority;
    if (!(PRIORITIES as readonly string[]).includes(priority)) {
      throw new OperationsError('invalid_payload', 'Prioridad inválida');
    }
    const target = validation.toAreaKey;
    const assignee = input.ownerUserId
      ? { ownerUserId: input.ownerUserId, backupUserId: input.backupUserId ?? null }
      : await this.assigneeFor(target);
    let dueAt = input.dueAt;
    if (!dueAt) {
      const minutes = input.slaMinutes ?? (await getOperationsConfig()).slaDefaults.action;
      dueAt = addMinutes(this.now, Math.max(0, minutes));
    }
    const created = await this.tx.areaRequest.create({
      data: {
        caseId,
        fromAreaKey: validation.fromAreaKey,
        toAreaKey: target,
        kind: validation.kind,
        objectType,
        objectId,
        title,
        payload: toOperationalJson(validation.payload),
        freeText: validation.freeText,
        priority,
        status: 'sent',
        blocksDelivery: input.blocksDelivery ?? validation.blocksDelivery,
        dueAt,
        ownerUserId: assignee.ownerUserId,
        backupUserId: assignee.backupUserId,
        createdByType: this.actor.type === 'zoho' ? 'system' : this.actor.type,
        createdById: this.actor.id,
      },
    });
    const workItem = await this.createWorkItem({
      areaKey: target,
      kind: 'action',
      title: `Solicitud de ${AREA_LABELS[validation.fromAreaKey]}: ${title}`,
      caseId,
      objectType: 'area_request',
      objectId: created.id,
      ownerUserId: assignee.ownerUserId,
      backupUserId: assignee.backupUserId,
      dueAt,
      notify: false,
    });
    const request = await this.tx.areaRequest.update({
      where: { id: created.id },
      data: { workItemId: workItem.id },
    });
    this.emit(
      OPS_EVENTS.request.created,
      {
        requestId: request.id,
        kind: request.kind,
        fromAreaKey: request.fromAreaKey,
        toAreaKey: request.toAreaKey,
        ownerUserId: request.ownerUserId,
        backupUserId: request.backupUserId,
        workItemId: workItem.id,
        priority: request.priority,
        blocksDelivery: request.blocksDelivery,
        dueAt: request.dueAt.toISOString(),
        hasFreeText: request.freeText !== null,
      },
      { caseId, areaKey: target, objectType: 'area_request', objectId: request.id }
    );
    // The ONE notice of a new request (the agents layer only posts the cards): a delivery blocker
    // pushes with high urgency; the key keeps it single even if the request is announced again.
    this.notify({
      userId: request.ownerUserId,
      category: 'ops_request',
      type: 'ops_request_created',
      title: `${AREA_LABELS[validation.fromAreaKey]} te pide: ${title}`,
      body: `${validation.label} · vence ${formatDue(request.dueAt)}`,
      url: `/app/mywork?workItem=${workItem.id}`,
      entityType: 'area_request',
      entityId: request.id,
      metadata: { caseId, workItemId: workItem.id, blocksDelivery: request.blocksDelivery },
      dedupeKey: `area_request:${request.id}:${request.ownerUserId}`,
      push: request.blocksDelivery ? { urgency: 'high' } : undefined,
    });
    return { request, workItem };
  }

  async relate(from: ObjectRef, to: ObjectRef, relation: string): Promise<void> {
    const key = {
      fromType: requireText(from.type, 'el tipo de origen', 60),
      fromId: requireText(from.id, 'el origen', 120),
      toType: requireText(to.type, 'el tipo de destino', 60),
      toId: requireText(to.id, 'el destino', 120),
      relation: requireText(relation, 'la relación', 60),
    };
    await this.tx.objectRelation.createMany({
      data: [{ ...key, validFrom: this.now }],
      skipDuplicates: true,
    });
    await this.tx.objectRelation.updateMany({
      where: { ...key, validTo: { not: null } },
      data: { validTo: null, validFrom: this.now },
    });
  }

  /** Writes the buffers inside the transaction (events → reactions → jobs → notifications → audits). */
  async flush(): Promise<OperationalEventRecord[]> {
    const records = await appendEvents(this.tx, this.events);
    // Reactions that must never be lost are enqueued atomically with the state.
    await runOperationalEventsTxListeners(this.tx, records, { outbox: (job) => this.outbox(job) });
    for (const job of this.jobs) {
      await enqueueJob({ ...job, tx: this.tx });
    }
    for (const notification of this.notifications) {
      await notifyUser({ ...notification, tx: this.tx });
    }
    for (const audit of this.audits) {
      await recordAuditEvent(
        {
          actorUserId: this.actorUserId,
          action: audit.action,
          targetType: audit.targetType,
          targetId: audit.targetId ?? null,
          metadata: audit.metadata ? toOperationalJson(audit.metadata) : undefined,
        },
        this.tx
      );
    }
    return records;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * A row the command depends on changed under it (lost version race). Domain
 * code may throw it too: the engine rolls the transaction back and runs the
 * whole command once more, then answers `concurrency_conflict` (retryable).
 */
const CONCURRENCY_CONFLICT_BRAND: unique symbol = Symbol.for('unik.operations.concurrencyConflict');
const CLAIM_LOST_BRAND: unique symbol = Symbol.for('unik.operations.claimLost');

export class ConcurrencyConflict extends Error {
  // Branded like `OperationsError`: this module is compiled once per webpack
  // layer, so `instanceof` alone misses an error thrown by another copy.
  readonly [CONCURRENCY_CONFLICT_BRAND] = true;

  constructor() {
    super('Aggregate version changed during the command');
    this.name = 'ConcurrencyConflict';
  }
}

export function isConcurrencyConflict(err: unknown): err is ConcurrencyConflict {
  if (err instanceof ConcurrencyConflict) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[CONCURRENCY_CONFLICT_BRAND] === true
  );
}

class ClaimLostError extends Error {
  readonly [CLAIM_LOST_BRAND] = true;

  constructor() {
    super('The command claim was taken by another execution');
    this.name = 'ClaimLostError';
  }
}

function isClaimLostError(err: unknown): err is ClaimLostError {
  if (err instanceof ClaimLostError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[CLAIM_LOST_BRAND] === true
  );
}

function baseResult<D>(cmd: Pick<DomainCommand, 'commandId' | 'type'>): CommandResult<D> {
  return {
    commandId: cmd.commandId,
    type: cmd.type,
    status: 'accepted',
    aggregateVersion: 0,
    emittedEventIds: [],
    createdWorkItemIds: [],
  };
}

function rejection<D>(
  cmd: Pick<DomainCommand, 'commandId' | 'type'>,
  errorCode: string,
  message: string
): CommandResult<D> {
  return { ...baseResult<D>(cmd), status: 'rejected', errorCode, message };
}

/** Deterministic fingerprint of what the command asks for (not who or when). */
export function commandPayloadHash(cmd: DomainCommand<unknown>): string {
  const material = canonicalJson(
    toOperationalJson({
      type: cmd.type,
      aggregate: cmd.aggregate,
      expectedVersion: cmd.expectedVersion ?? null,
      payload: cmd.payload ?? null,
    })
  );
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

function shapeError(cmd: DomainCommand<unknown>): string | null {
  if (!cmd || typeof cmd !== 'object') return 'Comando inválido';
  if (typeof cmd.commandId !== 'string' || !COMMAND_ID_PATTERN.test(cmd.commandId)) {
    return 'Identificador de comando inválido';
  }
  if (typeof cmd.type !== 'string' || !COMMAND_TYPE_PATTERN.test(cmd.type))
    return 'Tipo de comando inválido';
  if (
    !cmd.actor ||
    !(ACTOR_TYPES as readonly string[]).includes(cmd.actor.type) ||
    typeof cmd.actor.id !== 'string' ||
    !cmd.actor.id.trim()
  ) {
    return 'Actor inválido';
  }
  if (
    !cmd.aggregate ||
    typeof cmd.aggregate.type !== 'string' ||
    !cmd.aggregate.type.trim() ||
    typeof cmd.aggregate.id !== 'string' ||
    !cmd.aggregate.id.trim() ||
    cmd.aggregate.id.length > 200
  ) {
    return 'Registro del comando inválido';
  }
  if (
    cmd.expectedVersion !== undefined &&
    (!Number.isInteger(cmd.expectedVersion) || cmd.expectedVersion < 1)
  ) {
    return 'Versión esperada inválida';
  }
  if (
    cmd.deviceId !== undefined &&
    (typeof cmd.deviceId !== 'string' || cmd.deviceId.length > 120)
  ) {
    return 'Dispositivo inválido';
  }
  return null;
}

function resolveOccurredAt(value: string | undefined, now: Date): Date | null {
  if (value === undefined) return now;
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.getTime())) return null;
  // A device clock ahead of the server never produces events in the future.
  return parsed.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS ? now : parsed;
}

type Claim =
  | { kind: 'owned'; receivedAt: Date }
  | { kind: 'replay'; result: CommandResult }
  | { kind: 'in_flight' }
  | { kind: 'conflict' };

function storedResult(row: {
  id: string;
  type: string;
  status: string;
  result: Prisma.JsonValue | null;
  errorCode: string | null;
}): CommandResult {
  const stored =
    row.result && typeof row.result === 'object' && !Array.isArray(row.result)
      ? (row.result as unknown as CommandResult)
      : null;
  if (stored && typeof stored.status === 'string') return { ...stored, replayed: true };
  const base = baseResult({ commandId: row.id, type: row.type });
  return {
    ...base,
    status:
      row.status === 'rejected'
        ? 'rejected'
        : row.status === 'pending_external'
          ? 'pending_external'
          : 'completed',
    errorCode: row.errorCode ?? undefined,
    replayed: true,
  };
}

/**
 * Claims the command id. Always on the wall clock, never the injected `now`:
 * `receivedAt` decides when a claim counts as abandoned, and a stale instant
 * (e.g. the start of a long supervisor tick) would let another instance take
 * over a claim that is still running.
 */
async function claimCommand(cmd: DomainCommand<unknown>, payloadHash: string): Promise<Claim> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = new Date();
    const created = await prisma.operationalCommand.createManyAndReturn({
      data: [
        {
          id: cmd.commandId,
          type: cmd.type,
          actorType: cmd.actor.type,
          actorId: cmd.actor.id,
          aggregateType: cmd.aggregate.type,
          aggregateId: cmd.aggregate.id,
          expectedVersion: cmd.expectedVersion ?? null,
          payloadHash,
          deviceId: cmd.deviceId ?? null,
          status: 'accepted',
          receivedAt: now,
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    if (created.length === 1) return { kind: 'owned', receivedAt: now };

    const existing = await prisma.operationalCommand.findUnique({ where: { id: cmd.commandId } });
    if (!existing) continue; // removed between both statements: claim again
    if (
      existing.payloadHash !== payloadHash ||
      existing.type !== cmd.type ||
      existing.actorType !== cmd.actor.type ||
      existing.actorId !== cmd.actor.id
    ) {
      // Another intent, or another actor: never replay (nor take over) someone else's command.
      return { kind: 'conflict' };
    }
    if (
      existing.status === 'completed' ||
      existing.status === 'pending_external' ||
      existing.status === 'rejected'
    ) {
      return { kind: 'replay', result: storedResult(existing) };
    }
    const abandoned =
      existing.status === 'failed' ||
      (existing.status === 'accepted' &&
        now.getTime() - existing.receivedAt.getTime() > IN_FLIGHT_STALE_MS);
    if (!abandoned) return { kind: 'in_flight' };
    const reclaimed = await prisma.operationalCommand.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        receivedAt: existing.receivedAt,
        actorType: cmd.actor.type,
        actorId: cmd.actor.id,
      },
      data: {
        status: 'accepted',
        receivedAt: now,
        deviceId: cmd.deviceId ?? null,
        errorCode: null,
        result: Prisma.DbNull,
        completedAt: null,
      },
    });
    return reclaimed.count === 1 ? { kind: 'owned', receivedAt: now } : { kind: 'in_flight' };
  }
  return { kind: 'in_flight' };
}

async function finalizeOutside(
  commandId: string,
  receivedAt: Date,
  status: 'rejected' | 'failed',
  errorCode: string,
  result: CommandResult | null
): Promise<void> {
  try {
    await prisma.operationalCommand.updateMany({
      where: { id: commandId, status: 'accepted', receivedAt },
      data: {
        status,
        errorCode,
        result: result ? toOperationalJson(result) : Prisma.DbNull,
        completedAt: new Date(),
      },
    });
  } catch (err) {
    log('ledger_finalize_failed', {
      commandId,
      status,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function describeIssues(error: {
  issues: Array<{ path: (string | number)[]; message: string }>;
}): string {
  return error.issues
    .slice(0, 3)
    .map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
    )
    .join('; ');
}

interface TransactionOutcome {
  result: CommandResult;
  events: OperationalEventRecord[];
  ctx: OperationsCommandContext;
}

async function runInTransaction(
  definition: AnyDefinition,
  cmd: DomainCommand<unknown>,
  payload: unknown,
  user: CurrentUser | null,
  receivedAt: Date,
  now: Date,
  occurredAt: Date
): Promise<TransactionOutcome> {
  return prisma.$transaction(
    async (tx) => {
      const ctx = new OperationsCommandContext(
        tx,
        cmd.commandId,
        cmd.type,
        cmd.actor,
        user,
        now,
        occurredAt
      );
      contexts().set(tx as object, ctx);
      try {
        let aggregateVersion = 0;
        if (definition.aggregate !== 'none') {
          const current = await definition.aggregate.loadVersion(tx, cmd.aggregate.id);
          if (current === null) {
            throw new OperationsError(
              'not_found',
              'No se encontró el registro sobre el que se quiere actuar'
            );
          }
          if (cmd.expectedVersion !== undefined && current !== cmd.expectedVersion) {
            throw new OperationsError(
              'version_conflict',
              'El registro cambió mientras trabajabas; recarga e intenta de nuevo',
              { details: { expectedVersion: cmd.expectedVersion, currentVersion: current } }
            );
          }
          // Bump first: the row lock serializes concurrent commands on the aggregate.
          if (!(await definition.aggregate.bumpVersion(tx, cmd.aggregate.id, current))) {
            throw new ConcurrencyConflict();
          }
          aggregateVersion = current + 1;
        }

        const output =
          (await definition.handler(tx, { ...cmd, payload }, ctx)) ?? ({} as CommandHandlerOutput);
        const events = await ctx.flush();

        const status = output.status ?? 'completed';
        const result: CommandResult = {
          commandId: cmd.commandId,
          type: cmd.type,
          status,
          aggregateVersion: output.aggregateVersion ?? aggregateVersion,
          emittedEventIds: events.map((e) => e.id),
          createdWorkItemIds: ctx.createdWorkItems.map((w) => w.id),
          ...(output.externalSyncStatus ? { externalSyncStatus: output.externalSyncStatus } : {}),
          ...(output.data !== undefined ? { data: output.data } : {}),
        };

        const auditMode = definition.audit ?? 'user';
        if (auditMode === 'always' || (auditMode === 'user' && cmd.actor.type === 'user')) {
          await recordAuditEvent(
            {
              actorUserId:
                cmd.actor.type === 'user' || cmd.actor.type === 'ai' ? cmd.actor.id : null,
              action: `operations.command.${cmd.type}`,
              targetType: cmd.aggregate.type,
              targetId: cmd.aggregate.id,
              metadata: toOperationalJson({
                commandId: cmd.commandId,
                status,
                deviceId: cmd.deviceId ?? null,
                events: events.length,
              }),
            },
            tx
          );
        }

        const closed = await tx.operationalCommand.updateMany({
          where: { id: cmd.commandId, status: 'accepted', receivedAt },
          data: {
            status,
            result: toOperationalJson(result),
            errorCode: null,
            completedAt: new Date(),
          },
        });
        if (closed.count !== 1) throw new ClaimLostError();
        return { result, events, ctx };
      } finally {
        contexts().delete(tx as object);
      }
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS }
  );
}

async function afterCommit(outcome: TransactionOutcome): Promise<void> {
  const { ctx, events, result } = outcome;
  try {
    if (ctx.jobs.length > 0) wakeJobWorker();
    await publishEventsRealtime(events, { commandId: result.commandId, commandType: result.type });

    const byUser = new Map<string, string[]>();
    for (const item of ctx.createdWorkItems) {
      for (const userId of [item.ownerUserId, item.backupUserId]) {
        if (!userId) continue;
        byUser.set(userId, [...(byUser.get(userId) ?? []), item.id]);
      }
    }
    for (const [userId, workItemIds] of byUser) {
      await publishRealtime(userChannel(userId), OPS_REALTIME_TYPES.workItems, {
        commandId: result.commandId,
        commandType: result.type,
        workItemIds,
      }).catch((err) =>
        log('realtime_failed', {
          channel: userChannel(userId),
          message: err instanceof Error ? err.message : String(err),
        })
      );
    }
    for (const message of ctx.realtimeMessages) {
      await publishRealtime(message.channel, message.type, message.payload).catch((err) =>
        log('realtime_failed', {
          channel: message.channel,
          message: err instanceof Error ? err.message : String(err),
        })
      );
    }
    await dispatchOperationalEvents(events);
  } catch (err) {
    log('after_commit_failed', {
      commandId: result.commandId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Executes a registered command (see the module comment for the full flow).
 * Expected rejections come back as `status: 'rejected'` with `errorCode`;
 * only unexpected failures throw.
 */
export async function executeCommand<D = unknown>(
  cmd: DomainCommand<unknown>,
  user?: CurrentUser | null,
  options: ExecuteCommandOptions = {}
): Promise<CommandResult<D>> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const session = user ?? null;

  const invalidShape = shapeError(cmd);
  if (invalidShape) {
    return rejection<D>(
      { commandId: String(cmd?.commandId ?? ''), type: String(cmd?.type ?? '') },
      'invalid_payload',
      invalidShape
    );
  }
  const definition = registry().get(cmd.type);
  if (!definition) return rejection<D>(cmd, 'unknown_command', `Comando desconocido: ${cmd.type}`);

  if (definition.actorTypes && !definition.actorTypes.includes(cmd.actor.type)) {
    return rejection<D>(cmd, 'forbidden', 'Este tipo de actor no puede ejecutar esta acción');
  }
  const humanOrBot = cmd.actor.type === 'user' || cmd.actor.type === 'ai';
  if (humanOrBot && !session) {
    return rejection<D>(cmd, 'unauthenticated', 'Tu sesión expiró; vuelve a iniciar sesión');
  }
  if (humanOrBot && session && session.id !== cmd.actor.id) {
    return rejection<D>(cmd, 'actor_mismatch', 'El comando no corresponde a tu sesión');
  }
  if (definition.permission && session && !hasPermission(session, definition.permission)) {
    return rejection<D>(cmd, 'forbidden', 'No tienes permisos para realizar esta acción');
  }
  if (definition.aggregate !== 'none' && cmd.aggregate.type !== definition.aggregate.type) {
    return rejection<D>(cmd, 'invalid_payload', 'El registro no corresponde a este comando');
  }
  const parsed = definition.schema.safeParse(cmd.payload);
  if (!parsed.success) {
    return rejection<D>(cmd, 'invalid_payload', `Datos inválidos: ${describeIssues(parsed.error)}`);
  }
  const occurredAt = resolveOccurredAt(cmd.occurredAt, now);
  if (!occurredAt) return rejection<D>(cmd, 'invalid_payload', 'Fecha del comando inválida');

  // Loaded before the transaction and pinned inside it (see withPinnedOperationsConfig).
  const config = await getOperationsConfig();
  const claim = await claimCommand(cmd, commandPayloadHash(cmd));
  if (claim.kind === 'replay') {
    log('command_replayed', {
      commandId: cmd.commandId,
      type: cmd.type,
      status: claim.result.status,
    });
    return claim.result as CommandResult<D>;
  }
  if (claim.kind === 'in_flight') {
    return { ...baseResult<D>(cmd), status: 'accepted', replayed: true };
  }
  if (claim.kind === 'conflict') {
    return rejection<D>(
      cmd,
      'command_id_conflict',
      'Este identificador de comando ya se usó para otra operación'
    );
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const outcome = await withPinnedOperationsConfig(config, () =>
        runInTransaction(definition, cmd, parsed.data, session, claim.receivedAt, now, occurredAt)
      );
      await afterCommit(outcome);
      log('command_completed', {
        commandId: cmd.commandId,
        type: cmd.type,
        status: outcome.result.status,
        events: outcome.events.length,
        attempt,
        ms: Date.now() - startedAt,
      });
      return outcome.result as CommandResult<D>;
    } catch (err) {
      // Both guards check the process-wide brand, never only `instanceof`: the
      // error may come from another compiled copy of its module (see below).
      if (isConcurrencyConflict(err) || isJobDedupeConflictError(err)) {
        if (attempt === 0) {
          log('command_retry', { commandId: cmd.commandId, type: cmd.type, reason: err.name });
          continue;
        }
        const result = rejection<D>(
          cmd,
          'concurrency_conflict',
          'Otra operación modificó el mismo registro; intenta de nuevo'
        );
        // A transient loss is not a decision: stored as `failed`, so repeating the
        // same commandId (supervisor findings, job confirmations…) runs it again.
        await finalizeOutside(
          cmd.commandId,
          claim.receivedAt,
          'failed',
          'concurrency_conflict',
          null
        );
        log('command_rejected', {
          commandId: cmd.commandId,
          type: cmd.type,
          errorCode: 'concurrency_conflict',
        });
        return result;
      }
      if (isClaimLostError(err)) {
        return { ...baseResult<D>(cmd), status: 'accepted', replayed: true };
      }
      if (isOperationsError(err) || isAuthorizationError(err)) {
        const code = isOperationsError(err) ? err.code : 'forbidden';
        const result = rejection<D>(cmd, code, err.message);
        await finalizeOutside(cmd.commandId, claim.receivedAt, 'rejected', code, result);
        log('command_rejected', {
          commandId: cmd.commandId,
          type: cmd.type,
          errorCode: code,
          ms: Date.now() - startedAt,
        });
        return result;
      }
      await finalizeOutside(cmd.commandId, claim.receivedAt, 'failed', 'internal_error', null);
      console.error(
        JSON.stringify({
          component: 'operations-commands',
          event: 'command_failed',
          commandId: cmd.commandId,
          type: cmd.type,
          message: err instanceof Error ? err.message : String(err),
        })
      );
      throw err;
    }
  }
  // Unreachable: the loop always returns or throws.
  throw new Error('executeCommand: retry loop exhausted');
}
