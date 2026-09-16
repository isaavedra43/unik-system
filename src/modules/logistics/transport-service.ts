import { z } from 'zod';
import { Prisma, type DeliveryOrder, type Package, type Trip } from '@prisma/client';
import { hasPermission } from '@/modules/auth/authorization';
import {
  OperationsError,
  requireCommandContext,
  type CommandContext,
  type CommandHandlerOutput,
} from '@/modules/operations/commands';
import { transitionIncidentInTx } from '@/modules/operations/incidents-service';
import { registerWorkItemHooks } from '@/modules/operations/work-items-service';
import { toOperationalJson } from '@/modules/operations/events-service';
import { OPS_EVENTS } from '@/modules/operations/types';
import { JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { attachPackage, findLinkablePackage } from './delivery-service';
import { assertFleetAvailable } from './fleet-service';
import {
  actorUserId,
  asRecord,
  caseReference,
  closeOpenWorkItems,
  dayText,
  idText,
  loadDeliveryOrder,
  logisticsError,
  notifyDeliveryUpdate,
  publishDeliveryChange,
  readShipmentInput,
  requireDay,
  type Tx,
  bumpDeliveryOrder,
} from './logistics-helpers';
import {
  DELIVERY_MODE_LABELS,
  DELIVERY_ORDER_STATUS_LABELS,
  LOGISTICS_EVENTS,
  LOGISTICS_JOB_TYPES,
  LOGISTICS_OBJECT_TYPES,
  LOGISTICS_ZOHO_MAX_ATTEMPTS,
  SHIPPING_MODES,
  TRANSPORT_ASSIGNABLE_STATUSES,
  isDeliveryOrderStatus,
  zohoShipRequestKey,
  type DeliveryMode,
  type ShippingMode,
} from './types';
import {
  compareShipment,
  describeDifferences,
  evaluateShipmentReadback,
  normalizeCarrier,
  normalizeTracking,
  toIsoDay,
  transitionZohoSync,
  ZOHO_OPERATION_LABELS,
  type ShipmentReadback,
} from './zoho-sync-state';

/**
 * Transport assignment and its Zoho mirror (plan sections 4.2 and 6.3).
 *
 * `assignTransport` also decides HOW it ships (plan §4 `mode`): `own_fleet`
 * demands a unit and a driver of ours, `carrier` (a courier or an external
 * haulier) travels with its tracking number and neither of the two. Switching
 * between the two is only possible while the delivery is not loaded on a trip.
 *
 * `assignTransport` never calls Zoho: it stores what must be written
 * (`shipmentInput` with its `requestKey`), leaves the order `pending_external`
 * and enqueues `ops.zoho.ship_package` in the same transaction (dedupe
 * `zoho:ship:{id}:{version}`, group `case:{caseId}`, 5 attempts). The job
 * writes with the existing `shipPackage` and then runs `reconcileShipment`,
 * which compares Zoho's read-back with `shipmentInput`:
 * equal → `assigned` + `zoho.shipment_confirmed` + `EvidenceLink zoho_readback`;
 * different → `conflict` adopting Zoho's values + incident `zoho_conflict` +
 * work item to Logística; local patch (API budget) → stays `pending_external`
 * until the sweep re-reads. Exhausted retries → `recordZohoWriteFailure`.
 */

const ORDER = LOGISTICS_OBJECT_TYPES.deliveryOrder;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const assignTransportSchema = z.object({
  deliveryOrderId: idText,
  carrier: z.string().trim().min(1, 'Indica el transportista').max(100),
  /** Shipment date written to Zoho (YYYY-MM-DD). */
  date: dayText,
  trackingNumber: z.string().trim().max(100).nullable().optional(),
  vehicleId: idText.nullable().optional(),
  driverId: idText.nullable().optional(),
  /**
   * Plan §4: how it ships. `own_fleet` needs a unit and a driver of ours;
   * `carrier` (a courier or an external haulier) travels with its tracking
   * number and none of the two. Omitted keeps the mode the order already has.
   */
  mode: z.enum(SHIPPING_MODES).optional(),
});
export type AssignTransportInput = z.infer<typeof assignTransportSchema>;

export const shipmentReadbackSchema = z.object({
  carrier: z.string().max(200).nullable(),
  shipmentDate: dayText.nullable(),
  trackingNumber: z.string().max(200).nullable(),
  zohoShipmentId: z.string().max(120).nullable(),
  shipmentNumber: z.string().max(120).nullable().optional(),
  status: z.string().max(60).nullable().optional(),
});

export const reconcileShipmentSchema = z.object({
  deliveryOrderId: idText,
  /** The write this read-back belongs to; a newer assignment makes it obsolete. */
  requestKey: z.string().max(200).nullable().optional(),
  source: z.enum(['zoho', 'local', 'mock']),
  readback: shipmentReadbackSchema,
});
export type ReconcileShipmentInput = z.infer<typeof reconcileShipmentSchema>;

export const zohoWriteFailureSchema = z.object({
  deliveryOrderId: idText,
  operation: z.enum(['ship', 'mark_delivered', 'cancel_shipment']),
  requestKey: z.string().min(1).max(200),
  error: z.string().max(2000),
  attempts: z.number().int().min(1).max(100),
});
export type ZohoWriteFailureInput = z.infer<typeof zohoWriteFailureSchema>;

export const zohoConfirmationSchema = z.object({
  deliveryOrderId: idText,
  source: z.enum(['zoho', 'local', 'mock']),
});
export type ZohoConfirmationInput = z.infer<typeof zohoConfirmationSchema>;

/**
 * Package row → read-back compared with `shipmentInput`. UNIK writes the carrier
 * as Zoho's `delivery_method`, while the package may also carry a `carrier` of
 * its own (a manual shipment, tracking data): the field matching what UNIK
 * wrote is compared, otherwise the written field (`delivery_method`) first.
 */
export function toShipmentReadback(
  pkg: Pick<
    Package,
    | 'carrier'
    | 'deliveryMethod'
    | 'shipmentDate'
    | 'trackingNumber'
    | 'zohoShipmentId'
    | 'shipmentNumber'
    | 'status'
  >,
  expectedCarrier?: string | null
): ShipmentReadback {
  const expected = expectedCarrier ? normalizeCarrier(expectedCarrier) : null;
  const carrier =
    [pkg.deliveryMethod, pkg.carrier].find(
      (value) => expected !== null && value && normalizeCarrier(value) === expected
    ) ??
    pkg.deliveryMethod ??
    pkg.carrier ??
    null;
  return {
    carrier,
    shipmentDate: toIsoDay(pkg.shipmentDate),
    trackingNumber: pkg.trackingNumber ?? null,
    zohoShipmentId: pkg.zohoShipmentId ?? null,
    shipmentNumber: pkg.shipmentNumber ?? null,
    status: pkg.status ?? null,
  };
}

// ---------------------------------------------------------------------------
// assignTransport
// ---------------------------------------------------------------------------

export interface AssignTransportResult {
  deliveryOrderId: string;
  status: string;
  /** How it ships after the assignment (`own_fleet` | `carrier`). */
  mode: string;
  zohoSyncState: string;
  requestKey: string;
  unchanged: boolean;
}

export async function assignTransport(
  tx: Tx,
  input: AssignTransportInput
): Promise<CommandHandlerOutput<AssignTransportResult>> {
  const ctx = requireCommandContext(tx);
  let order = await loadDeliveryOrder(tx, input.deliveryOrderId);
  if (!(TRANSPORT_ASSIGNABLE_STATUSES as readonly string[]).includes(order.status)) {
    const label = isDeliveryOrderStatus(order.status)
      ? DELIVERY_ORDER_STATUS_LABELS[order.status]
      : order.status;
    throw new OperationsError(
      'invalid_state',
      `No se puede asignar transporte a una entrega ${label.toLowerCase()}`
    );
  }
  if (!(SHIPPING_MODES as readonly string[]).includes(order.mode)) {
    throw new OperationsError(
      'invalid_state',
      'Sólo las entregas con flotilla propia o transportista llevan orden de envío en Zoho'
    );
  }
  if (ctx.user && !hasPermission(ctx.user, 'logistics.zoho_write')) {
    throw new OperationsError('forbidden', 'No tienes permiso para escribir embarques en Zoho');
  }
  const day = requireDay(input.date, 'la fecha de envío');

  // Plan §4: transport decides HOW it ships. Only own fleet ↔ carrier; a pickup
  // or a direct supplier delivery was already rejected above.
  const mode: ShippingMode = input.mode ?? (order.mode as ShippingMode);
  const modeChanged = mode !== order.mode;
  if (modeChanged && order.tripId) {
    throw new OperationsError(
      'invalid_state',
      'La entrega está cargada en un viaje de la flotilla; quítala del viaje antes de cambiar cómo se envía'
    );
  }

  let vehicleId: string | null = null;
  let driverId: string | null = null;
  if (mode === 'own_fleet') {
    if (!input.vehicleId || !input.driverId) {
      throw new OperationsError('invalid_payload', 'Con flotilla propia indica vehículo y chofer');
    }
    if (
      order.tripId &&
      (order.vehicleId !== input.vehicleId || order.driverId !== input.driverId)
    ) {
      throw new OperationsError(
        'invalid_state',
        'La entrega ya está en un viaje con otro vehículo o chofer; cámbiala desde el viaje'
      );
    }
    await assertFleetAvailable(tx, {
      vehicleId: input.vehicleId,
      driverId: input.driverId,
      day,
      ignoreTripId: order.tripId,
      allowBusy: true,
    });
    vehicleId = input.vehicleId;
    driverId = input.driverId;
  }
  // A carrier shipment travels with its own tracking number: vehicleId and
  // driverId stay null (whatever the caller sent) so the board, the dispatch
  // tiles and Zoho stop showing a unit of ours that never carried it.

  let linkedNow = false;
  if (!order.packageId) {
    const opCase = await tx.operationalCase.findUnique({
      where: { id: order.caseId },
      select: { zohoSalesOrderId: true },
    });
    const pkg = opCase?.zohoSalesOrderId
      ? await findLinkablePackage(tx, opCase.zohoSalesOrderId, {
          allocationIds: order.allocationIds,
          excludeDeliveryOrderId: order.id,
        })
      : null;
    if (!pkg) {
      throw logisticsError(
        'package_missing',
        'Zoho aún no tiene paquete para esta orden de venta; Ventas debe crearlo antes de asignar transporte'
      );
    }
    order = await attachPackage(ctx, order, pkg);
    linkedNow = true;
  }

  const trackingNumber = input.trackingNumber?.trim() || null;
  const current = readShipmentInput(order.shipmentInput);
  const unchanged =
    !linkedNow &&
    !modeChanged &&
    current !== null &&
    (order.status === 'pending_external' || order.status === 'assigned') &&
    (order.vehicleId ?? null) === vehicleId &&
    (order.driverId ?? null) === driverId &&
    normalizeCarrier(current.carrier) === normalizeCarrier(input.carrier) &&
    current.shipmentDate === input.date &&
    normalizeTracking(current.trackingNumber) === normalizeTracking(trackingNumber);
  if (unchanged && current) {
    const waiting = order.status === 'pending_external';
    return {
      status: waiting ? 'pending_external' : 'completed',
      externalSyncStatus: waiting ? 'queued' : 'confirmed',
      data: {
        deliveryOrderId: order.id,
        status: order.status,
        mode: order.mode,
        zohoSyncState: order.zohoSyncState,
        requestKey: current.requestKey,
        unchanged: true,
      },
    };
  }

  const eventOptions = {
    caseId: order.caseId,
    areaKey: 'logistica',
    objectType: ORDER,
    objectId: order.id,
  } as const;
  if (modeChanged) {
    ctx.emit(
      LOGISTICS_EVENTS.delivery.modeChanged,
      {
        deliveryOrderId: order.id,
        previousMode: order.mode,
        mode,
        previousModeLabel: DELIVERY_MODE_LABELS[order.mode as DeliveryMode] ?? order.mode,
        modeLabel: DELIVERY_MODE_LABELS[mode],
      },
      eventOptions
    );
  }
  ctx.emit(
    LOGISTICS_EVENTS.delivery.transportAssigned,
    {
      deliveryOrderId: order.id,
      mode,
      carrier: input.carrier,
      vehicleId,
      driverId,
      date: input.date,
    },
    eventOptions
  );
  // The engine already bumped the version: one key per assignment.
  const updated = await queueShipmentWrite(
    ctx,
    order,
    {
      carrier: input.carrier,
      shipmentDate: input.date,
      trackingNumber,
      vehicleId,
      driverId,
      ...(modeChanged ? { mode } : {}),
    },
    { bump: false }
  );
  const requestKey = readShipmentInput(updated.shipmentInput)!.requestKey;
  if (vehicleId) {
    await ctx.relate(
      { type: ORDER, id: order.id },
      { type: LOGISTICS_OBJECT_TYPES.vehicle, id: vehicleId },
      'uses'
    );
  }
  publishDeliveryChange(ctx, updated);
  return {
    status: 'pending_external',
    externalSyncStatus: 'queued',
    data: {
      deliveryOrderId: order.id,
      status: updated.status,
      mode: updated.mode,
      zohoSyncState: updated.zohoSyncState,
      requestKey,
      unchanged: false,
    },
  };
}

export interface ShipmentWriteFields {
  carrier: string;
  /** YYYY-MM-DD */
  shipmentDate: string;
  trackingNumber: string | null;
  vehicleId: string | null;
  driverId: string | null;
  /** Only when the assignment changes how it ships (own fleet ↔ carrier). */
  mode?: ShippingMode;
}

/**
 * Stores what must be written in Zoho (`shipmentInput` with a new request key),
 * leaves the order waiting for Zoho and enqueues `ops.zoho.ship_package` in the
 * same transaction. `bump`: the order is not the aggregate of the running
 * command (e.g. a trip loads it), so its version is bumped here with a guard.
 */
export async function queueShipmentWrite(
  ctx: CommandContext,
  order: DeliveryOrder,
  fields: ShipmentWriteFields,
  options: { bump: boolean }
): Promise<DeliveryOrder> {
  const transition = transitionZohoSync(order.zohoSyncState, 'ship_requested');
  if (!transition.ok) throw new OperationsError('invalid_state', transition.message);
  const requestKey = zohoShipRequestKey(order.id, options.bump ? order.version + 1 : order.version);
  const shipmentInput = {
    carrier: fields.carrier,
    shipmentDate: fields.shipmentDate,
    trackingNumber: fields.trackingNumber,
    requestKey,
    requestedByUserId: actorUserId(ctx),
    requestedAt: ctx.now.toISOString(),
  };
  const data = {
    ...(fields.mode ? { mode: fields.mode } : {}),
    carrier: fields.carrier,
    vehicleId: fields.vehicleId,
    driverId: fields.driverId,
    plannedDate: requireDay(fields.shipmentDate, 'la fecha de envío'),
    shipmentInput: toOperationalJson(shipmentInput),
    status: 'pending_external',
    zohoSyncState: transition.state,
    zohoError: null,
    conflictDetail: Prisma.DbNull,
  };
  const updated = options.bump
    ? await bumpDeliveryOrder(ctx.tx, order, data)
    : await ctx.tx.deliveryOrder.update({ where: { id: order.id }, data });
  // A new write answers any pending decision about the previous one.
  await closeOpenWorkItems(
    ctx,
    { objectType: ORDER, objectId: order.id, kinds: ['external_sync'] },
    { status: 'done', result: { resolution: 'rewrite_requested', requestKey } }
  );
  ctx.outbox({
    type: LOGISTICS_JOB_TYPES.shipPackage,
    payload: { deliveryOrderId: order.id, requestKey },
    dedupeKey: requestKey,
    groupKey: `case:${order.caseId}`,
    maxAttempts: LOGISTICS_ZOHO_MAX_ATTEMPTS,
    priority: JOB_PRIORITY.interactive,
    createdBy: actorUserId(ctx) ?? undefined,
  });
  ctx.emit(
    OPS_EVENTS.zoho.shipmentQueued,
    {
      deliveryOrderId: order.id,
      requestKey,
      carrier: fields.carrier,
      shipmentDate: fields.shipmentDate,
      trackingNumber: fields.trackingNumber,
    },
    { caseId: order.caseId, areaKey: 'logistica', objectType: ORDER, objectId: order.id }
  );
  return updated;
}

/** A shipping delivery (own fleet or carrier) never leaves without its Zoho package. */
export function assertPackageForDispatch(order: Pick<DeliveryOrder, 'mode' | 'packageId'>): void {
  if ((SHIPPING_MODES as readonly string[]).includes(order.mode) && !order.packageId) {
    throw logisticsError(
      'package_missing',
      'Zoho aún no tiene paquete para esta entrega; Ventas debe crearlo antes de cargarla'
    );
  }
}

/**
 * Before a shipping delivery leaves on a trip (plan §6.3 `confirmLoad`): it
 * needs its Zoho package, and when transport was never assigned — or its last
 * write failed — the shipment order is written in Zoho with the trip's vehicle
 * and driver. The transport step only closes when Zoho reads it back.
 */
export async function ensureShipmentForDispatch(
  ctx: CommandContext,
  order: DeliveryOrder,
  trip: Pick<Trip, 'date' | 'vehicleId' | 'driverId'>
): Promise<DeliveryOrder> {
  if (!(SHIPPING_MODES as readonly string[]).includes(order.mode)) return order;
  assertPackageForDispatch(order);
  const current = readShipmentInput(order.shipmentInput);
  if (current && order.zohoSyncState !== 'failed') return order;
  const vehicle = await ctx.tx.vehicle.findUnique({
    where: { id: trip.vehicleId },
    select: { code: true, label: true },
  });
  return queueShipmentWrite(
    ctx,
    order,
    {
      carrier:
        current?.carrier ??
        order.carrier ??
        `Flotilla propia ${vehicle?.label || vehicle?.code || ''}`.trim(),
      shipmentDate: current?.shipmentDate ?? trip.date.toISOString().slice(0, 10),
      trackingNumber: current?.trackingNumber ?? null,
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
    },
    { bump: true }
  );
}

// ---------------------------------------------------------------------------
// reconcileShipment
// ---------------------------------------------------------------------------

export interface ReconcileShipmentResult {
  deliveryOrderId: string;
  outcome: 'awaiting_readback' | 'not_written' | 'match' | 'mismatch' | 'superseded' | 'ignored';
  zohoSyncState: string;
  status: string;
  incidentId?: string | null;
}

/** Whether a stored read-back (JSON) holds the same shipment values. */
export function sameShipmentReadback(a: unknown, b: ShipmentReadback): boolean {
  const left = asRecord(a);
  return (
    normalizeCarrier(left.carrier as string | null) === normalizeCarrier(b.carrier) &&
    (left.shipmentDate ?? null) === b.shipmentDate &&
    normalizeTracking(left.trackingNumber as string | null) === normalizeTracking(b.trackingNumber)
  );
}

/** A stop the driver could not deliver (not a failed Zoho write): the reconciliation keeps it visible. */
function isPhysicalFailure(order: Pick<DeliveryOrder, 'status' | 'zohoSyncState'>): boolean {
  return order.status === 'failed' && order.zohoSyncState !== 'failed';
}

/** Status of an order once Zoho confirmed its shipment. */
async function confirmedStatus(tx: Tx, order: DeliveryOrder): Promise<string> {
  if (isPhysicalFailure(order)) return 'failed';
  if (order.status === 'dispatched') return 'dispatched';
  const trip = order.tripId
    ? await tx.trip.findUnique({ where: { id: order.tripId }, select: { status: true } })
    : null;
  return trip?.status === 'en_route' ? 'dispatched' : 'assigned';
}

export async function reconcileShipment(
  tx: Tx,
  input: ReconcileShipmentInput
): Promise<CommandHandlerOutput<ReconcileShipmentResult>> {
  const ctx = requireCommandContext(tx);
  const order = await loadDeliveryOrder(tx, input.deliveryOrderId);
  const shipment = readShipmentInput(order.shipmentInput);
  const base = {
    deliveryOrderId: order.id,
    zohoSyncState: order.zohoSyncState,
    status: order.status,
  };
  if (!shipment) return { data: { ...base, outcome: 'ignored' } };
  if (input.requestKey && input.requestKey !== shipment.requestKey) {
    return { data: { ...base, outcome: 'superseded' } };
  }
  if (
    order.status === 'cancelled' ||
    order.status === 'delivered' ||
    order.status === 'partially_delivered'
  ) {
    return { data: { ...base, outcome: 'ignored' } };
  }

  const readback = input.readback;
  const outcome = evaluateShipmentReadback(shipment, readback, input.source);
  const readbackJson = toOperationalJson({
    ...readback,
    source: input.source,
    requestKey: shipment.requestKey,
    readAt: ctx.now.toISOString(),
  });
  const eventOptions = {
    caseId: order.caseId,
    areaKey: 'logistica',
    objectType: ORDER,
    objectId: order.id,
  };

  if (outcome === 'awaiting_readback') {
    const transition = transitionZohoSync(order.zohoSyncState, 'write_applied_locally');
    if (!transition.ok) return { data: { ...base, outcome: 'ignored' } };
    const updated = await tx.deliveryOrder.update({
      where: { id: order.id },
      data: {
        zohoSyncState: transition.state,
        zohoReadback: readbackJson,
        zohoShipmentId: readback.zohoShipmentId ?? order.zohoShipmentId,
      },
    });
    publishDeliveryChange(ctx, updated);
    return {
      status: 'pending_external',
      externalSyncStatus: 'queued',
      data: {
        deliveryOrderId: order.id,
        outcome,
        zohoSyncState: updated.zohoSyncState,
        status: updated.status,
      },
    };
  }

  if (outcome === 'not_written') {
    // Nothing is written in the order: a re-read that finds no shipment changes nothing.
    const failed = order.zohoSyncState === 'failed';
    return {
      status: failed ? 'completed' : 'pending_external',
      externalSyncStatus: failed ? 'failed' : 'queued',
      data: { ...base, outcome },
    };
  }

  if (outcome === 'match') {
    const transition = transitionZohoSync(order.zohoSyncState, 'readback_matched');
    if (!transition.ok) return { data: { ...base, outcome: 'ignored' } };
    const status = await confirmedStatus(tx, order);
    const updated = await tx.deliveryOrder.update({
      where: { id: order.id },
      data: {
        status,
        zohoSyncState: transition.state,
        zohoShipmentId: readback.zohoShipmentId,
        zohoReadback: readbackJson,
        conflictDetail: Prisma.DbNull,
        zohoError: null,
        carrier: readback.carrier ?? order.carrier,
      },
    });
    if (transition.changed) {
      const parts = [
        readback.carrier ?? shipment.carrier,
        readback.shipmentDate ?? shipment.shipmentDate,
        readback.trackingNumber ? `guía ${readback.trackingNumber}` : null,
        readback.shipmentNumber ?? null,
      ].filter(Boolean);
      await tx.evidenceLink.create({
        data: {
          caseId: order.caseId,
          objectType: ORDER,
          objectId: order.id,
          kind: 'zoho_readback',
          note: `Zoho confirmó el embarque: ${parts.join(' · ')}`.slice(0, 1000),
          createdBy: ctx.actor.id,
        },
      });
      ctx.emit(
        OPS_EVENTS.zoho.shipmentConfirmed,
        {
          deliveryOrderId: order.id,
          requestKey: shipment.requestKey,
          source: input.source,
          zohoShipmentId: readback.zohoShipmentId,
          shipmentNumber: readback.shipmentNumber ?? null,
        },
        eventOptions
      );
    }
    await closeOpenWorkItems(
      ctx,
      { objectType: ORDER, objectId: order.id, kinds: ['external_sync'] },
      { status: 'done', result: { resolution: 'readback_ok', requestKey: shipment.requestKey } }
    );
    publishDeliveryChange(ctx, updated);
    return {
      status: 'completed',
      externalSyncStatus: 'confirmed',
      data: {
        deliveryOrderId: order.id,
        outcome,
        zohoSyncState: updated.zohoSyncState,
        status: updated.status,
      },
    };
  }

  // mismatch: Zoho is the authority of the package.
  const transition = transitionZohoSync(order.zohoSyncState, 'readback_mismatched');
  if (!transition.ok) return { data: { ...base, outcome: 'ignored' } };
  const { differences } = compareShipment(shipment, readback);
  const previousActual = asRecord(order.conflictDetail).actual;
  const repeated =
    order.zohoSyncState === 'readback_mismatch' && sameShipmentReadback(previousActual, readback);
  const conflictDetail = {
    requestKey: shipment.requestKey,
    expected: {
      carrier: shipment.carrier,
      shipmentDate: shipment.shipmentDate,
      trackingNumber: shipment.trackingNumber,
    },
    actual: readback,
    differences,
    source: input.source,
    detectedAt: ctx.now.toISOString(),
  };
  if (repeated) {
    // Same values Zoho already had: nothing to write, no new work nor event.
    const { incident } = await ctx.openIncident({
      kind: 'zoho_conflict',
      areaKey: 'logistica',
      severity: 'medium',
      title: `Zoho guardó otro embarque en ${await caseReference(tx, order.caseId)}`,
      dedupeKey: `zoho_conflict:${order.id}:${shipment.requestKey}`,
      caseId: order.caseId,
      detail: { deliveryOrderId: order.id, ...conflictDetail },
    });
    return {
      status: 'completed',
      externalSyncStatus: 'conflict',
      data: { ...base, outcome, incidentId: incident.id },
    };
  }
  const status = isPhysicalFailure(order)
    ? 'failed'
    : order.status === 'dispatched'
      ? 'dispatched'
      : 'conflict';
  const updated = await tx.deliveryOrder.update({
    where: { id: order.id },
    data: {
      status,
      zohoSyncState: transition.state,
      carrier: readback.carrier ?? order.carrier,
      plannedDate: readback.shipmentDate ? requireDay(readback.shipmentDate) : order.plannedDate,
      zohoShipmentId: readback.zohoShipmentId,
      zohoReadback: readbackJson,
      conflictDetail: toOperationalJson(conflictDetail),
      zohoError: null,
    },
  });
  const ref = await caseReference(tx, order.caseId);
  const { incident, created } = await ctx.openIncident({
    kind: 'zoho_conflict',
    areaKey: 'logistica',
    severity: 'medium',
    title: `Zoho guardó otro embarque en ${ref}`,
    dedupeKey: `zoho_conflict:${order.id}:${shipment.requestKey}`,
    caseId: order.caseId,
    detail: { deliveryOrderId: order.id, ...conflictDetail },
  });
  if (created) {
    await ctx.createWorkItem({
      areaKey: 'logistica',
      kind: 'external_sync',
      title: `Decidir si se reescribe el embarque en Zoho (${ref})`,
      description:
        `${describeDifferences(differences)}. Zoho es la autoridad del paquete y se muestran sus valores. ` +
        'Asigna de nuevo el transporte para volver a escribir, o acepta los valores de Zoho cerrando este trabajo.',
      caseId: order.caseId,
      objectType: ORDER,
      objectId: order.id,
    });
    // Plan 6.6: el dueño del expediente se entera del conflicto con Zoho, no
    // sólo Logística (que lo ve como incidencia y trabajo de sincronización).
    await notifyDeliveryUpdate(ctx, order.caseId, {
      type: 'delivery_zoho_conflict',
      title: (reference) => `Zoho guardó otro embarque en ${reference}`,
      body: describeDifferences(differences),
      entityId: order.id,
      dedupeKey: `delivery_zoho_conflict:${order.id}:${shipment.requestKey}`,
    });
  }
  if (!repeated) {
    ctx.emit(
      OPS_EVENTS.zoho.shipmentConflict,
      {
        deliveryOrderId: order.id,
        requestKey: shipment.requestKey,
        differences,
        incidentId: incident.id,
      },
      eventOptions
    );
  }
  publishDeliveryChange(ctx, updated);
  return {
    status: 'completed',
    externalSyncStatus: 'conflict',
    data: {
      deliveryOrderId: order.id,
      outcome,
      zohoSyncState: updated.zohoSyncState,
      status: updated.status,
      incidentId: incident.id,
    },
  };
}

// ---------------------------------------------------------------------------
// Failures and confirmations reported by the jobs
// ---------------------------------------------------------------------------

export async function recordZohoWriteFailure(
  tx: Tx,
  input: ZohoWriteFailureInput
): Promise<CommandHandlerOutput<ReconcileShipmentResult>> {
  const ctx = requireCommandContext(tx);
  const order = await loadDeliveryOrder(tx, input.deliveryOrderId);
  const base = {
    deliveryOrderId: order.id,
    zohoSyncState: order.zohoSyncState,
    status: order.status,
  };
  const stillOwed =
    input.operation === 'ship'
      ? readShipmentInput(order.shipmentInput)?.requestKey === input.requestKey &&
        order.status !== 'cancelled' &&
        (order.zohoSyncState === 'pending_write' || order.zohoSyncState === 'written')
      : input.operation === 'mark_delivered'
        ? order.zohoSyncState === 'delivered_pending_write'
        : order.status === 'cancelled' && order.zohoSyncState === 'pending_write';
  if (!stillOwed) return { data: { ...base, outcome: 'superseded' } };
  const transition = transitionZohoSync(order.zohoSyncState, 'write_failed');
  if (!transition.ok) return { data: { ...base, outcome: 'ignored' } };

  const status =
    input.operation === 'ship' &&
    ['pending_external', 'assigned', 'conflict'].includes(order.status)
      ? 'failed'
      : order.status;
  const updated = await tx.deliveryOrder.update({
    where: { id: order.id },
    data: {
      status,
      zohoSyncState: transition.state,
      zohoError: input.error.slice(0, 1000),
      zohoLastAttemptAt: ctx.now,
    },
  });
  const ref = await caseReference(tx, order.caseId);
  const label = ZOHO_OPERATION_LABELS[input.operation];
  const { incident, created } = await ctx.openIncident({
    kind: 'zoho_failure',
    areaKey: 'logistica',
    severity: 'high',
    title: `No se pudo ${label} en Zoho (${ref})`,
    dedupeKey: `zoho_failure:${input.operation}:${order.id}:${input.requestKey}`,
    caseId: order.caseId,
    detail: {
      deliveryOrderId: order.id,
      operation: input.operation,
      requestKey: input.requestKey,
      error: input.error,
      attempts: input.attempts,
    },
  });
  if (created) {
    const next =
      input.operation === 'ship'
        ? 'Revisa el paquete en Zoho y vuelve a asignar el transporte cuando Zoho responda.'
        : 'Hazlo directamente en Zoho o espera: la conciliación de cada 30 minutos relee el paquete y lo confirma.';
    await ctx.createWorkItem({
      areaKey: 'logistica',
      kind: 'external_sync',
      title: `Resolver falla de Zoho al ${label} (${ref})`,
      description:
        `Zoho no aceptó la escritura tras ${input.attempts} intento(s): ${input.error}. ${next}`.slice(
          0,
          2000
        ),
      caseId: order.caseId,
      objectType: ORDER,
      objectId: order.id,
    });
  }
  ctx.emit(
    OPS_EVENTS.zoho.shipmentFailed,
    {
      deliveryOrderId: order.id,
      operation: input.operation,
      requestKey: input.requestKey,
      error: input.error.slice(0, 500),
      attempts: input.attempts,
      incidentId: incident.id,
    },
    { caseId: order.caseId, areaKey: 'logistica', objectType: ORDER, objectId: order.id }
  );
  publishDeliveryChange(ctx, updated);
  return {
    status: 'completed',
    externalSyncStatus: 'failed',
    data: {
      deliveryOrderId: order.id,
      outcome: 'ignored',
      zohoSyncState: updated.zohoSyncState,
      status: updated.status,
      incidentId: incident.id,
    },
  };
}

export async function confirmZohoDelivered(
  tx: Tx,
  input: ZohoConfirmationInput
): Promise<CommandHandlerOutput<ReconcileShipmentResult>> {
  const ctx = requireCommandContext(tx);
  const order = await loadDeliveryOrder(tx, input.deliveryOrderId);
  const base = {
    deliveryOrderId: order.id,
    zohoSyncState: order.zohoSyncState,
    status: order.status,
  };
  if (order.status !== 'delivered' && order.status !== 'partially_delivered') {
    return { data: { ...base, outcome: 'ignored' } };
  }
  const transition = transitionZohoSync(order.zohoSyncState, 'delivery_written');
  if (!transition.ok || !transition.changed) return { data: { ...base, outcome: 'ignored' } };
  const updated = await tx.deliveryOrder.update({
    where: { id: order.id },
    data: { zohoSyncState: transition.state, zohoError: null, zohoLastAttemptAt: ctx.now },
  });
  await tx.evidenceLink.create({
    data: {
      caseId: order.caseId,
      objectType: ORDER,
      objectId: order.id,
      kind: 'zoho_readback',
      note:
        input.source === 'mock'
          ? 'Entrega marcada en Zoho (simulado)'
          : 'Zoho marcó el paquete como entregado',
      createdBy: ctx.actor.id,
    },
  });
  await closeOpenWorkItems(
    ctx,
    { objectType: ORDER, objectId: order.id, kinds: ['external_sync'] },
    { status: 'done', result: { resolution: 'delivered_written' } }
  );
  ctx.emit(
    OPS_EVENTS.zoho.deliveredMarked,
    { deliveryOrderId: order.id, source: input.source },
    { caseId: order.caseId, areaKey: 'logistica', objectType: ORDER, objectId: order.id }
  );
  publishDeliveryChange(ctx, updated);
  return {
    externalSyncStatus: 'confirmed',
    data: {
      deliveryOrderId: order.id,
      outcome: 'match',
      zohoSyncState: updated.zohoSyncState,
      status: updated.status,
    },
  };
}

export async function confirmZohoShipmentCancelled(
  tx: Tx,
  input: ZohoConfirmationInput
): Promise<CommandHandlerOutput<ReconcileShipmentResult>> {
  const ctx = requireCommandContext(tx);
  const order = await loadDeliveryOrder(tx, input.deliveryOrderId);
  const base = {
    deliveryOrderId: order.id,
    zohoSyncState: order.zohoSyncState,
    status: order.status,
  };
  if (order.status !== 'cancelled') return { data: { ...base, outcome: 'ignored' } };
  const transition = transitionZohoSync(order.zohoSyncState, 'shipment_cancelled');
  if (!transition.ok || !transition.changed) return { data: { ...base, outcome: 'ignored' } };
  const updated = await tx.deliveryOrder.update({
    where: { id: order.id },
    data: {
      zohoSyncState: transition.state,
      zohoShipmentId: null,
      zohoError: null,
      zohoLastAttemptAt: ctx.now,
    },
  });
  await closeOpenWorkItems(
    ctx,
    { objectType: ORDER, objectId: order.id, kinds: ['external_sync'] },
    { status: 'done', result: { resolution: 'shipment_cancelled' } }
  );
  ctx.emit(
    OPS_EVENTS.zoho.shipmentCancelled,
    { deliveryOrderId: order.id, source: input.source },
    { caseId: order.caseId, areaKey: 'logistica', objectType: ORDER, objectId: order.id }
  );
  publishDeliveryChange(ctx, updated);
  return {
    externalSyncStatus: 'confirmed',
    data: {
      deliveryOrderId: order.id,
      outcome: 'match',
      zohoSyncState: updated.zohoSyncState,
      status: updated.status,
    },
  };
}

// ---------------------------------------------------------------------------
// Accepting Zoho's values of a conflict
// ---------------------------------------------------------------------------

/**
 * Closing the conflict decision without writing again accepts what Zoho keeps
 * (Zoho is the authority of the package, plan §4.2): the stored shipment input
 * becomes Zoho's read-back, the order is confirmed and the `zoho_conflict`
 * incident is resolved, so the case moves on. False when there is no conflict.
 */
export async function acceptZohoShipmentInTx(tx: Tx, deliveryOrderId: string): Promise<boolean> {
  const ctx = requireCommandContext(tx);
  const order = await loadDeliveryOrder(tx, deliveryOrderId);
  if (order.zohoSyncState !== 'readback_mismatch') return false;
  const shipment = readShipmentInput(order.shipmentInput);
  const actual = shipmentReadbackSchema.safeParse(asRecord(order.conflictDetail).actual);
  if (!shipment || !actual.success) return false;
  const transition = transitionZohoSync(order.zohoSyncState, 'readback_matched');
  if (!transition.ok) return false;
  const readback = actual.data;
  const accepted = {
    ...shipment,
    carrier: readback.carrier ?? shipment.carrier,
    shipmentDate: readback.shipmentDate ?? shipment.shipmentDate,
    trackingNumber: readback.trackingNumber,
    acceptedFromZohoAt: ctx.now.toISOString(),
    acceptedBy: actorUserId(ctx),
  };
  const updated = await bumpDeliveryOrder(tx, order, {
    status: await confirmedStatus(tx, order),
    zohoSyncState: transition.state,
    shipmentInput: toOperationalJson(accepted),
    conflictDetail: Prisma.DbNull,
    carrier: readback.carrier ?? order.carrier,
    zohoShipmentId: readback.zohoShipmentId ?? order.zohoShipmentId,
    zohoError: null,
  });
  await tx.evidenceLink.create({
    data: {
      caseId: order.caseId,
      objectType: ORDER,
      objectId: order.id,
      kind: 'zoho_readback',
      note: `Se aceptaron los valores de Zoho: ${[
        accepted.carrier,
        accepted.shipmentDate,
        accepted.trackingNumber ? `guía ${accepted.trackingNumber}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}`.slice(0, 1000),
      createdBy: ctx.actor.id,
    },
  });
  const incident = await tx.incident.findUnique({
    where: { dedupeKey: `zoho_conflict:${order.id}:${shipment.requestKey}` },
  });
  if (incident && ['open', 'acknowledged'].includes(incident.status)) {
    await transitionIncidentInTx(tx, incident, 'resolve', {
      resolution: 'Se aceptaron los valores del embarque que guardó Zoho',
    });
  }
  ctx.emit(
    OPS_EVENTS.zoho.shipmentConfirmed,
    {
      deliveryOrderId: order.id,
      requestKey: shipment.requestKey,
      source: 'accepted_zoho_values',
      zohoShipmentId: readback.zohoShipmentId,
      shipmentNumber: readback.shipmentNumber ?? null,
    },
    { caseId: order.caseId, areaKey: 'logistica', objectType: ORDER, objectId: order.id }
  );
  publishDeliveryChange(ctx, updated);
  return true;
}

// The conflict work item (kind external_sync on the delivery order) is the decision:
// rewriting goes through `delivery.assign_transport`; closing it accepts Zoho's values.
registerWorkItemHooks(
  ORDER,
  {
    async afterComplete({ tx, item }) {
      if (item.kind !== 'external_sync' || !item.objectId) return;
      await acceptZohoShipmentInTx(tx, item.objectId);
    },
  },
  'logistics-transport'
);
