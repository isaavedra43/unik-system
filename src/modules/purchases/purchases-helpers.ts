import { Prisma } from '@prisma/client';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { isNotificationCategory, type NotificationCategory } from '@/modules/notifications/catalog';
import type { CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { isOpsFlagEnabled } from '@/modules/operations/operations-config';
import { nextNumber } from '@/modules/operations/sequence-service';
import {
  PURCHASES_AREA_KEY,
  PURCHASES_BOARD_CHANNEL,
  PURCHASES_REALTIME_TYPE,
  PURCHASES_SEQUENCES,
  SUPPLIER_CHANNEL_TYPES,
  type SupplierChannelType,
} from './purchases-types';

/**
 * Small shared helpers of the purchases services (inside commands): module
 * flag, actor checks, folios, numbers, events on the Compras area and the
 * realtime board.
 */

export type Db = Prisma.TransactionClient;

export const MODULE_DISABLED_MESSAGE = 'El módulo de compras está desactivado';

export function D(value: Prisma.Decimal.Value | null | undefined): Prisma.Decimal {
  if (value === null || value === undefined || value === '') return new Prisma.Decimal(0);
  return new Prisma.Decimal(value);
}

export function num(value: Prisma.Decimal.Value | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(typeof value === 'object' ? value.toString() : value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function numOrNull(value: Prisma.Decimal.Value | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(typeof value === 'object' ? value.toString() : value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Decimal → string with at most 4 decimals ("12.5", "0"). */
export function decText(value: Prisma.Decimal.Value | null | undefined): string {
  return D(value).toDecimalPlaces(4).toString();
}

export function decTextOrNull(value: Prisma.Decimal.Value | null | undefined): string | null {
  return value === null || value === undefined ? null : decText(value);
}

export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function truncate(text: string | null | undefined, max: number): string {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function assertPurchasesEnabled(): Promise<void> {
  if (!(await isOpsFlagEnabled('purchases'))) {
    throw new OperationsError('module_disabled', MODULE_DISABLED_MESSAGE);
  }
}

/** Session user of a user/ai command. */
export function commandUser(ctx: Pick<CommandContext, 'user'>): CurrentUser {
  if (!ctx.user)
    throw new OperationsError('unauthenticated', 'Tu sesión expiró; vuelve a iniciar sesión');
  return ctx.user;
}

/** System and Zoho actors are trusted; people and AI identities need one of the keys. */
export function actorHasAny(
  ctx: Pick<CommandContext, 'actor' | 'user'>,
  keys: readonly string[]
): boolean {
  if (ctx.actor.type === 'system' || ctx.actor.type === 'zoho') return true;
  const user = ctx.user;
  if (!user) return false;
  return keys.some((key) => hasPermission(user, key));
}

export function assertActorHasAny(
  ctx: Pick<CommandContext, 'actor' | 'user'>,
  keys: readonly string[],
  message = 'No tienes permisos para realizar esta acción'
): void {
  if (!actorHasAny(ctx, keys)) throw new OperationsError('forbidden', message);
}

/** User id to store in `createdByUserId`-like columns: the person or bot, `system:{id}` otherwise. */
export function recordActorId(ctx: Pick<CommandContext, 'actor'>): string {
  return ctx.actor.type === 'user' || ctx.actor.type === 'ai'
    ? ctx.actor.id
    : `system:${ctx.actor.id}`.slice(0, 120);
}

/** Human (or bot) user id of the actor, null for system/Zoho. */
export function actorUserId(ctx: Pick<CommandContext, 'actor'>): string | null {
  return ctx.actor.type === 'user' || ctx.actor.type === 'ai' ? ctx.actor.id : null;
}

export async function nextFolio(tx: Db, kind: keyof typeof PURCHASES_SEQUENCES): Promise<string> {
  const sequence = PURCHASES_SEQUENCES[kind];
  return nextNumber(tx, sequence.key, sequence.prefix);
}

/**
 * Category every Compras notification uses, so a person turns purchases on or
 * off apart from the rest of the engine (plan 6.6). The catalogue is the source
 * of truth; the fallback only survives a catalogue that dropped the key.
 */
export function purchaseNotificationCategory(): NotificationCategory {
  return isNotificationCategory('purchase_update') ? 'purchase_update' : 'ops_workitem';
}

export interface PurchasesEventOptions {
  caseId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
}

/** Event of the Compras area. */
export function emitPurchases(
  ctx: CommandContext,
  type: string,
  payload: Record<string, unknown>,
  options: PurchasesEventOptions = {}
): void {
  ctx.emit(type, payload, {
    caseId: options.caseId ?? null,
    areaKey: PURCHASES_AREA_KEY,
    objectType: options.objectType ?? null,
    objectId: options.objectId ?? null,
  });
}

/** Realtime message on `purchases:board` (published after the commit). */
export function publishBoard(ctx: CommandContext, payload: Record<string, unknown>): void {
  ctx.realtime(PURCHASES_BOARD_CHANNEL, PURCHASES_REALTIME_TYPE, {
    commandId: ctx.commandId,
    commandType: ctx.commandType,
    ...payload,
  });
}

export interface SupplierChannel {
  type: SupplierChannelType;
  value: string;
}

export function parseChannels(value: unknown): SupplierChannel[] {
  if (!Array.isArray(value)) return [];
  const out: SupplierChannel[] = [];
  for (const entry of value) {
    const row = asRecord(entry);
    const type = row.type;
    const text = typeof row.value === 'string' ? row.value.trim() : '';
    if (
      typeof type !== 'string' ||
      !(SUPPLIER_CHANNEL_TYPES as readonly string[]).includes(type) ||
      !text
    )
      continue;
    if (out.some((c) => c.type === type && c.value === text)) continue;
    out.push({ type: type as SupplierChannelType, value: text.slice(0, 300) });
  }
  return out.slice(0, 20);
}

export function assertFoundRow<T>(row: T | null | undefined, message: string): T {
  if (!row) throw new OperationsError('not_found', message);
  return row;
}

export function throwCheck(
  check: { ok: true } | { ok: false; code: string; message: string }
): void {
  if (!check.ok) throw new OperationsError(check.code, check.message);
}
