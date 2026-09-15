import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { isKnownPermission } from '@/modules/auth/permissions';
import {
  executeCommand,
  type CommandContext,
  type CommandResult,
  type DomainCommand,
} from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { isOpsFlagEnabled } from '@/modules/operations/operations-config';
import type { ActorType } from '@/modules/operations/types';
import type { CashAccountRef, CategoryRef, CostCenterRef } from './expense-rules';
import { localDateKey } from './finance-dates';
import { FINANCE_AREA_KEY, FINANCE_BOARD_CHANNEL, FINANCE_SYSTEM_ACTOR_ID } from './types';

/**
 * Small shared helpers of the finance services (server side).
 */

export interface FinanceCommandOptions {
  commandId?: string;
  expectedVersion?: number;
  now?: Date;
  deviceId?: string;
  occurredAt?: string;
}

/** Rejects user commands while the `finance` flag (or the whole core) is off. */
export async function assertFinanceEnabled(): Promise<void> {
  if (!(await isOpsFlagEnabled('finance'))) {
    throw new OperationsError('module_disabled', 'La contabilidad interna está desactivada');
  }
}

/** Skips the flag for system commands (jobs must be able to finish pending work). */
export async function assertFinanceEnabledFor(ctx: Pick<CommandContext, 'actor'>): Promise<void> {
  if (ctx.actor.type === 'system') return;
  await assertFinanceEnabled();
}

export function todayKeyOf(ctx: Pick<CommandContext, 'now'>): string {
  return localDateKey(ctx.now);
}

/** User id stored in `createdByUserId`/`postedByUserId`: the person or bot, or `system:finance`. */
export function actorUserIdOf(ctx: Pick<CommandContext, 'actor'>): string {
  if (ctx.actor.type === 'user' || ctx.actor.type === 'ai') return ctx.actor.id;
  return `system:${ctx.actor.id || FINANCE_SYSTEM_ACTOR_ID}`.slice(0, 120);
}

export function financeEventOptions(
  objectType: string,
  objectId: string,
  caseId?: string | null
): { caseId: string | null; areaKey: string; objectType: string; objectId: string } {
  return { caseId: caseId ?? null, areaKey: FINANCE_AREA_KEY, objectType, objectId };
}

export function publishBoard(ctx: Pick<CommandContext, 'realtime'>, type: string, payload: Record<string, unknown>): void {
  ctx.realtime(FINANCE_BOARD_CHANNEL, type, payload);
}

export function hasFinancePermission(user: CurrentUser | null | undefined, key: string): boolean {
  if (!user || !isKnownPermission(key)) return false;
  return hasPermission(user, key);
}

export function assertAggregateTarget(cmd: Pick<DomainCommand<unknown>, 'aggregate'>, id: string, label: string): void {
  if (cmd.aggregate.id !== id) {
    throw new OperationsError('invalid_payload', `${label} no corresponde al registro del comando`);
  }
}

export interface CatalogRefs {
  categories: CategoryRef[];
  costCenters: CostCenterRef[];
  cashAccounts: CashAccountRef[];
  categoriesById: Map<string, CategoryRef>;
  costCentersById: Map<string, CostCenterRef>;
  cashAccountsById: Map<string, CashAccountRef>;
}

type CatalogDb = Pick<Prisma.TransactionClient, 'financeCategory' | 'costCenter' | 'cashAccount'>;

export async function loadCatalogRefs(db: CatalogDb): Promise<CatalogRefs> {
  const [categories, costCenters, cashAccounts] = await Promise.all([
    db.financeCategory.findMany({
      select: { id: true, key: true, name: true, kind: true, status: true, defaultCostCenterId: true },
      orderBy: { key: 'asc' },
    }),
    db.costCenter.findMany({
      select: { id: true, key: true, name: true, areaKey: true, status: true },
      orderBy: { key: 'asc' },
    }),
    db.cashAccount.findMany({
      select: { id: true, key: true, name: true, status: true, currency: true },
      orderBy: { key: 'asc' },
    }),
  ]);
  return {
    categories,
    costCenters,
    cashAccounts,
    categoriesById: new Map(categories.map((c) => [c.id, c])),
    costCentersById: new Map(costCenters.map((c) => [c.id, c])),
    cashAccountsById: new Map(cashAccounts.map((c) => [c.id, c])),
  };
}

/** Loads the finance command catalog (lazy: services call it before executing by type). */
export async function ensureFinanceCommands(): Promise<void> {
  await import('./finance-commands');
}

export interface RunFinanceCommandInput {
  type: string;
  aggregate: { type: string; id: string };
  payload: unknown;
  actorType?: ActorType;
}

/** Executes a finance command as `actor` (a person, or a bot as `ai`). */
export async function runFinanceCommand<D>(
  actor: CurrentUser,
  input: RunFinanceCommandInput,
  options: FinanceCommandOptions = {}
): Promise<CommandResult<D>> {
  await ensureFinanceCommands();
  return executeCommand<D>(
    {
      commandId: options.commandId ?? randomUUID(),
      type: input.type,
      actor: { type: input.actorType ?? (actor.isBot === true ? 'ai' : 'user'), id: actor.id },
      aggregate: input.aggregate,
      expectedVersion: options.expectedVersion,
      payload: input.payload,
      deviceId: options.deviceId,
      occurredAt: options.occurredAt,
    },
    actor,
    { now: options.now }
  );
}

/** Executes a finance command as the finance system actor (jobs, reactions). */
export async function runFinanceSystemCommand<D>(
  input: Omit<RunFinanceCommandInput, 'actorType'> & { commandId: string },
  options: { now?: Date } = {}
): Promise<CommandResult<D>> {
  await ensureFinanceCommands();
  return executeCommand<D>(
    {
      commandId: input.commandId,
      type: input.type,
      actor: { type: 'system', id: FINANCE_SYSTEM_ACTOR_ID },
      aggregate: input.aggregate,
      payload: input.payload,
    },
    null,
    { now: options.now }
  );
}

export function newRowId(): string {
  return `fin_${randomUUID().replace(/-/g, '')}`;
}

export function requireFound<T>(row: T | null | undefined, message: string): T {
  if (row === null || row === undefined) throw new OperationsError('not_found', message);
  return row;
}
