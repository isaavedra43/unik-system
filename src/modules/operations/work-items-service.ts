import { randomUUID } from 'crypto';
import type { Prisma, WorkItem } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { resolveResponsible } from '@/modules/comms/responsibles-service';
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
import { authorizeOperationsChannel, toOperationalJson } from './events-service';
import {
  attachEvidenceInTx,
  describeEvidenceKey,
  evidenceWhereForWorkItem,
  loadWorkItemEvidence,
  missingEvidence,
  presentResultKeys,
  type EvidenceDTO,
} from './evidence-service';
import { getOperationsConfig, type OperationsSettings } from './operations-config';
import {
  AREA_KEYS,
  AREA_LABELS,
  OPS_EVENTS,
  WORK_ITEM_KINDS,
  WORK_ITEM_KIND_LABELS,
  WORK_ITEM_OPEN_STATUSES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_STATUS_LABELS,
  isAreaKey,
  type EscalationRung,
  type WorkItemStatus,
} from './types';

/**
 * Work items of the operations core (plan sections 2.1, 2.6 and 7.4).
 *
 * Commands (all on the `work_item` aggregate, allowed to the owner, the backup,
 * `operations.manage` or a system actor):
 * - `workitem.start`    open | waiting | escalated → in_progress
 * - `workitem.wait`     any open state → waiting (reason, optional waitUntil)
 * - `workitem.complete` any open state → done, after checking `requiredEvidence`
 * - `workitem.reassign` owner/backup (and optionally a new due date, which
 *   restarts the escalation ladder)
 * - `workitem.escalate` next rung of the configured ladder
 *
 * Escalation ladder (`config.escalation`): level `i < ladder.length` applies
 * rung `ladder[i]` (defaults: 0 backup → owner and backup are warned and an
 * inactive owner is replaced; 1 area_lead → the area lead becomes the backup;
 * 2 administracion → the Administración responsible becomes the backup);
 * level `ladder.length` opens a critical `sla_breach` incident. Rungs from
 * `area_lead` on mark the item `escalated`.
 *
 * Other services mutate work items inside their own commands with the `*InTx`
 * helpers. Objects that own work items (area requests, approvals) plug in with
 * `registerWorkItemHooks(objectType, hooks)`: `before*` hooks run only when the
 * work item command is the entry point; `after*` hooks run on every path.
 */

export const WORK_ITEM_AGGREGATE_TYPE = 'work_item';

export const WORK_ITEM_COMMANDS = {
  start: 'workitem.start',
  complete: 'workitem.complete',
  wait: 'workitem.wait',
  reassign: 'workitem.reassign',
  escalate: 'workitem.escalate',
} as const;

const MANAGE_PERMISSION = 'operations.manage';
const VIEW_PERMISSION = 'operations.view';
const MAX_WAIT_MS = 366 * 24 * 60 * 60_000;
const MAX_RESULT_JSON_LENGTH = 20_000;

type Db = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export type WorkItemAction = 'start' | 'wait' | 'complete' | 'cancel' | 'reassign' | 'escalate';

const OPEN_STATUSES: readonly WorkItemStatus[] = WORK_ITEM_OPEN_STATUSES;

/** States from which each action is allowed. */
export const WORK_ITEM_TRANSITIONS: Record<WorkItemAction, readonly WorkItemStatus[]> = {
  start: ['open', 'waiting', 'escalated'],
  wait: OPEN_STATUSES,
  complete: OPEN_STATUSES,
  cancel: OPEN_STATUSES,
  reassign: OPEN_STATUSES,
  escalate: OPEN_STATUSES,
};

const ACTION_LABELS: Record<WorkItemAction, string> = {
  start: 'iniciar',
  wait: 'poner en espera',
  complete: 'terminar',
  cancel: 'cancelar',
  reassign: 'reasignar',
  escalate: 'escalar',
};

export function isWorkItemOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

export function canTransitionWorkItem(action: WorkItemAction, status: string): boolean {
  return (WORK_ITEM_TRANSITIONS[action] as readonly string[]).includes(status);
}

export function isWorkItemParticipant(
  userId: string,
  item: { ownerUserId: string; backupUserId: string | null }
): boolean {
  return item.ownerUserId === userId || item.backupUserId === userId;
}

/** Highest escalation level already applied, or -1 when the item was never escalated. */
export function appliedEscalationLevel(item: {
  escalationLevel: number;
  escalatedAt: Date | string | null;
}): number {
  return item.escalatedAt ? item.escalationLevel : -1;
}

export type EscalationStep = EscalationRung | 'incident';

/**
 * Minutes past due at which each level applies (`ladder.length + 1` entries:
 * one per rung plus the incident). Missing entries extend the last gap
 * (at least 60 minutes): defaults [0, 120, 480] → [0, 120, 480, 840].
 */
export function escalationThresholds(escalation: OperationsSettings['escalation']): number[] {
  const levels = escalation.ladder.length + 1;
  const thresholds: number[] = [];
  for (let i = 0; i < levels; i++) {
    const previous = i > 0 ? thresholds[i - 1] : 0;
    if (i < escalation.afterMinutes.length) {
      thresholds.push(Math.max(escalation.afterMinutes[i], previous));
      continue;
    }
    const beforePrevious = i > 1 ? thresholds[i - 2] : 0;
    thresholds.push(previous + Math.max(previous - beforePrevious, 60));
  }
  return thresholds;
}

/** Step applied at `level`: a rung of the ladder, the incident (last level) or null (out of range). */
export function escalationStepFor(
  level: number,
  ladder: readonly EscalationRung[]
): EscalationStep | null {
  if (!Number.isInteger(level) || level < 0) return null;
  if (level < ladder.length) return ladder[level];
  if (level === ladder.length) return 'incident';
  return null;
}

/** Level that corresponds to being `overdueMinutes` late (null when not overdue yet). */
export function escalationLevelFor(
  overdueMinutes: number,
  escalation: OperationsSettings['escalation']
): number | null {
  if (!(overdueMinutes > 0)) return null;
  const thresholds = escalationThresholds(escalation);
  let level: number | null = null;
  thresholds.forEach((threshold, index) => {
    if (overdueMinutes >= threshold) level = index;
  });
  return level;
}

/** Level the supervisor should apply now, or null (closed, not overdue or already applied). */
export function nextEscalationLevel(
  item: { status: string; dueAt: Date; escalationLevel: number; escalatedAt: Date | null },
  escalation: OperationsSettings['escalation'],
  now: Date
): number | null {
  if (!isWorkItemOpenStatus(item.status)) return null;
  const minutes = (now.getTime() - item.dueAt.getTime()) / 60_000;
  const level = escalationLevelFor(minutes, escalation);
  if (level === null) return null;
  return level > appliedEscalationLevel(item) ? level : null;
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared by the area request and incident services)
// ---------------------------------------------------------------------------

const dateFormatter = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatOperationsDate(date: Date): string {
  try {
    return dateFormatter.format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  if (hours < 24) return total % 60 ? `${hours} h ${total % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

export function workItemUrl(workItemId: string): string {
  return `/app/mywork?workItem=${workItemId}`;
}

function areaLabel(areaKey: string): string {
  return isAreaKey(areaKey) ? AREA_LABELS[areaKey] : areaKey;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Keyset pagination (shared)
// ---------------------------------------------------------------------------

export function encodeListCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id]), 'utf8').toString('base64url');
}

export function decodeListCursor(
  cursor: string | null | undefined
): { at: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      const at = new Date(parsed[0]);
      if (!Number.isNaN(at.getTime())) return { at, id: parsed[1] };
    }
  } catch {
    // falls through to the domain error
  }
  throw new OperationsError('invalid_payload', 'Cursor inválido');
}

/** `(field, id)` keyset condition after `cursor` in the given direction. */
export function keysetCondition(
  field: string,
  direction: 'asc' | 'desc',
  cursor: { at: Date; id: string } | null
): Record<string, unknown> | null {
  if (!cursor) return null;
  const op = direction === 'asc' ? 'gt' : 'lt';
  return {
    OR: [{ [field]: { [op]: cursor.at } }, { [field]: cursor.at, id: { [op]: cursor.id } }],
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface WorkItemHookArgs {
  tx: Db;
  ctx: CommandContext;
  item: WorkItem;
}

export interface WorkItemHooks {
  /** Entry point `workitem.start` only. Throw `OperationsError` to reject. */
  beforeStart?(args: WorkItemHookArgs): Promise<void>;
  /** Entry point `workitem.wait` only. */
  beforeWait?(args: WorkItemHookArgs, input: { reason: string; until: Date | null }): Promise<void>;
  /** Entry point `workitem.complete` only (evidence was already checked). */
  beforeComplete?(
    args: WorkItemHookArgs,
    input: { result: Record<string, unknown>; note: string | null }
  ): Promise<void>;
  /** Every completion path, with the updated row. */
  afterComplete?(args: WorkItemHookArgs): Promise<void>;
  /** Every reassignment path (including the owner replacement of the escalation). */
  afterReassign?(
    args: WorkItemHookArgs,
    change: { previousOwnerUserId: string; previousBackupUserId: string | null }
  ): Promise<void>;
}

/** Hooks registered with this key run for every work item. */
export const ANY_WORK_ITEM_OBJECT = '*';

/** Object types whose work items must never change without their owning object's hooks. */
const OBJECT_TYPES_REQUIRING_HOOKS = ['area_request'];

type GlobalWithHooks = typeof globalThis & {
  __unikWorkItemHooks?: Map<string, Map<string, WorkItemHooks>>;
};

function hookRegistry(): Map<string, Map<string, WorkItemHooks>> {
  const scope = globalThis as GlobalWithHooks;
  if (!scope.__unikWorkItemHooks) scope.__unikWorkItemHooks = new Map();
  return scope.__unikWorkItemHooks;
}

/**
 * Registers (or replaces, same `key`) hooks for the work items of `objectType`
 * (`'*'` for all). Returns the unregister function.
 */
export function registerWorkItemHooks(
  objectType: string,
  hooks: WorkItemHooks,
  key = 'default'
): () => void {
  const registry = hookRegistry();
  const byKey = registry.get(objectType) ?? new Map<string, WorkItemHooks>();
  byKey.set(key, hooks);
  registry.set(objectType, byKey);
  return () => {
    if (byKey.get(key) === hooks) byKey.delete(key);
  };
}

export function hasWorkItemHooks(objectType: string): boolean {
  return (hookRegistry().get(objectType)?.size ?? 0) > 0;
}

function hooksFor(item: Pick<WorkItem, 'objectType'>): WorkItemHooks[] {
  const registry = hookRegistry();
  const specific = item.objectType ? [...(registry.get(item.objectType)?.values() ?? [])] : [];
  return [...specific, ...(registry.get(ANY_WORK_ITEM_OBJECT)?.values() ?? [])];
}

function assertLinkedHandlersLoaded(item: WorkItem): void {
  if (
    item.objectType &&
    OBJECT_TYPES_REQUIRING_HOOKS.includes(item.objectType) &&
    !hasWorkItemHooks(item.objectType)
  ) {
    throw new OperationsError(
      'invalid_state',
      'Este trabajo se atiende desde su solicitud; ábrela para responder'
    );
  }
}

// Approval work items are decided through `approval.decide` (approvals-service).
registerWorkItemHooks(
  'approval_request',
  {
    async beforeWait() {
      throw new OperationsError(
        'invalid_state',
        'Las aprobaciones no se ponen en espera; apruébala o recházala'
      );
    },
    async beforeComplete() {
      throw new OperationsError(
        'invalid_state',
        'Decide la aprobación (aprobar o rechazar) desde la solicitud de aprobación'
      );
    },
  },
  'core'
);

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** Active, non-bot user. */
export async function isActiveHumanUser(
  db: Db,
  userId: string | null | undefined
): Promise<boolean> {
  if (!userId) return false;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { isActive: true, isBot: true },
  });
  return Boolean(user?.isActive && !user.isBot);
}

/** Owner, backup, `operations.manage` or a system actor. */
export function assertCanActOnWorkItem(
  ctx: Pick<CommandContext, 'actor' | 'user'>,
  item: Pick<WorkItem, 'ownerUserId' | 'backupUserId'>
): void {
  if (ctx.actor.type === 'system' || ctx.actor.type === 'zoho') return;
  const user = ctx.user;
  if (!user) {
    throw new OperationsError('unauthenticated', 'Tu sesión expiró; vuelve a iniciar sesión');
  }
  if (isWorkItemParticipant(user.id, item) || hasPermission(user, MANAGE_PERMISSION)) return;
  throw new OperationsError(
    'forbidden',
    'Sólo el responsable del trabajo, su suplente o un gestor de operaciones puede hacer esto'
  );
}

/**
 * Who may see the work of an area: `operations.view`, members of the area
 * channel, the area lead and the area responsible or backup.
 */
export async function canViewArea(actor: CurrentUser, areaKey: string): Promise<boolean> {
  if (!isAreaKey(areaKey)) return false;
  if (await authorizeOperationsChannel(actor, 'area', areaKey)) return true;
  const area = await prisma.area.findUnique({
    where: { key: areaKey },
    select: { leadUserId: true, responsibleArea: true },
  });
  if (area?.leadUserId === actor.id) return true;
  const responsible = await prisma.responsible.findUnique({
    where: { area: area?.responsibleArea || areaKey },
    select: { userId: true, backupUserId: true, active: true },
  });
  return Boolean(
    responsible?.active &&
    (responsible.userId === actor.id || responsible.backupUserId === actor.id)
  );
}

// ---------------------------------------------------------------------------
// In-transaction mutations
// ---------------------------------------------------------------------------

export interface WorkItemMutationOptions {
  /** True when the work item is the aggregate of the running command (its version was already bumped). */
  aggregate?: boolean;
}

function versionData(options: WorkItemMutationOptions): { version?: { increment: number } } {
  return options.aggregate ? {} : { version: { increment: 1 } };
}

function eventOptions(item: WorkItem) {
  return {
    caseId: item.caseId,
    areaKey: item.areaKey,
    objectType: WORK_ITEM_AGGREGATE_TYPE,
    objectId: item.id,
  };
}

export async function loadWorkItem(db: Db, workItemId: string): Promise<WorkItem> {
  const item = await db.workItem.findUnique({ where: { id: workItemId } });
  if (!item) throw new OperationsError('not_found', 'No se encontró el trabajo');
  return item;
}

export function assertWorkItemTransition(
  action: WorkItemAction,
  item: Pick<WorkItem, 'status'>
): void {
  if (canTransitionWorkItem(action, item.status)) return;
  const label = (WORK_ITEM_STATUS_LABELS as Record<string, string>)[item.status] ?? item.status;
  throw new OperationsError(
    'invalid_state',
    `No se puede ${ACTION_LABELS[action]} un trabajo ${label.toLowerCase()}`,
    { details: { action, status: item.status } }
  );
}

async function runAfterHook<K extends 'afterComplete' | 'afterReassign'>(
  name: K,
  args: WorkItemHookArgs,
  ...rest: K extends 'afterReassign'
    ? [{ previousOwnerUserId: string; previousBackupUserId: string | null }]
    : []
): Promise<void> {
  for (const hooks of hooksFor(args.item)) {
    if (name === 'afterComplete') await hooks.afterComplete?.(args);
    else await hooks.afterReassign?.(args, rest[0] as never);
  }
}

export async function startWorkItemInTx(
  tx: Db,
  item: WorkItem,
  options: WorkItemMutationOptions = {}
): Promise<WorkItem> {
  const ctx = requireCommandContext(tx);
  assertWorkItemTransition('start', item);
  const updated = await tx.workItem.update({
    where: { id: item.id },
    data: { status: 'in_progress', waitReason: null, waitUntil: null, ...versionData(options) },
  });
  ctx.emit(
    OPS_EVENTS.workitem.started,
    {
      workItemId: updated.id,
      previousStatus: item.status,
      startedBy: ctx.actor.id,
      stepId: updated.stepId,
      objectType: updated.objectType,
      objectId: updated.objectId,
    },
    eventOptions(updated)
  );
  return updated;
}

export interface WaitWorkItemInput {
  reason: string;
  until?: Date | null;
}

function validateWait(input: WaitWorkItemInput, now: Date): { reason: string; until: Date | null } {
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  if (reason.length < 3) {
    throw new OperationsError('invalid_payload', 'Indica por qué el trabajo queda en espera');
  }
  const until = input.until ?? null;
  if (until) {
    if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) {
      throw new OperationsError('invalid_payload', 'La fecha de espera debe ser futura');
    }
    if (until.getTime() - now.getTime() > MAX_WAIT_MS) {
      throw new OperationsError('invalid_payload', 'La espera no puede superar un año');
    }
  }
  return { reason, until };
}

export async function waitWorkItemInTx(
  tx: Db,
  item: WorkItem,
  input: WaitWorkItemInput,
  options: WorkItemMutationOptions = {}
): Promise<WorkItem> {
  const ctx = requireCommandContext(tx);
  assertWorkItemTransition('wait', item);
  const { reason, until } = validateWait(input, ctx.now);
  const updated = await tx.workItem.update({
    where: { id: item.id },
    data: { status: 'waiting', waitReason: reason, waitUntil: until, ...versionData(options) },
  });
  ctx.emit(
    OPS_EVENTS.workitem.waiting,
    {
      workItemId: updated.id,
      previousStatus: item.status,
      reason,
      waitUntil: until?.toISOString() ?? null,
    },
    eventOptions(updated)
  );
  if (ctx.actor.id !== updated.ownerUserId) {
    ctx.notify({
      userId: updated.ownerUserId,
      category: 'ops_workitem',
      type: 'ops_workitem_waiting',
      title: `En espera: ${updated.title}`,
      body: reason,
      url: workItemUrl(updated.id),
      entityType: WORK_ITEM_AGGREGATE_TYPE,
      entityId: updated.id,
    });
  }
  return updated;
}

export interface CompleteWorkItemInput {
  result?: Record<string, unknown> | null;
  note?: string | null;
  /** For completions driven by the owning object (e.g. a resolved area request). */
  skipEvidenceCheck?: boolean;
}

/** Throws `missing_evidence` (422) listing what `requiredEvidence` still lacks. */
export async function assertWorkItemEvidence(
  db: Db,
  item: WorkItem,
  input: { result?: Record<string, unknown> | null; note?: string | null }
): Promise<void> {
  if (item.requiredEvidence.length === 0) return;
  const links = await db.evidenceLink.findMany({
    where: evidenceWhereForWorkItem(item),
    select: { kind: true },
  });
  const kinds = links.map((link) => link.kind);
  if (input.note && input.note.trim()) kinds.push('note');
  const missing = missingEvidence(item.requiredEvidence, {
    kinds,
    keys: presentResultKeys(input.result ?? {}),
  });
  if (missing.length > 0) {
    throw new OperationsError(
      'missing_evidence',
      `Falta evidencia para terminar el trabajo: ${missing.map(describeEvidenceKey).join(', ')}`,
      { httpStatus: 422, details: { missing } }
    );
  }
}

export async function completeWorkItemInTx(
  tx: Db,
  item: WorkItem,
  input: CompleteWorkItemInput = {},
  options: WorkItemMutationOptions = {}
): Promise<WorkItem> {
  const ctx = requireCommandContext(tx);
  assertWorkItemTransition('complete', item);
  const result = input.result ?? {};
  const note = input.note?.trim() || null;
  if (!input.skipEvidenceCheck) await assertWorkItemEvidence(tx, item, { result, note });
  const merged = { ...asRecord(item.result), ...result, ...(note ? { note } : {}) };
  if (JSON.stringify(merged).length > MAX_RESULT_JSON_LENGTH) {
    throw new OperationsError('invalid_payload', 'El resultado del trabajo es demasiado grande');
  }
  if (note) await attachEvidenceInTx(tx, { workItemId: item.id, kind: 'note', note });

  const updated = await tx.workItem.update({
    where: { id: item.id },
    data: {
      status: 'done',
      completedBy: ctx.actor.id,
      completedAt: ctx.now,
      result: toOperationalJson(merged),
      ...versionData(options),
    },
  });
  ctx.emit(
    OPS_EVENTS.workitem.completed,
    {
      workItemId: updated.id,
      kind: updated.kind,
      previousStatus: item.status,
      completedBy: ctx.actor.id,
      stepId: updated.stepId,
      objectType: updated.objectType,
      objectId: updated.objectId,
      resultKeys: Object.keys(merged),
    },
    eventOptions(updated)
  );
  const personal = ctx.actor.type === 'user' || ctx.actor.type === 'ai';
  if (personal && ctx.actor.id !== updated.ownerUserId) {
    ctx.notify({
      userId: updated.ownerUserId,
      category: 'ops_workitem',
      type: 'ops_workitem_completed',
      title: `Se terminó tu trabajo: ${updated.title}`,
      body: note,
      url: workItemUrl(updated.id),
      entityType: WORK_ITEM_AGGREGATE_TYPE,
      entityId: updated.id,
    });
  }
  await runAfterHook('afterComplete', { tx, ctx, item: updated });
  return updated;
}

export async function cancelWorkItemInTx(
  tx: Db,
  item: WorkItem,
  input: { reason: string },
  options: WorkItemMutationOptions = {}
): Promise<WorkItem> {
  const ctx = requireCommandContext(tx);
  assertWorkItemTransition('cancel', item);
  const reason = String(input.reason ?? '')
    .trim()
    .slice(0, 500);
  const updated = await tx.workItem.update({
    where: { id: item.id },
    data: {
      status: 'cancelled',
      completedAt: ctx.now,
      result: toOperationalJson({
        ...asRecord(item.result),
        ...(reason ? { cancelReason: reason } : {}),
      }),
      ...versionData(options),
    },
  });
  ctx.emit(
    OPS_EVENTS.workitem.cancelled,
    { workItemId: updated.id, previousStatus: item.status, reason: reason || null },
    eventOptions(updated)
  );
  if (ctx.actor.id !== updated.ownerUserId) {
    ctx.notify({
      userId: updated.ownerUserId,
      category: 'ops_workitem',
      type: 'ops_workitem_cancelled',
      title: `Ya no es necesario: ${updated.title}`,
      body: reason || null,
      url: workItemUrl(updated.id),
      entityType: WORK_ITEM_AGGREGATE_TYPE,
      entityId: updated.id,
    });
  }
  return updated;
}

export interface ReassignWorkItemInput {
  ownerUserId: string;
  /** undefined keeps the current backup (dropped if it becomes the owner); null removes it. */
  backupUserId?: string | null;
  /** New due date; restarts the escalation ladder. */
  dueAt?: Date | null;
  reason?: string | null;
}

export async function reassignWorkItemInTx(
  tx: Db,
  item: WorkItem,
  input: ReassignWorkItemInput,
  options: WorkItemMutationOptions = {}
): Promise<WorkItem> {
  const ctx = requireCommandContext(tx);
  assertWorkItemTransition('reassign', item);
  const ownerUserId = String(input.ownerUserId ?? '').trim();
  if (input.backupUserId && input.backupUserId === ownerUserId) {
    throw new OperationsError('invalid_payload', 'El suplente debe ser otra persona');
  }
  if (!(await isActiveHumanUser(tx, ownerUserId))) {
    throw new OperationsError(
      'invalid_payload',
      'El nuevo responsable no existe, está inactivo o es un bot'
    );
  }
  let backupUserId = input.backupUserId === undefined ? item.backupUserId : input.backupUserId;
  if (backupUserId === ownerUserId) backupUserId = null;
  if (
    backupUserId &&
    backupUserId !== item.backupUserId &&
    !(await isActiveHumanUser(tx, backupUserId))
  ) {
    throw new OperationsError(
      'invalid_payload',
      'El suplente no existe, está inactivo o es un bot'
    );
  }
  const dueAt = input.dueAt ?? null;
  if (dueAt && (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= ctx.now.getTime())) {
    throw new OperationsError('invalid_payload', 'La nueva fecha límite debe ser futura');
  }
  const ownerChanged = ownerUserId !== item.ownerUserId;
  const backupChanged = backupUserId !== item.backupUserId;
  if (!ownerChanged && !backupChanged && !dueAt) {
    throw new OperationsError('invalid_state', 'El trabajo ya tiene esos responsables');
  }
  const reason = input.reason?.trim().slice(0, 500) || null;

  const data: Prisma.WorkItemUpdateInput = {
    ownerUserId,
    backupUserId,
    ...versionData(options),
  };
  if (dueAt) {
    data.dueAt = dueAt;
    data.escalationLevel = 0;
    data.escalatedAt = null;
    if (item.status === 'escalated') data.status = 'open';
  }
  const updated = await tx.workItem.update({ where: { id: item.id }, data });
  ctx.emit(
    OPS_EVENTS.workitem.reassigned,
    {
      workItemId: updated.id,
      previousOwnerUserId: item.ownerUserId,
      previousBackupUserId: item.backupUserId,
      ownerUserId: updated.ownerUserId,
      backupUserId: updated.backupUserId,
      previousDueAt: item.dueAt.toISOString(),
      dueAt: updated.dueAt.toISOString(),
      escalationReset: Boolean(dueAt),
      reason,
    },
    eventOptions(updated)
  );

  const due = `${areaLabel(updated.areaKey)} · vence ${formatOperationsDate(updated.dueAt)}`;
  const body = reason ? `${due} · ${reason}` : due;
  if (ownerChanged) {
    ctx.notify({
      userId: updated.ownerUserId,
      category: 'ops_workitem',
      type: 'ops_workitem_assigned',
      title: `Te asignaron: ${updated.title}`,
      body,
      url: workItemUrl(updated.id),
      entityType: WORK_ITEM_AGGREGATE_TYPE,
      entityId: updated.id,
    });
    if (item.ownerUserId !== updated.backupUserId) {
      ctx.notify({
        userId: item.ownerUserId,
        category: 'ops_workitem',
        type: 'ops_workitem_reassigned',
        title: `Se reasignó: ${updated.title}`,
        body: reason,
        url: workItemUrl(updated.id),
        entityType: WORK_ITEM_AGGREGATE_TYPE,
        entityId: updated.id,
      });
    }
  }
  if (backupChanged && updated.backupUserId) {
    ctx.notify({
      userId: updated.backupUserId,
      category: 'ops_workitem',
      type: 'ops_workitem_backup',
      title: `Eres suplente de: ${updated.title}`,
      body,
      url: workItemUrl(updated.id),
      entityType: WORK_ITEM_AGGREGATE_TYPE,
      entityId: updated.id,
    });
  }
  await runAfterHook(
    'afterReassign',
    { tx, ctx, item: updated },
    { previousOwnerUserId: item.ownerUserId, previousBackupUserId: item.backupUserId }
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

export type EscalationReason = 'overdue' | 'manual' | 'request_overdue';

export interface EscalateWorkItemOptions extends WorkItemMutationOptions {
  reason?: EscalationReason;
  note?: string | null;
}

export interface EscalationOutcome {
  /** False when the level (or a higher one) was already applied: nothing changed. */
  applied: boolean;
  level: number;
  step: EscalationStep;
  workItem: WorkItem;
  previousOwnerUserId: string;
  previousBackupUserId: string | null;
  /** Area lead or Administración person who now backs the work item. */
  escalatedToUserId: string | null;
  notifiedUserIds: string[];
  incidentId: string | null;
}

/** Active area lead different from `excludeUserId`: Area.leadUserId, then the area responsible and backup. */
async function resolveAreaLead(
  tx: Db,
  areaKey: string,
  excludeUserId: string
): Promise<string | null> {
  const area = await tx.area.findUnique({
    where: { key: areaKey },
    select: { leadUserId: true, responsibleArea: true },
  });
  const candidates: string[] = [];
  if (area?.leadUserId) candidates.push(area.leadUserId);
  const responsible = await resolveResponsible(area?.responsibleArea || areaKey);
  if (responsible) {
    candidates.push(responsible.userId);
    if (responsible.backupUserId) candidates.push(responsible.backupUserId);
  }
  for (const userId of candidates) {
    if (userId !== excludeUserId && (await isActiveHumanUser(tx, userId))) return userId;
  }
  return null;
}

/** Administración responsible (or its backup / super admin fallback) different from `excludeUserId`. */
async function resolveAdministrationTarget(
  tx: Db,
  excludeUserId: string | null
): Promise<string | null> {
  try {
    const assignee = await resolveAreaAssignee(tx, 'administracion');
    for (const userId of [assignee.ownerUserId, assignee.backupUserId]) {
      if (userId && userId !== excludeUserId) return userId;
    }
    return null;
  } catch (err) {
    if (isOperationsError(err) && err.code === 'no_responsible') return null;
    throw err;
  }
}

/**
 * Applies escalation `level` to a work item inside the running command
 * (see the module comment for the ladder). Idempotent: a level already
 * applied returns `applied: false`. An inactive owner is replaced by the
 * backup or the area assignee on any level.
 */
export async function escalateWorkItem(
  tx: Db,
  item: WorkItem | string,
  level: number,
  options: EscalateWorkItemOptions = {}
): Promise<EscalationOutcome> {
  const ctx = requireCommandContext(tx);
  const current = await loadWorkItem(tx, typeof item === 'string' ? item : item.id);
  assertWorkItemTransition('escalate', current);
  const { ladder } = (await getOperationsConfig()).escalation;
  const step = escalationStepFor(level, ladder);
  if (step === null) {
    throw new OperationsError(
      'invalid_payload',
      `Nivel de escalación inválido (de 0 a ${ladder.length})`
    );
  }
  const previousLevel = appliedEscalationLevel(current);
  const outcome: EscalationOutcome = {
    applied: false,
    level,
    step,
    workItem: current,
    previousOwnerUserId: current.ownerUserId,
    previousBackupUserId: current.backupUserId,
    escalatedToUserId: null,
    notifiedUserIds: [],
    incidentId: null,
  };
  if (previousLevel >= level) return outcome;

  let ownerUserId = current.ownerUserId;
  let backupUserId = current.backupUserId;
  let ownerReplaced = false;
  if (!(await isActiveHumanUser(tx, ownerUserId))) {
    if (backupUserId && (await isActiveHumanUser(tx, backupUserId))) {
      ownerUserId = backupUserId;
      backupUserId = null;
      ownerReplaced = true;
    } else if (isAreaKey(current.areaKey)) {
      try {
        const assignee = await resolveAreaAssignee(tx, current.areaKey);
        if (assignee.ownerUserId !== ownerUserId) {
          ownerUserId = assignee.ownerUserId;
          backupUserId = assignee.backupUserId;
          ownerReplaced = true;
        }
      } catch (err) {
        if (!isOperationsError(err) || err.code !== 'no_responsible') throw err;
      }
    }
  }

  const overdueMinutes = Math.max(
    0,
    Math.floor((ctx.now.getTime() - current.dueAt.getTime()) / 60_000)
  );
  let status = current.status;
  let escalatedToUserId: string | null = null;
  let incidentId: string | null = null;
  if (step === 'area_lead') {
    escalatedToUserId =
      (await resolveAreaLead(tx, current.areaKey, ownerUserId)) ??
      (await resolveAdministrationTarget(tx, ownerUserId));
    status = 'escalated';
  } else if (step === 'administracion') {
    escalatedToUserId = await resolveAdministrationTarget(tx, ownerUserId);
    status = 'escalated';
  } else if (step === 'incident') {
    const { incident } = await ctx.openIncident({
      kind: 'sla_breach',
      areaKey: isAreaKey(current.areaKey) ? current.areaKey : 'administracion',
      severity: 'critical',
      title: `Trabajo vencido sin atender: ${current.title}`.slice(0, 200),
      dedupeKey: `sla_breach:work_item:${current.id}`,
      caseId: current.caseId,
      ownerUserId: await resolveAdministrationTarget(tx, null),
      detail: {
        workItemId: current.id,
        title: current.title,
        areaKey: current.areaKey,
        ownerUserId,
        backupUserId,
        dueAt: current.dueAt.toISOString(),
        overdueMinutes,
        escalationLevel: level,
      },
    });
    incidentId = incident.id;
    status = 'escalated';
  }
  if (escalatedToUserId && escalatedToUserId !== ownerUserId) backupUserId = escalatedToUserId;

  const updated = await tx.workItem.update({
    where: { id: current.id },
    data: {
      ownerUserId,
      backupUserId,
      status,
      escalationLevel: level,
      escalatedAt: ctx.now,
      ...versionData(options),
    },
  });
  const options_ = eventOptions(updated);
  if (ownerReplaced) {
    ctx.emit(
      OPS_EVENTS.workitem.reassigned,
      {
        workItemId: updated.id,
        previousOwnerUserId: current.ownerUserId,
        previousBackupUserId: current.backupUserId,
        ownerUserId: updated.ownerUserId,
        backupUserId: updated.backupUserId,
        reason: 'owner_inactive',
      },
      options_
    );
  }
  if (previousLevel < 0 && overdueMinutes > 0) {
    ctx.emit(
      OPS_EVENTS.workitem.overdue,
      {
        workItemId: updated.id,
        dueAt: current.dueAt.toISOString(),
        overdueMinutes,
        ownerUserId: updated.ownerUserId,
        backupUserId: updated.backupUserId,
      },
      options_
    );
  }
  ctx.emit(
    OPS_EVENTS.workitem.escalated,
    {
      workItemId: updated.id,
      level,
      previousLevel,
      step,
      reason: options.reason ?? 'overdue',
      note: options.note ?? null,
      ownerUserId: updated.ownerUserId,
      backupUserId: updated.backupUserId,
      escalatedToUserId,
      incidentId,
      overdueMinutes,
    },
    options_
  );

  const lateness =
    overdueMinutes > 0
      ? `vencido hace ${formatMinutes(overdueMinutes)}`
      : `vence ${formatOperationsDate(updated.dueAt)}`;
  const body = `${areaLabel(updated.areaKey)} · ${lateness}`;
  const messages = new Map<string, string>();
  if (step === 'backup') {
    messages.set(updated.ownerUserId, `Trabajo vencido: ${updated.title}`);
    if (updated.backupUserId) {
      messages.set(updated.backupUserId, `Trabajo vencido (eres suplente): ${updated.title}`);
    }
  } else if (step === 'incident') {
    messages.set(updated.ownerUserId, `Tu trabajo vencido ya es incidencia: ${updated.title}`);
    if (updated.backupUserId) {
      messages.set(updated.backupUserId, `Trabajo vencido ya es incidencia: ${updated.title}`);
    }
  } else {
    messages.set(updated.ownerUserId, `Tu trabajo se escaló: ${updated.title}`);
    if (escalatedToUserId) messages.set(escalatedToUserId, `Escalado a ti: ${updated.title}`);
  }
  for (const [userId, title] of messages) {
    ctx.notify({
      userId,
      category: 'ops_escalation',
      type: step === 'backup' ? 'ops_workitem_overdue' : 'ops_workitem_escalated',
      title,
      body: options.note ? `${body} · ${options.note}` : body,
      url: workItemUrl(updated.id),
      entityType: WORK_ITEM_AGGREGATE_TYPE,
      entityId: updated.id,
      push: level >= 1 ? { urgency: 'high' } : undefined,
    });
  }
  if (ownerReplaced) {
    await runAfterHook(
      'afterReassign',
      { tx, ctx, item: updated },
      { previousOwnerUserId: current.ownerUserId, previousBackupUserId: current.backupUserId }
    );
  }

  return {
    ...outcome,
    applied: true,
    workItem: updated,
    escalatedToUserId,
    incidentId,
    notifiedUserIds: [...messages.keys()].filter((userId) => userId !== ctx.actor.id),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const workItemAggregate = versionedAggregate(WORK_ITEM_AGGREGATE_TYPE, 'workItem');
const isoDateTime = z.string().trim().datetime({ offset: true, message: 'Fecha inválida (ISO)' });

const startSchema = z.object({});
const completeSchema = z.object({
  result: z.record(z.unknown()).optional(),
  note: z.string().trim().min(1).max(2000).optional(),
});
const waitSchema = z.object({
  reason: z.string().trim().min(3, 'Indica el motivo de la espera').max(500),
  until: isoDateTime.optional(),
});
const reassignSchema = z.object({
  ownerUserId: z.string().trim().min(1).max(120),
  backupUserId: z.string().trim().min(1).max(120).nullable().optional(),
  dueAt: isoDateTime.optional(),
  reason: z.string().trim().max(500).optional(),
});
const escalateSchema = z.object({
  level: z.number().int().min(0).max(20).optional(),
  reason: z.enum(['overdue', 'manual', 'request_overdue']).optional(),
  note: z.string().trim().max(500).optional(),
});

export interface WorkItemCommandData {
  workItemId: string;
  status: string;
  ownerUserId: string;
  backupUserId: string | null;
  escalationLevel: number;
  dueAt: string;
}

export interface WorkItemEscalationData extends WorkItemCommandData {
  applied: boolean;
  level: number;
  step: EscalationStep;
  escalatedToUserId: string | null;
  incidentId: string | null;
  notifiedUserIds: string[];
}

function commandData(item: WorkItem): WorkItemCommandData {
  return {
    workItemId: item.id,
    status: item.status,
    ownerUserId: item.ownerUserId,
    backupUserId: item.backupUserId,
    escalationLevel: item.escalationLevel,
    dueAt: item.dueAt.toISOString(),
  };
}

registerCommand<z.output<typeof startSchema>, WorkItemCommandData>(WORK_ITEM_COMMANDS.start, {
  schema: startSchema,
  aggregate: workItemAggregate,
  async handler(tx, cmd, ctx) {
    const item = await loadWorkItem(tx, cmd.aggregate.id);
    assertCanActOnWorkItem(ctx, item);
    assertWorkItemTransition('start', item);
    assertLinkedHandlersLoaded(item);
    for (const hooks of hooksFor(item)) await hooks.beforeStart?.({ tx, ctx, item });
    const updated = await startWorkItemInTx(tx, item, { aggregate: true });
    return { data: commandData(updated) };
  },
});

registerCommand<z.output<typeof waitSchema>, WorkItemCommandData>(WORK_ITEM_COMMANDS.wait, {
  schema: waitSchema,
  aggregate: workItemAggregate,
  async handler(tx, cmd, ctx) {
    const item = await loadWorkItem(tx, cmd.aggregate.id);
    assertCanActOnWorkItem(ctx, item);
    assertWorkItemTransition('wait', item);
    const input = validateWait(
      {
        reason: cmd.payload.reason,
        until: cmd.payload.until ? new Date(cmd.payload.until) : null,
      },
      ctx.now
    );
    assertLinkedHandlersLoaded(item);
    for (const hooks of hooksFor(item)) await hooks.beforeWait?.({ tx, ctx, item }, input);
    const updated = await waitWorkItemInTx(tx, item, input, { aggregate: true });
    return { data: commandData(updated) };
  },
});

registerCommand<z.output<typeof completeSchema>, WorkItemCommandData>(WORK_ITEM_COMMANDS.complete, {
  schema: completeSchema,
  aggregate: workItemAggregate,
  async handler(tx, cmd, ctx) {
    const item = await loadWorkItem(tx, cmd.aggregate.id);
    assertCanActOnWorkItem(ctx, item);
    assertWorkItemTransition('complete', item);
    const result = cmd.payload.result ?? {};
    const note = cmd.payload.note ?? null;
    await assertWorkItemEvidence(tx, item, { result, note });
    assertLinkedHandlersLoaded(item);
    for (const hooks of hooksFor(item)) {
      await hooks.beforeComplete?.({ tx, ctx, item }, { result, note });
    }
    const updated = await completeWorkItemInTx(
      tx,
      item,
      { result, note, skipEvidenceCheck: true },
      { aggregate: true }
    );
    return { data: commandData(updated) };
  },
});

registerCommand<z.output<typeof reassignSchema>, WorkItemCommandData>(WORK_ITEM_COMMANDS.reassign, {
  schema: reassignSchema,
  aggregate: workItemAggregate,
  async handler(tx, cmd, ctx) {
    const item = await loadWorkItem(tx, cmd.aggregate.id);
    assertCanActOnWorkItem(ctx, item);
    const updated = await reassignWorkItemInTx(
      tx,
      item,
      {
        ownerUserId: cmd.payload.ownerUserId,
        backupUserId: cmd.payload.backupUserId,
        dueAt: cmd.payload.dueAt ? new Date(cmd.payload.dueAt) : null,
        reason: cmd.payload.reason ?? null,
      },
      { aggregate: true }
    );
    return { data: commandData(updated) };
  },
});

registerCommand<z.output<typeof escalateSchema>, WorkItemEscalationData>(
  WORK_ITEM_COMMANDS.escalate,
  {
    schema: escalateSchema,
    aggregate: workItemAggregate,
    async handler(tx, cmd, ctx) {
      const item = await loadWorkItem(tx, cmd.aggregate.id);
      assertCanActOnWorkItem(ctx, item);
      assertWorkItemTransition('escalate', item);
      const { escalation } = await getOperationsConfig();
      const applied = appliedEscalationLevel(item);
      const automatic = ctx.actor.type === 'system' || ctx.actor.type === 'zoho';
      const manager = ctx.user ? hasPermission(ctx.user, MANAGE_PERMISSION) : false;

      let level = cmd.payload.level;
      if (level === undefined) {
        const next = automatic ? nextEscalationLevel(item, escalation, ctx.now) : applied + 1;
        if (next === null) {
          throw new OperationsError('invalid_state', 'El trabajo todavía no requiere escalación');
        }
        level = next;
      }
      if (level > escalation.ladder.length) {
        throw new OperationsError(
          'invalid_state',
          'El trabajo ya está en el último nivel de escalación'
        );
      }
      if (!automatic && !manager) {
        const ceiling = Math.min(applied + 1, escalation.ladder.length - 1);
        if (level > ceiling) {
          throw new OperationsError(
            'forbidden',
            'Sólo puedes escalar un nivel a la vez; la incidencia por vencimiento la abre un gestor o el supervisor'
          );
        }
      }
      const outcome = await escalateWorkItem(tx, item, level, {
        aggregate: true,
        reason: cmd.payload.reason ?? (automatic ? 'overdue' : 'manual'),
        note: cmd.payload.note || null,
      });
      return {
        data: {
          ...commandData(outcome.workItem),
          applied: outcome.applied,
          level: outcome.level,
          step: outcome.step,
          escalatedToUserId: outcome.escalatedToUserId,
          incidentId: outcome.incidentId,
          notifiedUserIds: outcome.notifiedUserIds,
        },
      };
    },
  }
);

// ---------------------------------------------------------------------------
// Command wrappers for signed-in users
// ---------------------------------------------------------------------------

export interface WorkItemCommandOptions {
  commandId?: string;
  expectedVersion?: number;
  deviceId?: string;
  now?: Date;
}

function runWorkItemCommand<D>(
  actor: CurrentUser,
  type: string,
  workItemId: string,
  payload: unknown,
  options: WorkItemCommandOptions
): Promise<CommandResult<D>> {
  return executeCommand<D>(
    {
      commandId: options.commandId ?? randomUUID(),
      type,
      actor: { type: 'user', id: actor.id },
      aggregate: { type: WORK_ITEM_AGGREGATE_TYPE, id: workItemId },
      expectedVersion: options.expectedVersion,
      deviceId: options.deviceId,
      payload,
    },
    actor,
    { now: options.now }
  );
}

const isoOf = (value: Date | string | null | undefined) =>
  value instanceof Date ? value.toISOString() : (value ?? undefined);

export function startWorkItem(
  actor: CurrentUser,
  workItemId: string,
  options: WorkItemCommandOptions = {}
): Promise<CommandResult<WorkItemCommandData>> {
  return runWorkItemCommand(actor, WORK_ITEM_COMMANDS.start, workItemId, {}, options);
}

export function completeWorkItem(
  actor: CurrentUser,
  workItemId: string,
  input: { result?: Record<string, unknown>; note?: string } = {},
  options: WorkItemCommandOptions = {}
): Promise<CommandResult<WorkItemCommandData>> {
  return runWorkItemCommand(actor, WORK_ITEM_COMMANDS.complete, workItemId, input, options);
}

export function waitWorkItem(
  actor: CurrentUser,
  workItemId: string,
  input: { reason: string; until?: Date | string | null },
  options: WorkItemCommandOptions = {}
): Promise<CommandResult<WorkItemCommandData>> {
  return runWorkItemCommand(
    actor,
    WORK_ITEM_COMMANDS.wait,
    workItemId,
    { reason: input.reason, until: isoOf(input.until) },
    options
  );
}

export function reassignWorkItem(
  actor: CurrentUser,
  workItemId: string,
  input: {
    ownerUserId: string;
    backupUserId?: string | null;
    dueAt?: Date | string | null;
    reason?: string;
  },
  options: WorkItemCommandOptions = {}
): Promise<CommandResult<WorkItemCommandData>> {
  return runWorkItemCommand(
    actor,
    WORK_ITEM_COMMANDS.reassign,
    workItemId,
    { ...input, dueAt: isoOf(input.dueAt) },
    options
  );
}

/** Manual escalation (`workitem.escalate`); without `level` it asks for the next rung. */
export function requestWorkItemEscalation(
  actor: CurrentUser,
  workItemId: string,
  input: { level?: number; note?: string } = {},
  options: WorkItemCommandOptions = {}
): Promise<CommandResult<WorkItemEscalationData>> {
  return runWorkItemCommand(actor, WORK_ITEM_COMMANDS.escalate, workItemId, input, options);
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

export interface WorkItemDTO {
  id: string;
  caseId: string | null;
  caseNumber: string | null;
  customerName: string | null;
  stepId: string | null;
  areaKey: string;
  areaLabel: string;
  kind: string;
  kindLabel: string;
  title: string;
  description: string | null;
  status: string;
  statusLabel: string;
  ownerUserId: string;
  ownerName: string | null;
  backupUserId: string | null;
  backupName: string | null;
  dueAt: string;
  overdue: boolean;
  escalationLevel: number;
  escalatedAt: string | null;
  waitReason: string | null;
  waitUntil: string | null;
  objectType: string | null;
  objectId: string | null;
  requiredEvidence: string[];
  result: Record<string, unknown> | null;
  completedBy: string | null;
  completedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemPermissionsDTO {
  canStart: boolean;
  canWait: boolean;
  canComplete: boolean;
  canReassign: boolean;
  canEscalate: boolean;
}

export interface WorkItemDetailDTO extends WorkItemDTO {
  evidence: EvidenceDTO[];
  /** Required evidence still missing (empty for closed items). */
  missingEvidence: string[];
  permissions: WorkItemPermissionsDTO;
}

export interface WorkItemPage {
  items: WorkItemDTO[];
  nextCursor: string | null;
}

export const workItemFiltersSchema = z
  .object({
    /** open (default) | closed (done, cancelled) | all; ignored when `status` is given. */
    scope: z.enum(['open', 'closed', 'all']).default('open'),
    status: z.array(z.enum(WORK_ITEM_STATUSES)).max(WORK_ITEM_STATUSES.length).optional(),
    kind: z.array(z.enum(WORK_ITEM_KINDS)).max(WORK_ITEM_KINDS.length).optional(),
    areaKey: z.enum(AREA_KEYS).optional(),
    caseId: z.string().trim().min(1).max(120).optional(),
    /** Only for `listMyWorkItems`. */
    role: z.enum(['any', 'owner', 'backup']).default('any'),
    overdueOnly: z.boolean().default(false),
    dueBefore: z.coerce.date().optional(),
    search: z.string().trim().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().trim().max(300).optional(),
  })
  .strict();

export type WorkItemFilters = z.input<typeof workItemFiltersSchema>;
type ParsedWorkItemFilters = z.output<typeof workItemFiltersSchema>;

function parseFilters(filters: WorkItemFilters): ParsedWorkItemFilters {
  const parsed = workItemFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    throw new OperationsError(
      'invalid_payload',
      `Filtros inválidos: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'filtros'}: ${issue.message}`)
        .join('; ')}`
    );
  }
  return parsed.data;
}

async function queryWorkItems(
  base: Prisma.WorkItemWhereInput[],
  filters: ParsedWorkItemFilters,
  now: Date
): Promise<WorkItemPage> {
  const and: Prisma.WorkItemWhereInput[] = [...base];
  if (filters.status?.length) and.push({ status: { in: filters.status } });
  else if (filters.scope === 'open') and.push({ status: { in: [...OPEN_STATUSES] } });
  else if (filters.scope === 'closed') and.push({ status: { in: ['done', 'cancelled'] } });
  if (filters.kind?.length) and.push({ kind: { in: filters.kind } });
  if (filters.areaKey) and.push({ areaKey: filters.areaKey });
  if (filters.caseId) and.push({ caseId: filters.caseId });
  if (filters.overdueOnly) {
    and.push({ dueAt: { lt: now }, status: { in: [...OPEN_STATUSES] } });
  }
  if (filters.dueBefore) and.push({ dueAt: { lte: filters.dueBefore } });
  if (filters.search) {
    and.push({
      OR: [
        { title: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ],
    });
  }
  const closedOrder = filters.scope === 'closed' && !filters.status?.length;
  const field = closedOrder ? 'updatedAt' : 'dueAt';
  const direction = closedOrder ? 'desc' : 'asc';
  const keyset = keysetCondition(field, direction, decodeListCursor(filters.cursor));
  if (keyset) and.push(keyset as Prisma.WorkItemWhereInput);

  const rows = await prisma.workItem.findMany({
    where: { AND: and },
    orderBy: [{ [field]: direction }, { id: direction }],
    take: filters.limit + 1,
  });
  const page = rows.slice(0, filters.limit);
  const last = page[page.length - 1];
  return {
    items: await toWorkItemDTOs(page, now),
    nextCursor: rows.length > filters.limit && last ? encodeListCursor(last[field], last.id) : null,
  };
}

/** DTOs with owner/backup names and case numbers (no access check). */
export async function toWorkItemDTOs(
  rows: WorkItem[],
  now: Date = new Date()
): Promise<WorkItemDTO[]> {
  if (rows.length === 0) return [];
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.ownerUserId, r.backupUserId]).filter(Boolean) as string[]),
  ];
  const caseIds = [...new Set(rows.map((r) => r.caseId).filter(Boolean) as string[])];
  const [users, cases] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    caseIds.length
      ? prisma.operationalCase.findMany({
          where: { id: { in: caseIds } },
          select: { id: true, caseNumber: true, customerName: true },
        })
      : Promise.resolve([]),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const caseById = new Map(cases.map((c) => [c.id, c]));
  return rows.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    caseNumber: row.caseId ? (caseById.get(row.caseId)?.caseNumber ?? null) : null,
    customerName: row.caseId ? (caseById.get(row.caseId)?.customerName ?? null) : null,
    stepId: row.stepId,
    areaKey: row.areaKey,
    areaLabel: areaLabel(row.areaKey),
    kind: row.kind,
    kindLabel: (WORK_ITEM_KIND_LABELS as Record<string, string>)[row.kind] ?? row.kind,
    title: row.title,
    description: row.description,
    status: row.status,
    statusLabel: (WORK_ITEM_STATUS_LABELS as Record<string, string>)[row.status] ?? row.status,
    ownerUserId: row.ownerUserId,
    ownerName: names.get(row.ownerUserId) ?? null,
    backupUserId: row.backupUserId,
    backupName: row.backupUserId ? (names.get(row.backupUserId) ?? null) : null,
    dueAt: row.dueAt.toISOString(),
    overdue: isWorkItemOpenStatus(row.status) && row.dueAt.getTime() < now.getTime(),
    escalationLevel: row.escalationLevel,
    escalatedAt: row.escalatedAt?.toISOString() ?? null,
    waitReason: row.waitReason,
    waitUntil: row.waitUntil?.toISOString() ?? null,
    objectType: row.objectType,
    objectId: row.objectId,
    requiredEvidence: row.requiredEvidence,
    result: row.result === null ? null : asRecord(row.result),
    completedBy: row.completedBy,
    completedAt: row.completedAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/** Work items where the user is owner and/or backup (default: open ones, most urgent first). */
export async function listMyWorkItems(
  user: CurrentUser,
  filters: WorkItemFilters = {},
  options: { now?: Date } = {}
): Promise<WorkItemPage> {
  const parsed = parseFilters(filters);
  const mine: Prisma.WorkItemWhereInput =
    parsed.role === 'owner'
      ? { ownerUserId: user.id }
      : parsed.role === 'backup'
        ? { backupUserId: user.id }
        : { OR: [{ ownerUserId: user.id }, { backupUserId: user.id }] };
  return queryWorkItems([mine], parsed, options.now ?? new Date());
}

/**
 * Required evidence still missing for each OPEN work item of the list (the same rule the core
 * applies when completing): uploaded evidence links and keys of the stored result. Items without
 * required evidence are not queried. Keyed by work item id.
 */
export async function missingEvidenceForWorkItems(
  items: ReadonlyArray<Pick<WorkItemDTO, 'id' | 'stepId' | 'objectType' | 'objectId' | 'createdAt' | 'requiredEvidence' | 'result' | 'status'>>
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const pending = items.filter((item) => item.requiredEvidence.length > 0 && isWorkItemOpenStatus(item.status));
  await Promise.all(
    pending.map(async (item) => {
      const links = await prisma.evidenceLink.findMany({
        where: evidenceWhereForWorkItem({
          id: item.id,
          stepId: item.stepId,
          objectType: item.objectType,
          objectId: item.objectId,
          createdAt: new Date(item.createdAt),
        }),
        select: { kind: true },
        take: 200,
      });
      out.set(
        item.id,
        missingEvidence(item.requiredEvidence, {
          kinds: links.map((link) => link.kind),
          keys: presentResultKeys(asRecord(item.result)),
        })
      );
    })
  );
  return out;
}

/** Work items of an area; requires `operations.view`, area channel membership, lead or responsible. */
export async function listAreaWorkItems(
  actor: CurrentUser,
  areaKey: string,
  filters: WorkItemFilters = {},
  options: { now?: Date } = {}
): Promise<WorkItemPage> {
  if (!isAreaKey(areaKey)) throw new OperationsError('invalid_payload', 'Área inválida');
  if (!(await canViewArea(actor, areaKey))) {
    throw new OperationsError('forbidden', 'No tienes acceso al trabajo de esta área');
  }
  const parsed = parseFilters({ ...filters, areaKey });
  return queryWorkItems([], { ...parsed, role: 'any' }, options.now ?? new Date());
}

/** Permissions of `actor` over `item` (pure; approval items are decided elsewhere). */
export function workItemPermissions(
  actor: CurrentUser,
  item: Pick<WorkItem, 'ownerUserId' | 'backupUserId' | 'status' | 'objectType'>
): WorkItemPermissionsDTO {
  const canAct = isWorkItemParticipant(actor.id, item) || hasPermission(actor, MANAGE_PERMISSION);
  const approval = item.objectType === 'approval_request';
  return {
    canStart: canAct && canTransitionWorkItem('start', item.status),
    canWait: canAct && !approval && canTransitionWorkItem('wait', item.status),
    canComplete: canAct && !approval && canTransitionWorkItem('complete', item.status),
    canReassign: canAct && canTransitionWorkItem('reassign', item.status),
    canEscalate: canAct && canTransitionWorkItem('escalate', item.status),
  };
}

/**
 * One work item with its evidence and the actor's permissions. Visible with
 * `operations.view`, to its owner/backup, the case owner and whoever can view
 * its area. Not found and not allowed look the same.
 */
export async function getWorkItem(
  actor: CurrentUser,
  workItemId: string,
  options: { now?: Date } = {}
): Promise<WorkItemDetailDTO> {
  const notFound = () => new OperationsError('not_found', 'No se encontró el trabajo');
  const item = await prisma.workItem.findUnique({ where: { id: workItemId } });
  if (!item) throw notFound();
  let allowed = hasPermission(actor, VIEW_PERMISSION) || isWorkItemParticipant(actor.id, item);
  if (!allowed && item.caseId) {
    const operationalCase = await prisma.operationalCase.findUnique({
      where: { id: item.caseId },
      select: { ownerUserId: true },
    });
    allowed = operationalCase?.ownerUserId === actor.id;
  }
  if (!allowed) allowed = await canViewArea(actor, item.areaKey);
  if (!allowed) throw notFound();

  const [dto] = await toWorkItemDTOs([item], options.now ?? new Date());
  const evidence = await loadWorkItemEvidence(item);
  const missing = isWorkItemOpenStatus(item.status)
    ? missingEvidence(item.requiredEvidence, {
        kinds: evidence.map((e) => e.kind),
        keys: presentResultKeys(asRecord(item.result)),
      })
    : [];
  return {
    ...dto,
    evidence,
    missingEvidence: missing,
    permissions: workItemPermissions(actor, item),
  };
}
