import { z } from 'zod';
import type { DeliveryOrder, Trip, TripStop, Vehicle } from '@prisma/client';
import { hasPermission } from '@/modules/auth/authorization';
import {
  OperationsError,
  requireCommandContext,
  type CommandContext,
  type CommandHandlerOutput,
} from '@/modules/operations/commands';
import { nextNumber } from '@/modules/operations/sequence-service';
import { OPS_EVENTS } from '@/modules/operations/types';
import { expectedQuantity } from './delivery-rules';
import {
  deliveryRecordFieldsSchema,
  recordDelivery,
  type RecordDeliveryResult,
} from './delivery-service';
import { assertFleetAvailable } from './fleet-service';
import { assertPackageForDispatch, ensureShipmentForDispatch } from './transport-service';
import { formatDay } from './fleet-rules';
import {
  assertDriverOrDispatcher,
  bumpDeliveryOrder,
  caseReference,
  dayText,
  defaultTripStart,
  idText,
  instantText,
  latitude,
  loadDeliveryOrder,
  loadStop,
  loadTrip,
  logisticsError,
  longitude,
  parseInstant,
  publishDeliveryChange,
  publishTripChange,
  requireDay,
  toNumber,
  toNumberOrZero,
  type Tx,
} from './logistics-helpers';
import {
  computeEtas,
  haversineKm,
  isValidPoint,
  planRoute,
  type LoadLine,
  type RouteStopInput,
  type RouteViolation,
} from './route-rules';
import {
  LOGISTICS_EVENTS,
  LOGISTICS_OBJECT_TYPES,
  TRIP_ACTIVE_STATUSES,
  TRIP_ELIGIBLE_STATUSES,
  TRIP_STOP_OPEN_STATUSES,
} from './types';

/**
 * Trips of the own fleet (plan section 6.3): build with route rules, add and
 * reorder stops, start, arrive (GPS), complete (records the delivery), fail
 * and close. The aggregate of every trip command except `trip.build` is the
 * trip (its version is bumped by the engine); delivery orders touched from a
 * trip are updated with a version guard.
 */

const TRIP = LOGISTICS_OBJECT_TYPES.trip;
const ORDER = LOGISTICS_OBJECT_TYPES.deliveryOrder;

// ---------------------------------------------------------------------------
// Schemas (the trip id travels as the command aggregate id)
// ---------------------------------------------------------------------------

export const buildTripSchema = z.object({
  date: dayText,
  vehicleId: idText,
  driverId: idText,
  deliveryOrderIds: z.array(idText).min(1).max(60),
  /** Warehouse coordinates; improves the stop order and ETAs. */
  origin: z.object({ lat: latitude, lng: longitude }).nullable().optional(),
  startAt: instantText.nullable().optional(),
  /** false keeps the given order. */
  optimize: z.boolean().default(true),
  /** Over capacity; requires `logistics.manage_fleet`. */
  overrideCapacity: z.boolean().default(false),
  notes: z.string().trim().max(1000).optional(),
});
export type BuildTripInput = z.infer<typeof buildTripSchema>;

export const addStopSchema = z.object({
  deliveryOrderId: idText,
  overrideCapacity: z.boolean().default(false),
});
export type AddStopInput = z.infer<typeof addStopSchema>;

export const reorderStopsSchema = z.object({ stopIds: z.array(idText).min(1).max(60) });
export type ReorderStopsInput = z.infer<typeof reorderStopsSchema>;

export const tripOnlySchema = z.object({});

export const arriveStopSchema = z.object({
  stopId: idText,
  lat: latitude.nullable().optional(),
  lng: longitude.nullable().optional(),
});
export type ArriveStopInput = z.infer<typeof arriveStopSchema>;

export const completeStopSchema = deliveryRecordFieldsSchema.extend({ stopId: idText });
export type CompleteStopInput = z.infer<typeof completeStopSchema>;

export const failStopSchema = z.object({
  stopId: idText,
  reason: z.string().trim().min(1, 'Indica por qué no se entregó').max(500),
  lat: latitude.nullable().optional(),
  lng: longitude.nullable().optional(),
});
export type FailStopInput = z.infer<typeof failStopSchema>;

type WithTrip<T> = T & { tripId: string };

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function stopInputOf(order: DeliveryOrder): RouteStopInput {
  return {
    id: order.id,
    lat: toNumber(order.lat),
    lng: toNumber(order.lng),
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
  };
}

function capacityOf(vehicle: Vehicle) {
  return {
    capacityKg: toNumber(vehicle.capacityKg),
    capacityM2: toNumber(vehicle.capacityM2),
    capacityPieces: vehicle.capacityPieces,
  };
}

/** What each order still carries, with the profile factors for kg / m². */
async function loadLines(tx: Tx, orders: DeliveryOrder[]): Promise<LoadLine[]> {
  const allocationIds = [...new Set(orders.flatMap((o) => o.allocationIds))];
  if (allocationIds.length === 0) return [];
  const allocations = await tx.demandAllocation.findMany({ where: { id: { in: allocationIds } } });
  const demands = await tx.caseDemand.findMany({
    where: { id: { in: [...new Set(allocations.map((a) => a.demandId))] } },
  });
  const itemIds = [
    ...new Set(demands.map((d) => d.zohoItemId).filter((id): id is string => Boolean(id))),
  ];
  const profiles = itemIds.length
    ? await tx.productInventoryProfile.findMany({ where: { zohoItemId: { in: itemIds } } })
    : [];
  const lines: LoadLine[] = [];
  for (const order of orders) {
    for (const allocationId of order.allocationIds) {
      const allocation = allocations.find((a) => a.id === allocationId);
      if (!allocation) continue;
      const demand = demands.find((d) => d.id === allocation.demandId);
      const profile = demand?.zohoItemId
        ? profiles.find((p) => p.zohoItemId === demand.zohoItemId)
        : undefined;
      lines.push({
        deliveryOrderId: order.id,
        label: demand?.sku || demand?.name || allocation.id,
        quantity: expectedQuantity({
          allocationId: allocation.id,
          demandId: allocation.demandId,
          quantity: toNumberOrZero(allocation.quantity),
          deliveredQuantity: toNumberOrZero(allocation.deliveredQuantity),
        }),
        unit: demand?.baseUnit ?? profile?.baseUnit ?? 'pz',
        weightKgPerUnit: toNumber(profile?.weightKgPerBaseUnit),
        areaM2PerUnit: toNumber(profile?.areaM2PerBaseUnit),
      });
    }
  }
  return lines;
}

async function assertOrdersEligible(
  tx: Tx,
  orders: DeliveryOrder[],
  currentTripId?: string
): Promise<void> {
  for (const order of orders) {
    if (order.mode !== 'own_fleet') {
      throw new OperationsError(
        'invalid_state',
        'Sólo las entregas con flotilla propia van en un viaje',
        {
          details: { deliveryOrderId: order.id },
        }
      );
    }
    if (!(TRIP_ELIGIBLE_STATUSES as readonly string[]).includes(order.status)) {
      throw new OperationsError(
        'invalid_state',
        'Una de las entregas no se puede cargar en su estado actual',
        {
          details: { deliveryOrderId: order.id, status: order.status },
        }
      );
    }
  }
  const tripIds = [
    ...new Set(orders.map((o) => o.tripId).filter((id): id is string => Boolean(id))),
  ].filter((id) => id !== currentTripId);
  if (tripIds.length > 0) {
    const active = await tx.trip.findMany({
      where: { id: { in: tripIds }, status: { in: [...TRIP_ACTIVE_STATUSES] } },
      select: { id: true, number: true },
    });
    if (active.length > 0) {
      throw new OperationsError(
        'invalid_state',
        `Alguna entrega ya está en otro viaje activo (${active.map((t) => t.number).join(', ')})`,
        { details: { tripIds: active.map((t) => t.id) } }
      );
    }
  }
}

function assertCapacity(
  ctx: CommandContext,
  violations: RouteViolation[],
  override: boolean,
  load: unknown
): void {
  const errors = violations.filter((v) => v.severity === 'error');
  if (errors.length === 0) return;
  if (!override) {
    throw logisticsError('capacity_exceeded', errors.map((e) => e.message).join('; '), {
      violations,
      load,
    });
  }
  if (ctx.user && !hasPermission(ctx.user, 'logistics.manage_fleet')) {
    throw new OperationsError(
      'forbidden',
      'Sólo quien gestiona la flotilla puede cargar sobre la capacidad'
    );
  }
}

function assertTripStatus(trip: Trip, allowed: readonly string[], message: string): void {
  if (!allowed.includes(trip.status)) throw new OperationsError('invalid_state', message);
}

// ---------------------------------------------------------------------------
// buildTrip
// ---------------------------------------------------------------------------

export interface BuildTripResult {
  tripId: string;
  number: string;
  date: string;
  stops: Array<{ stopId: string; deliveryOrderId: string; sequence: number; etaAt: string | null }>;
  violations: RouteViolation[];
  load: { kg: number; m2: number; pieces: number };
  totalDistanceKm: number;
}

export async function buildTrip(
  tx: Tx,
  input: BuildTripInput
): Promise<CommandHandlerOutput<BuildTripResult>> {
  const ctx = requireCommandContext(tx);
  const day = requireDay(input.date, 'la fecha del viaje');
  const { vehicle, driver } = await assertFleetAvailable(tx, {
    vehicleId: input.vehicleId,
    driverId: input.driverId,
    day,
  });
  const ids = [...new Set(input.deliveryOrderIds)];
  const orders = await tx.deliveryOrder.findMany({ where: { id: { in: ids } } });
  if (orders.length !== ids.length) {
    throw new OperationsError('not_found', 'Alguna orden de entrega no existe');
  }
  await assertOrdersEligible(tx, orders);

  const lines = await loadLines(tx, orders);
  const startAt = parseInstant(input.startAt, 'la hora de salida') ?? defaultTripStart(input.date);
  const plan = planRoute({
    vehicle: capacityOf(vehicle),
    lines,
    stops: orders.map(stopInputOf),
    options: { origin: input.origin ?? null, startAt },
    keepOrder: !input.optimize,
  });
  assertCapacity(ctx, plan.violations, input.overrideCapacity, plan.load);

  const number = await nextNumber(tx, 'trip', 'VJ');
  const trip = await tx.trip.create({
    data: {
      number,
      date: day,
      vehicleId: vehicle.id,
      driverId: driver.id,
      status: 'planned',
      notes: input.notes ?? null,
    },
  });
  const stops: BuildTripResult['stops'] = [];
  for (const planned of plan.stops) {
    const order = orders.find((o) => o.id === planned.id)!;
    const stop = await tx.tripStop.create({
      data: {
        tripId: trip.id,
        deliveryOrderId: order.id,
        sequence: planned.sequence,
        status: 'pending',
        etaAt: planned.etaAt,
        lat: order.lat,
        lng: order.lng,
      },
    });
    const updated = await bumpDeliveryOrder(
      tx,
      order,
      { tripId: trip.id, vehicleId: vehicle.id, driverId: driver.id, plannedDate: day },
      { tripId: order.tripId }
    );
    await ctx.relate({ type: TRIP, id: trip.id }, { type: ORDER, id: order.id }, 'includes');
    publishDeliveryChange(ctx, updated);
    stops.push({
      stopId: stop.id,
      deliveryOrderId: order.id,
      sequence: stop.sequence,
      etaAt: stop.etaAt ? stop.etaAt.toISOString() : null,
    });
  }
  await ctx.relate(
    { type: TRIP, id: trip.id },
    { type: LOGISTICS_OBJECT_TYPES.vehicle, id: vehicle.id },
    'uses'
  );
  await ctx.relate(
    { type: TRIP, id: trip.id },
    { type: LOGISTICS_OBJECT_TYPES.driver, id: driver.id },
    'driven_by'
  );
  const load = { kg: plan.load.kg, m2: plan.load.m2, pieces: plan.load.pieces };
  ctx.emit(
    LOGISTICS_EVENTS.trip.built,
    {
      tripId: trip.id,
      number,
      date: input.date,
      vehicleId: vehicle.id,
      driverId: driver.id,
      deliveryOrderIds: stops.map((s) => s.deliveryOrderId),
      load,
      violations: plan.violations,
      totalDistanceKm: plan.totalDistanceKm,
      overrideCapacity: input.overrideCapacity && plan.blocking,
    },
    { areaKey: 'logistica', objectType: TRIP, objectId: trip.id }
  );
  publishTripChange(ctx, trip, { date: input.date });
  return {
    aggregateVersion: trip.version,
    data: {
      tripId: trip.id,
      number,
      date: formatDay(day),
      stops,
      violations: plan.violations,
      load,
      totalDistanceKm: plan.totalDistanceKm,
    },
  };
}

// ---------------------------------------------------------------------------
// addStop / reorderStops
// ---------------------------------------------------------------------------

async function ordersOfStops(tx: Tx, stops: TripStop[]): Promise<DeliveryOrder[]> {
  if (stops.length === 0) return [];
  const orders = await tx.deliveryOrder.findMany({
    where: { id: { in: stops.map((s) => s.deliveryOrderId) } },
  });
  return stops
    .map((stop) => orders.find((o) => o.id === stop.deliveryOrderId))
    .filter((o): o is DeliveryOrder => Boolean(o));
}

function etaStart(ctx: CommandContext, trip: Trip): Date {
  const planned = defaultTripStart(formatDay(trip.date));
  return trip.status === 'en_route' || planned.getTime() < ctx.now.getTime() ? ctx.now : planned;
}

export async function addStop(
  tx: Tx,
  input: WithTrip<AddStopInput>
): Promise<
  CommandHandlerOutput<{
    tripId: string;
    stopId: string;
    sequence: number;
    violations: RouteViolation[];
  }>
> {
  const ctx = requireCommandContext(tx);
  const trip = await loadTrip(tx, input.tripId);
  assertTripStatus(
    trip,
    TRIP_ACTIVE_STATUSES,
    'Sólo se agregan paradas a viajes planeados o en ruta'
  );
  const order = await loadDeliveryOrder(tx, input.deliveryOrderId);
  const stops = await tx.tripStop.findMany({
    where: { tripId: trip.id },
    orderBy: { sequence: 'asc' },
  });
  const existing = stops.find((s) => s.deliveryOrderId === order.id);
  if (existing && (TRIP_STOP_OPEN_STATUSES as readonly string[]).includes(existing.status)) {
    return {
      data: { tripId: trip.id, stopId: existing.id, sequence: existing.sequence, violations: [] },
    };
  }
  await assertOrdersEligible(tx, [order], trip.id);

  const openStops = stops.filter((s) =>
    (TRIP_STOP_OPEN_STATUSES as readonly string[]).includes(s.status)
  );
  const openOrders = await ordersOfStops(tx, openStops);
  const vehicle = await tx.vehicle.findUnique({ where: { id: trip.vehicleId } });
  if (!vehicle) throw new OperationsError('not_found', 'No se encontró el vehículo del viaje');
  const plan = planRoute({
    vehicle: capacityOf(vehicle),
    lines: await loadLines(tx, [...openOrders, order]),
    stops: [...openOrders, order].map(stopInputOf),
    options: { startAt: etaStart(ctx, trip) },
    keepOrder: true,
  });
  assertCapacity(ctx, plan.violations, input.overrideCapacity, plan.load);

  const sequence = stops.reduce((max, s) => Math.max(max, s.sequence), 0) + 1;
  const eta = plan.stops.find((s) => s.id === order.id)?.etaAt ?? null;
  const stop = existing
    ? await tx.tripStop.update({
        where: { id: existing.id },
        data: { status: 'pending', sequence, etaAt: eta, arrivedAt: null, departedAt: null },
      })
    : await tx.tripStop.create({
        data: {
          tripId: trip.id,
          deliveryOrderId: order.id,
          sequence,
          status: 'pending',
          etaAt: eta,
          lat: order.lat,
          lng: order.lng,
        },
      });
  // Loaded on a running trip: the order leaves now, so its Zoho shipment must exist.
  const loaded =
    trip.status === 'en_route' ? await ensureShipmentForDispatch(ctx, order, trip) : order;
  const dispatchNow =
    trip.status === 'en_route' &&
    ['pending', 'planned', 'assigned', 'failed'].includes(loaded.status);
  const updated = await bumpDeliveryOrder(
    tx,
    loaded,
    {
      tripId: trip.id,
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
      plannedDate: trip.date,
      ...(dispatchNow ? { status: 'dispatched' } : {}),
    },
    { tripId: order.tripId }
  );
  await ctx.relate({ type: TRIP, id: trip.id }, { type: ORDER, id: order.id }, 'includes');
  ctx.emit(
    LOGISTICS_EVENTS.trip.stopAdded,
    {
      tripId: trip.id,
      stopId: stop.id,
      deliveryOrderId: order.id,
      sequence,
      violations: plan.violations,
    },
    { caseId: order.caseId, areaKey: 'logistica', objectType: TRIP, objectId: trip.id }
  );
  if (dispatchNow) {
    ctx.emit(
      OPS_EVENTS.delivery.dispatched,
      { deliveryOrderId: order.id, tripId: trip.id },
      { caseId: order.caseId, areaKey: 'logistica', objectType: ORDER, objectId: order.id }
    );
  }
  publishDeliveryChange(ctx, updated);
  publishTripChange(ctx, trip);
  return { data: { tripId: trip.id, stopId: stop.id, sequence, violations: plan.violations } };
}

export async function reorderStops(
  tx: Tx,
  input: WithTrip<ReorderStopsInput>
): Promise<CommandHandlerOutput<{ tripId: string; stopIds: string[] }>> {
  const ctx = requireCommandContext(tx);
  const trip = await loadTrip(tx, input.tripId);
  assertTripStatus(trip, TRIP_ACTIVE_STATUSES, 'Sólo se reordenan viajes planeados o en ruta');
  const stops = await tx.tripStop.findMany({
    where: { tripId: trip.id },
    orderBy: { sequence: 'asc' },
  });
  const ids = input.stopIds;
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== stops.length ||
    !stops.every((s) => ids.includes(s.id))
  ) {
    throw new OperationsError(
      'invalid_payload',
      'La lista debe incluir cada parada del viaje exactamente una vez'
    );
  }
  const visited = stops.filter((s) => s.status !== 'pending').map((s) => s.id);
  const reordered = ids.map((id) => stops.find((s) => s.id === id)!);
  if (reordered.slice(0, visited.length).some((s, index) => s.id !== visited[index])) {
    throw new OperationsError('invalid_payload', 'Las paradas ya visitadas no se pueden mover');
  }
  const pending = reordered.slice(visited.length);
  const orders = await ordersOfStops(tx, pending);
  const etas = computeEtas(orders.map(stopInputOf), { startAt: etaStart(ctx, trip) });
  for (const [index, stop] of reordered.entries()) {
    const planned = etas.stops.find((s) => s.id === stop.deliveryOrderId);
    await tx.tripStop.update({
      where: { id: stop.id },
      data: {
        sequence: index + 1,
        ...(stop.status === 'pending' ? { etaAt: planned?.etaAt ?? null } : {}),
      },
    });
  }
  ctx.emit(
    LOGISTICS_EVENTS.trip.stopsReordered,
    { tripId: trip.id, stopIds: ids, violations: etas.violations },
    { areaKey: 'logistica', objectType: TRIP, objectId: trip.id }
  );
  publishTripChange(ctx, trip);
  return { data: { tripId: trip.id, stopIds: ids } };
}

// ---------------------------------------------------------------------------
// startTrip / arriveStop / completeStop / failStop / closeTrip
// ---------------------------------------------------------------------------

export async function startTrip(
  tx: Tx,
  input: { tripId: string }
): Promise<CommandHandlerOutput<{ tripId: string; status: string }>> {
  const ctx = requireCommandContext(tx);
  const trip = await loadTrip(tx, input.tripId);
  await assertDriverOrDispatcher(ctx, trip.driverId, 'iniciar este viaje');
  if (trip.status === 'en_route') return { data: { tripId: trip.id, status: trip.status } };
  assertTripStatus(trip, ['planned'], 'Sólo se inicia un viaje planeado');
  const stops = await tx.tripStop.findMany({
    where: { tripId: trip.id },
    orderBy: { sequence: 'asc' },
  });
  const open = stops.filter((s) =>
    (TRIP_STOP_OPEN_STATUSES as readonly string[]).includes(s.status)
  );
  if (open.length === 0)
    throw new OperationsError('invalid_state', 'El viaje no tiene paradas pendientes');

  const loadedOrders = await ordersOfStops(tx, open);
  // Checked before anything is written: the trip does not start with an order that cannot leave.
  for (const order of loadedOrders) assertPackageForDispatch(order);
  const updatedTrip = await tx.trip.update({
    where: { id: trip.id },
    data: { status: 'en_route', startedAt: ctx.now },
  });
  for (const loaded of loadedOrders) {
    // A shipping delivery leaves with its Zoho package and a shipment write queued.
    const order = await ensureShipmentForDispatch(ctx, loaded, trip);
    // pending_external / conflict keep their status so the Zoho sync stays visible.
    if (['pending', 'planned', 'assigned', 'failed'].includes(order.status)) {
      const updated = await bumpDeliveryOrder(tx, order, { status: 'dispatched' });
      publishDeliveryChange(ctx, updated);
    }
    ctx.emit(
      OPS_EVENTS.delivery.dispatched,
      { deliveryOrderId: order.id, tripId: trip.id, zohoSyncState: order.zohoSyncState },
      { caseId: order.caseId, areaKey: 'logistica', objectType: ORDER, objectId: order.id }
    );
  }
  ctx.emit(
    LOGISTICS_EVENTS.trip.started,
    { tripId: trip.id, number: trip.number, stops: open.length },
    { areaKey: 'logistica', objectType: TRIP, objectId: trip.id }
  );
  publishTripChange(ctx, updatedTrip);
  return { data: { tripId: trip.id, status: updatedTrip.status } };
}

async function openStopOfRunningTrip(
  ctx: CommandContext,
  tripId: string,
  stopId: string,
  action: string
) {
  const trip = await loadTrip(ctx.tx, tripId);
  await assertDriverOrDispatcher(ctx, trip.driverId, action);
  assertTripStatus(trip, ['en_route'], 'Inicia el viaje antes de registrar sus paradas');
  const stop = await loadStop(ctx.tx, trip.id, stopId);
  return { trip, stop };
}

export async function arriveStop(
  tx: Tx,
  input: WithTrip<ArriveStopInput>
): Promise<
  CommandHandlerOutput<{
    tripId: string;
    stopId: string;
    status: string;
    distanceFromDestinationKm: number | null;
  }>
> {
  const ctx = requireCommandContext(tx);
  const { trip, stop } = await openStopOfRunningTrip(
    ctx,
    input.tripId,
    input.stopId,
    'registrar la llegada'
  );
  if (stop.status === 'arrived') {
    return {
      data: {
        tripId: trip.id,
        stopId: stop.id,
        status: stop.status,
        distanceFromDestinationKm: null,
      },
    };
  }
  if (stop.status !== 'pending')
    throw new OperationsError('invalid_state', 'La parada ya está cerrada');
  const gps = { lat: input.lat ?? undefined, lng: input.lng ?? undefined };
  const destination = {
    lat: toNumber(stop.lat) ?? undefined,
    lng: toNumber(stop.lng) ?? undefined,
  };
  const distance =
    isValidPoint(gps) && isValidPoint(destination)
      ? Math.round(haversineKm(gps, destination) * 100) / 100
      : null;
  const updated = await tx.tripStop.update({
    where: { id: stop.id },
    data: {
      status: 'arrived',
      arrivedAt: ctx.now,
      ...(isValidPoint(gps) ? { lat: gps.lat, lng: gps.lng } : {}),
    },
  });
  const order = await ctx.tx.deliveryOrder.findUnique({
    where: { id: stop.deliveryOrderId },
    select: { caseId: true },
  });
  ctx.emit(
    LOGISTICS_EVENTS.trip.stopArrived,
    {
      tripId: trip.id,
      stopId: stop.id,
      deliveryOrderId: stop.deliveryOrderId,
      lat: isValidPoint(gps) ? gps.lat : null,
      lng: isValidPoint(gps) ? gps.lng : null,
      distanceFromDestinationKm: distance,
    },
    {
      caseId: order?.caseId ?? null,
      areaKey: 'logistica',
      objectType: LOGISTICS_OBJECT_TYPES.tripStop,
      objectId: stop.id,
    }
  );
  publishTripChange(ctx, trip, { stopId: stop.id, stopStatus: updated.status });
  return {
    data: {
      tripId: trip.id,
      stopId: stop.id,
      status: updated.status,
      distanceFromDestinationKm: distance,
    },
  };
}

export async function completeStop(
  tx: Tx,
  input: WithTrip<CompleteStopInput>
): Promise<CommandHandlerOutput<RecordDeliveryResult & { tripId: string; stopId: string }>> {
  const ctx = requireCommandContext(tx);
  const { trip, stop } = await openStopOfRunningTrip(
    ctx,
    input.tripId,
    input.stopId,
    'registrar esta entrega'
  );
  if (!(TRIP_STOP_OPEN_STATUSES as readonly string[]).includes(stop.status)) {
    throw new OperationsError('invalid_state', 'La parada ya está cerrada');
  }
  const { stopId, tripId, ...fields } = input;
  const result = await recordDelivery(
    tx,
    { ...fields, deliveryOrderId: stop.deliveryOrderId },
    { orderVersionGuard: true }
  );
  publishTripChange(ctx, trip, { stopId: stop.id, stopStatus: 'done' });
  const pending = result.zohoWriteQueued;
  return {
    status: pending ? 'pending_external' : 'completed',
    externalSyncStatus: pending ? 'queued' : 'none',
    data: { ...result, tripId, stopId },
  };
}

export async function failStop(
  tx: Tx,
  input: WithTrip<FailStopInput>
): Promise<
  CommandHandlerOutput<{
    tripId: string;
    stopId: string;
    deliveryOrderId: string;
    workItemId: string;
    areaRequestId: string;
  }>
> {
  const ctx = requireCommandContext(tx);
  const { trip, stop } = await openStopOfRunningTrip(
    ctx,
    input.tripId,
    input.stopId,
    'registrar la entrega fallida'
  );
  if (!(TRIP_STOP_OPEN_STATUSES as readonly string[]).includes(stop.status)) {
    throw new OperationsError('invalid_state', 'La parada ya está cerrada');
  }
  const order = await loadDeliveryOrder(tx, stop.deliveryOrderId);
  await tx.tripStop.update({
    where: { id: stop.id },
    data: { status: 'failed', departedAt: ctx.now },
  });
  const updated = await bumpDeliveryOrder(tx, order, { status: 'failed', tripId: null });
  await tx.deliveryEvidence.create({
    data: {
      deliveryOrderId: order.id,
      kind: 'note',
      note: input.reason,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      commandId: ctx.commandId,
      createdBy: ctx.actor.id,
    },
  });
  const ref = await caseReference(tx, order.caseId);
  const workItem = await ctx.createWorkItem({
    areaKey: 'logistica',
    kind: 'action',
    title: `Reprogramar entrega fallida (${ref})`,
    description: `No se pudo entregar en el viaje ${trip.number}: ${input.reason}`,
    caseId: order.caseId,
    objectType: ORDER,
    objectId: order.id,
  });
  const { request } = await ctx.createAreaRequest({
    caseId: order.caseId,
    fromAreaKey: 'logistica',
    toAreaKey: 'ventas',
    kind: 'customer_notice',
    objectType: ORDER,
    objectId: order.id,
    title: `Avisar al cliente: entrega fallida (${ref})`,
    payload: { caseId: order.caseId, reason: input.reason },
  });
  const eventOptions = { caseId: order.caseId, areaKey: 'logistica' };
  ctx.emit(
    LOGISTICS_EVENTS.trip.stopFailed,
    { tripId: trip.id, stopId: stop.id, deliveryOrderId: order.id, reason: input.reason },
    { ...eventOptions, objectType: LOGISTICS_OBJECT_TYPES.tripStop, objectId: stop.id }
  );
  ctx.emit(
    OPS_EVENTS.delivery.failed,
    {
      deliveryOrderId: order.id,
      tripId: trip.id,
      reason: input.reason,
      workItemId: workItem.id,
      areaRequestId: request.id,
    },
    { ...eventOptions, objectType: ORDER, objectId: order.id }
  );
  publishDeliveryChange(ctx, { ...updated, tripId: trip.id });
  publishTripChange(ctx, trip, { stopId: stop.id, stopStatus: 'failed' });
  return {
    data: {
      tripId: trip.id,
      stopId: stop.id,
      deliveryOrderId: order.id,
      workItemId: workItem.id,
      areaRequestId: request.id,
    },
  };
}

export async function closeTrip(
  tx: Tx,
  input: { tripId: string }
): Promise<
  CommandHandlerOutput<{ tripId: string; status: string; delivered: number; failed: number }>
> {
  const ctx = requireCommandContext(tx);
  const trip = await loadTrip(tx, input.tripId);
  await assertDriverOrDispatcher(ctx, trip.driverId, 'cerrar este viaje');
  const stops = await tx.tripStop.findMany({ where: { tripId: trip.id } });
  const delivered = stops.filter((s) => s.status === 'done').length;
  const failed = stops.filter((s) => s.status === 'failed').length;
  if (trip.status === 'done')
    return { data: { tripId: trip.id, status: trip.status, delivered, failed } };
  assertTripStatus(trip, ['en_route'], 'Sólo se cierra un viaje en ruta');
  const open = stops.filter((s) =>
    (TRIP_STOP_OPEN_STATUSES as readonly string[]).includes(s.status)
  );
  if (open.length > 0) {
    throw logisticsError(
      'stops_pending',
      `Quedan ${open.length} parada(s) sin entregar ni marcar como fallidas`,
      {
        stopIds: open.map((s) => s.id),
      }
    );
  }
  const updated = await tx.trip.update({
    where: { id: trip.id },
    data: { status: 'done', endedAt: ctx.now },
  });
  ctx.emit(
    LOGISTICS_EVENTS.trip.closed,
    { tripId: trip.id, number: trip.number, delivered, failed },
    { areaKey: 'logistica', objectType: TRIP, objectId: trip.id }
  );
  publishTripChange(ctx, updated);
  return { data: { tripId: trip.id, status: updated.status, delivered, failed } };
}
