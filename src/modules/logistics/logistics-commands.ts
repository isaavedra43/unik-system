import { createHash, randomUUID } from 'crypto';
import type { z } from 'zod';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  executeCommand,
  OperationsError,
  registerCommand,
  versionedAggregate,
  type CommandResult,
  type DomainCommand,
} from '@/modules/operations/commands';
import {
  cancelDeliveryOrder,
  cancelDeliveryOrderSchema,
  createDeliveryOrder,
  createDeliveryOrderSchema,
  linkPackage,
  linkPackageSchema,
  recordDelivery,
  recordDeliverySchema,
  type CancelDeliveryOrderResult,
  type RecordDeliveryResult,
} from './delivery-service';
import {
  createDriver,
  createVehicle,
  driverCreateSchema,
  driverUpdateSchema,
  toDriverDTO,
  toVehicleDTO,
  updateDriver,
  updateVehicle,
  vehicleCreateSchema,
  vehicleUpdateSchema,
  type DriverDTO,
  type VehicleDTO,
} from './fleet-service';
import { normalizeVehicleCode } from './fleet-rules';
import { assertLogisticsEnabled } from './logistics-helpers';
import {
  assignTransport,
  assignTransportSchema,
  confirmZohoDelivered,
  confirmZohoShipmentCancelled,
  reconcileShipment,
  reconcileShipmentSchema,
  recordZohoWriteFailure,
  zohoConfirmationSchema,
  zohoWriteFailureSchema,
  type AssignTransportResult,
} from './transport-service';
import {
  addStop,
  addStopSchema,
  arriveStop,
  arriveStopSchema,
  buildTrip,
  buildTripSchema,
  cancelTrip,
  cancelTripSchema,
  closeTrip,
  completeStop,
  completeStopSchema,
  failStop,
  failStopSchema,
  reorderStops,
  reorderStopsSchema,
  startTrip,
  tripOnlySchema,
  type BuildTripResult,
  type CancelTripResult,
} from './trips-service';
import { LOGISTICS_COMMANDS, LOGISTICS_OBJECT_TYPES, LOGISTICS_SYSTEM_ACTOR_ID } from './types';

/**
 * Registration of the logistics commands (plan sections 4 and 6.3) and the
 * uniform service signatures `fn(actor, input, {commandId})` used by routes,
 * server actions, the driver PWA and the AI tools.
 *
 * | command | aggregate | permission |
 * |---|---|---|
 * | delivery.create | none (`delivery:{caseId}:{allocations}`) | logistics.dispatch |
 * | delivery.link_package / assign_transport / cancel | delivery_order | logistics.dispatch (+ logistics.zoho_write to ship) |
 * | delivery.record | delivery_order | dispatcher or assigned driver (checked in the handler) |
 * | delivery.reconcile_shipment / zoho_write_failed / zoho_delivered / zoho_shipment_cancelled | delivery_order | system actor only |
 * | trip.build | none | logistics.dispatch |
 * | trip.add_stop / reorder | trip | logistics.dispatch |
 * | trip.start / arrive_stop / complete_stop / fail_stop / close | trip | dispatcher or the trip's driver |
 * | trip.cancel | trip | logistics.dispatch |
 * | fleet.vehicle.create / update, fleet.driver.create / update | none | logistics.manage_fleet |
 *
 * Import this file from `operations/register-commands.ts` so every entry
 * point that executes commands by type has the catalog.
 */

const ORDER = LOGISTICS_OBJECT_TYPES.deliveryOrder;
const TRIP = LOGISTICS_OBJECT_TYPES.trip;
const deliveryAggregate = versionedAggregate(ORDER, 'deliveryOrder');
const tripAggregate = versionedAggregate(TRIP, 'trip');
const SYSTEM_ONLY = ['system'] as const;

function assertTarget(cmd: DomainCommand<unknown>, deliveryOrderId: string): void {
  if (cmd.aggregate.id !== deliveryOrderId) {
    throw new OperationsError(
      'invalid_payload',
      'La orden de entrega no corresponde al registro del comando'
    );
  }
}

// ---------------------------------------------------------------------------
// Delivery orders
// ---------------------------------------------------------------------------

registerCommand(LOGISTICS_COMMANDS.deliveryCreate, {
  schema: createDeliveryOrderSchema,
  permission: 'logistics.dispatch',
  aggregate: 'none',
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    const result = await createDeliveryOrder(tx, cmd.payload);
    return {
      aggregateVersion: result.deliveryOrder.version,
      data: {
        deliveryOrderId: result.deliveryOrder.id,
        status: result.deliveryOrder.status,
        packageLinked: result.packageLinked,
        areaRequestId: result.areaRequestId,
        workItemId: result.workItemId,
      },
    };
  },
});

registerCommand(LOGISTICS_COMMANDS.deliveryLinkPackage, {
  schema: linkPackageSchema,
  permission: 'logistics.dispatch',
  aggregate: deliveryAggregate,
  async handler(tx, cmd) {
    if (cmd.actor.type !== 'system') await assertLogisticsEnabled();
    assertTarget(cmd, cmd.payload.deliveryOrderId);
    const result = await linkPackage(tx, cmd.payload);
    return {
      data: {
        deliveryOrderId: result.deliveryOrder.id,
        packageId: result.deliveryOrder.packageId,
        status: result.deliveryOrder.status,
        linked: result.linked,
      },
    };
  },
});

registerCommand(LOGISTICS_COMMANDS.deliveryAssignTransport, {
  schema: assignTransportSchema,
  permission: 'logistics.dispatch',
  aggregate: deliveryAggregate,
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    assertTarget(cmd, cmd.payload.deliveryOrderId);
    return assignTransport(tx, cmd.payload);
  },
});

registerCommand(LOGISTICS_COMMANDS.deliveryRecord, {
  schema: recordDeliverySchema,
  aggregate: deliveryAggregate,
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    assertTarget(cmd, cmd.payload.deliveryOrderId);
    const result = await recordDelivery(tx, cmd.payload, { orderVersionGuard: false });
    return {
      status: result.zohoWriteQueued ? 'pending_external' : 'completed',
      externalSyncStatus: result.zohoWriteQueued ? 'queued' : 'none',
      data: result,
    };
  },
});

registerCommand(LOGISTICS_COMMANDS.deliveryCancel, {
  schema: cancelDeliveryOrderSchema,
  permission: 'logistics.dispatch',
  aggregate: deliveryAggregate,
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    assertTarget(cmd, cmd.payload.deliveryOrderId);
    const result = await cancelDeliveryOrder(tx, cmd.payload);
    return {
      status: result.zohoCancelQueued ? 'pending_external' : 'completed',
      externalSyncStatus: result.zohoCancelQueued ? 'queued' : 'none',
      data: result,
    };
  },
});

registerCommand(LOGISTICS_COMMANDS.deliveryReconcileShipment, {
  schema: reconcileShipmentSchema,
  aggregate: deliveryAggregate,
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd) {
    assertTarget(cmd, cmd.payload.deliveryOrderId);
    return reconcileShipment(tx, cmd.payload);
  },
});

registerCommand(LOGISTICS_COMMANDS.deliveryZohoWriteFailed, {
  schema: zohoWriteFailureSchema,
  aggregate: deliveryAggregate,
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd) {
    assertTarget(cmd, cmd.payload.deliveryOrderId);
    return recordZohoWriteFailure(tx, cmd.payload);
  },
});

registerCommand(LOGISTICS_COMMANDS.deliveryZohoDelivered, {
  schema: zohoConfirmationSchema,
  aggregate: deliveryAggregate,
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd) {
    assertTarget(cmd, cmd.payload.deliveryOrderId);
    return confirmZohoDelivered(tx, cmd.payload);
  },
});

registerCommand(LOGISTICS_COMMANDS.deliveryZohoShipmentCancelled, {
  schema: zohoConfirmationSchema,
  aggregate: deliveryAggregate,
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd) {
    assertTarget(cmd, cmd.payload.deliveryOrderId);
    return confirmZohoShipmentCancelled(tx, cmd.payload);
  },
});

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

registerCommand(LOGISTICS_COMMANDS.tripBuild, {
  schema: buildTripSchema,
  permission: 'logistics.dispatch',
  aggregate: 'none',
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return buildTrip(tx, cmd.payload);
  },
});

registerCommand(LOGISTICS_COMMANDS.tripAddStop, {
  schema: addStopSchema,
  permission: 'logistics.dispatch',
  aggregate: tripAggregate,
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return addStop(tx, { ...cmd.payload, tripId: cmd.aggregate.id });
  },
});

registerCommand(LOGISTICS_COMMANDS.tripReorder, {
  schema: reorderStopsSchema,
  permission: 'logistics.dispatch',
  aggregate: tripAggregate,
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return reorderStops(tx, { ...cmd.payload, tripId: cmd.aggregate.id });
  },
});

registerCommand(LOGISTICS_COMMANDS.tripStart, {
  schema: tripOnlySchema,
  aggregate: tripAggregate,
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return startTrip(tx, { tripId: cmd.aggregate.id });
  },
});

registerCommand(LOGISTICS_COMMANDS.tripArriveStop, {
  schema: arriveStopSchema,
  aggregate: tripAggregate,
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return arriveStop(tx, { ...cmd.payload, tripId: cmd.aggregate.id });
  },
});

registerCommand(LOGISTICS_COMMANDS.tripCompleteStop, {
  schema: completeStopSchema,
  aggregate: tripAggregate,
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return completeStop(tx, { ...cmd.payload, tripId: cmd.aggregate.id });
  },
});

registerCommand(LOGISTICS_COMMANDS.tripFailStop, {
  schema: failStopSchema,
  aggregate: tripAggregate,
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return failStop(tx, { ...cmd.payload, tripId: cmd.aggregate.id });
  },
});

registerCommand(LOGISTICS_COMMANDS.tripClose, {
  schema: tripOnlySchema,
  aggregate: tripAggregate,
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return closeTrip(tx, { tripId: cmd.aggregate.id });
  },
});

// Calling off a trip is a planning decision (it releases every delivery on it),
// so it asks for `logistics.dispatch` and not for the driver of the trip.
registerCommand(LOGISTICS_COMMANDS.tripCancel, {
  schema: cancelTripSchema,
  permission: 'logistics.dispatch',
  aggregate: tripAggregate,
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return cancelTrip(tx, { ...cmd.payload, tripId: cmd.aggregate.id });
  },
});

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

registerCommand(LOGISTICS_COMMANDS.fleetVehicleCreate, {
  schema: vehicleCreateSchema,
  permission: 'logistics.manage_fleet',
  aggregate: 'none',
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return { data: toVehicleDTO(await createVehicle(tx, cmd.payload)) };
  },
});

registerCommand(LOGISTICS_COMMANDS.fleetVehicleUpdate, {
  schema: vehicleUpdateSchema,
  permission: 'logistics.manage_fleet',
  aggregate: 'none',
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return { data: toVehicleDTO(await updateVehicle(tx, cmd.payload)) };
  },
});

registerCommand(LOGISTICS_COMMANDS.fleetDriverCreate, {
  schema: driverCreateSchema,
  permission: 'logistics.manage_fleet',
  aggregate: 'none',
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return { data: toDriverDTO(await createDriver(tx, cmd.payload)) };
  },
});

registerCommand(LOGISTICS_COMMANDS.fleetDriverUpdate, {
  schema: driverUpdateSchema,
  permission: 'logistics.manage_fleet',
  aggregate: 'none',
  async handler(tx, cmd) {
    await assertLogisticsEnabled();
    return { data: toDriverDTO(await updateDriver(tx, cmd.payload)) };
  },
});

// ---------------------------------------------------------------------------
// Uniform service signatures
// ---------------------------------------------------------------------------

export interface LogisticsCommandOptions {
  /** Client-generated id (offline queue); a new UUID otherwise. */
  commandId?: string;
  expectedVersion?: number;
  deviceId?: string;
  occurredAt?: string;
  /** `ai` when a bot user executes it through a tool. */
  actorType?: 'user' | 'ai';
}

function run<D>(
  actor: CurrentUser,
  type: string,
  aggregate: { type: string; id: string },
  payload: unknown,
  options: LogisticsCommandOptions = {}
): Promise<CommandResult<D>> {
  return executeCommand<D>(
    {
      commandId: options.commandId ?? randomUUID(),
      type,
      actor: { type: options.actorType ?? 'user', id: actor.id },
      aggregate,
      expectedVersion: options.expectedVersion,
      payload,
      deviceId: options.deviceId,
      occurredAt: options.occurredAt,
    },
    actor
  );
}

/** Stable natural key of a delivery creation: the same case and allocations never create two orders. */
export function deliveryCreationKey(caseId: string, allocationIds: string[]): string {
  const digest = createHash('sha256')
    .update([...new Set(allocationIds)].sort().join('|'))
    .digest('hex')
    .slice(0, 24);
  return `delivery:${caseId}:${digest}`;
}

export interface CreateDeliveryOrderData {
  deliveryOrderId: string;
  status: string;
  packageLinked: boolean;
  areaRequestId: string | null;
  workItemId: string | null;
}

export const createDeliveryOrderCommand = (
  actor: CurrentUser,
  input: z.input<typeof createDeliveryOrderSchema>,
  options?: LogisticsCommandOptions
) =>
  run<CreateDeliveryOrderData>(
    actor,
    LOGISTICS_COMMANDS.deliveryCreate,
    { type: ORDER, id: deliveryCreationKey(input.caseId, input.allocationIds) },
    input,
    options
  );

export const linkPackageCommand = (
  actor: CurrentUser,
  input: z.input<typeof linkPackageSchema>,
  options?: LogisticsCommandOptions
) =>
  run<{ deliveryOrderId: string; packageId: string | null; status: string; linked: boolean }>(
    actor,
    LOGISTICS_COMMANDS.deliveryLinkPackage,
    { type: ORDER, id: input.deliveryOrderId },
    input,
    options
  );

export const assignTransportCommand = (
  actor: CurrentUser,
  input: z.input<typeof assignTransportSchema>,
  options?: LogisticsCommandOptions
) =>
  run<AssignTransportResult>(
    actor,
    LOGISTICS_COMMANDS.deliveryAssignTransport,
    { type: ORDER, id: input.deliveryOrderId },
    input,
    options
  );

export const recordDeliveryCommand = (
  actor: CurrentUser,
  input: z.input<typeof recordDeliverySchema>,
  options?: LogisticsCommandOptions
) =>
  run<RecordDeliveryResult>(
    actor,
    LOGISTICS_COMMANDS.deliveryRecord,
    { type: ORDER, id: input.deliveryOrderId },
    input,
    options
  );

export const cancelDeliveryOrderCommand = (
  actor: CurrentUser,
  input: z.input<typeof cancelDeliveryOrderSchema>,
  options?: LogisticsCommandOptions
) =>
  run<CancelDeliveryOrderResult>(
    actor,
    LOGISTICS_COMMANDS.deliveryCancel,
    { type: ORDER, id: input.deliveryOrderId },
    input,
    options
  );

export const buildTripCommand = (
  actor: CurrentUser,
  input: z.input<typeof buildTripSchema>,
  options?: LogisticsCommandOptions
) =>
  run<BuildTripResult>(
    actor,
    LOGISTICS_COMMANDS.tripBuild,
    { type: TRIP, id: `trip:${input.vehicleId}:${input.date}` },
    input,
    options
  );

type TripCommandInput<T> = T & { tripId: string };

function tripCommand<S extends z.ZodTypeAny, D>(type: string) {
  return (
    actor: CurrentUser,
    input: TripCommandInput<z.input<S>>,
    options?: LogisticsCommandOptions
  ) => {
    const { tripId, ...payload } = input as TripCommandInput<Record<string, unknown>>;
    return run<D>(actor, type, { type: TRIP, id: tripId }, payload, options);
  };
}

export const addStopCommand = tripCommand<
  typeof addStopSchema,
  { tripId: string; stopId: string; sequence: number }
>(LOGISTICS_COMMANDS.tripAddStop);
export const reorderStopsCommand = tripCommand<
  typeof reorderStopsSchema,
  { tripId: string; stopIds: string[] }
>(LOGISTICS_COMMANDS.tripReorder);
export const startTripCommand = tripCommand<
  typeof tripOnlySchema,
  { tripId: string; status: string }
>(LOGISTICS_COMMANDS.tripStart);
export const arriveStopCommand = tripCommand<
  typeof arriveStopSchema,
  { tripId: string; stopId: string; status: string; distanceFromDestinationKm: number | null }
>(LOGISTICS_COMMANDS.tripArriveStop);
export const completeStopCommand = tripCommand<
  typeof completeStopSchema,
  RecordDeliveryResult & { tripId: string; stopId: string }
>(LOGISTICS_COMMANDS.tripCompleteStop);
export const failStopCommand = tripCommand<
  typeof failStopSchema,
  {
    tripId: string;
    stopId: string;
    deliveryOrderId: string;
    workItemId: string;
    areaRequestId: string;
  }
>(LOGISTICS_COMMANDS.tripFailStop);
export const closeTripCommand = tripCommand<
  typeof tripOnlySchema,
  { tripId: string; status: string; delivered: number; failed: number }
>(LOGISTICS_COMMANDS.tripClose);
export const cancelTripCommand = tripCommand<typeof cancelTripSchema, CancelTripResult>(
  LOGISTICS_COMMANDS.tripCancel
);

export const createVehicleCommand = (
  actor: CurrentUser,
  input: z.input<typeof vehicleCreateSchema>,
  options?: LogisticsCommandOptions
) =>
  run<VehicleDTO>(
    actor,
    LOGISTICS_COMMANDS.fleetVehicleCreate,
    { type: LOGISTICS_OBJECT_TYPES.vehicle, id: `vehicle:${normalizeVehicleCode(input.code)}` },
    input,
    options
  );

export const updateVehicleCommand = (
  actor: CurrentUser,
  input: z.input<typeof vehicleUpdateSchema>,
  options?: LogisticsCommandOptions
) =>
  run<VehicleDTO>(
    actor,
    LOGISTICS_COMMANDS.fleetVehicleUpdate,
    { type: LOGISTICS_OBJECT_TYPES.vehicle, id: input.vehicleId },
    input,
    options
  );

export const createDriverCommand = (
  actor: CurrentUser,
  input: z.input<typeof driverCreateSchema>,
  options?: LogisticsCommandOptions
) =>
  run<DriverDTO>(
    actor,
    LOGISTICS_COMMANDS.fleetDriverCreate,
    { type: LOGISTICS_OBJECT_TYPES.driver, id: `driver:${input.userId ?? input.name}` },
    input,
    options
  );

export const updateDriverCommand = (
  actor: CurrentUser,
  input: z.input<typeof driverUpdateSchema>,
  options?: LogisticsCommandOptions
) =>
  run<DriverDTO>(
    actor,
    LOGISTICS_COMMANDS.fleetDriverUpdate,
    { type: LOGISTICS_OBJECT_TYPES.driver, id: input.driverId },
    input,
    options
  );

/** For jobs and sweeps: a `system` command on a delivery order with a deterministic id. */
export function executeLogisticsSystemCommand<D>(
  type: string,
  deliveryOrderId: string,
  payload: Record<string, unknown>,
  commandId: string
): Promise<CommandResult<D>> {
  return executeCommand<D>(
    {
      commandId,
      type,
      actor: { type: 'system', id: LOGISTICS_SYSTEM_ACTOR_ID },
      aggregate: { type: ORDER, id: deliveryOrderId },
      payload,
    },
    null
  );
}
