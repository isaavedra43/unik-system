import { randomUUID } from 'crypto';
import type { AreaRequest, Prisma, WorkItem } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasAnyPermission, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import {
  OPERATIONS_MANAGE_PERMISSION,
  OPERATIONS_OPERATOR_PERMISSIONS,
  OPERATIONS_VIEW_PERMISSION,
} from '@/modules/operations/permissions';
import { resolveResponsible } from '@/modules/comms/responsibles-service';
import { JOB_PRIORITY, type JobContext } from '@/modules/jobs/job-queue';
import {
  executeCommand,
  registerCommand,
  requireCommandContext,
  resolveAreaAssignee,
  versionedAggregate,
  type CommandContext,
  type CommandResult,
} from './commands';
import { OperationsError, isOperationsError } from './errors';
import {
  areaChannel,
  onOperationalEventsInTransaction,
  toOperationalJson,
  type OperationalEventRecord,
  type OperationalOutboxJob,
} from './events-service';
import { AREA_REQUEST_KIND_CATALOG, isAreaRequestKind } from './request-kinds';
import {
  AREA_LABELS,
  AREA_REQUEST_KINDS,
  AREA_REQUEST_OPEN_STATUSES,
  AREA_REQUEST_STATUSES,
  AREA_REQUEST_STATUS_LABELS,
  OPS_EVENTS,
  PRIORITY_LABELS,
  isAreaKey,
  type ActorType,
  type AreaRequestStatus,
  type OperationsActor,
} from './types';
import {
  canViewArea,
  cancelWorkItemInTx,
  completeWorkItemInTx,
  decodeListCursor,
  encodeListCursor,
  escalateWorkItem,
  formatMinutes,
  isActiveHumanUser,
  isWorkItemOpenStatus,
  keysetCondition,
  registerWorkItemHooks,
  startWorkItemInTx,
  waitWorkItemInTx,
  type EscalationOutcome,
} from './work-items-service';

/**
 * Lifecycle of requests between areas (plan sections 5.3 and 10). Creation
 * lives in the command engine (`ctx.createAreaRequest`, which also creates the
 * linked work item of the destination area); this service moves them forward.
 *
 * States: sent → acknowledged → accepted ⇄ blocked → resolved | rejected, plus
 * cancelled / expired from any open state.
 * - `acknowledged` is automatic: the transaction that emits `request.created`
 *   also enqueues `ops.request.auto_ack`, whose handler runs
 *   `request.acknowledge` as a system actor when the request has an active
 *   human owner (durable: a restart right after the commit loses nothing).
 * - `accept`, `block`, `resolve` and `reject` are decided only by a human
 *   responsible of the destination area (owner/backup of the request or of its
 *   work item, area lead, area responsible) or whoever operates the core
 *   (`OPERATIONS_OPERATOR_PERMISSIONS`: `operations.manage` / `operations.admin`).
 * - `cancel`: the same deciders, the human who created it, or a system actor.
 * - `expire`: system actors (case closed or cancelled) or `operations.manage`.
 *
 * The linked work item always follows the request (accept → in_progress,
 * block → waiting, resolve/reject → done, cancel/expire → cancelled); working
 * the item from "Mi trabajo" moves the request the same way through the work
 * item hooks registered at the bottom of this file.
 */

export const AREA_REQUEST_AGGREGATE_TYPE = 'area_request';

export const AREA_REQUEST_COMMANDS = {
  acknowledge: 'request.acknowledge',
  accept: 'request.accept',
  block: 'request.block',
  resolve: 'request.resolve',
  reject: 'request.reject',
  cancel: 'request.cancel',
  expire: 'request.expire',
} as const;

/** Realtime message on `area:{fromAreaKey}` so the requesting area sees answers to its requests. */
export const AREA_REQUEST_REALTIME_TYPE = 'ops.requests';

export const AUTO_ACK_ACTOR: OperationsActor = {
  type: 'system',
  id: 'operations.request_auto_ack',
};

const MANAGE_PERMISSION = OPERATIONS_MANAGE_PERMISSION;
const VIEW_PERMISSION = OPERATIONS_VIEW_PERMISSION;
/** Quien opera el núcleo sin ser dueño de la fila: `operations.manage` u `operations.admin`. */
const OPERATOR_PERMISSIONS = [...OPERATIONS_OPERATOR_PERMISSIONS];

type Db = Prisma.TransactionClient;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-area-requests', event, ...extra }));

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export type AreaRequestAction =
  'acknowledge' | 'accept' | 'block' | 'resolve' | 'reject' | 'cancel' | 'expire';

const OPEN_STATUSES: readonly AreaRequestStatus[] = AREA_REQUEST_OPEN_STATUSES;

export const AREA_REQUEST_TRANSITIONS: Record<
  AreaRequestAction,
  { from: readonly AreaRequestStatus[]; to: AreaRequestStatus }
> = {
  acknowledge: { from: ['sent'], to: 'acknowledged' },
  accept: { from: ['sent', 'acknowledged', 'blocked'], to: 'accepted' },
  block: { from: ['sent', 'acknowledged', 'accepted'], to: 'blocked' },
  resolve: { from: OPEN_STATUSES, to: 'resolved' },
  reject: { from: OPEN_STATUSES, to: 'rejected' },
  cancel: { from: OPEN_STATUSES, to: 'cancelled' },
  expire: { from: OPEN_STATUSES, to: 'expired' },
};

const ACTION_LABELS: Record<AreaRequestAction, string> = {
  acknowledge: 'marcar como recibida',
  accept: 'aceptar',
  block: 'bloquear',
  resolve: 'resolver',
  reject: 'rechazar',
  cancel: 'cancelar',
  expire: 'vencer',
};

const EVENT_BY_ACTION: Record<AreaRequestAction, string> = {
  acknowledge: OPS_EVENTS.request.acknowledged,
  accept: OPS_EVENTS.request.accepted,
  block: OPS_EVENTS.request.blocked,
  resolve: OPS_EVENTS.request.resolved,
  reject: OPS_EVENTS.request.rejected,
  cancel: OPS_EVENTS.request.cancelled,
  expire: OPS_EVENTS.request.expired,
};

export function isAreaRequestOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

/** Next status for `action`, or null when the transition is not allowed. */
export function nextAreaRequestStatus(
  action: AreaRequestAction,
  status: string
): AreaRequestStatus | null {
  const rule = AREA_REQUEST_TRANSITIONS[action];
  return (rule.from as readonly string[]).includes(status) ? rule.to : null;
}

export function isAreaRequestOverdue(request: { status: string; dueAt: Date }, now: Date): boolean {
  return isAreaRequestOpenStatus(request.status) && request.dueAt.getTime() < now.getTime();
}

function statusLabel(status: string): string {
  return (AREA_REQUEST_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

function areaLabel(areaKey: string): string {
  return isAreaKey(areaKey) ? AREA_LABELS[areaKey] : areaKey;
}

function kindLabel(kind: string): string {
  return isAreaRequestKind(kind) ? AREA_REQUEST_KIND_CATALOG[kind].label : kind;
}

function caseUrl(caseId: string): string {
  return `/app/operations/cases/${caseId}`;
}

function truncate(text: string | null | undefined, max = 300): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export async function loadAreaRequest(db: Db, requestId: string): Promise<AreaRequest> {
  const request = await db.areaRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new OperationsError('not_found', 'No se encontró la solicitud');
  return request;
}

/**
 * Responsible of the destination: owner/backup of the request or of its work
 * item (after reassignments), the area lead, or the area responsible/backup.
 */
export async function isAreaRequestResponsible(
  db: Db,
  userId: string,
  request: Pick<AreaRequest, 'ownerUserId' | 'backupUserId' | 'workItemId' | 'toAreaKey'>
): Promise<boolean> {
  if (request.ownerUserId === userId || request.backupUserId === userId) return true;
  if (request.workItemId) {
    const item = await db.workItem.findUnique({
      where: { id: request.workItemId },
      select: { ownerUserId: true, backupUserId: true },
    });
    if (item && (item.ownerUserId === userId || item.backupUserId === userId)) return true;
  }
  const area = await db.area.findUnique({
    where: { key: request.toAreaKey },
    select: { leadUserId: true, responsibleArea: true },
  });
  if (area?.leadUserId === userId) return true;
  const responsible = await resolveResponsible(area?.responsibleArea || request.toAreaKey);
  return Boolean(
    responsible && (responsible.userId === userId || responsible.backupUserId === userId)
  );
}

const HUMAN_ONLY_MESSAGE = 'Las solicitudes entre áreas sólo las decide una persona responsable';

/** Human destination responsible or an operator of the core (`operations.manage` / `operations.admin`; optionally the human requester). */
async function assertHumanDecider(
  tx: Db,
  ctx: Pick<CommandContext, 'actor' | 'user'>,
  request: AreaRequest,
  options: { allowRequester?: boolean } = {}
): Promise<void> {
  if (ctx.actor.type !== 'user') throw new OperationsError('forbidden', HUMAN_ONLY_MESSAGE);
  const user = ctx.user;
  if (!user) {
    throw new OperationsError('unauthenticated', 'Tu sesión expiró; vuelve a iniciar sesión');
  }
  if (!(await isActiveHumanUser(tx, user.id))) {
    throw new OperationsError('forbidden', HUMAN_ONLY_MESSAGE);
  }
  if (hasAnyPermission(user, OPERATOR_PERMISSIONS)) return;
  if (await isAreaRequestResponsible(tx, user.id, request)) return;
  if (
    options.allowRequester &&
    request.createdByType === 'user' &&
    request.createdById === user.id
  ) {
    return;
  }
  throw new OperationsError(
    'forbidden',
    'Sólo el responsable del área destino o quien gestiona operaciones puede decidir esta solicitud'
  );
}

/** Who asked: the human creator, or the current assignee of the requesting area. */
async function requesterUserId(tx: Db, request: AreaRequest): Promise<string | null> {
  if (request.createdByType === 'user' && request.createdById) return request.createdById;
  if (!isAreaKey(request.fromAreaKey)) return null;
  try {
    return (await resolveAreaAssignee(tx, request.fromAreaKey)).ownerUserId;
  } catch (err) {
    if (isOperationsError(err) && err.code === 'no_responsible') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// In-transaction transition
// ---------------------------------------------------------------------------

export interface AreaRequestTransitionInput {
  note?: string | null;
  reason?: string | null;
  answer?: string | null;
  data?: Record<string, unknown> | null;
}

export interface AreaRequestTransitionOptions {
  /** True when the request is the aggregate of the running command. */
  aggregate?: boolean;
  /** Default true; false when the work item is being changed by its own command. */
  syncWorkItem?: boolean;
}

export interface AreaRequestTransitionOutcome {
  request: AreaRequest;
  previousStatus: string;
  /** False for an acknowledge on a request already past `sent`. */
  changed: boolean;
  workItem: WorkItem | null;
}

const clean = (value: string | null | undefined): string | null => value?.trim() || null;

async function syncLinkedWorkItem(
  tx: Db,
  item: WorkItem,
  action: AreaRequestAction,
  input: { reason: string | null; answer: string | null; data: Record<string, unknown> | null }
): Promise<WorkItem> {
  switch (action) {
    case 'acknowledge':
      return item;
    case 'accept':
      return item.status === 'in_progress' ? item : startWorkItemInTx(tx, item);
    case 'block':
      return waitWorkItemInTx(tx, item, { reason: input.reason ?? 'Solicitud bloqueada' });
    case 'resolve':
      return completeWorkItemInTx(tx, item, {
        result: {
          requestStatus: 'resolved',
          answer: input.answer,
          ...(input.data ? { answerData: input.data } : {}),
        },
        skipEvidenceCheck: true,
      });
    case 'reject':
      return completeWorkItemInTx(tx, item, {
        result: { requestStatus: 'rejected', reason: input.reason },
        skipEvidenceCheck: true,
      });
    case 'cancel':
    case 'expire':
      return cancelWorkItemInTx(tx, item, {
        reason: input.reason ?? (action === 'expire' ? 'Solicitud vencida' : 'Solicitud cancelada'),
      });
  }
}

const NOTIFY_VERBS: Partial<Record<AreaRequestAction, string>> = {
  accept: 'aceptó',
  block: 'bloqueó',
  resolve: 'respondió',
  reject: 'rechazó',
};

/**
 * Moves a request inside the running command, keeps its work item in step,
 * emits `request.*`, publishes to the requesting area and notifies the other
 * side. Callers check who may decide (`assertHumanDecider` in the commands).
 */
export async function transitionAreaRequestInTx(
  tx: Db,
  request: AreaRequest | string,
  action: AreaRequestAction,
  input: AreaRequestTransitionInput = {},
  options: AreaRequestTransitionOptions = {}
): Promise<AreaRequestTransitionOutcome> {
  const ctx = requireCommandContext(tx);
  const current = typeof request === 'string' ? await loadAreaRequest(tx, request) : request;
  if (
    action === 'acknowledge' &&
    isAreaRequestOpenStatus(current.status) &&
    current.status !== 'sent'
  ) {
    return { request: current, previousStatus: current.status, changed: false, workItem: null };
  }
  const next = nextAreaRequestStatus(action, current.status);
  if (!next) {
    throw new OperationsError(
      'invalid_state',
      `No se puede ${ACTION_LABELS[action]} una solicitud ${statusLabel(current.status).toLowerCase()}`,
      { details: { action, status: current.status } }
    );
  }
  const reason = clean(input.reason);
  const note = clean(input.note);
  const answer = clean(input.answer);
  if ((action === 'block' || action === 'reject' || action === 'cancel') && !reason) {
    throw new OperationsError('invalid_payload', 'Indica el motivo');
  }
  if (action === 'resolve' && !answer) {
    throw new OperationsError('invalid_payload', 'Escribe la respuesta de la solicitud');
  }

  const stamp = { by: ctx.actor.id, at: ctx.now.toISOString() };
  const data: Prisma.AreaRequestUpdateInput = {
    status: next,
    ...(options.aggregate ? {} : { version: { increment: 1 } }),
  };
  switch (action) {
    case 'accept':
      if (note) data.answer = toOperationalJson({ kind: 'accepted', note, ...stamp });
      break;
    case 'block':
      data.answer = toOperationalJson({ kind: 'blocked', reason, ...stamp });
      break;
    case 'resolve':
      data.answer = toOperationalJson({
        kind: 'resolved',
        text: answer,
        data: input.data ?? null,
        ...stamp,
      });
      data.answeredAt = ctx.now;
      data.closedAt = ctx.now;
      break;
    case 'reject':
      data.answer = toOperationalJson({ kind: 'rejected', reason, ...stamp });
      data.answeredAt = ctx.now;
      data.closedAt = ctx.now;
      break;
    case 'cancel':
    case 'expire':
      data.closedAt = ctx.now;
      break;
    case 'acknowledge':
      break;
  }
  const updated = await tx.areaRequest.update({ where: { id: current.id }, data });

  let workItem: WorkItem | null = null;
  if (options.syncWorkItem !== false && updated.workItemId) {
    const item = await tx.workItem.findUnique({ where: { id: updated.workItemId } });
    workItem =
      item && isWorkItemOpenStatus(item.status)
        ? await syncLinkedWorkItem(tx, item, action, { reason, answer, data: input.data ?? null })
        : item;
  }

  ctx.emit(
    EVENT_BY_ACTION[action],
    {
      requestId: updated.id,
      kind: updated.kind,
      fromAreaKey: updated.fromAreaKey,
      toAreaKey: updated.toAreaKey,
      previousStatus: current.status,
      status: next,
      workItemId: updated.workItemId,
      priority: updated.priority,
      blocksDelivery: updated.blocksDelivery,
      reason,
      note,
      hasAnswer: action === 'resolve',
    },
    {
      caseId: updated.caseId,
      areaKey: updated.toAreaKey,
      objectType: AREA_REQUEST_AGGREGATE_TYPE,
      objectId: updated.id,
    }
  );
  ctx.realtime(areaChannel(updated.fromAreaKey), AREA_REQUEST_REALTIME_TYPE, {
    requestId: updated.id,
    caseId: updated.caseId,
    status: next,
    previousStatus: current.status,
    direction: 'out',
  });

  const verb = NOTIFY_VERBS[action];
  if (verb) {
    const recipient = await requesterUserId(tx, updated);
    if (recipient) {
      const urgent = (action === 'block' || action === 'reject') && updated.blocksDelivery;
      ctx.notify({
        userId: recipient,
        category: 'ops_request',
        type: `ops_request_${next}`,
        title: `${areaLabel(updated.toAreaKey)} ${verb}: ${updated.title}`,
        body: truncate(answer ?? reason ?? note),
        url: caseUrl(updated.caseId),
        entityType: AREA_REQUEST_AGGREGATE_TYPE,
        entityId: updated.id,
        push: urgent ? { urgency: 'high' } : undefined,
      });
    }
  } else if (action === 'cancel' || action === 'expire') {
    const label = action === 'cancel' ? 'cancelada' : 'vencida';
    for (const userId of new Set([updated.ownerUserId, updated.backupUserId])) {
      if (!userId) continue;
      ctx.notify({
        userId,
        category: 'ops_request',
        type: `ops_request_${next}`,
        title: `Solicitud ${label}: ${updated.title}`,
        body: truncate(reason),
        url: caseUrl(updated.caseId),
        entityType: AREA_REQUEST_AGGREGATE_TYPE,
        entityId: updated.id,
      });
    }
  }

  return { request: updated, previousStatus: current.status, changed: true, workItem };
}

/**
 * Supervisor helper for an overdue request: escalates its work item to
 * `level` (idempotent per level) and, only the first time, emits
 * `request.overdue` with a notice to the requester. The flag does not depend
 * on who escalated the work item (the supervisor's work item pass may have
 * done it already), and the agents layer reacts once per request instead of
 * once per rung. No-op when the request is closed or not overdue yet.
 */
export async function markAreaRequestOverdue(
  tx: Db,
  request: AreaRequest | string,
  level: number
): Promise<{ emitted: boolean; escalation: EscalationOutcome | null }> {
  const ctx = requireCommandContext(tx);
  const current = typeof request === 'string' ? await loadAreaRequest(tx, request) : request;
  if (!isAreaRequestOverdue(current, ctx.now)) return { emitted: false, escalation: null };

  let escalation: EscalationOutcome | null = null;
  if (current.workItemId) {
    const item = await tx.workItem.findUnique({ where: { id: current.workItemId } });
    if (item && isWorkItemOpenStatus(item.status)) {
      escalation = await escalateWorkItem(tx, item, level, { reason: 'request_overdue' });
    }
  }
  const alreadyFlagged = await tx.operationalEvent.findFirst({
    where: {
      caseId: current.caseId,
      type: OPS_EVENTS.request.overdue,
      objectType: AREA_REQUEST_AGGREGATE_TYPE,
      objectId: current.id,
    },
    select: { id: true },
  });
  if (alreadyFlagged) return { emitted: false, escalation };

  const overdueMinutes = Math.floor((ctx.now.getTime() - current.dueAt.getTime()) / 60_000);
  ctx.emit(
    OPS_EVENTS.request.overdue,
    {
      requestId: current.id,
      kind: current.kind,
      fromAreaKey: current.fromAreaKey,
      toAreaKey: current.toAreaKey,
      level,
      overdueMinutes,
      workItemId: current.workItemId,
      blocksDelivery: current.blocksDelivery,
    },
    {
      caseId: current.caseId,
      areaKey: current.toAreaKey,
      objectType: AREA_REQUEST_AGGREGATE_TYPE,
      objectId: current.id,
    }
  );
  const recipient = await requesterUserId(tx, current);
  if (recipient) {
    ctx.notify({
      userId: recipient,
      category: 'ops_request',
      type: 'ops_request_overdue',
      title: `Sin respuesta a tiempo: ${current.title}`,
      body: `${areaLabel(current.toAreaKey)} · vencida hace ${formatMinutes(overdueMinutes)}`,
      url: caseUrl(current.caseId),
      entityType: AREA_REQUEST_AGGREGATE_TYPE,
      entityId: current.id,
    });
  }
  return { emitted: true, escalation };
}

/** Expires every open request of a case (case closed or cancelled), closing their work items. */
export async function expireAreaRequestsForCase(
  tx: Db,
  caseId: string,
  reason: string
): Promise<AreaRequest[]> {
  const open = await tx.areaRequest.findMany({
    where: { caseId, status: { in: [...OPEN_STATUSES] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const expired: AreaRequest[] = [];
  for (const request of open) {
    expired.push((await transitionAreaRequestInTx(tx, request, 'expire', { reason })).request);
  }
  return expired;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const requestAggregate = versionedAggregate(AREA_REQUEST_AGGREGATE_TYPE, 'areaRequest');
const reasonField = z.string().trim().min(3, 'Indica el motivo').max(1000);

const REQUEST_SCHEMAS = {
  acknowledge: z.object({}),
  accept: z.object({ note: z.string().trim().min(1).max(1000).optional() }),
  block: z.object({ reason: reasonField }),
  resolve: z.object({
    answer: z.string().trim().min(1, 'Escribe la respuesta').max(4000),
    data: z.record(z.unknown()).optional(),
  }),
  reject: z.object({ reason: reasonField }),
  cancel: z.object({ reason: reasonField }),
  expire: z.object({ reason: z.string().trim().max(1000).optional() }),
} satisfies Record<AreaRequestAction, z.ZodTypeAny>;

export interface AreaRequestCommandData {
  requestId: string;
  status: string;
  previousStatus: string;
  changed: boolean;
  workItemId: string | null;
  workItemStatus: string | null;
}

function registerRequestCommand<A extends AreaRequestAction>(
  action: A,
  config: {
    actorTypes?: readonly ActorType[];
    authorize(tx: Db, ctx: CommandContext, request: AreaRequest): Promise<void>;
  }
): void {
  const schema = REQUEST_SCHEMAS[action] as z.ZodType<AreaRequestTransitionInput>;
  registerCommand<AreaRequestTransitionInput, AreaRequestCommandData>(
    AREA_REQUEST_COMMANDS[action],
    {
      schema,
      aggregate: requestAggregate,
      actorTypes: config.actorTypes,
      async handler(tx, cmd, ctx) {
        const request = await loadAreaRequest(tx, cmd.aggregate.id);
        await config.authorize(tx, ctx, request);
        const outcome = await transitionAreaRequestInTx(tx, request, action, cmd.payload, {
          aggregate: true,
        });
        return {
          data: {
            requestId: outcome.request.id,
            status: outcome.request.status,
            previousStatus: outcome.previousStatus,
            changed: outcome.changed,
            workItemId: outcome.request.workItemId,
            workItemStatus: outcome.workItem?.status ?? null,
          },
        };
      },
    }
  );
}

registerRequestCommand('acknowledge', {
  async authorize(tx, ctx, request) {
    if (ctx.actor.type === 'user') {
      await assertHumanDecider(tx, ctx, request);
      return;
    }
    // Coordinators (system / AI) acknowledge only requests with an active human owner.
    if (!(await isActiveHumanUser(tx, request.ownerUserId))) {
      throw new OperationsError(
        'no_responsible',
        'La solicitud no tiene un responsable activo que la reciba'
      );
    }
  },
});

for (const action of ['accept', 'block', 'resolve', 'reject'] as const) {
  registerRequestCommand(action, {
    actorTypes: ['user'],
    authorize: (tx, ctx, request) => assertHumanDecider(tx, ctx, request),
  });
}

registerRequestCommand('cancel', {
  actorTypes: ['user', 'system'],
  async authorize(tx, ctx, request) {
    if (ctx.actor.type === 'system') return;
    await assertHumanDecider(tx, ctx, request, { allowRequester: true });
  },
});

registerRequestCommand('expire', {
  actorTypes: ['user', 'system'],
  // `expire` sigue exigiendo `operations.manage` a secas: lo normal es que lo dé
  // por vencido el job, ninguna superficie lo ofrece como botón y no es una de
  // las acciones que la Torre declara sobre una excepción (7.7). Si alguna vez
  // se ofrece en pantalla, hay que moverlo a OPERATOR_PERMISSIONS.
  async authorize(_tx, ctx) {
    if (ctx.actor.type === 'system') return;
    if (!ctx.user || !hasPermission(ctx.user, MANAGE_PERMISSION)) {
      throw new OperationsError(
        'forbidden',
        'Sólo un gestor de operaciones puede dar por vencida una solicitud'
      );
    }
  },
});

// ---------------------------------------------------------------------------
// Work item hooks: working the linked item from "Mi trabajo" moves the request
// ---------------------------------------------------------------------------

async function linkedRequest(tx: Db, item: WorkItem): Promise<AreaRequest> {
  const request = item.objectId
    ? await tx.areaRequest.findUnique({ where: { id: item.objectId } })
    : null;
  if (!request) {
    throw new OperationsError('not_found', 'No se encontró la solicitud ligada a este trabajo');
  }
  return request;
}

registerWorkItemHooks(
  AREA_REQUEST_AGGREGATE_TYPE,
  {
    async beforeStart({ tx, ctx, item }) {
      const request = await linkedRequest(tx, item);
      await assertHumanDecider(tx, ctx, request);
      if (request.status === 'accepted') return;
      await transitionAreaRequestInTx(tx, request, 'accept', {}, { syncWorkItem: false });
    },
    async beforeWait({ tx, ctx, item }, input) {
      const request = await linkedRequest(tx, item);
      await assertHumanDecider(tx, ctx, request);
      if (request.status === 'blocked') return;
      await transitionAreaRequestInTx(
        tx,
        request,
        'block',
        { reason: input.reason },
        { syncWorkItem: false }
      );
    },
    async beforeComplete({ tx, ctx, item }, input) {
      const request = await linkedRequest(tx, item);
      await assertHumanDecider(tx, ctx, request);
      const { answer: resultAnswer, ...rest } = input.result;
      const answer =
        input.note ??
        (typeof resultAnswer === 'string' && resultAnswer.trim() ? resultAnswer : null);
      if (!answer) {
        throw new OperationsError(
          'invalid_payload',
          'Escribe la respuesta de la solicitud en la nota para terminar este trabajo'
        );
      }
      await transitionAreaRequestInTx(
        tx,
        request,
        'resolve',
        { answer, data: Object.keys(rest).length > 0 ? rest : null },
        { syncWorkItem: false }
      );
    },
    async afterReassign({ tx, item }) {
      if (!item.objectId) return;
      const request = await tx.areaRequest.findUnique({ where: { id: item.objectId } });
      if (!request || !isAreaRequestOpenStatus(request.status)) return;
      if (request.ownerUserId === item.ownerUserId && request.backupUserId === item.backupUserId) {
        return;
      }
      await tx.areaRequest.update({
        where: { id: request.id },
        data: {
          ownerUserId: item.ownerUserId,
          backupUserId: item.backupUserId,
          version: { increment: 1 },
        },
      });
    },
  },
  'area-requests'
);

// ---------------------------------------------------------------------------
// Automatic acknowledge (the coordinator marks received requests)
// ---------------------------------------------------------------------------

export const AREA_REQUEST_AUTO_ACK_JOB = 'ops.request.auto_ack';

/** Same key as the command id: one acknowledgement per request, ever. */
export const areaRequestAutoAckKey = (requestId: string) => `request-ack:${requestId}`;

/** Jobs for the `request.created` events of a transaction (pure). */
export function planAreaRequestAutoAckJobs(
  events: OperationalEventRecord[]
): OperationalOutboxJob[] {
  return events
    .filter(
      (event) =>
        event.type === OPS_EVENTS.request.created &&
        event.objectType === AREA_REQUEST_AGGREGATE_TYPE &&
        Boolean(event.objectId)
    )
    .map((event) => ({
      type: AREA_REQUEST_AUTO_ACK_JOB,
      payload: { requestId: event.objectId },
      dedupeKey: areaRequestAutoAckKey(event.objectId!),
      priority: JOB_PRIORITY.interactive,
      maxAttempts: 3,
      createdBy: AUTO_ACK_ACTOR.id,
    }));
}

/**
 * Acknowledges one request when it is still `sent` and its owner is an active
 * human, with a deterministic command id (`request-ack:{id}`) so the agents
 * layer or a retry never acknowledges twice. Null when it does not apply.
 */
export async function autoAcknowledgeAreaRequest(
  requestId: string
): Promise<CommandResult<AreaRequestCommandData> | null> {
  const request = await prisma.areaRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, ownerUserId: true },
  });
  if (!request || request.status !== 'sent') return null;
  if (!(await isActiveHumanUser(prisma, request.ownerUserId))) {
    log('auto_ack_skipped', { requestId: request.id, reason: 'no_active_owner' });
    return null;
  }
  const result = await executeCommand<AreaRequestCommandData>(
    {
      commandId: areaRequestAutoAckKey(request.id),
      type: AREA_REQUEST_COMMANDS.acknowledge,
      actor: AUTO_ACK_ACTOR,
      aggregate: { type: AREA_REQUEST_AGGREGATE_TYPE, id: request.id },
      payload: {},
    },
    null
  );
  if (result.status === 'rejected') {
    log('auto_ack_rejected', { requestId: request.id, errorCode: result.errorCode });
  }
  return result;
}

/** Handler of `ops.request.auto_ack`; a lost concurrency race is retried by the queue. */
export async function runAreaRequestAutoAckJob(
  job: JobContext<unknown>
): Promise<Record<string, unknown>> {
  const payload = (job.payload ?? {}) as { requestId?: unknown };
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
  if (!requestId) return { skipped: 'invalid_payload' };
  const result = await autoAcknowledgeAreaRequest(requestId);
  if (!result) return { skipped: 'not_applicable', requestId };
  if (result.status === 'rejected' && result.errorCode === 'concurrency_conflict') {
    throw new Error(`Acuse de ${requestId} perdió una carrera de concurrencia; se reintentará`);
  }
  return { requestId, status: result.status, errorCode: result.errorCode ?? null };
}

type GlobalWithAutoAck = typeof globalThis & { __unikAreaRequestAutoAck?: () => void };
{
  const scope = globalThis as GlobalWithAutoAck;
  scope.__unikAreaRequestAutoAck?.();
  scope.__unikAreaRequestAutoAck = onOperationalEventsInTransaction(async (_tx, events, sink) => {
    for (const job of planAreaRequestAutoAckJobs(events)) sink.outbox(job);
  });
}

// ---------------------------------------------------------------------------
// Command wrappers for signed-in users
// ---------------------------------------------------------------------------

export interface AreaRequestCommandOptions {
  commandId?: string;
  expectedVersion?: number;
  deviceId?: string;
  now?: Date;
}

function runRequestCommand(
  actor: CurrentUser,
  action: AreaRequestAction,
  requestId: string,
  payload: Record<string, unknown>,
  options: AreaRequestCommandOptions
): Promise<CommandResult<AreaRequestCommandData>> {
  return executeCommand<AreaRequestCommandData>(
    {
      commandId: options.commandId ?? randomUUID(),
      type: AREA_REQUEST_COMMANDS[action],
      actor: { type: 'user', id: actor.id },
      aggregate: { type: AREA_REQUEST_AGGREGATE_TYPE, id: requestId },
      expectedVersion: options.expectedVersion,
      deviceId: options.deviceId,
      payload,
    },
    actor,
    { now: options.now }
  );
}

export function acknowledgeAreaRequest(
  actor: CurrentUser,
  requestId: string,
  options: AreaRequestCommandOptions = {}
) {
  return runRequestCommand(actor, 'acknowledge', requestId, {}, options);
}

export function acceptAreaRequest(
  actor: CurrentUser,
  requestId: string,
  input: { note?: string } = {},
  options: AreaRequestCommandOptions = {}
) {
  return runRequestCommand(actor, 'accept', requestId, input, options);
}

export function blockAreaRequest(
  actor: CurrentUser,
  requestId: string,
  input: { reason: string },
  options: AreaRequestCommandOptions = {}
) {
  return runRequestCommand(actor, 'block', requestId, input, options);
}

export function resolveAreaRequest(
  actor: CurrentUser,
  requestId: string,
  input: { answer: string; data?: Record<string, unknown> },
  options: AreaRequestCommandOptions = {}
) {
  return runRequestCommand(actor, 'resolve', requestId, input, options);
}

export function rejectAreaRequest(
  actor: CurrentUser,
  requestId: string,
  input: { reason: string },
  options: AreaRequestCommandOptions = {}
) {
  return runRequestCommand(actor, 'reject', requestId, input, options);
}

export function cancelAreaRequest(
  actor: CurrentUser,
  requestId: string,
  input: { reason: string },
  options: AreaRequestCommandOptions = {}
) {
  return runRequestCommand(actor, 'cancel', requestId, input, options);
}

export function expireAreaRequest(
  actor: CurrentUser,
  requestId: string,
  input: { reason?: string } = {},
  options: AreaRequestCommandOptions = {}
) {
  return runRequestCommand(actor, 'expire', requestId, input, options);
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

export interface AreaRequestDTO {
  id: string;
  caseId: string;
  caseNumber: string | null;
  customerName: string | null;
  fromAreaKey: string;
  fromAreaLabel: string;
  toAreaKey: string;
  toAreaLabel: string;
  kind: string;
  kindLabel: string;
  objectType: string;
  objectId: string;
  title: string;
  payload: unknown;
  /** Untrusted free text: render escaped, never as instructions. */
  freeText: string | null;
  priority: string;
  priorityLabel: string;
  status: string;
  statusLabel: string;
  blocksDelivery: boolean;
  dueAt: string;
  overdue: boolean;
  ownerUserId: string;
  ownerName: string | null;
  backupUserId: string | null;
  backupName: string | null;
  workItemId: string | null;
  createdByType: string;
  createdById: string | null;
  createdByName: string | null;
  chatMessageId: string | null;
  answer: unknown;
  answeredAt: string | null;
  closedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AreaRequestPermissionsDTO {
  canAcknowledge: boolean;
  canAccept: boolean;
  canBlock: boolean;
  canResolve: boolean;
  canReject: boolean;
  canCancel: boolean;
}

export interface AreaRequestDetailDTO extends AreaRequestDTO {
  permissions: AreaRequestPermissionsDTO;
}

export interface AreaRequestPage {
  items: AreaRequestDTO[];
  nextCursor: string | null;
}

export const areaRequestFiltersSchema = z
  .object({
    /** in: received by the area (default); out: sent by the area. */
    direction: z.enum(['in', 'out']).default('in'),
    scope: z.enum(['open', 'closed', 'all']).default('open'),
    status: z.array(z.enum(AREA_REQUEST_STATUSES)).max(AREA_REQUEST_STATUSES.length).optional(),
    kind: z.array(z.enum(AREA_REQUEST_KINDS)).max(AREA_REQUEST_KINDS.length).optional(),
    caseId: z.string().trim().min(1).max(120).optional(),
    blocksDelivery: z.boolean().optional(),
    overdueOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().trim().max(300).optional(),
  })
  .strict();

export type AreaRequestFilters = z.input<typeof areaRequestFiltersSchema>;

/** DTOs with names and case numbers (no access check). */
export async function toAreaRequestDTOs(
  rows: AreaRequest[],
  now: Date = new Date()
): Promise<AreaRequestDTO[]> {
  if (rows.length === 0) return [];
  const userIds = [
    ...new Set(
      rows
        .flatMap((r) => [
          r.ownerUserId,
          r.backupUserId,
          r.createdByType === 'user' || r.createdByType === 'ai' ? r.createdById : null,
        ])
        .filter(Boolean) as string[]
    ),
  ];
  const caseIds = [...new Set(rows.map((r) => r.caseId))];
  const [users, cases] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    prisma.operationalCase.findMany({
      where: { id: { in: caseIds } },
      select: { id: true, caseNumber: true, customerName: true },
    }),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const caseById = new Map(cases.map((c) => [c.id, c]));
  return rows.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    caseNumber: caseById.get(row.caseId)?.caseNumber ?? null,
    customerName: caseById.get(row.caseId)?.customerName ?? null,
    fromAreaKey: row.fromAreaKey,
    fromAreaLabel: areaLabel(row.fromAreaKey),
    toAreaKey: row.toAreaKey,
    toAreaLabel: areaLabel(row.toAreaKey),
    kind: row.kind,
    kindLabel: kindLabel(row.kind),
    objectType: row.objectType,
    objectId: row.objectId,
    title: row.title,
    payload: row.payload,
    freeText: row.freeText,
    priority: row.priority,
    priorityLabel: (PRIORITY_LABELS as Record<string, string>)[row.priority] ?? row.priority,
    status: row.status,
    statusLabel: statusLabel(row.status),
    blocksDelivery: row.blocksDelivery,
    dueAt: row.dueAt.toISOString(),
    overdue: isAreaRequestOverdue(row, now),
    ownerUserId: row.ownerUserId,
    ownerName: names.get(row.ownerUserId) ?? null,
    backupUserId: row.backupUserId,
    backupName: row.backupUserId ? (names.get(row.backupUserId) ?? null) : null,
    workItemId: row.workItemId,
    createdByType: row.createdByType,
    createdById: row.createdById,
    createdByName: row.createdById ? (names.get(row.createdById) ?? null) : null,
    chatMessageId: row.chatMessageId,
    answer: row.answer,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * Requests received (`direction: 'in'`) or sent (`'out'`) by an area. Requires
 * `operations.view`, area channel membership, the area lead or its responsible.
 */
export async function listAreaRequests(
  actor: CurrentUser,
  areaKey: string,
  filters: AreaRequestFilters = {},
  options: { now?: Date } = {}
): Promise<AreaRequestPage> {
  if (!isAreaKey(areaKey)) throw new OperationsError('invalid_payload', 'Área inválida');
  const parsed = areaRequestFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    throw new OperationsError(
      'invalid_payload',
      `Filtros inválidos: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'filtros'}: ${issue.message}`)
        .join('; ')}`
    );
  }
  if (!(await canViewArea(actor, areaKey))) {
    throw new OperationsError('forbidden', 'No tienes acceso a las solicitudes de esta área');
  }
  const f = parsed.data;
  const now = options.now ?? new Date();
  const and: Prisma.AreaRequestWhereInput[] = [
    f.direction === 'in' ? { toAreaKey: areaKey } : { fromAreaKey: areaKey },
  ];
  if (f.status?.length) and.push({ status: { in: f.status } });
  else if (f.scope === 'open') and.push({ status: { in: [...OPEN_STATUSES] } });
  else if (f.scope === 'closed') {
    and.push({ status: { notIn: [...OPEN_STATUSES] } });
  }
  if (f.kind?.length) and.push({ kind: { in: f.kind } });
  if (f.caseId) and.push({ caseId: f.caseId });
  if (f.blocksDelivery !== undefined) and.push({ blocksDelivery: f.blocksDelivery });
  if (f.overdueOnly) and.push({ dueAt: { lt: now }, status: { in: [...OPEN_STATUSES] } });

  const closedOrder = f.scope === 'closed' && !f.status?.length;
  const field = closedOrder ? 'updatedAt' : 'dueAt';
  const direction = closedOrder ? 'desc' : 'asc';
  const keyset = keysetCondition(field, direction, decodeListCursor(f.cursor));
  if (keyset) and.push(keyset as Prisma.AreaRequestWhereInput);

  const rows = await prisma.areaRequest.findMany({
    where: { AND: and },
    orderBy: [{ [field]: direction }, { id: direction }],
    take: f.limit + 1,
  });
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return {
    items: await toAreaRequestDTOs(page, now),
    nextCursor: rows.length > f.limit && last ? encodeListCursor(last[field], last.id) : null,
  };
}

/**
 * One request with the actor's permissions. Visible with `operations.view`, to
 * its owner/backup and creator, the case owner and whoever can view either area.
 */
export async function getAreaRequest(
  actor: CurrentUser,
  requestId: string,
  options: { now?: Date } = {}
): Promise<AreaRequestDetailDTO> {
  const notFound = () => new OperationsError('not_found', 'No se encontró la solicitud');
  const row = await prisma.areaRequest.findUnique({ where: { id: requestId } });
  if (!row) throw notFound();
  const requester = row.createdByType === 'user' && row.createdById === actor.id;
  let allowed =
    hasPermission(actor, VIEW_PERMISSION) ||
    row.ownerUserId === actor.id ||
    row.backupUserId === actor.id ||
    requester;
  if (!allowed) {
    const operationalCase = await prisma.operationalCase.findUnique({
      where: { id: row.caseId },
      select: { ownerUserId: true },
    });
    allowed =
      operationalCase?.ownerUserId === actor.id ||
      (await canViewArea(actor, row.toAreaKey)) ||
      (await canViewArea(actor, row.fromAreaKey));
  }
  if (!allowed) throw notFound();

  const [dto] = await toAreaRequestDTOs([row], options.now ?? new Date());
  const responsible =
    hasAnyPermission(actor, OPERATOR_PERMISSIONS) ||
    (await isAreaRequestResponsible(prisma, actor.id, row));
  const can = (action: AreaRequestAction) => nextAreaRequestStatus(action, row.status) !== null;
  return {
    ...dto,
    permissions: {
      canAcknowledge: responsible && can('acknowledge'),
      canAccept: responsible && can('accept'),
      canBlock: responsible && can('block'),
      canResolve: responsible && can('resolve'),
      canReject: responsible && can('reject'),
      canCancel: (responsible || requester) && can('cancel'),
    },
  };
}
