/**
 * Vocabulary of the logistics module (plan sections 4 and 6.3): delivery
 * modes, the states of DeliveryOrder / Trip / TripStop / DeliveryEvidence (kept
 * identical to the `///` comments in prisma/schema.prisma), command and job
 * names, event types and realtime channels.
 *
 * Pure module (no Prisma, no server imports): safe for client components.
 */

// ---------------------------------------------------------------------------
// DeliveryOrder
// ---------------------------------------------------------------------------

export const DELIVERY_MODES = [
  'own_fleet',
  'carrier',
  'customer_pickup',
  'direct_supplier',
] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const DELIVERY_MODE_LABELS: Record<DeliveryMode, string> = {
  own_fleet: 'Flotilla propia',
  carrier: 'Paquetería o transportista',
  customer_pickup: 'Recoge el cliente',
  direct_supplier: 'Entrega directa del proveedor',
};

/**
 * Modes that ship through Zoho (a shipment order is written on the package).
 * It is a tuple so it can also be the list of modes offered when transport is
 * assigned (`assignTransport` accepts `mode`, and the dialog builds its select
 * from here): own fleet or an external carrier, never a pickup.
 */
export const SHIPPING_MODES = ['own_fleet', 'carrier'] as const;
export type ShippingMode = (typeof SHIPPING_MODES)[number];

export function isShippingMode(value: unknown): value is ShippingMode {
  return typeof value === 'string' && (SHIPPING_MODES as readonly string[]).includes(value);
}

export const DELIVERY_ORDER_STATUSES = [
  'pending',
  'planned',
  'assigned',
  'pending_external',
  'conflict',
  'dispatched',
  'delivered',
  'partially_delivered',
  'failed',
  'cancelled',
] as const;
export type DeliveryOrderStatus = (typeof DELIVERY_ORDER_STATUSES)[number];

/** A delivery that still needs somebody (also holds its allocations). */
export const DELIVERY_ORDER_OPEN_STATUSES = [
  'pending',
  'planned',
  'assigned',
  'pending_external',
  'conflict',
  'dispatched',
  'failed',
] as const;

export const DELIVERY_ORDER_CLOSED_STATUSES = [
  'delivered',
  'partially_delivered',
  'cancelled',
] as const;

/** Statuses from which transport can be (re)assigned. */
export const TRANSPORT_ASSIGNABLE_STATUSES = [
  'pending',
  'planned',
  'assigned',
  'pending_external',
  'conflict',
  'failed',
] as const;

/** Statuses a delivery order may have to be put on a trip. */
export const TRIP_ELIGIBLE_STATUSES = TRANSPORT_ASSIGNABLE_STATUSES;

export const DELIVERY_ORDER_STATUS_LABELS: Record<DeliveryOrderStatus, string> = {
  pending: 'Pendiente',
  planned: 'Planeada',
  assigned: 'Transporte asignado',
  pending_external: 'Esperando a Zoho',
  conflict: 'Conflicto con Zoho',
  dispatched: 'En camino',
  delivered: 'Entregada',
  partially_delivered: 'Entregada parcialmente',
  failed: 'Fallida',
  cancelled: 'Cancelada',
};

export function isDeliveryOrderStatus(value: unknown): value is DeliveryOrderStatus {
  return (
    typeof value === 'string' && (DELIVERY_ORDER_STATUSES as readonly string[]).includes(value)
  );
}

export function isDeliveryOrderOpen(status: string): boolean {
  return (DELIVERY_ORDER_OPEN_STATUSES as readonly string[]).includes(status);
}

/** Allocation states whose material is ready to leave (plan: "exige material listo"). */
export const ALLOCATION_DELIVERABLE_STATUSES = ['ready', 'released', 'reopened'] as const;

/** A direct-supplier delivery can be planned while the supplier still works on it. */
export const DIRECT_SUPPLIER_ALLOCATION_STATUSES = [
  'planned',
  'reserved',
  'requested',
  'in_progress',
  'ready',
  'released',
  'reopened',
] as const;

// ---------------------------------------------------------------------------
// Trip / TripStop
// ---------------------------------------------------------------------------

export const TRIP_STATUSES = ['planned', 'en_route', 'done', 'cancelled'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];
export const TRIP_ACTIVE_STATUSES = ['planned', 'en_route'] as const;

export const TRIP_STATUS_LABELS: Record<TripStatus, string> = {
  planned: 'Planeado',
  en_route: 'En ruta',
  done: 'Terminado',
  cancelled: 'Cancelado',
};

export const TRIP_STOP_STATUSES = ['pending', 'arrived', 'done', 'failed'] as const;
export type TripStopStatus = (typeof TRIP_STOP_STATUSES)[number];
export const TRIP_STOP_OPEN_STATUSES = ['pending', 'arrived'] as const;

export const TRIP_STOP_STATUS_LABELS: Record<TripStopStatus, string> = {
  pending: 'Pendiente',
  arrived: 'En el sitio',
  done: 'Entregada',
  failed: 'Fallida',
};

// ---------------------------------------------------------------------------
// DeliveryEvidence
// ---------------------------------------------------------------------------

export const DELIVERY_EVIDENCE_KINDS = ['photo', 'signature', 'note', 'qty_confirmation'] as const;
export type DeliveryEvidenceKind = (typeof DELIVERY_EVIDENCE_KINDS)[number];

/** Only these close a delivery: a photo of the goods or the signature of whoever received. */
export const PHYSICAL_EVIDENCE_KINDS = ['photo', 'signature'] as const;

export const DELIVERY_EVIDENCE_KIND_LABELS: Record<DeliveryEvidenceKind, string> = {
  photo: 'Foto',
  signature: 'Firma',
  note: 'Nota',
  qty_confirmation: 'Confirmación de cantidades',
};

// ---------------------------------------------------------------------------
// Commands, jobs, events, realtime
// ---------------------------------------------------------------------------

export const LOGISTICS_COMMANDS = {
  deliveryCreate: 'delivery.create',
  deliveryLinkPackage: 'delivery.link_package',
  deliveryAssignTransport: 'delivery.assign_transport',
  deliveryRecord: 'delivery.record',
  deliveryCancel: 'delivery.cancel',
  deliveryReconcileShipment: 'delivery.reconcile_shipment',
  deliveryZohoWriteFailed: 'delivery.zoho_write_failed',
  deliveryZohoDelivered: 'delivery.zoho_delivered',
  deliveryZohoShipmentCancelled: 'delivery.zoho_shipment_cancelled',
  tripBuild: 'trip.build',
  tripAddStop: 'trip.add_stop',
  tripReorder: 'trip.reorder',
  tripStart: 'trip.start',
  tripArriveStop: 'trip.arrive_stop',
  tripCompleteStop: 'trip.complete_stop',
  tripFailStop: 'trip.fail_stop',
  tripClose: 'trip.close',
  tripCancel: 'trip.cancel',
  fleetVehicleCreate: 'fleet.vehicle.create',
  fleetVehicleUpdate: 'fleet.vehicle.update',
  fleetDriverCreate: 'fleet.driver.create',
  fleetDriverUpdate: 'fleet.driver.update',
} as const;
export type LogisticsCommandType = (typeof LOGISTICS_COMMANDS)[keyof typeof LOGISTICS_COMMANDS];

/** Aggregate / object types used in commands, events, evidence and relations. */
export const LOGISTICS_OBJECT_TYPES = {
  deliveryOrder: 'delivery_order',
  trip: 'trip',
  tripStop: 'trip_stop',
  vehicle: 'vehicle',
  driver: 'driver',
  package: 'package',
  allocation: 'demand_allocation',
  case: 'operational_case',
  deliveryEvidence: 'delivery_evidence',
} as const;

export const LOGISTICS_JOB_TYPES = {
  shipPackage: 'ops.zoho.ship_package',
  markDelivered: 'ops.zoho.mark_delivered',
  cancelShipment: 'ops.zoho.cancel_shipment',
  reconcile: 'logistics.zoho_reconcile',
} as const;

/** Attempts of every Zoho write job (the queue backs off 1, 2, 3, 4 minutes). */
export const LOGISTICS_ZOHO_MAX_ATTEMPTS = 5;
export const LOGISTICS_RECONCILE_EVERY_MS = 30 * 60_000;

/** Dedupe keys of the Zoho outbox jobs (also stored as `shipmentInput.requestKey`). */
export const zohoShipRequestKey = (deliveryOrderId: string, version: number) =>
  `zoho:ship:${deliveryOrderId}:${version}`;
export const zohoDeliveredKey = (deliveryOrderId: string) => `zoho:delivered:${deliveryOrderId}`;
export const zohoCancelKey = (deliveryOrderId: string) => `zoho:cancel:${deliveryOrderId}`;

/** Actor id recorded in the package audit log when a job writes to Zoho without a requester. */
export const LOGISTICS_SYSTEM_ACTOR_ID = 'system:logistics';

/** Module-specific event types (core ones live in OPS_EVENTS). */
export const LOGISTICS_EVENTS = {
  delivery: {
    packageRequested: 'delivery.package_requested',
    packageLinked: 'delivery.package_linked',
    transportAssigned: 'delivery.transport_assigned',
    modeChanged: 'delivery.mode_changed',
    releasedFromTrip: 'delivery.released_from_trip',
    cancelled: 'delivery.cancelled',
    evidenceAdded: 'delivery.evidence_added',
  },
  trip: {
    built: 'trip.built',
    stopAdded: 'trip.stop_added',
    stopsReordered: 'trip.stops_reordered',
    started: 'trip.started',
    stopArrived: 'trip.stop_arrived',
    stopCompleted: 'trip.stop_completed',
    stopFailed: 'trip.stop_failed',
    closed: 'trip.closed',
    cancelled: 'trip.cancelled',
  },
  fleet: {
    vehicleCreated: 'fleet.vehicle_created',
    vehicleUpdated: 'fleet.vehicle_updated',
    driverCreated: 'fleet.driver_created',
    driverUpdated: 'fleet.driver_updated',
  },
} as const;

export const LOGISTICS_REALTIME = {
  /** Dispatch board (permission `logistics.dispatch`). */
  dispatchChannel: 'logistics:dispatch',
  tripChannel: (tripId: string) => `trip:${tripId}`,
  types: {
    deliveries: 'logistics.deliveries',
    trips: 'logistics.trips',
  },
} as const;

/** Upload target of the driver PWA and the dispatch board (see logistics-storage.ts). */
export const DELIVERY_EVIDENCE_UPLOAD_TARGET = 'delivery_evidence';
export const DELIVERY_EVIDENCE_STORAGE_PURPOSE = 'evidence';
export const DELIVERY_EVIDENCE_MAX_BYTES = 15 * 1024 * 1024;
export const DELIVERY_EVIDENCE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;
