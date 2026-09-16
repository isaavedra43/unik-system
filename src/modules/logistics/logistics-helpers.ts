import { z } from 'zod';
import { Prisma, type DeliveryOrder, type Trip, type TripStop } from '@prisma/client';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { isNotificationCategory, type NotificationCategory } from '@/modules/notifications/catalog';
import { OperationsError, type CommandContext } from '@/modules/operations/commands';
import { toOperationalJson } from '@/modules/operations/events-service';
import { isOpsFlagEnabled } from '@/modules/operations/operations-config';
import {
  AREA_REQUEST_OPEN_STATUSES,
  OPS_EVENTS,
  WORK_ITEM_OPEN_STATUSES,
} from '@/modules/operations/types';
import { parseDay } from './fleet-rules';
import { LOGISTICS_OBJECT_TYPES, LOGISTICS_REALTIME } from './types';

/**
 * Shared server helpers of the logistics services: Decimal/date parsing,
 * domain errors with stable codes, loaders, version-guarded writes on rows
 * that are not the command aggregate, closing of work items and area requests
 * tied to a delivery order, driver/dispatcher authorization and realtime.
 */

export type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const LOGISTICS_ERROR_HTTP_STATUS = {
  module_disabled: 409,
  package_missing: 409,
  allocation_in_delivery: 409,
  evidence_required: 422,
  evidence_invalid: 422,
  invalid_quantity: 422,
  nothing_delivered: 422,
  capacity_exceeded: 422,
  fleet_unavailable: 409,
  duplicate_code: 409,
  driver_user_taken: 409,
  in_use: 409,
  stops_pending: 409,
  /** `trip.cancel` on a trip that already delivered something: it is closed, not cancelled. */
  trip_has_deliveries: 409,
} as const;

export type LogisticsErrorCode = keyof typeof LOGISTICS_ERROR_HTTP_STATUS;

export function logisticsError(
  code: LogisticsErrorCode,
  message: string,
  details?: Record<string, unknown>
): OperationsError {
  return new OperationsError(code, message, {
    httpStatus: LOGISTICS_ERROR_HTTP_STATUS[code],
    details,
  });
}

/** HTTP status of a logistics rejection code (core codes are resolved by `httpStatusForCode`). */
export function logisticsHttpStatus(code: string | undefined): number | null {
  if (!code) return null;
  return (LOGISTICS_ERROR_HTTP_STATUS as Record<string, number>)[code] ?? null;
}

export async function assertLogisticsEnabled(): Promise<void> {
  if (!(await isOpsFlagEnabled('logistics'))) {
    throw logisticsError(
      'module_disabled',
      'El módulo de Logística está apagado en la configuración de Operaciones'
    );
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export function toNumber(
  value: Prisma.Decimal | number | string | null | undefined
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = typeof value === 'string' ? Number(value) : value.toNumber();
  return Number.isFinite(parsed) ? parsed : null;
}

export function toNumberOrZero(value: Prisma.Decimal | number | string | null | undefined): number {
  return toNumber(value) ?? 0;
}

/** Decimal(18,4) from a JS number. */
export function toDecimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value.toFixed(4));
}

export function requireDay(day: string, field = 'la fecha'): Date {
  const date = parseDay(day);
  if (!date) throw new OperationsError('invalid_payload', `Revisa ${field} (formato AAAA-MM-DD)`);
  return date;
}

export function parseInstant(value: string | null | undefined, field = 'la hora'): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new OperationsError('invalid_payload', `Revisa ${field} (fecha y hora ISO)`);
  }
  return date;
}

/** Planned trips start at 08:00 in Mexico City (UTC−6, no daylight saving since 2022). */
export function defaultTripStart(day: string): Date {
  return new Date(`${day}T08:00:00-06:00`);
}

export function jsonOrDbNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : toOperationalJson(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const idText = z.string().trim().min(1).max(120);
export const dayText = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');
export const instantText = z
  .string()
  .trim()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Fecha y hora inválidas (ISO)');
export const latitude = z.number().finite().min(-90).max(90);
export const longitude = z.number().finite().min(-180).max(180);

// ---------------------------------------------------------------------------
// shipmentInput
// ---------------------------------------------------------------------------

const shipmentInputRecordSchema = z.object({
  carrier: z.string().min(1),
  shipmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  trackingNumber: z.string().nullable().default(null),
  requestKey: z.string().min(1),
  requestedByUserId: z.string().nullable().default(null),
  requestedAt: z.string().nullable().default(null),
});

/** What `assignTransport` stored in `DeliveryOrder.shipmentInput`. */
export type ShipmentInputRecord = z.infer<typeof shipmentInputRecordSchema>;

export function readShipmentInput(value: unknown): ShipmentInputRecord | null {
  const parsed = shipmentInputRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Loaders and guarded writes
// ---------------------------------------------------------------------------

export async function loadDeliveryOrder(tx: Tx, id: string): Promise<DeliveryOrder> {
  const order = await tx.deliveryOrder.findUnique({ where: { id } });
  if (!order) throw new OperationsError('not_found', 'No se encontró la orden de entrega');
  return order;
}

export async function loadTrip(tx: Tx, id: string): Promise<Trip> {
  const trip = await tx.trip.findUnique({ where: { id } });
  if (!trip) throw new OperationsError('not_found', 'No se encontró el viaje');
  return trip;
}

export async function loadStop(tx: Tx, tripId: string, stopId: string): Promise<TripStop> {
  const stop = await tx.tripStop.findUnique({ where: { id: stopId } });
  if (!stop || stop.tripId !== tripId) {
    throw new OperationsError('not_found', 'No se encontró la parada en este viaje');
  }
  return stop;
}

/**
 * Update of a delivery order that is NOT the aggregate of the running command
 * (trips, stops): guarded by its version and bumping it, so a concurrent
 * command on the order is rejected instead of silently overwritten.
 */
export async function bumpDeliveryOrder(
  tx: Tx,
  order: Pick<DeliveryOrder, 'id' | 'version'>,
  data: Prisma.DeliveryOrderUpdateManyMutationInput,
  extraWhere: Prisma.DeliveryOrderWhereInput = {}
): Promise<DeliveryOrder> {
  const res = await tx.deliveryOrder.updateMany({
    where: { ...extraWhere, id: order.id, version: order.version },
    data: { ...data, version: { increment: 1 } },
  });
  if (res.count !== 1) {
    throw new OperationsError(
      'concurrency_conflict',
      'La orden de entrega cambió mientras se registraba; recarga e intenta de nuevo'
    );
  }
  return loadDeliveryOrder(tx, order.id);
}

/** "EXP-000123 · SO-00045" for titles; falls back to the case id. */
export async function caseReference(tx: Tx, caseId: string): Promise<string> {
  const found = await tx.operationalCase.findUnique({
    where: { id: caseId },
    select: { caseNumber: true, salesOrderNumber: true },
  });
  if (!found) return caseId;
  return found.salesOrderNumber
    ? `${found.caseNumber} · ${found.salesOrderNumber}`
    : found.caseNumber;
}

// ---------------------------------------------------------------------------
// Notifications (plan 6.6: `delivery_update`)
// ---------------------------------------------------------------------------

/**
 * Category every Logística notification uses, so a person turns deliveries on
 * or off apart from the rest of the engine (plan 6.6). The catalogue is the
 * source of truth; the fallback only survives a catalogue that dropped the key.
 */
export function deliveryNotificationCategory(): NotificationCategory {
  return isNotificationCategory('delivery_update') ? 'delivery_update' : 'ops_workitem';
}

/** Expediente 360 of the case: where the owner sees the delivery and its evidence. */
export function caseUrl(caseId: string): string {
  return `/app/operations/cases/${caseId}`;
}

export interface DeliveryNotice {
  /** Fine-grained type inside the category (`delivery_dispatched`, `delivery_confirmed`…). */
  type: string;
  /** Title, or a builder that receives «EXP-000123 · SO-00045». */
  title: string | ((ref: string) => string);
  body?: string | null;
  url?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Idempotency across retries of the same movement. */
  dedupeKey?: string | null;
}

/**
 * Tells the owner of the expediente that one of their deliveries moved
 * (plan 6.6: "viajes que salen, paradas entregadas, entregas con conflicto o
 * reprogramadas"). One read of the case gives both the recipient and the
 * reference used in the title.
 *
 * `ctx.notify` never notifies the actor, so the chofer who closes a stop does
 * not get a notice about their own tap; a system actor (Zoho jobs) has no user
 * id, so the owner is always told about a conflict.
 */
export async function notifyDeliveryUpdate(
  ctx: CommandContext,
  caseId: string | null | undefined,
  notice: DeliveryNotice
): Promise<string | null> {
  if (!caseId) return null;
  const found = await ctx.tx.operationalCase.findUnique({
    where: { id: caseId },
    select: { ownerUserId: true, caseNumber: true, salesOrderNumber: true },
  });
  const owner = found?.ownerUserId ?? null;
  // `system:{id}` owners are not people: nobody to notify.
  if (!owner || owner.includes(':')) return null;
  const ref = found?.salesOrderNumber
    ? `${found.caseNumber} · ${found.salesOrderNumber}`
    : (found?.caseNumber ?? caseId);
  ctx.notify({
    userId: owner,
    category: deliveryNotificationCategory(),
    type: notice.type,
    title: (typeof notice.title === 'function' ? notice.title(ref) : notice.title).slice(0, 200),
    body: notice.body ?? null,
    url: notice.url ?? caseUrl(caseId),
    entityType: notice.entityType ?? LOGISTICS_OBJECT_TYPES.deliveryOrder,
    entityId: notice.entityId ?? null,
    ...(notice.dedupeKey ? { dedupeKey: notice.dedupeKey } : {}),
  });
  return owner;
}

// ---------------------------------------------------------------------------
// Work items and area requests tied to an object
// ---------------------------------------------------------------------------

export function actorUserId(ctx: CommandContext): string | null {
  return ctx.actor.type === 'user' || ctx.actor.type === 'ai' ? ctx.actor.id : null;
}

/** Closes the open work items of an object; returns how many were closed. */
export async function closeOpenWorkItems(
  ctx: CommandContext,
  filter: { objectType: string; objectId: string; kinds?: string[]; areaKey?: string },
  outcome: { status: 'done' | 'cancelled'; result: Record<string, unknown> }
): Promise<number> {
  const items = await ctx.tx.workItem.findMany({
    where: {
      objectType: filter.objectType,
      objectId: filter.objectId,
      status: { in: [...WORK_ITEM_OPEN_STATUSES] },
      ...(filter.kinds ? { kind: { in: filter.kinds } } : {}),
      ...(filter.areaKey ? { areaKey: filter.areaKey } : {}),
    },
  });
  for (const item of items) {
    await ctx.tx.workItem.update({
      where: { id: item.id },
      data: {
        status: outcome.status,
        completedAt: ctx.now,
        completedBy: ctx.actor.id,
        result: toOperationalJson({ ...outcome.result, commandId: ctx.commandId }),
        version: { increment: 1 },
      },
    });
    ctx.emit(
      outcome.status === 'done' ? OPS_EVENTS.workitem.completed : OPS_EVENTS.workitem.cancelled,
      { workItemId: item.id, kind: item.kind, title: item.title, ...outcome.result },
      { caseId: item.caseId, areaKey: item.areaKey, objectType: 'work_item', objectId: item.id }
    );
  }
  return items.length;
}

/** Resolves or cancels the open area requests of an object (and their work items). */
export async function closeOpenAreaRequests(
  ctx: CommandContext,
  filter: { objectType: string; objectId: string; kind?: string },
  outcome: { status: 'resolved' | 'cancelled'; answer: Record<string, unknown> }
): Promise<number> {
  const requests = await ctx.tx.areaRequest.findMany({
    where: {
      objectType: filter.objectType,
      objectId: filter.objectId,
      status: { in: [...AREA_REQUEST_OPEN_STATUSES] },
      ...(filter.kind ? { kind: filter.kind } : {}),
    },
  });
  for (const request of requests) {
    await ctx.tx.areaRequest.update({
      where: { id: request.id },
      data: {
        status: outcome.status,
        answer: toOperationalJson(outcome.answer),
        answeredAt: outcome.status === 'resolved' ? ctx.now : request.answeredAt,
        closedAt: ctx.now,
        version: { increment: 1 },
      },
    });
    ctx.emit(
      outcome.status === 'resolved' ? OPS_EVENTS.request.resolved : OPS_EVENTS.request.cancelled,
      { requestId: request.id, kind: request.kind, ...outcome.answer },
      {
        caseId: request.caseId,
        areaKey: request.toAreaKey,
        objectType: 'area_request',
        objectId: request.id,
      }
    );
    await closeOpenWorkItems(
      ctx,
      { objectType: 'area_request', objectId: request.id },
      {
        status: outcome.status === 'resolved' ? 'done' : 'cancelled',
        result: { requestStatus: outcome.status },
      }
    );
  }
  return requests.length;
}

// ---------------------------------------------------------------------------
// Authorization inside handlers
// ---------------------------------------------------------------------------

/**
 * Whether the user is the driver of `driverId`: `logistics.drive` AND the active
 * `Driver` linked to their user. The one rule for commands, evidence files and
 * the `trip:{id}` realtime channel (a revoked permission revokes all of them).
 */
export async function isActiveDriverOf(
  db: Pick<Tx, 'driver'>,
  user: CurrentUser,
  driverId: string | null | undefined
): Promise<boolean> {
  if (!driverId || !hasPermission(user, 'logistics.drive')) return false;
  const driver = await db.driver.findUnique({
    where: { id: driverId },
    select: { userId: true, active: true },
  });
  return Boolean(driver?.active && driver.userId === user.id);
}

/**
 * Dispatchers (`logistics.dispatch`) operate any delivery or trip; drivers
 * (`logistics.drive`) only those assigned to the active `Driver` linked to
 * their user. System and Zoho actors are trusted (jobs, sweeps).
 */
export async function assertDriverOrDispatcher(
  ctx: CommandContext,
  driverId: string | null,
  action: string
): Promise<void> {
  if (ctx.actor.type === 'system' || ctx.actor.type === 'zoho') return;
  const user = ctx.user;
  if (!user)
    throw new OperationsError('unauthenticated', 'Tu sesión expiró; vuelve a iniciar sesión');
  if (hasPermission(user, 'logistics.dispatch')) return;
  if (await isActiveDriverOf(ctx.tx, user, driverId)) return;
  throw new OperationsError(
    'forbidden',
    `No puedes ${action}: sólo el chofer asignado o el personal de despacho`
  );
}

// ---------------------------------------------------------------------------
// Realtime (published after the commit by the engine)
// ---------------------------------------------------------------------------

export function publishDeliveryChange(
  ctx: CommandContext,
  order: Pick<DeliveryOrder, 'id' | 'caseId' | 'status' | 'zohoSyncState' | 'tripId'>
): void {
  const payload = {
    commandId: ctx.commandId,
    commandType: ctx.commandType,
    deliveryOrderId: order.id,
    caseId: order.caseId,
    status: order.status,
    zohoSyncState: order.zohoSyncState,
    tripId: order.tripId,
  };
  ctx.realtime(LOGISTICS_REALTIME.dispatchChannel, LOGISTICS_REALTIME.types.deliveries, payload);
  if (order.tripId) {
    ctx.realtime(
      LOGISTICS_REALTIME.tripChannel(order.tripId),
      LOGISTICS_REALTIME.types.deliveries,
      payload
    );
  }
}

export function publishTripChange(
  ctx: CommandContext,
  trip: Pick<Trip, 'id' | 'status' | 'number'>,
  extra: Record<string, unknown> = {}
): void {
  const payload = {
    commandId: ctx.commandId,
    commandType: ctx.commandType,
    tripId: trip.id,
    number: trip.number,
    status: trip.status,
    ...extra,
  };
  ctx.realtime(LOGISTICS_REALTIME.dispatchChannel, LOGISTICS_REALTIME.types.trips, payload);
  ctx.realtime(LOGISTICS_REALTIME.tripChannel(trip.id), LOGISTICS_REALTIME.types.trips, payload);
}

export const deliveryRef = (id: string) => ({ type: LOGISTICS_OBJECT_TYPES.deliveryOrder, id });
