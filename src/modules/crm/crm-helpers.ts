import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import {
  executeCommand,
  OperationsError,
  versionedAggregate,
  type CommandContext,
  type CommandResult,
  type DomainCommand,
} from '@/modules/operations/commands';
import { httpStatusForCode } from '@/modules/operations/errors';
import { CRM_OBJECT_TYPES, CRM_SYSTEM_ACTOR_ID } from './types';

/**
 * Shared plumbing of the CRM services: command execution with the uniform
 * `fn(actor, input, opts)` signature, version adapters, errors, visibility and
 * small conversions. No command is registered here (no import cycles).
 */

export const opportunityAggregate = versionedAggregate(CRM_OBJECT_TYPES.opportunity, 'opportunity');
export const radarSignalAggregate = versionedAggregate(CRM_OBJECT_TYPES.radarSignal, 'radarSignal');

export interface CrmCommandOptions {
  /** Client-generated id (offline queue, approved proposal); a new UUID otherwise. */
  commandId?: string;
  expectedVersion?: number;
  deviceId?: string;
  occurredAt?: string;
  /** Server clock (tests). */
  now?: Date;
}

/** Error of a CRM service outside a command (Spanish message, HTTP status). */
export class CrmError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'CrmError';
  }
}

export function isCrmError(error: unknown): error is CrmError {
  return error instanceof CrmError;
}

/** `ai` for bot identities, `user` for people. */
export function crmActorType(actor: Pick<CurrentUser, 'isBot'>): 'user' | 'ai' {
  return actor.isBot === true ? 'ai' : 'user';
}

export function runCrmCommand<D>(
  actor: CurrentUser,
  type: string,
  aggregate: { type: string; id: string },
  payload: unknown,
  options: CrmCommandOptions = {}
): Promise<CommandResult<D>> {
  return executeCommand<D>(
    {
      commandId: options.commandId ?? randomUUID(),
      type,
      actor: { type: crmActorType(actor), id: actor.id },
      aggregate,
      expectedVersion: options.expectedVersion,
      payload,
      deviceId: options.deviceId,
      occurredAt: options.occurredAt,
    },
    actor,
    options.now ? { now: options.now } : {}
  );
}

/** Jobs and internal reactions: a `system` command with a deterministic id. */
export function runCrmSystemCommand<D>(
  type: string,
  aggregate: { type: string; id: string },
  payload: unknown,
  commandId: string,
  options: { now?: Date } = {}
): Promise<CommandResult<D>> {
  return executeCommand<D>(
    { commandId, type, actor: { type: 'system', id: CRM_SYSTEM_ACTOR_ID }, aggregate, payload },
    null,
    options.now ? { now: options.now } : {}
  );
}

/** Returns the data of a completed command or throws its Spanish rejection as `CrmError`. */
export function unwrapCrmResult<D>(result: CommandResult<D>): D {
  if (result.status === 'rejected') {
    const code = result.errorCode ?? 'rejected';
    throw new CrmError(result.message ?? 'La operación fue rechazada', code, httpStatusForCode(code));
  }
  if (result.status === 'accepted') {
    throw new CrmError('La operación ya se está procesando; revisa en unos segundos', 'in_progress', 409);
  }
  return result.data as D;
}

export function assertCrmPermission(user: CurrentUser, permissionKey: string): void {
  if (!hasPermission(user, permissionKey)) {
    throw new CrmError('No tienes permisos para realizar esta acción', 'forbidden', 403);
  }
}

/** Sees every salesperson's opportunities and signals (otherwise only their own). */
export function canSeeAllCrm(user: CurrentUser): boolean {
  return user.isSuperAdmin || hasPermission(user, 'crm.manage');
}

/** People see their own and unassigned radar signals; `crm.manage` and AI identities see all. */
export function isSignalVisibleTo(user: CurrentUser, signal: { salespersonUserId: string | null }): boolean {
  if (user.isBot === true || canSeeAllCrm(user)) return true;
  return signal.salespersonUserId === null || signal.salespersonUserId === user.id;
}

/** Prisma filter equivalent to `isSignalVisibleTo`. */
export function visibleSignalsWhere(user: CurrentUser): Prisma.RadarSignalWhereInput {
  if (user.isBot === true || canSeeAllCrm(user)) return {};
  return { OR: [{ salespersonUserId: user.id }, { salespersonUserId: null }] };
}

/** Person or bot behind a command; null for system actors. */
export function commandUserId(ctx: Pick<CommandContext, 'actor'>): string | null {
  return ctx.actor.type === 'user' || ctx.actor.type === 'ai' ? ctx.actor.id : null;
}

export function assertAggregateTarget(cmd: DomainCommand<unknown>, id: string, label = 'registro'): void {
  if (cmd.aggregate.id !== id) {
    throw new OperationsError('invalid_payload', `El ${label} no corresponde al registro del comando`);
  }
}

export function toDecimal(value: number | null | undefined): Prisma.Decimal | null {
  return value === null || value === undefined ? null : new Prisma.Decimal(value);
}

export function decimalString(value: Prisma.Decimal | number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Prisma.Decimal ? value.toString() : String(value);
}

export function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Base64url cursor over a JSON tuple. */
export function encodeCursor(parts: ReadonlyArray<string | number>): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): Array<string | number> | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(parsed) && parsed.every((part) => typeof part === 'string' || typeof part === 'number')
      ? (parsed as Array<string | number>)
      : null;
  } catch {
    return null;
  }
}

/** Names of users by id (missing ids are skipped). */
export async function loadUserNames(
  db: Pick<Prisma.TransactionClient, 'user'>,
  ids: ReadonlyArray<string | null | undefined>
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((row) => [row.id, row.name]));
}
