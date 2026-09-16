import type { DeliveryOrder, Trip, TripStop } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { OperationsError } from '@/modules/operations/errors';
import { expectedQuantity } from '@/modules/logistics/delivery-rules';
import { getFleetAvailability } from '@/modules/logistics/fleet-service';
import { toNumber, toNumberOrZero } from '@/modules/logistics/logistics-helpers';
import {
  DELIVERY_EVIDENCE_KIND_LABELS,
  DELIVERY_ORDER_OPEN_STATUSES,
  TRIP_ACTIVE_STATUSES,
  type DeliveryEvidenceKind,
} from '@/modules/logistics/types';
import {
  SHIPMENT_FIELD_LABELS,
  ZOHO_SYNC_STATE_LABELS,
  isZohoSyncState,
  type ShipmentField,
} from '@/modules/logistics/zoho-sync-state';
import { markSensitive } from '../area-work-row';
import type { AreaRowDetail, AreaRowEvidence, AreaRowField, AreaWorkRow } from '../area-work-row';
import {
  deliveryModeLabel,
  deliveryStatusLabel,
  deliveryStatusTone,
  formatDayLabel,
  formatTime,
  formatWindow,
  operationDay,
  stopStatusLabel,
  tripProgress,
  tripStatusLabel,
  type DeliveryEvidenceDTO,
  type DeliveryLineDTO,
  type DispatchBoardData,
  type DispatchDelivery,
  type DispatchDriver,
  type DispatchPermissions,
  type DispatchStop,
  type DispatchTrip,
  type DispatchVehicle,
  type FleetOverviewData,
  type TripDetailData,
} from './logistics-view-model';

/**
 * Read model of the Logística surfaces (plan 7.6): the dispatch board, the trip
 * page, the fleet page and the detail of the area's own work rows. SERVER ONLY.
 *
 * Access follows the module permissions, never the area alone: `logistics.view`
 * (or `operations.admin`) reads, `logistics.dispatch` operates, and the driver
 * of a trip sees the trip they are running. Nothing here writes: every change
 * goes through `executeCommand`.
 */

const OPEN_STATUSES: string[] = [...DELIVERY_ORDER_OPEN_STATUSES];
const ACTIVE_TRIPS: string[] = [...TRIP_ACTIVE_STATUSES];
const BOARD_DELIVERY_LIMIT = 300;
const BOARD_TRIP_LIMIT = 60;
const LOCAL_OFFSET_HOURS = 6;

export function logisticsPermissions(actor: CurrentUser): DispatchPermissions {
  return {
    canDispatch: hasPermission(actor, 'logistics.dispatch'),
    canManageFleet: hasPermission(actor, 'logistics.manage_fleet'),
    canWriteZoho: hasPermission(actor, 'logistics.zoho_write'),
    canDrive: hasPermission(actor, 'logistics.drive'),
    canUseAssistant: hasPermission(actor, 'assistant.use'),
  };
}

/** Anyone who may read logistics (the area route already checked the area gate). */
export function assertLogisticsView(actor: CurrentUser): void {
  if (
    hasPermission(actor, 'logistics.view') ||
    hasPermission(actor, 'logistics.dispatch') ||
    hasPermission(actor, 'operations.admin')
  ) {
    return;
  }
  throw new OperationsError('forbidden', 'No tienes permiso para ver la operación de Logística');
}

export function assertDispatch(actor: CurrentUser): void {
  if (!hasPermission(actor, 'logistics.dispatch')) {
    throw new OperationsError('forbidden', 'Sólo despacho puede operar las entregas y los viajes');
  }
}

function dayRange(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60_000) };
}

function instantRange(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  start.setUTCHours(start.getUTCHours() + LOCAL_OFFSET_HOURS);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60_000) };
}

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

function coordinates(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const latitude = toNumber(lat as never);
  const longitude = toNumber(lng as never);
  return latitude !== null && longitude !== null ? { lat: latitude, lng: longitude } : null;
}

function readDifferences(conflictDetail: unknown): DispatchDelivery['zohoDifferences'] {
  if (!conflictDetail || typeof conflictDetail !== 'object') return [];
  const raw = (conflictDetail as Record<string, unknown>).differences;
  if (!Array.isArray(raw)) return [];
  const out: DispatchDelivery['zohoDifferences'] = [];
  for (const entry of raw.slice(0, 5)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const field = typeof record.field === 'string' ? (record.field as ShipmentField) : null;
    if (!field || !(field in SHIPMENT_FIELD_LABELS)) continue;
    out.push({
      label: SHIPMENT_FIELD_LABELS[field],
      expected: typeof record.expected === 'string' ? record.expected : null,
      actual: typeof record.actual === 'string' ? record.actual : null,
    });
  }
  return out;
}

function trackingOf(shipmentInput: unknown): string | null {
  if (!shipmentInput || typeof shipmentInput !== 'object') return null;
  const value = (shipmentInput as Record<string, unknown>).trackingNumber;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

interface DeliveryContext {
  cases: Map<
    string,
    { caseNumber: string; salesOrderNumber: string | null; customerName: string | null }
  >;
  trips: Map<string, { number: string }>;
  vehicles: Map<string, { label: string; code: string }>;
  drivers: Map<string, { name: string }>;
  lines: Map<string, DeliveryLineDTO[]>;
  evidence: Map<string, number>;
}

function toDispatchDelivery(order: DeliveryOrder, context: DeliveryContext): DispatchDelivery {
  const reference = context.cases.get(order.caseId);
  const lines = context.lines.get(order.id) ?? [];
  return {
    id: order.id,
    version: order.version,
    status: order.status,
    statusLabel: deliveryStatusLabel(order.status),
    tone: deliveryStatusTone(order.status),
    mode: order.mode,
    modeLabel: deliveryModeLabel(order.mode),
    caseId: order.caseId,
    caseNumber: reference?.caseNumber ?? null,
    salesOrderNumber: reference?.salesOrderNumber ?? null,
    customerName: reference?.customerName ?? order.contactName ?? null,
    carrier: order.carrier,
    trackingNumber: trackingOf(order.shipmentInput),
    plannedDate: iso(order.plannedDate),
    windowStart: iso(order.windowStart),
    windowEnd: iso(order.windowEnd),
    address: {
      line: order.addressLine,
      city: order.city,
      state: order.state,
      postalCode: order.postalCode,
    },
    contact: { name: order.contactName, phone: order.contactPhone },
    coordinates: coordinates(order.lat, order.lng),
    tripId: order.tripId,
    tripNumber: order.tripId ? (context.trips.get(order.tripId)?.number ?? null) : null,
    vehicleId: order.vehicleId,
    vehicleLabel: order.vehicleId ? (context.vehicles.get(order.vehicleId)?.label ?? null) : null,
    driverId: order.driverId,
    driverName: order.driverId ? (context.drivers.get(order.driverId)?.name ?? null) : null,
    packageId: order.packageId,
    zohoPackageId: order.zohoPackageId,
    zohoSyncState: order.zohoSyncState,
    zohoError: order.zohoError,
    zohoDifferences: readDifferences(order.conflictDetail),
    lines,
    pendingUnits: lines.reduce((sum, line) => sum + line.pendingQuantity, 0),
    evidenceCount: context.evidence.get(order.id) ?? 0,
    deliveredAt: iso(order.deliveredAt),
    receivedBy: order.receivedBy,
    partialReason: order.partialReason,
    open: OPEN_STATUSES.includes(order.status),
  };
}

/** Lines still owed by each delivery order (allocation + demand of the case). */
async function loadLines(orders: DeliveryOrder[]): Promise<Map<string, DeliveryLineDTO[]>> {
  const allocationIds = [...new Set(orders.flatMap((order) => order.allocationIds))];
  if (allocationIds.length === 0) return new Map();
  const allocations = await prisma.demandAllocation.findMany({
    where: { id: { in: allocationIds } },
    select: { id: true, demandId: true, quantity: true, deliveredQuantity: true },
  });
  const demandIds = [...new Set(allocations.map((allocation) => allocation.demandId))];
  const demands =
    demandIds.length > 0
      ? await prisma.caseDemand.findMany({
          where: { id: { in: demandIds } },
          select: { id: true, sku: true, name: true, baseUnit: true },
        })
      : [];
  const allocationById = new Map(allocations.map((allocation) => [allocation.id, allocation]));
  const demandById = new Map(demands.map((demand) => [demand.id, demand]));

  const byOrder = new Map<string, DeliveryLineDTO[]>();
  for (const order of orders) {
    const lines: DeliveryLineDTO[] = [];
    for (const allocationId of order.allocationIds) {
      const allocation = allocationById.get(allocationId);
      if (!allocation) continue;
      const demand = demandById.get(allocation.demandId);
      const quantity = toNumberOrZero(allocation.quantity);
      const deliveredQuantity = toNumberOrZero(allocation.deliveredQuantity);
      lines.push({
        allocationId: allocation.id,
        demandId: allocation.demandId,
        sku: demand?.sku ?? null,
        name: demand?.name ?? 'Artículo',
        unit: demand?.baseUnit ?? '',
        quantity,
        deliveredQuantity,
        pendingQuantity: expectedQuantity({
          allocationId: allocation.id,
          demandId: allocation.demandId,
          quantity,
          deliveredQuantity,
        }),
      });
    }
    byOrder.set(order.id, lines);
  }
  return byOrder;
}

async function buildContext(orders: DeliveryOrder[]): Promise<DeliveryContext> {
  const caseIds = [...new Set(orders.map((order) => order.caseId))];
  const tripIds = [
    ...new Set(orders.map((order) => order.tripId).filter((id): id is string => Boolean(id))),
  ];
  const vehicleIds = [
    ...new Set(orders.map((order) => order.vehicleId).filter((id): id is string => Boolean(id))),
  ];
  const driverIds = [
    ...new Set(orders.map((order) => order.driverId).filter((id): id is string => Boolean(id))),
  ];
  const orderIds = orders.map((order) => order.id);

  const [cases, trips, vehicles, drivers, evidence, lines] = await Promise.all([
    caseIds.length > 0
      ? prisma.operationalCase.findMany({
          where: { id: { in: caseIds } },
          select: { id: true, caseNumber: true, salesOrderNumber: true, customerName: true },
        })
      : Promise.resolve([]),
    tripIds.length > 0
      ? prisma.trip.findMany({ where: { id: { in: tripIds } }, select: { id: true, number: true } })
      : Promise.resolve([]),
    vehicleIds.length > 0
      ? prisma.vehicle.findMany({
          where: { id: { in: vehicleIds } },
          select: { id: true, label: true, code: true },
        })
      : Promise.resolve([]),
    driverIds.length > 0
      ? prisma.driver.findMany({
          where: { id: { in: driverIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    orderIds.length > 0
      ? prisma.deliveryEvidence.groupBy({
          by: ['deliveryOrderId'],
          where: {
            deliveryOrderId: { in: orderIds },
            kind: { in: ['photo', 'signature'] },
            storageObjectId: { not: null },
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    loadLines(orders),
  ]);

  return {
    cases: new Map(
      cases.map((row) => [
        row.id,
        {
          caseNumber: row.caseNumber,
          salesOrderNumber: row.salesOrderNumber,
          customerName: row.customerName,
        },
      ])
    ),
    trips: new Map(trips.map((row) => [row.id, { number: row.number }])),
    vehicles: new Map(vehicles.map((row) => [row.id, { label: row.label, code: row.code }])),
    drivers: new Map(drivers.map((row) => [row.id, { name: row.name }])),
    lines,
    evidence: new Map(
      (evidence as Array<{ deliveryOrderId: string; _count: { _all: number } }>).map((row) => [
        row.deliveryOrderId,
        row._count._all,
      ])
    ),
  };
}

function toDispatchStop(stop: TripStop): DispatchStop {
  return {
    id: stop.id,
    sequence: stop.sequence,
    status: stop.status,
    statusLabel: stopStatusLabel(stop.status),
    etaAt: iso(stop.etaAt),
    arrivedAt: iso(stop.arrivedAt),
    departedAt: iso(stop.departedAt),
    deliveryOrderId: stop.deliveryOrderId,
    coordinates: coordinates(stop.lat, stop.lng),
  };
}

function toDispatchTrip(
  trip: Trip,
  stops: TripStop[],
  vehicle: { id: string; code: string; label: string; plate: string } | null,
  driver: { id: string; name: string; phone: string | null } | null
): DispatchTrip {
  return {
    id: trip.id,
    version: trip.version,
    number: trip.number,
    date: trip.date.toISOString().slice(0, 10),
    status: trip.status,
    statusLabel: tripStatusLabel(trip.status),
    startedAt: iso(trip.startedAt),
    endedAt: iso(trip.endedAt),
    notes: trip.notes,
    vehicle,
    driver,
    stops: stops
      .filter((stop) => stop.tripId === trip.id)
      .sort((a, b) => a.sequence - b.sequence)
      .map(toDispatchStop),
  };
}

// ---------------------------------------------------------------------------
// Dispatch board
// ---------------------------------------------------------------------------

export async function getDispatchBoard(
  actor: CurrentUser,
  options: { date: string; now?: Date }
): Promise<DispatchBoardData> {
  assertLogisticsView(actor);
  const now = options.now ?? new Date();
  const day = dayRange(options.date);
  const instants = instantRange(options.date);

  const trips = await prisma.trip.findMany({
    where: {
      OR: [
        { date: { gte: day.start, lt: day.end } },
        { status: 'en_route', date: { lt: day.end } },
      ],
    },
    orderBy: [{ date: 'asc' }, { number: 'asc' }],
    take: BOARD_TRIP_LIMIT,
  });
  const tripIds = trips.map((trip) => trip.id);

  const [stops, orders, fleet] = await Promise.all([
    tripIds.length > 0
      ? prisma.tripStop.findMany({
          where: { tripId: { in: tripIds } },
          orderBy: [{ tripId: 'asc' }, { sequence: 'asc' }],
        })
      : Promise.resolve([]),
    prisma.deliveryOrder.findMany({
      where: {
        OR: [
          { status: { in: OPEN_STATUSES }, plannedDate: { lt: day.end } },
          { status: { in: OPEN_STATUSES }, plannedDate: null },
          ...(tripIds.length > 0 ? [{ tripId: { in: tripIds } }] : []),
          {
            status: { in: ['delivered', 'partially_delivered'] },
            deliveredAt: { gte: instants.start, lt: instants.end },
          },
        ],
      },
      orderBy: [{ plannedDate: 'asc' }, { createdAt: 'asc' }],
      take: BOARD_DELIVERY_LIMIT,
    }),
    getFleetAvailability(options.date).catch(() => null),
  ]);

  const context = await buildContext(orders);
  const vehicleIds = [...new Set(trips.map((trip) => trip.vehicleId))];
  const driverIds = [...new Set(trips.map((trip) => trip.driverId))];
  const [tripVehicles, tripDrivers] = await Promise.all([
    vehicleIds.length > 0
      ? prisma.vehicle.findMany({
          where: { id: { in: vehicleIds } },
          select: { id: true, code: true, label: true, plate: true },
        })
      : Promise.resolve([]),
    driverIds.length > 0
      ? prisma.driver.findMany({
          where: { id: { in: driverIds } },
          select: { id: true, name: true, phone: true },
        })
      : Promise.resolve([]),
  ]);
  const vehicleById = new Map(tripVehicles.map((row) => [row.id, row]));
  const driverById = new Map(tripDrivers.map((row) => [row.id, row]));

  const deliveries = orders.map((order) => toDispatchDelivery(order, context));
  const dispatchTrips = trips.map((trip) =>
    toDispatchTrip(
      trip,
      stops,
      vehicleById.get(trip.vehicleId) ?? null,
      driverById.get(trip.driverId) ?? null
    )
  );

  const vehicles: DispatchVehicle[] = (fleet?.vehicles ?? []).map((vehicle) => ({
    id: vehicle.id,
    code: vehicle.code,
    plate: vehicle.plate,
    label: vehicle.label,
    capacityKg: vehicle.capacityKg,
    capacityM2: vehicle.capacityM2,
    capacityPieces: vehicle.capacityPieces,
    maintenanceUntil: vehicle.maintenanceUntil,
    active: vehicle.active,
    available: vehicle.available,
    reasons: vehicle.reasons,
  }));
  const drivers: DispatchDriver[] = (fleet?.drivers ?? []).map((driver) => ({
    id: driver.id,
    name: driver.name,
    phone: driver.phone,
    licenseNumber: driver.licenseNumber,
    userId: driver.userId,
    active: driver.active,
    available: driver.available,
    reasons: driver.reasons,
  }));

  const open = deliveries.filter((delivery) => delivery.open);
  return {
    date: options.date,
    generatedAt: now.toISOString(),
    deliveries,
    trips: dispatchTrips,
    vehicles,
    drivers,
    permissions: logisticsPermissions(actor),
    counters: {
      unassigned: open.filter((delivery) => !delivery.tripId).length,
      onTrips: open.filter((delivery) => Boolean(delivery.tripId)).length,
      inTransit: open.filter((delivery) => delivery.status === 'dispatched').length,
      zohoPending: open.filter(
        (delivery) => delivery.status === 'pending_external' || delivery.status === 'conflict'
      ).length,
      failed: open.filter((delivery) => delivery.status === 'failed').length,
      tripsActive: dispatchTrips.filter((trip) => ACTIVE_TRIPS.includes(trip.status)).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Trip detail
// ---------------------------------------------------------------------------

async function evidenceOf(orderIds: string[]): Promise<Record<string, DeliveryEvidenceDTO[]>> {
  if (orderIds.length === 0) return {};
  const rows = await prisma.deliveryEvidence.findMany({
    where: { deliveryOrderId: { in: orderIds } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const userIds = [...new Set(rows.map((row) => row.createdBy))];
  const users =
    userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : [];
  const names = new Map(users.map((user) => [user.id, user.name]));
  const out: Record<string, DeliveryEvidenceDTO[]> = {};
  for (const row of rows) {
    const list = out[row.deliveryOrderId] ?? [];
    list.push({
      id: row.id,
      kind: row.kind,
      kindLabel: DELIVERY_EVIDENCE_KIND_LABELS[row.kind as DeliveryEvidenceKind] ?? row.kind,
      note: row.note,
      storageObjectId: row.storageObjectId,
      createdAt: row.createdAt.toISOString(),
      createdByName: names.get(row.createdBy) ?? null,
    });
    out[row.deliveryOrderId] = list;
  }
  return out;
}

export async function getTripDetail(
  actor: CurrentUser,
  tripId: string,
  options: { now?: Date } = {}
): Promise<TripDetailData | null> {
  assertLogisticsView(actor);
  const now = options.now ?? new Date();
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) return null;

  const [stops, vehicle, driver] = await Promise.all([
    prisma.tripStop.findMany({ where: { tripId: trip.id }, orderBy: { sequence: 'asc' } }),
    prisma.vehicle.findUnique({
      where: { id: trip.vehicleId },
      select: { id: true, code: true, label: true, plate: true },
    }),
    prisma.driver.findUnique({
      where: { id: trip.driverId },
      select: { id: true, name: true, phone: true, userId: true, active: true },
    }),
  ]);
  const orderIds = [...new Set(stops.map((stop) => stop.deliveryOrderId))];
  const orders =
    orderIds.length > 0
      ? await prisma.deliveryOrder.findMany({ where: { id: { in: orderIds } } })
      : [];
  const context = await buildContext(orders);
  const evidence = await evidenceOf(orderIds);

  return {
    trip: toDispatchTrip(
      trip,
      stops,
      vehicle ?? null,
      driver ? { id: driver.id, name: driver.name, phone: driver.phone } : null
    ),
    deliveries: orders.map((order) => toDispatchDelivery(order, context)),
    evidence,
    permissions: logisticsPermissions(actor),
    isDriver: Boolean(driver?.active && driver.userId === actor.id),
    generatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export async function getFleetOverview(
  actor: CurrentUser,
  options: { date?: string; now?: Date } = {}
): Promise<FleetOverviewData> {
  assertLogisticsView(actor);
  const now = options.now ?? new Date();
  const date = options.date ?? operationDay(now);
  const [fleet, trips] = await Promise.all([
    getFleetAvailability(date),
    prisma.trip.findMany({
      where: { status: { in: ACTIVE_TRIPS } },
      orderBy: [{ date: 'asc' }],
      take: 100,
      select: { id: true, number: true, date: true, status: true, vehicleId: true, driverId: true },
    }),
  ]);

  return {
    date: fleet.date,
    vehicles: fleet.vehicles.map((vehicle) => ({
      id: vehicle.id,
      code: vehicle.code,
      plate: vehicle.plate,
      label: vehicle.label,
      capacityKg: vehicle.capacityKg,
      capacityM2: vehicle.capacityM2,
      capacityPieces: vehicle.capacityPieces,
      maintenanceUntil: vehicle.maintenanceUntil,
      active: vehicle.active,
      available: vehicle.available,
      reasons: vehicle.reasons,
    })),
    drivers: fleet.drivers.map((driver) => ({
      id: driver.id,
      name: driver.name,
      phone: driver.phone,
      licenseNumber: driver.licenseNumber,
      userId: driver.userId,
      active: driver.active,
      available: driver.available,
      reasons: driver.reasons,
    })),
    trips: trips.map((trip) => ({
      id: trip.id,
      number: trip.number,
      date: trip.date.toISOString().slice(0, 10),
      status: trip.status,
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
    })),
    permissions: logisticsPermissions(actor),
    generatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Row detail of the work centre
// ---------------------------------------------------------------------------

function field(
  label: string,
  value: string | null | undefined,
  hint?: string | null
): AreaRowField | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? { label, value: text, hint: hint ?? null } : null;
}

function compact(fields: Array<AreaRowField | null>): AreaRowField[] {
  return fields.filter((entry): entry is AreaRowField => entry !== null);
}

function zohoStateLabel(state: string): string {
  return isZohoSyncState(state) ? ZOHO_SYNC_STATE_LABELS[state] : state;
}

async function deliveryRowDetail(order: DeliveryOrder): Promise<Partial<AreaRowDetail>> {
  const context = await buildContext([order]);
  const delivery = toDispatchDelivery(order, context);
  const evidence = await evidenceOf([order.id]);
  const lines = delivery.lines
    .map((line) => `${line.name} · ${line.pendingQuantity} ${line.unit}`.trim())
    .slice(0, 8)
    .join('; ');
  const differences = delivery.zohoDifferences
    .map(
      (entry) =>
        `${entry.label}: UNIK "${entry.expected ?? 'vacío'}" · Zoho "${entry.actual ?? 'vacío'}"`
    )
    .join(' · ');

  const rows: AreaRowEvidence[] = (evidence[order.id] ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    label: item.kindLabel,
    note: item.note,
    createdAt: item.createdAt,
    createdByName: item.createdByName,
    storageObjectId: item.storageObjectId,
  }));

  return {
    fields: compact([
      field('Estado', delivery.statusLabel),
      field('Modo de entrega', delivery.modeLabel),
      field('Transportista', delivery.carrier ?? delivery.vehicleLabel),
      field('Guía', delivery.trackingNumber),
      field('Chofer', delivery.driverName),
      field('Viaje', delivery.tripNumber),
      field('Fecha planeada', delivery.plannedDate ? formatDayLabel(delivery.plannedDate) : null),
      field('Ventana', formatWindow(delivery.windowStart, delivery.windowEnd)),
      field(
        'Dirección',
        [delivery.address.line, delivery.address.city, delivery.address.state]
          .filter(Boolean)
          .join(', ')
      ),
      // Nombre + teléfono de quien recibe: dato de contacto, igual que en el grafo.
      markSensitive(
        field(
          'Contacto',
          [delivery.contact.name, delivery.contact.phone].filter(Boolean).join(' · ')
        ),
        'contact'
      ),
      field('Paquete de Zoho', delivery.zohoPackageId ?? (delivery.packageId ? 'Enlazado' : null)),
      field(
        'Sincronización con Zoho',
        zohoStateLabel(delivery.zohoSyncState),
        differences || delivery.zohoError
      ),
      field('Líneas por entregar', lines),
      field('Entregada', delivery.deliveredAt ? formatDayLabel(delivery.deliveredAt) : null),
      field('Recibió', delivery.receivedBy),
      field('Motivo de la entrega parcial', delivery.partialReason),
    ]),
    evidence: rows,
    // Delivery evidence has its own upload target and its own rules (only the
    // assigned driver or dispatch, and only while the delivery is open): it is
    // attached from Despacho, from the trip page or from the driver PWA.
    evidenceTargetId: null,
    missingEvidence: [],
    freeText: null,
  };
}

async function tripRowDetail(trip: Trip): Promise<Partial<AreaRowDetail>> {
  const [stops, vehicle, driver] = await Promise.all([
    prisma.tripStop.findMany({ where: { tripId: trip.id }, orderBy: { sequence: 'asc' } }),
    prisma.vehicle.findUnique({
      where: { id: trip.vehicleId },
      select: { code: true, label: true, plate: true },
    }),
    prisma.driver.findUnique({
      where: { id: trip.driverId },
      select: { name: true, phone: true, active: true },
    }),
  ]);
  const progress = tripProgress(stops.map((stop) => ({ status: stop.status })));
  const nextStop = stops.find((stop) => stop.status === 'pending' || stop.status === 'arrived');

  return {
    fields: compact([
      field('Viaje', trip.number),
      field('Estado', tripStatusLabel(trip.status)),
      field('Fecha', formatDayLabel(trip.date.toISOString())),
      field('Unidad', vehicle ? `${vehicle.label} · ${vehicle.plate}` : null),
      field(
        'Chofer',
        driver ? driver.name : null,
        driver && !driver.active ? 'El chofer está inactivo' : driver?.phone
      ),
      field('Paradas', progress.label),
      field(
        'Siguiente parada',
        nextStop ? `#${nextStop.sequence} · ${stopStatusLabel(nextStop.status)}` : null
      ),
      field('Salida', trip.startedAt ? formatTime(trip.startedAt.toISOString()) : null),
      field('Cierre', trip.endedAt ? formatTime(trip.endedAt.toISOString()) : null),
      field('Notas', trip.notes),
    ]),
    evidence: [],
    evidenceTargetId: null,
    missingEvidence: [],
    freeText: null,
  };
}

/** Detail of the area's own rows (`delivery_order`, `trip`); null for anything else. */
export async function getLogisticsRowDetail(
  actor: CurrentUser,
  row: AreaWorkRow
): Promise<Partial<AreaRowDetail> | null> {
  assertLogisticsView(actor);
  if (row.rowKind === 'delivery_order') {
    const order = await prisma.deliveryOrder.findUnique({ where: { id: row.sourceId } });
    return order ? deliveryRowDetail(order) : null;
  }
  if (row.rowKind === 'trip') {
    const trip = await prisma.trip.findUnique({ where: { id: row.sourceId } });
    return trip ? tripRowDetail(trip) : null;
  }
  return null;
}
