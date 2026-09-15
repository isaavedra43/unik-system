import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { OperationsError } from '@/modules/operations/commands';
import { expectedQuantity } from './delivery-rules';
import { mexicoCityDay, parseDay } from './fleet-rules';
import { toNumber, toNumberOrZero } from './logistics-helpers';
import {
  DELIVERY_EVIDENCE_MAX_BYTES,
  DELIVERY_EVIDENCE_MIME_TYPES,
  DELIVERY_EVIDENCE_UPLOAD_TARGET,
  LOGISTICS_COMMANDS,
} from './types';

/**
 * Read model of the driver PWA (`GET /app/logistics/driver/api/today`, plan
 * section 6.3): the trips of the day of the driver linked to the user (plus
 * any trip still en route from an earlier day), with stops, lines still owed,
 * contact, coordinates, evidence already uploaded, upload targets and the
 * command types the PWA replays from its offline queue.
 *
 * Access: `logistics.drive` sees only the driver linked to the user;
 * `logistics.dispatch` may also look at another driver.
 */

export interface DriverTodayLine {
  allocationId: string;
  demandId: string;
  sku: string | null;
  name: string;
  unit: string;
  quantity: number;
  deliveredQuantity: number;
  pendingQuantity: number;
}

export interface DriverTodayEvidence {
  id: string;
  kind: string;
  storageObjectId: string | null;
  note: string | null;
  createdAt: string;
}

export interface DriverTodayStop {
  stopId: string;
  sequence: number;
  status: string;
  etaAt: string | null;
  arrivedAt: string | null;
  departedAt: string | null;
  deliveryOrder: {
    id: string;
    version: number;
    status: string;
    mode: string;
    zohoSyncState: string;
    caseId: string;
    caseNumber: string | null;
    salesOrderNumber: string | null;
    customerName: string | null;
    address: {
      line: string | null;
      city: string | null;
      state: string | null;
      postalCode: string | null;
    };
    contact: { name: string | null; phone: string | null };
    coordinates: { lat: number; lng: number } | null;
    window: { start: string | null; end: string | null };
    receivedBy: string | null;
    lines: DriverTodayLine[];
    evidence: DriverTodayEvidence[];
    evidenceUpload: {
      photo: { type: string; id: string };
      signature: { type: string; id: string };
      maxBytes: number;
      allowedMimeTypes: string[];
    };
  } | null;
}

export interface DriverTodayTrip {
  tripId: string;
  version: number;
  number: string;
  date: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  notes: string | null;
  vehicle: { id: string; code: string; label: string; plate: string } | null;
  stops: DriverTodayStop[];
}

export interface DriverToday {
  date: string;
  driver: { id: string; name: string; phone: string | null } | null;
  trips: DriverTodayTrip[];
  commands: {
    start: string;
    arrive: string;
    complete: string;
    fail: string;
    close: string;
  };
}

const COMMANDS: DriverToday['commands'] = {
  start: LOGISTICS_COMMANDS.tripStart,
  arrive: LOGISTICS_COMMANDS.tripArriveStop,
  complete: LOGISTICS_COMMANDS.tripCompleteStop,
  fail: LOGISTICS_COMMANDS.tripFailStop,
  close: LOGISTICS_COMMANDS.tripClose,
};

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

export async function getDriverToday(
  user: CurrentUser,
  options: { now?: Date; date?: string; driverId?: string } = {}
): Promise<DriverToday> {
  const dispatcher = hasPermission(user, 'logistics.dispatch');
  if (!dispatcher && !hasPermission(user, 'logistics.drive')) {
    throw new OperationsError('forbidden', 'No tienes permiso para ver los viajes de chofer');
  }
  if (options.driverId && !dispatcher) {
    throw new OperationsError(
      'forbidden',
      'Sólo despacho puede consultar los viajes de otro chofer'
    );
  }
  const day = options.date ?? mexicoCityDay(options.now ?? new Date());
  const date = parseDay(day);
  if (!date) throw new OperationsError('invalid_payload', 'Revisa la fecha (formato AAAA-MM-DD)');

  const driver = options.driverId
    ? await prisma.driver.findUnique({ where: { id: options.driverId } })
    : await prisma.driver.findUnique({ where: { userId: user.id } });
  if (!driver) return { date: day, driver: null, trips: [], commands: COMMANDS };

  const trips = await prisma.trip.findMany({
    where: {
      driverId: driver.id,
      status: { not: 'cancelled' },
      OR: [{ date }, { status: 'en_route', date: { lte: date } }],
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  const tripIds = trips.map((t) => t.id);
  const stops = tripIds.length
    ? await prisma.tripStop.findMany({
        where: { tripId: { in: tripIds } },
        orderBy: [{ tripId: 'asc' }, { sequence: 'asc' }],
      })
    : [];
  const orderIds = [...new Set(stops.map((s) => s.deliveryOrderId))];
  const orders = orderIds.length
    ? await prisma.deliveryOrder.findMany({ where: { id: { in: orderIds } } })
    : [];
  const caseIds = [...new Set(orders.map((o) => o.caseId))];
  const allocationIds = [...new Set(orders.flatMap((o) => o.allocationIds))];
  const vehicleIds = [...new Set(trips.map((t) => t.vehicleId))];
  const [cases, allocations, evidences, vehicles] = await Promise.all([
    caseIds.length
      ? prisma.operationalCase.findMany({
          where: { id: { in: caseIds } },
          select: { id: true, caseNumber: true, salesOrderNumber: true, customerName: true },
        })
      : Promise.resolve([]),
    allocationIds.length
      ? prisma.demandAllocation.findMany({ where: { id: { in: allocationIds } } })
      : Promise.resolve([]),
    orderIds.length
      ? prisma.deliveryEvidence.findMany({
          where: { deliveryOrderId: { in: orderIds } },
          orderBy: { createdAt: 'asc' },
        })
      : Promise.resolve([]),
    vehicleIds.length
      ? prisma.vehicle.findMany({ where: { id: { in: vehicleIds } } })
      : Promise.resolve([]),
  ]);
  const demandIds = [...new Set(allocations.map((a) => a.demandId))];
  const demands = demandIds.length
    ? await prisma.caseDemand.findMany({ where: { id: { in: demandIds } } })
    : [];

  const stopDto = (stop: (typeof stops)[number]): DriverTodayStop => {
    const order = orders.find((o) => o.id === stop.deliveryOrderId);
    if (!order) {
      return {
        stopId: stop.id,
        sequence: stop.sequence,
        status: stop.status,
        etaAt: iso(stop.etaAt),
        arrivedAt: iso(stop.arrivedAt),
        departedAt: iso(stop.departedAt),
        deliveryOrder: null,
      };
    }
    const opCase = cases.find((c) => c.id === order.caseId);
    const lat = toNumber(order.lat);
    const lng = toNumber(order.lng);
    const lines: DriverTodayLine[] = order.allocationIds
      .map((allocationId) => allocations.find((a) => a.id === allocationId))
      .filter((a): a is (typeof allocations)[number] => Boolean(a))
      .map((allocation) => {
        const demand = demands.find((d) => d.id === allocation.demandId);
        const quantity = toNumberOrZero(allocation.quantity);
        const deliveredQuantity = toNumberOrZero(allocation.deliveredQuantity);
        return {
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
        };
      });
    return {
      stopId: stop.id,
      sequence: stop.sequence,
      status: stop.status,
      etaAt: iso(stop.etaAt),
      arrivedAt: iso(stop.arrivedAt),
      departedAt: iso(stop.departedAt),
      deliveryOrder: {
        id: order.id,
        version: order.version,
        status: order.status,
        mode: order.mode,
        zohoSyncState: order.zohoSyncState,
        caseId: order.caseId,
        caseNumber: opCase?.caseNumber ?? null,
        salesOrderNumber: opCase?.salesOrderNumber ?? null,
        customerName: opCase?.customerName ?? null,
        address: {
          line: order.addressLine,
          city: order.city,
          state: order.state,
          postalCode: order.postalCode,
        },
        contact: { name: order.contactName, phone: order.contactPhone },
        coordinates: lat !== null && lng !== null ? { lat, lng } : null,
        window: { start: iso(order.windowStart), end: iso(order.windowEnd) },
        receivedBy: order.receivedBy,
        lines,
        evidence: evidences
          .filter((e) => e.deliveryOrderId === order.id)
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            storageObjectId: e.storageObjectId,
            note: e.note,
            createdAt: e.createdAt.toISOString(),
          })),
        evidenceUpload: {
          photo: { type: DELIVERY_EVIDENCE_UPLOAD_TARGET, id: order.id },
          signature: { type: DELIVERY_EVIDENCE_UPLOAD_TARGET, id: `${order.id}:signature` },
          maxBytes: DELIVERY_EVIDENCE_MAX_BYTES,
          allowedMimeTypes: [...DELIVERY_EVIDENCE_MIME_TYPES],
        },
      },
    };
  };

  return {
    date: day,
    driver: { id: driver.id, name: driver.name, phone: driver.phone },
    trips: trips.map((trip) => {
      const vehicle = vehicles.find((v) => v.id === trip.vehicleId);
      return {
        tripId: trip.id,
        version: trip.version,
        number: trip.number,
        date: trip.date.toISOString().slice(0, 10),
        status: trip.status,
        startedAt: iso(trip.startedAt),
        endedAt: iso(trip.endedAt),
        notes: trip.notes,
        vehicle: vehicle
          ? { id: vehicle.id, code: vehicle.code, label: vehicle.label, plate: vehicle.plate }
          : null,
        stops: stops.filter((s) => s.tripId === trip.id).map(stopDto),
      };
    }),
    commands: COMMANDS,
  };
}
