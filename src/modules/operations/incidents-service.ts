import { randomUUID } from 'crypto';
import type { Incident, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import {
  executeCommand,
  registerCommand,
  requireCommandContext,
  versionedAggregate,
  type CommandContext,
  type CommandResult,
  type OpenIncidentInput,
} from './commands';
import { OperationsError } from './errors';
import { toOperationalJson } from './events-service';
import {
  AREA_KEYS,
  AREA_LABELS,
  INCIDENT_KINDS,
  INCIDENT_KIND_LABELS,
  INCIDENT_OPEN_STATUSES,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_STATUSES,
  OPS_EVENTS,
  isAreaKey,
  type IncidentSeverity,
  type IncidentStatus,
} from './types';
import {
  canViewArea,
  cancelWorkItemInTx,
  completeWorkItemInTx,
  decodeListCursor,
  encodeListCursor,
  keysetCondition,
} from './work-items-service';

/**
 * Operational incidents (plan sections 2.1 and 2.6).
 *
 * Opening happens inside other commands through `ctx.openIncident` (idempotent
 * by `dedupeKey`). `openOrReopenIncident(tx, input)` adds the rule "an incident
 * that repeats after being resolved opens again": same row, status `open`,
 * previous resolution kept in `detail.history`, `incident.opened` with
 * `reopened: true`. Dismissed incidents stay dismissed unless the caller asks.
 *
 * Commands on the `incident` aggregate, allowed to its owner, `operations.manage`
 * or a system actor:
 * - `incident.acknowledge` open → acknowledged (a manager acknowledging an
 *   incident without owner becomes its owner)
 * - `incident.resolve`     open | acknowledged → resolved (resolution required);
 *   closes its open follow-up work items as done
 * - `incident.dismiss`     open | acknowledged → dismissed (reason required);
 *   cancels its open follow-up work items
 */

export const INCIDENT_AGGREGATE_TYPE = 'incident';

export const INCIDENT_COMMANDS = {
  acknowledge: 'incident.acknowledge',
  resolve: 'incident.resolve',
  dismiss: 'incident.dismiss',
} as const;

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  open: 'Abierta',
  acknowledged: 'En atención',
  resolved: 'Resuelta',
  dismissed: 'Descartada',
};

export const INCIDENT_HISTORY_LIMIT = 20;

const MANAGE_PERMISSION = 'operations.manage';
const VIEW_PERMISSION = 'operations.view';

type Db = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export type IncidentAction = 'acknowledge' | 'resolve' | 'dismiss' | 'reopen';

const OPEN_STATUSES: readonly IncidentStatus[] = INCIDENT_OPEN_STATUSES;

export const INCIDENT_TRANSITIONS: Record<
  IncidentAction,
  { from: readonly IncidentStatus[]; to: IncidentStatus }
> = {
  acknowledge: { from: ['open'], to: 'acknowledged' },
  resolve: { from: OPEN_STATUSES, to: 'resolved' },
  dismiss: { from: OPEN_STATUSES, to: 'dismissed' },
  reopen: { from: ['resolved'], to: 'open' },
};

const ACTION_LABELS: Record<IncidentAction, string> = {
  acknowledge: 'atender',
  resolve: 'resolver',
  dismiss: 'descartar',
  reopen: 'reabrir',
};

export function nextIncidentStatus(action: IncidentAction, status: string): IncidentStatus | null {
  const rule = INCIDENT_TRANSITIONS[action];
  return (rule.from as readonly string[]).includes(status) ? rule.to : null;
}

export function isIncidentOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

/** A repeated dedupeKey reopens resolved incidents (and dismissed ones only when asked). */
export function shouldReopenIncident(
  status: string,
  options: { reopenDismissed?: boolean } = {}
): boolean {
  return status === 'resolved' || (Boolean(options.reopenDismissed) && status === 'dismissed');
}

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function maxIncidentSeverity(a: string, b: string): IncidentSeverity {
  const rank = (value: string) =>
    (SEVERITY_RANK as Record<string, number>)[value] ?? SEVERITY_RANK.medium;
  const winner = rank(a) >= rank(b) ? a : b;
  return (INCIDENT_SEVERITIES as readonly string[]).includes(winner)
    ? (winner as IncidentSeverity)
    : 'medium';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Adds a closed episode to `detail.history` (newest last, capped) and bumps `reopenCount`. */
export function appendIncidentHistory(
  detail: unknown,
  entry: Record<string, unknown>
): { history: Record<string, unknown>[]; reopenCount: number } {
  const current = asRecord(detail);
  const previous = Array.isArray(current.history)
    ? (current.history as unknown[]).filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
      )
    : [];
  const count = typeof current.reopenCount === 'number' ? current.reopenCount : 0;
  return {
    history: [...previous, entry].slice(-INCIDENT_HISTORY_LIMIT),
    reopenCount: count + 1,
  };
}

function areaLabel(areaKey: string): string {
  return isAreaKey(areaKey) ? AREA_LABELS[areaKey] : areaKey;
}

function severityLabel(severity: string): string {
  return (INCIDENT_SEVERITY_LABELS as Record<string, string>)[severity] ?? severity;
}

function statusLabel(status: string): string {
  return (INCIDENT_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

function incidentUrl(incident: Pick<Incident, 'id' | 'caseId'>): string {
  return incident.caseId
    ? `/app/operations/cases/${incident.caseId}?incident=${incident.id}`
    : `/app/operations?incident=${incident.id}`;
}

// ---------------------------------------------------------------------------
// Open or reopen
// ---------------------------------------------------------------------------

export interface OpenOrReopenIncidentInput extends OpenIncidentInput {
  /** Also reopen when the previous occurrence was dismissed (default false). */
  reopenDismissed?: boolean;
}

export interface OpenOrReopenIncidentOutcome {
  incident: Incident;
  created: boolean;
  reopened: boolean;
}

/**
 * `ctx.openIncident` plus reopening: the same `dedupeKey` after the incident
 * was resolved sets it `open` again (highest severity of both occurrences,
 * new title/detail, previous resolution in `detail.history`).
 */
export async function openOrReopenIncident(
  tx: Db,
  input: OpenOrReopenIncidentInput
): Promise<OpenOrReopenIncidentOutcome> {
  const ctx = requireCommandContext(tx);
  const { reopenDismissed, ...openInput } = input;
  const { incident, created } = await ctx.openIncident(openInput);
  if (created || !shouldReopenIncident(incident.status, { reopenDismissed })) {
    return { incident, created, reopened: false };
  }

  const { history, reopenCount } = appendIncidentHistory(incident.detail, {
    status: incident.status,
    openedAt: incident.openedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    resolvedBy: incident.resolvedBy,
    resolution: incident.resolution,
    reopenedAt: ctx.now.toISOString(),
  });
  const severity = maxIncidentSeverity(incident.severity, input.severity ?? incident.severity);
  const title = input.title?.trim().slice(0, 200) || incident.title;
  const updated = await tx.incident.update({
    where: { id: incident.id },
    data: {
      status: 'open',
      severity,
      title,
      detail: toOperationalJson({
        ...asRecord(incident.detail),
        ...(input.detail ?? {}),
        history,
        reopenCount,
      }),
      ownerUserId: incident.ownerUserId ?? input.ownerUserId ?? null,
      openedAt: ctx.now,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
      version: { increment: 1 },
    },
  });
  ctx.emit(
    OPS_EVENTS.incident.opened,
    {
      incidentId: updated.id,
      kind: updated.kind,
      severity: updated.severity,
      title: updated.title,
      ownerUserId: updated.ownerUserId,
      dedupeKey: updated.dedupeKey,
      reopened: true,
      reopenCount,
      previousStatus: incident.status,
    },
    {
      caseId: updated.caseId,
      areaKey: updated.areaKey,
      objectType: INCIDENT_AGGREGATE_TYPE,
      objectId: updated.id,
    }
  );
  if (updated.ownerUserId && input.notify !== false) {
    const severe = updated.severity === 'high' || updated.severity === 'critical';
    ctx.notify({
      userId: updated.ownerUserId,
      category: 'ops_incident',
      type: 'ops_incident_reopened',
      title: `Se repitió la incidencia: ${updated.title}`,
      body: `${areaLabel(updated.areaKey)} · severidad ${severityLabel(updated.severity).toLowerCase()}`,
      url: incidentUrl(updated),
      entityType: INCIDENT_AGGREGATE_TYPE,
      entityId: updated.id,
      push: severe
        ? { urgency: 'high', requireInteraction: updated.severity === 'critical' }
        : undefined,
    });
  }
  return { incident: updated, created: false, reopened: true };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export async function loadIncident(db: Db, incidentId: string): Promise<Incident> {
  const incident = await db.incident.findUnique({ where: { id: incidentId } });
  if (!incident) throw new OperationsError('not_found', 'No se encontró la incidencia');
  return incident;
}

/** Owner of the incident, `operations.manage` or a system actor. */
export function assertCanHandleIncident(
  ctx: Pick<CommandContext, 'actor' | 'user'>,
  incident: Pick<Incident, 'ownerUserId'>
): void {
  if (ctx.actor.type === 'system' || ctx.actor.type === 'zoho') return;
  const user = ctx.user;
  if (!user) {
    throw new OperationsError('unauthenticated', 'Tu sesión expiró; vuelve a iniciar sesión');
  }
  if (hasPermission(user, MANAGE_PERMISSION)) return;
  if (incident.ownerUserId && incident.ownerUserId === user.id) return;
  throw new OperationsError(
    'forbidden',
    'Sólo el responsable de la incidencia o un gestor de operaciones puede hacer esto'
  );
}

export interface IncidentTransitionInput {
  note?: string | null;
  resolution?: string | null;
  reason?: string | null;
}

export interface IncidentTransitionOutcome {
  incident: Incident;
  previousStatus: string;
  closedWorkItemIds: string[];
}

/** Acknowledge, resolve or dismiss inside the running command (callers check permissions). */
export async function transitionIncidentInTx(
  tx: Db,
  incident: Incident | string,
  action: Exclude<IncidentAction, 'reopen'>,
  input: IncidentTransitionInput = {},
  options: { aggregate?: boolean } = {}
): Promise<IncidentTransitionOutcome> {
  const ctx = requireCommandContext(tx);
  const current = typeof incident === 'string' ? await loadIncident(tx, incident) : incident;
  const next = nextIncidentStatus(action, current.status);
  if (!next) {
    throw new OperationsError(
      'invalid_state',
      `No se puede ${ACTION_LABELS[action]} una incidencia ${statusLabel(current.status).toLowerCase()}`,
      { details: { action, status: current.status } }
    );
  }
  const note = input.note?.trim() || null;
  const resolution = input.resolution?.trim() || null;
  const reason = input.reason?.trim() || null;
  if (action === 'resolve' && (!resolution || resolution.length < 3)) {
    throw new OperationsError('invalid_payload', 'Describe cómo se resolvió la incidencia');
  }
  if (action === 'dismiss' && (!reason || reason.length < 3)) {
    throw new OperationsError('invalid_payload', 'Indica por qué se descarta la incidencia');
  }

  const data: Prisma.IncidentUpdateInput = {
    status: next,
    ...(options.aggregate ? {} : { version: { increment: 1 } }),
  };
  if (action === 'acknowledge') {
    data.detail = toOperationalJson({
      ...asRecord(current.detail),
      acknowledgedBy: ctx.actor.id,
      acknowledgedAt: ctx.now.toISOString(),
      ...(note ? { acknowledgeNote: note } : {}),
    });
    if (!current.ownerUserId && ctx.actor.type === 'user') data.ownerUserId = ctx.actor.id;
  } else {
    data.resolvedAt = ctx.now;
    data.resolvedBy = ctx.actor.id;
    data.resolution = action === 'resolve' ? resolution : reason;
  }
  const updated = await tx.incident.update({ where: { id: current.id }, data });

  const closedWorkItemIds: string[] = [];
  if (action !== 'acknowledge') {
    const followUps = await tx.workItem.findMany({
      where: {
        objectType: INCIDENT_AGGREGATE_TYPE,
        objectId: updated.id,
        status: { in: ['open', 'in_progress', 'waiting', 'escalated'] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const item of followUps) {
      const closed =
        action === 'resolve'
          ? await completeWorkItemInTx(tx, item, {
              result: { incidentStatus: 'resolved', resolution },
              skipEvidenceCheck: true,
            })
          : await cancelWorkItemInTx(tx, item, { reason: `Incidencia descartada: ${reason}` });
      closedWorkItemIds.push(closed.id);
    }
  }

  const eventType =
    action === 'acknowledge'
      ? OPS_EVENTS.incident.acknowledged
      : action === 'resolve'
        ? OPS_EVENTS.incident.resolved
        : OPS_EVENTS.incident.dismissed;
  ctx.emit(
    eventType,
    {
      incidentId: updated.id,
      kind: updated.kind,
      severity: updated.severity,
      previousStatus: current.status,
      status: next,
      dedupeKey: updated.dedupeKey,
      ownerUserId: updated.ownerUserId,
      note,
      resolution: updated.resolution,
      closedWorkItemIds,
    },
    {
      caseId: updated.caseId,
      areaKey: updated.areaKey,
      objectType: INCIDENT_AGGREGATE_TYPE,
      objectId: updated.id,
    }
  );
  if (action !== 'acknowledge' && updated.ownerUserId && updated.ownerUserId !== ctx.actor.id) {
    ctx.notify({
      userId: updated.ownerUserId,
      category: 'ops_incident',
      type: action === 'resolve' ? 'ops_incident_resolved' : 'ops_incident_dismissed',
      title: `Incidencia ${action === 'resolve' ? 'resuelta' : 'descartada'}: ${updated.title}`,
      body: updated.resolution,
      url: incidentUrl(updated),
      entityType: INCIDENT_AGGREGATE_TYPE,
      entityId: updated.id,
    });
  }
  return { incident: updated, previousStatus: current.status, closedWorkItemIds };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const incidentAggregate = versionedAggregate(INCIDENT_AGGREGATE_TYPE, 'incident');

const INCIDENT_SCHEMAS = {
  acknowledge: z.object({ note: z.string().trim().min(1).max(1000).optional() }),
  resolve: z.object({
    resolution: z.string().trim().min(3, 'Describe cómo se resolvió').max(2000),
  }),
  dismiss: z.object({ reason: z.string().trim().min(3, 'Indica el motivo').max(2000) }),
};

export interface IncidentCommandData {
  incidentId: string;
  status: string;
  previousStatus: string;
  ownerUserId: string | null;
  closedWorkItemIds: string[];
}

for (const action of ['acknowledge', 'resolve', 'dismiss'] as const) {
  registerCommand<IncidentTransitionInput, IncidentCommandData>(INCIDENT_COMMANDS[action], {
    schema: INCIDENT_SCHEMAS[action] as z.ZodType<IncidentTransitionInput>,
    aggregate: incidentAggregate,
    actorTypes: ['user', 'system'],
    async handler(tx, cmd, ctx) {
      const incident = await loadIncident(tx, cmd.aggregate.id);
      assertCanHandleIncident(ctx, incident);
      const outcome = await transitionIncidentInTx(tx, incident, action, cmd.payload, {
        aggregate: true,
      });
      return {
        data: {
          incidentId: outcome.incident.id,
          status: outcome.incident.status,
          previousStatus: outcome.previousStatus,
          ownerUserId: outcome.incident.ownerUserId,
          closedWorkItemIds: outcome.closedWorkItemIds,
        },
      };
    },
  });
}

export interface IncidentCommandOptions {
  commandId?: string;
  expectedVersion?: number;
  deviceId?: string;
  now?: Date;
}

function runIncidentCommand(
  actor: CurrentUser,
  action: keyof typeof INCIDENT_COMMANDS,
  incidentId: string,
  payload: Record<string, unknown>,
  options: IncidentCommandOptions
): Promise<CommandResult<IncidentCommandData>> {
  return executeCommand<IncidentCommandData>(
    {
      commandId: options.commandId ?? randomUUID(),
      type: INCIDENT_COMMANDS[action],
      actor: { type: 'user', id: actor.id },
      aggregate: { type: INCIDENT_AGGREGATE_TYPE, id: incidentId },
      expectedVersion: options.expectedVersion,
      deviceId: options.deviceId,
      payload,
    },
    actor,
    { now: options.now }
  );
}

export function acknowledgeIncident(
  actor: CurrentUser,
  incidentId: string,
  input: { note?: string } = {},
  options: IncidentCommandOptions = {}
) {
  return runIncidentCommand(actor, 'acknowledge', incidentId, input, options);
}

export function resolveIncident(
  actor: CurrentUser,
  incidentId: string,
  input: { resolution: string },
  options: IncidentCommandOptions = {}
) {
  return runIncidentCommand(actor, 'resolve', incidentId, input, options);
}

export function dismissIncident(
  actor: CurrentUser,
  incidentId: string,
  input: { reason: string },
  options: IncidentCommandOptions = {}
) {
  return runIncidentCommand(actor, 'dismiss', incidentId, input, options);
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

export interface IncidentDTO {
  id: string;
  caseId: string | null;
  caseNumber: string | null;
  customerName: string | null;
  areaKey: string;
  areaLabel: string;
  kind: string;
  kindLabel: string;
  severity: string;
  severityLabel: string;
  status: string;
  statusLabel: string;
  title: string;
  detail: Record<string, unknown>;
  ownerUserId: string | null;
  ownerName: string | null;
  dedupeKey: string;
  openedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolution: string | null;
  reopenCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentPermissionsDTO {
  canAcknowledge: boolean;
  canResolve: boolean;
  canDismiss: boolean;
}

export interface IncidentDetailDTO extends IncidentDTO {
  permissions: IncidentPermissionsDTO;
}

export interface IncidentPage {
  items: IncidentDTO[];
  nextCursor: string | null;
}

export const incidentFiltersSchema = z
  .object({
    scope: z.enum(['open', 'closed', 'all']).default('open'),
    status: z.array(z.enum(INCIDENT_STATUSES)).max(INCIDENT_STATUSES.length).optional(),
    severity: z.array(z.enum(INCIDENT_SEVERITIES)).max(INCIDENT_SEVERITIES.length).optional(),
    kind: z.array(z.enum(INCIDENT_KINDS)).max(INCIDENT_KINDS.length).optional(),
    areaKey: z.enum(AREA_KEYS).optional(),
    caseId: z.string().trim().min(1).max(120).optional(),
    ownerUserId: z.string().trim().min(1).max(120).optional(),
    /** Only incidents owned by the actor. */
    mine: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().trim().max(300).optional(),
  })
  .strict();

export type IncidentFilters = z.input<typeof incidentFiltersSchema>;

/** DTOs with names and case numbers (no access check). */
export async function toIncidentDTOs(rows: Incident[]): Promise<IncidentDTO[]> {
  if (rows.length === 0) return [];
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.ownerUserId, r.resolvedBy]).filter(Boolean) as string[]),
  ];
  const caseIds = [...new Set(rows.map((r) => r.caseId).filter(Boolean) as string[])];
  const [users, cases] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    caseIds.length
      ? prisma.operationalCase.findMany({
          where: { id: { in: caseIds } },
          select: { id: true, caseNumber: true, customerName: true },
        })
      : Promise.resolve([]),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const caseById = new Map(cases.map((c) => [c.id, c]));
  return rows.map((row) => {
    const detail = asRecord(row.detail);
    return {
      id: row.id,
      caseId: row.caseId,
      caseNumber: row.caseId ? (caseById.get(row.caseId)?.caseNumber ?? null) : null,
      customerName: row.caseId ? (caseById.get(row.caseId)?.customerName ?? null) : null,
      areaKey: row.areaKey,
      areaLabel: areaLabel(row.areaKey),
      kind: row.kind,
      kindLabel: (INCIDENT_KIND_LABELS as Record<string, string>)[row.kind] ?? row.kind,
      severity: row.severity,
      severityLabel: severityLabel(row.severity),
      status: row.status,
      statusLabel: statusLabel(row.status),
      title: row.title,
      detail,
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerUserId ? (names.get(row.ownerUserId) ?? null) : null,
      dedupeKey: row.dedupeKey,
      openedAt: row.openedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedBy: row.resolvedBy,
      resolvedByName: row.resolvedBy ? (names.get(row.resolvedBy) ?? null) : null,
      resolution: row.resolution,
      reopenCount: typeof detail.reopenCount === 'number' ? detail.reopenCount : 0,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/**
 * Incidents, newest first. With `operations.view` every incident matches the
 * filters; otherwise only the actor's own, or those of an area the actor can
 * view when `areaKey` is given.
 */
export async function listIncidents(
  actor: CurrentUser,
  filters: IncidentFilters = {}
): Promise<IncidentPage> {
  const parsed = incidentFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    throw new OperationsError(
      'invalid_payload',
      `Filtros inválidos: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'filtros'}: ${issue.message}`)
        .join('; ')}`
    );
  }
  const f = parsed.data;
  const and: Prisma.IncidentWhereInput[] = [];
  const viewer = hasPermission(actor, VIEW_PERMISSION);
  const areaAccess = !viewer && f.areaKey ? await canViewArea(actor, f.areaKey) : false;
  if (f.mine || (!viewer && !areaAccess)) and.push({ ownerUserId: actor.id });
  if (f.status?.length) and.push({ status: { in: f.status } });
  else if (f.scope === 'open') and.push({ status: { in: [...OPEN_STATUSES] } });
  else if (f.scope === 'closed') and.push({ status: { in: ['resolved', 'dismissed'] } });
  if (f.severity?.length) and.push({ severity: { in: f.severity } });
  if (f.kind?.length) and.push({ kind: { in: f.kind } });
  if (f.areaKey) and.push({ areaKey: f.areaKey });
  if (f.caseId) and.push({ caseId: f.caseId });
  if (f.ownerUserId) and.push({ ownerUserId: f.ownerUserId });
  const keyset = keysetCondition('openedAt', 'desc', decodeListCursor(f.cursor));
  if (keyset) and.push(keyset as Prisma.IncidentWhereInput);

  const rows = await prisma.incident.findMany({
    where: { AND: and },
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    take: f.limit + 1,
  });
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return {
    items: await toIncidentDTOs(page),
    nextCursor: rows.length > f.limit && last ? encodeListCursor(last.openedAt, last.id) : null,
  };
}

/** One incident with the actor's permissions (`operations.view`, owner, case owner or area viewer). */
export async function getIncident(
  actor: CurrentUser,
  incidentId: string
): Promise<IncidentDetailDTO> {
  const notFound = () => new OperationsError('not_found', 'No se encontró la incidencia');
  const row = await prisma.incident.findUnique({ where: { id: incidentId } });
  if (!row) throw notFound();
  let allowed = hasPermission(actor, VIEW_PERMISSION) || row.ownerUserId === actor.id;
  if (!allowed && row.caseId) {
    const operationalCase = await prisma.operationalCase.findUnique({
      where: { id: row.caseId },
      select: { ownerUserId: true },
    });
    allowed = operationalCase?.ownerUserId === actor.id;
  }
  if (!allowed) allowed = await canViewArea(actor, row.areaKey);
  if (!allowed) throw notFound();

  const [dto] = await toIncidentDTOs([row]);
  const canHandle =
    hasPermission(actor, MANAGE_PERMISSION) ||
    Boolean(row.ownerUserId && row.ownerUserId === actor.id);
  return {
    ...dto,
    permissions: {
      canAcknowledge: canHandle && nextIncidentStatus('acknowledge', row.status) !== null,
      canResolve: canHandle && nextIncidentStatus('resolve', row.status) !== null,
      canDismiss: canHandle && nextIncidentStatus('dismiss', row.status) !== null,
    },
  };
}
