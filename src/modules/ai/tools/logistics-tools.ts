import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  DELIVERY_ORDER_OPEN_STATUSES,
  DELIVERY_ORDER_STATUS_LABELS,
  TRIP_ELIGIBLE_STATUSES,
  type DeliveryOrderStatus,
} from '@/modules/logistics/types';
import {
  OperationsToolError,
  assertCaseInAgentScope,
  assertReadingScope,
  canActForArea,
  checkActingScope,
  creationCommandId,
  isBotActor,
  loadOperationsCommands,
  localDayKey,
  registerOperationsTool,
  transitionCommandId,
  truncateText,
  unwrapCommand,
} from './operations-tool-kit';
import type { ToolExecutionContext } from './registry';

/**
 * Logistics tools (plan section 8, entrega 4 «tools `logistics-tools.ts`», y 6.3):
 * read the dispatch board and a trip, build and operate trips, and record what
 * really happened in a delivery.
 *
 * - Readings are limited to the actor's area for bots (the administrator reads
 *   all) and go through the same area queries the dispatch screen uses, so the
 *   tool never invents a second view of the board.
 * - Writes go through the logistics commands (`logistics-commands.ts`), so the
 *   engine checks `logistics.dispatch` again, keeps the version guard, writes
 *   the event and reuses the `commandId` (a repeated turn never duplicates a
 *   trip or a delivery). A bot acts only for Logística and, in a mention turn,
 *   with the limits of the person who mentioned it; a person executing an agent
 *   proposal is bound to its area.
 * - Everything that moves physical goods is `business_write`: it becomes an
 *   approval card for Logística. Nothing here writes to Zoho directly — the
 *   shipment order keeps travelling through the outbox (`assignCarrier` in
 *   `agents-tools.ts` and the `ops.zoho.*` jobs), and the read-back commands
 *   (`delivery.reconcile_shipment`, `delivery.zoho_*`) stay system-only by
 *   design and are deliberately NOT exposed here.
 */

const AREA = 'logistica' as const;
const idArg = z.string().trim().min(1).max(120);
const dayArg = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa el formato AAAA-MM-DD');

/** Names registered by this file (allowlists, settings and tests read it). */
export const LOGISTICS_TOOL_NAMES = [
  'getDispatchBoard',
  'getTripPlan',
  'buildTrip',
  'addTripStop',
  'reorderTripStops',
  'startTrip',
  'recordDeliveryResult',
  'reportFailedStop',
] as const;

async function actingReason(
  actor: CurrentUser,
  ctx?: ToolExecutionContext
): Promise<string | null> {
  const scope = checkActingScope(actor, AREA, ctx);
  if (scope) return scope;
  return isBotActor(actor) ? canActForArea(actor, AREA, ctx) : null;
}

async function assertMayAct(actor: CurrentUser, ctx?: ToolExecutionContext): Promise<void> {
  const reason = await actingReason(actor, ctx);
  if (reason) throw new OperationsToolError(reason, 'forbidden');
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function statusLabel(status: string): string {
  return DELIVERY_ORDER_STATUS_LABELS[status as DeliveryOrderStatus] ?? status;
}

/** Trip by folio (`VJ-12`, `VJ-000012`) or id. */
export async function resolveTripRef(ref: string) {
  const value = String(ref ?? '').trim();
  if (!value) throw new OperationsToolError('Indica el viaje', 'invalid_args');
  const folio = /^vj-?(\d{1,12})$/i.exec(value);
  const trip = folio
    ? await prisma.trip.findUnique({ where: { number: `VJ-${folio[1].padStart(6, '0')}` } })
    : await prisma.trip.findUnique({ where: { id: value } });
  if (!trip) throw new OperationsToolError(`No se encontró el viaje ${value}`, 'not_found');
  return trip;
}

/** Delivery order by id (the board and `getCaseSnapshot` return these ids). */
export async function resolveDeliveryOrderRef(ref: string) {
  const value = String(ref ?? '').trim();
  if (!value) throw new OperationsToolError('Indica la orden de entrega', 'invalid_args');
  const order = await prisma.deliveryOrder.findUnique({ where: { id: value } });
  if (!order)
    throw new OperationsToolError(`No se encontró la orden de entrega ${value}`, 'not_found');
  return order;
}

/** Vehicle by code (`CAM-01`) or id. */
async function resolveVehicleRef(
  ref: string
): Promise<{ id: string; code: string; label: string }> {
  const value = String(ref ?? '').trim();
  if (!value) throw new OperationsToolError('Indica el vehículo', 'invalid_args');
  const select = { id: true, code: true, label: true } as const;
  const vehicle =
    (await prisma.vehicle.findUnique({ where: { id: value }, select })) ??
    (await prisma.vehicle.findFirst({
      where: { code: { equals: value, mode: 'insensitive' } },
      select,
      orderBy: { code: 'asc' },
    }));
  if (!vehicle) throw new OperationsToolError(`No se encontró el vehículo ${value}`, 'not_found');
  return vehicle;
}

/** Driver by id or by name (exact, case-insensitive; ambiguous names are rejected). */
async function resolveDriverRef(ref: string): Promise<{ id: string; name: string }> {
  const value = String(ref ?? '').trim();
  if (!value) throw new OperationsToolError('Indica el chofer', 'invalid_args');
  const select = { id: true, name: true } as const;
  const byId = await prisma.driver.findUnique({ where: { id: value }, select });
  if (byId) return byId;
  const matches = await prisma.driver.findMany({
    where: { name: { equals: value, mode: 'insensitive' }, active: true },
    select,
    orderBy: { name: 'asc' },
    take: 2,
  });
  if (matches.length === 0)
    throw new OperationsToolError(`No se encontró el chofer ${value}`, 'not_found');
  if (matches.length > 1) {
    throw new OperationsToolError(
      `Hay más de un chofer llamado ${value}; indica su id`,
      'invalid_args'
    );
  }
  return matches[0];
}

/** Every case touched by these orders must be inside the agent's scope. */
async function assertOrdersInScope(
  actor: CurrentUser,
  orders: Array<{ caseId: string }>,
  ctx?: ToolExecutionContext
): Promise<void> {
  for (const caseId of new Set(orders.map((order) => order.caseId))) {
    await assertCaseInAgentScope(actor, caseId, ctx);
  }
}

// ---------------------------------------------------------------------------
// getDispatchBoard
// ---------------------------------------------------------------------------

const boardParams = z.object({
  date: dayArg.describe('Día del tablero AAAA-MM-DD; por omisión hoy').optional(),
  limit: z.number().int().min(1).max(40).describe('Cuántas entregas listar').default(15),
});
type BoardArgs = z.output<typeof boardParams>;

registerOperationsTool({
  name: 'getDispatchBoard',
  description:
    'Tablero de despacho de un día: contadores (sin asignar, en viaje, en tránsito, esperando a Zoho, fallidas), las entregas con su estado, expediente, destino, transporte y diferencias con Zoho, los viajes con sus paradas y la flotilla disponible con el motivo de cada no disponibilidad.',
  requiredPermission: 'logistics.view',
  effect: 'read',
  parameters: boardParams,
  execute: async (actor, raw, ctx) => {
    const args = raw as BoardArgs;
    assertReadingScope(actor, AREA, ctx);
    const date = args.date ?? localDayKey(new Date());
    const { getDispatchBoard } = await import('@/modules/areas/logistica/queries');
    const board = await getDispatchBoard(actor, { date });
    const open = board.deliveries.filter((delivery) => delivery.open);
    return {
      date: board.date,
      generatedAt: board.generatedAt,
      counters: board.counters,
      deliveries: open.slice(0, args.limit).map((delivery) => ({
        deliveryOrderId: delivery.id,
        status: delivery.statusLabel,
        mode: delivery.modeLabel,
        caseNumber: delivery.caseNumber,
        salesOrderNumber: delivery.salesOrderNumber,
        customer: delivery.customerName,
        city: delivery.address.city,
        plannedDate: delivery.plannedDate,
        pendingUnits: delivery.pendingUnits,
        carrier: delivery.carrier,
        tripNumber: delivery.tripNumber,
        packageMissing: delivery.packageId === null,
        zohoSyncState: delivery.zohoSyncState,
        zohoDifferences: delivery.zohoDifferences.map(
          (diff) => `${diff.label}: UNIK ${diff.expected ?? '—'} / Zoho ${diff.actual ?? '—'}`
        ),
        evidenceCount: delivery.evidenceCount,
      })),
      openTotal: open.length,
      trips: board.trips.map((trip) => ({
        tripId: trip.id,
        number: trip.number,
        date: trip.date,
        status: trip.statusLabel,
        vehicle: trip.vehicle ? `${trip.vehicle.code} · ${trip.vehicle.label}` : null,
        driver: trip.driver?.name ?? null,
        stops: trip.stops.map((stop) => ({
          stopId: stop.id,
          sequence: stop.sequence,
          status: stop.statusLabel,
          deliveryOrderId: stop.deliveryOrderId,
          etaAt: stop.etaAt,
        })),
      })),
      fleet: {
        vehicles: board.vehicles.map((vehicle) => ({
          vehicleId: vehicle.id,
          code: vehicle.code,
          label: vehicle.label,
          available: vehicle.available,
          reasons: vehicle.reasons,
          capacityKg: vehicle.capacityKg,
          capacityPieces: vehicle.capacityPieces,
        })),
        drivers: board.drivers.map((driver) => ({
          driverId: driver.id,
          name: driver.name,
          available: driver.available,
          reasons: driver.reasons,
        })),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// getTripPlan
// ---------------------------------------------------------------------------

const tripPlanParams = z.object({
  trip: z.string().trim().min(1).max(120).describe('Folio VJ-000012 o id del viaje'),
});
type TripPlanArgs = z.output<typeof tripPlanParams>;

registerOperationsTool({
  name: 'getTripPlan',
  description:
    'Detalle de un viaje: vehículo, chofer, estado, paradas en orden con su hora estimada y estado, y la entrega de cada parada con su expediente, destino, unidades pendientes y evidencias registradas.',
  requiredPermission: 'logistics.view',
  effect: 'read',
  parameters: tripPlanParams,
  execute: async (actor, raw, ctx) => {
    const args = raw as TripPlanArgs;
    assertReadingScope(actor, AREA, ctx);
    const trip = await resolveTripRef(args.trip);
    const { getTripDetail } = await import('@/modules/areas/logistica/queries');
    const detail = await getTripDetail(actor, trip.id);
    if (!detail) throw new OperationsToolError(`No se encontró el viaje ${args.trip}`, 'not_found');
    const byOrder = new Map(detail.deliveries.map((delivery) => [delivery.id, delivery]));
    return {
      tripId: detail.trip.id,
      number: detail.trip.number,
      date: detail.trip.date,
      status: detail.trip.statusLabel,
      startedAt: detail.trip.startedAt,
      endedAt: detail.trip.endedAt,
      vehicle: detail.trip.vehicle
        ? `${detail.trip.vehicle.code} · ${detail.trip.vehicle.label}`
        : null,
      driver: detail.trip.driver?.name ?? null,
      stops: detail.trip.stops.map((stop) => {
        const delivery = byOrder.get(stop.deliveryOrderId) ?? null;
        return {
          stopId: stop.id,
          sequence: stop.sequence,
          status: stop.statusLabel,
          etaAt: stop.etaAt,
          arrivedAt: stop.arrivedAt,
          deliveryOrderId: stop.deliveryOrderId,
          caseNumber: delivery?.caseNumber ?? null,
          customer: delivery?.customerName ?? null,
          address: delivery
            ? truncateText(
                [delivery.address.line, delivery.address.city, delivery.address.state]
                  .filter(Boolean)
                  .join(', '),
                240
              )
            : null,
          pendingUnits: delivery?.pendingUnits ?? null,
          deliveryStatus: delivery?.statusLabel ?? null,
          evidenceCount: (detail.evidence[stop.deliveryOrderId] ?? []).length,
        };
      }),
    };
  },
});

// ---------------------------------------------------------------------------
// buildTrip
// ---------------------------------------------------------------------------

const buildTripParams = z.object({
  vehicle: z.string().trim().min(1).max(120).describe('Código CAM-01 o id del vehículo'),
  driver: z.string().trim().min(1).max(200).describe('Nombre exacto o id del chofer'),
  deliveryOrderIds: z
    .array(idArg)
    .min(1)
    .max(40)
    .describe('Entregas que van en el viaje, en el orden deseado'),
  date: dayArg.describe('Día del viaje AAAA-MM-DD; por omisión hoy').optional(),
  optimize: z
    .boolean()
    .describe('true reordena las paradas por cercanía respetando ventanas')
    .default(true),
  notes: z.string().trim().max(1000).describe('Notas para el chofer').optional(),
  vehicleLabel: z.string().max(200).describe('Lo completa el sistema').optional(),
  driverLabel: z.string().max(200).describe('Lo completa el sistema').optional(),
});
type BuildTripArgs = z.output<typeof buildTripParams>;

registerOperationsTool({
  name: 'buildTrip',
  description:
    'Arma un viaje del día con un vehículo, un chofer y varias entregas, ordenando las paradas por cercanía y ventanas de entrega. No escribe nada en Zoho: la orden de envío sigue su camino por el outbox. Queda como propuesta para Logística.',
  requiredPermission: 'logistics.dispatch',
  effect: 'business_write',
  parameters: buildTripParams,
  summarize: (raw) => {
    const a = raw as BuildTripArgs;
    return truncateText(
      `Armar viaje del ${a.date ?? 'día de hoy'} con ${a.vehicleLabel ?? a.vehicle}, ${a.driverLabel ?? a.driver} y ${a.deliveryOrderIds.length} entrega(s)`,
      300
    );
  },
  prepareArgs: async (actor, raw, ctx) => {
    const args = raw as BuildTripArgs;
    const reason = await actingReason(actor, ctx);
    if (reason) return { error: reason };
    const ids = [...new Set(args.deliveryOrderIds)];
    const orders = await prisma.deliveryOrder.findMany({
      where: { id: { in: ids } },
      select: { id: true, caseId: true, status: true, tripId: true },
    });
    const missing = ids.filter((id) => !orders.some((order) => order.id === id));
    if (missing.length > 0)
      return { error: `No se encontraron las entregas ${missing.join(', ')}` };
    try {
      await assertOrdersInScope(actor, orders, ctx);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Alguna entrega está fuera de tu alcance',
      };
    }
    const onTrip = orders.filter((order) => order.tripId);
    if (onTrip.length > 0) {
      return {
        error: `Estas entregas ya están en un viaje: ${onTrip.map((order) => order.id).join(', ')}`,
      };
    }
    const blocked = orders.filter(
      (order) => !(TRIP_ELIGIBLE_STATUSES as readonly string[]).includes(order.status)
    );
    if (blocked.length > 0) {
      return {
        error: `No se puede subir a un viaje una entrega en estado ${blocked.map((order) => statusLabel(order.status)).join(', ')}`,
      };
    }
    let vehicle: { id: string; code: string; label: string };
    let driver: { id: string; name: string };
    try {
      vehicle = await resolveVehicleRef(args.vehicle);
      driver = await resolveDriverRef(args.driver);
    } catch (err) {
      return {
        error:
          err instanceof Error ? err.message : 'No se pudo identificar el vehículo o el chofer',
      };
    }
    return {
      args: {
        ...args,
        vehicle: vehicle.id,
        driver: driver.id,
        deliveryOrderIds: ids,
        date: args.date ?? localDayKey(new Date()),
        vehicleLabel: `${vehicle.code} · ${vehicle.label}`,
        driverLabel: driver.name,
      },
    };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as BuildTripArgs;
    await assertMayAct(actor, ctx);
    const vehicle = await resolveVehicleRef(args.vehicle);
    const driver = await resolveDriverRef(args.driver);
    const payload = compact({
      date: args.date ?? localDayKey(new Date()),
      vehicleId: vehicle.id,
      driverId: driver.id,
      deliveryOrderIds: [...new Set(args.deliveryOrderIds)],
      optimize: args.optimize,
      notes: args.notes,
    });
    await loadOperationsCommands();
    const { buildTripCommand } = await import('@/modules/logistics/logistics-commands');
    const result = unwrapCommand(
      await buildTripCommand(actor, payload, {
        commandId: creationCommandId('buildTrip', actor.id, payload, ctx),
        actorType: isBotActor(actor) ? 'ai' : 'user',
      })
    );
    const data = result.data;
    return {
      tripId: data?.tripId ?? null,
      number: data?.number ?? null,
      commandStatus: result.status,
      stops:
        data?.stops?.map((stop) => ({
          sequence: stop.sequence,
          deliveryOrderId: stop.deliveryOrderId,
          etaAt: stop.etaAt,
        })) ?? [],
      load: data?.load ?? null,
      note: 'El viaje queda planeado: iniciarlo exige que cada entrega tenga su paquete de Zoho.',
    };
  },
});

// ---------------------------------------------------------------------------
// addTripStop / reorderTripStops
// ---------------------------------------------------------------------------

const addStopParams = z.object({
  trip: z.string().trim().min(1).max(120).describe('Folio VJ-000012 o id del viaje'),
  deliveryOrderId: idArg.describe('Entrega que se agrega al final del viaje'),
  tripNumber: z.string().max(40).describe('Lo completa el sistema').optional(),
});
type AddStopArgs = z.output<typeof addStopParams>;

registerOperationsTool({
  name: 'addTripStop',
  description:
    'Agrega una entrega como última parada de un viaje planeado o en ruta. Rechaza la parada si excede la capacidad del vehículo. Queda como propuesta para Logística.',
  requiredPermission: 'logistics.dispatch',
  effect: 'business_write',
  parameters: addStopParams,
  summarize: (raw) => {
    const a = raw as AddStopArgs;
    return `Agregar la entrega ${a.deliveryOrderId} al viaje ${a.tripNumber ?? a.trip}`;
  },
  prepareArgs: async (actor, raw, ctx) => {
    const args = raw as AddStopArgs;
    const reason = await actingReason(actor, ctx);
    if (reason) return { error: reason };
    let trip: Awaited<ReturnType<typeof resolveTripRef>>;
    let order: Awaited<ReturnType<typeof resolveDeliveryOrderRef>>;
    try {
      trip = await resolveTripRef(args.trip);
      order = await resolveDeliveryOrderRef(args.deliveryOrderId);
      await assertCaseInAgentScope(actor, order.caseId, ctx);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'No se pudo preparar la parada' };
    }
    if (order.tripId) return { error: 'Esa entrega ya está en un viaje' };
    if (!(TRIP_ELIGIBLE_STATUSES as readonly string[]).includes(order.status)) {
      return {
        error: `No se puede subir a un viaje una entrega en estado ${statusLabel(order.status)}`,
      };
    }
    return { args: { ...args, trip: trip.id, tripNumber: trip.number } };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as AddStopArgs;
    await assertMayAct(actor, ctx);
    const trip = await resolveTripRef(args.trip);
    await loadOperationsCommands();
    const { addStopCommand } = await import('@/modules/logistics/logistics-commands');
    const result = unwrapCommand(
      await addStopCommand(
        actor,
        { tripId: trip.id, deliveryOrderId: args.deliveryOrderId },
        {
          commandId: transitionCommandId('addTripStop', ctx),
          actorType: isBotActor(actor) ? 'ai' : 'user',
        }
      )
    );
    return { tripNumber: trip.number, ...result.data, commandStatus: result.status };
  },
});

const reorderParams = z.object({
  trip: z.string().trim().min(1).max(120).describe('Folio VJ-000012 o id del viaje'),
  stopIds: z
    .array(idArg)
    .min(1)
    .max(60)
    .describe('Ids de las paradas en el orden deseado (todas las del viaje)'),
  tripNumber: z.string().max(40).describe('Lo completa el sistema').optional(),
});
type ReorderArgs = z.output<typeof reorderParams>;

registerOperationsTool({
  name: 'reorderTripStops',
  description:
    'Cambia el orden de las paradas pendientes de un viaje. Las paradas ya visitadas no se mueven y la lista debe traer todas las paradas del viaje. Queda como propuesta para Logística.',
  requiredPermission: 'logistics.dispatch',
  effect: 'business_write',
  parameters: reorderParams,
  summarize: (raw) => {
    const a = raw as ReorderArgs;
    return `Reordenar las ${a.stopIds.length} paradas del viaje ${a.tripNumber ?? a.trip}`;
  },
  prepareArgs: async (actor, raw, ctx) => {
    const args = raw as ReorderArgs;
    const reason = await actingReason(actor, ctx);
    if (reason) return { error: reason };
    let trip: Awaited<ReturnType<typeof resolveTripRef>>;
    try {
      trip = await resolveTripRef(args.trip);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'No se encontró el viaje' };
    }
    const stops = await prisma.tripStop.findMany({
      where: { tripId: trip.id },
      select: { id: true, deliveryOrderId: true },
    });
    const given = new Set(args.stopIds);
    if (given.size !== args.stopIds.length) return { error: 'Hay paradas repetidas en la lista' };
    const foreign = args.stopIds.filter((id) => !stops.some((stop) => stop.id === id));
    if (foreign.length > 0)
      return { error: `Estas paradas no son del viaje: ${foreign.join(', ')}` };
    if (stops.length !== args.stopIds.length) {
      return {
        error: `El viaje tiene ${stops.length} paradas: inclúyelas todas en el nuevo orden`,
      };
    }
    const orders = await prisma.deliveryOrder.findMany({
      where: { id: { in: stops.map((stop) => stop.deliveryOrderId) } },
      select: { id: true, caseId: true },
    });
    try {
      await assertOrdersInScope(actor, orders, ctx);
    } catch (err) {
      return {
        error:
          err instanceof Error ? err.message : 'Alguna entrega del viaje está fuera de tu alcance',
      };
    }
    return { args: { ...args, trip: trip.id, tripNumber: trip.number } };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as ReorderArgs;
    await assertMayAct(actor, ctx);
    const trip = await resolveTripRef(args.trip);
    await loadOperationsCommands();
    const { reorderStopsCommand } = await import('@/modules/logistics/logistics-commands');
    const result = unwrapCommand(
      await reorderStopsCommand(
        actor,
        { tripId: trip.id, stopIds: args.stopIds },
        {
          commandId: transitionCommandId('reorderTripStops', ctx),
          actorType: isBotActor(actor) ? 'ai' : 'user',
        }
      )
    );
    return { tripNumber: trip.number, ...result.data, commandStatus: result.status };
  },
});

// ---------------------------------------------------------------------------
// startTrip
// ---------------------------------------------------------------------------

const startTripParams = z.object({
  trip: z.string().trim().min(1).max(120).describe('Folio VJ-000012 o id del viaje'),
  tripNumber: z.string().max(40).describe('Lo completa el sistema').optional(),
});
type StartTripArgs = z.output<typeof startTripParams>;

registerOperationsTool({
  name: 'startTrip',
  description:
    'Pone un viaje en ruta. Exige que cada entrega tenga su paquete de Zoho y, si alguna no tenía transporte asignado o su escritura falló, encola la orden de envío con el vehículo y el chofer del viaje. Queda como propuesta para Logística.',
  requiredPermission: 'logistics.dispatch',
  effect: 'business_write',
  parameters: startTripParams,
  summarize: (raw) => {
    const a = raw as StartTripArgs;
    return `Poner en ruta el viaje ${a.tripNumber ?? a.trip}`;
  },
  prepareArgs: async (actor, raw, ctx) => {
    const args = raw as StartTripArgs;
    const reason = await actingReason(actor, ctx);
    if (reason) return { error: reason };
    let trip: Awaited<ReturnType<typeof resolveTripRef>>;
    try {
      trip = await resolveTripRef(args.trip);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'No se encontró el viaje' };
    }
    if (trip.status !== 'planned') {
      return { error: `El viaje ${trip.number} ya no está planeado (${trip.status})` };
    }
    const stops = await prisma.tripStop.findMany({
      where: { tripId: trip.id },
      select: { deliveryOrderId: true },
    });
    if (stops.length === 0) return { error: `El viaje ${trip.number} no tiene paradas` };
    const orders = await prisma.deliveryOrder.findMany({
      where: { id: { in: stops.map((stop) => stop.deliveryOrderId) } },
      select: { id: true, caseId: true, packageId: true },
    });
    try {
      await assertOrdersInScope(actor, orders, ctx);
    } catch (err) {
      return {
        error:
          err instanceof Error ? err.message : 'Alguna entrega del viaje está fuera de tu alcance',
      };
    }
    const withoutPackage = orders.filter((order) => !order.packageId);
    if (withoutPackage.length > 0) {
      return {
        error: `Estas entregas todavía no tienen paquete en Zoho: ${withoutPackage.map((order) => order.id).join(', ')}`,
      };
    }
    return { args: { ...args, trip: trip.id, tripNumber: trip.number } };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as StartTripArgs;
    await assertMayAct(actor, ctx);
    const trip = await resolveTripRef(args.trip);
    await loadOperationsCommands();
    const { startTripCommand } = await import('@/modules/logistics/logistics-commands');
    const result = unwrapCommand(
      await startTripCommand(
        actor,
        { tripId: trip.id },
        {
          commandId: transitionCommandId('startTrip', ctx),
          actorType: isBotActor(actor) ? 'ai' : 'user',
        }
      )
    );
    return { tripNumber: trip.number, ...result.data, commandStatus: result.status };
  },
});

// ---------------------------------------------------------------------------
// recordDeliveryResult
// ---------------------------------------------------------------------------

const recordParams = z.object({
  deliveryOrderId: idArg.describe('Orden de entrega'),
  receivedBy: z.string().trim().min(1).max(200).describe('Quién recibió la mercancía'),
  lines: z
    .array(
      z.object({
        allocationId: idArg.describe('Asignación de la entrega'),
        deliveredQty: z.number().finite().min(0).describe('Cantidad realmente entregada'),
      })
    )
    .min(1)
    .max(100)
    .describe('Una línea por asignación de la entrega, con lo realmente entregado'),
  evidenceObjectIds: z
    .array(idArg)
    .max(20)
    .describe('Ids de las fotos o firmas ya subidas a la entrega')
    .default([]),
  note: z.string().trim().max(1000).describe('Nota de la entrega').optional(),
  partialReason: z
    .string()
    .trim()
    .max(500)
    .describe('Por qué faltó producto (obligatorio si entregas de menos)')
    .optional(),
  caseNumber: z.string().max(40).describe('Lo completa el sistema').optional(),
  expectedSummary: z.string().max(400).describe('Lo completa el sistema').optional(),
});
type RecordArgs = z.output<typeof recordParams>;

registerOperationsTool({
  name: 'recordDeliveryResult',
  description:
    'Registra lo realmente entregado de una orden de entrega (una línea por asignación). Exige que ya haya una foto o firma subida. Si falta producto la entrega queda parcial: se abre la orden hija por el remanente, una incidencia y el trabajo «Decidir remanente» para Ventas. Queda como propuesta para Logística.',
  requiredPermission: 'logistics.dispatch',
  effect: 'business_write',
  parameters: recordParams,
  summarize: (raw) => {
    const a = raw as RecordArgs;
    const total = a.lines.reduce((sum, line) => sum + line.deliveredQty, 0);
    return truncateText(
      `Registrar entrega de ${total} unidad(es) recibidas por ${a.receivedBy} en ${a.caseNumber ?? a.deliveryOrderId}${a.expectedSummary ? ` (esperado ${a.expectedSummary})` : ''}`,
      300
    );
  },
  prepareArgs: async (actor, raw, ctx) => {
    const args = raw as RecordArgs;
    const reason = await actingReason(actor, ctx);
    if (reason) return { error: reason };
    let order: Awaited<ReturnType<typeof resolveDeliveryOrderRef>>;
    try {
      order = await resolveDeliveryOrderRef(args.deliveryOrderId);
      await assertCaseInAgentScope(actor, order.caseId, ctx);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'No se pudo preparar la entrega' };
    }
    if (!(DELIVERY_ORDER_OPEN_STATUSES as readonly string[]).includes(order.status)) {
      return { error: `La entrega ya está ${statusLabel(order.status)}` };
    }
    const allocationIds = new Set((order.allocationIds as string[] | null) ?? []);
    const foreign = args.lines.filter((line) => !allocationIds.has(line.allocationId));
    if (foreign.length > 0) {
      return {
        error: `Estas asignaciones no son de la entrega: ${foreign.map((line) => line.allocationId).join(', ')}`,
      };
    }
    const evidences = await prisma.deliveryEvidence.findMany({
      where: { deliveryOrderId: order.id, kind: { in: ['photo', 'signature'] } },
      select: { id: true },
      take: 1,
    });
    if (evidences.length === 0) {
      return {
        error:
          'Falta la evidencia de entrega: sube una foto o la firma de quien recibe antes de cerrarla',
      };
    }
    const allocations = await prisma.demandAllocation.findMany({
      where: { id: { in: args.lines.map((line) => line.allocationId) } },
      select: { id: true, quantity: true },
    });
    const expected = new Map(allocations.map((row) => [row.id, Number(row.quantity)]));
    const short = args.lines.filter(
      (line) => line.deliveredQty < (expected.get(line.allocationId) ?? line.deliveredQty)
    );
    if (short.length > 0 && !args.partialReason) {
      return {
        error: 'Estás entregando de menos: indica en `partialReason` por qué faltó producto',
      };
    }
    const opCase = await prisma.operationalCase.findUnique({
      where: { id: order.caseId },
      select: { caseNumber: true },
    });
    return {
      args: {
        ...args,
        caseNumber: opCase?.caseNumber,
        expectedSummary: truncateText(
          args.lines
            .map((line) => `${line.allocationId}: ${expected.get(line.allocationId) ?? '?'}`)
            .join(', '),
          400
        ),
      },
    };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as RecordArgs;
    await assertMayAct(actor, ctx);
    const payload = compact({
      deliveryOrderId: args.deliveryOrderId,
      lines: args.lines,
      receivedBy: args.receivedBy,
      evidenceObjectIds: args.evidenceObjectIds,
      note: args.note,
      partialReason: args.partialReason,
    });
    await loadOperationsCommands();
    const { recordDeliveryCommand } = await import('@/modules/logistics/logistics-commands');
    const result = unwrapCommand(
      await recordDeliveryCommand(actor, payload, {
        commandId: creationCommandId('recordDeliveryResult', actor.id, payload, ctx),
        actorType: isBotActor(actor) ? 'ai' : 'user',
      })
    );
    const data = result.data;
    return {
      deliveryOrderId: args.deliveryOrderId,
      status: data ? statusLabel(data.status) : result.status,
      complete: data?.complete ?? null,
      childDeliveryOrderId: data?.childDeliveryOrderId ?? null,
      totalDelivered: data?.totalDelivered ?? null,
      totalShort: data?.totalShort ?? null,
      incidentId: data?.incidentId ?? null,
      commandStatus: result.status,
      note: data?.complete
        ? 'Entrega completa: se marca entregado en Zoho por el outbox.'
        : 'Entrega parcial: quedó la orden hija por el remanente y el trabajo «Decidir remanente» para Ventas.',
    };
  },
});

// ---------------------------------------------------------------------------
// reportFailedStop
// ---------------------------------------------------------------------------

const failStopParams = z.object({
  trip: z.string().trim().min(1).max(120).describe('Folio VJ-000012 o id del viaje'),
  stopId: idArg.describe('Parada que no se pudo entregar'),
  reason: z.string().trim().min(3).max(500).describe('Por qué no se entregó'),
  tripNumber: z.string().max(40).describe('Lo completa el sistema').optional(),
});
type FailStopArgs = z.output<typeof failStopParams>;

registerOperationsTool({
  name: 'reportFailedStop',
  description:
    'Marca una parada como no entregada con su motivo: la entrega queda fallida, se abre el trabajo de reprogramación para Logística y se avisa a Ventas. Queda como propuesta para Logística.',
  requiredPermission: 'logistics.dispatch',
  effect: 'business_write',
  parameters: failStopParams,
  summarize: (raw) => {
    const a = raw as FailStopArgs;
    return truncateText(
      `Marcar como no entregada la parada ${a.stopId} del viaje ${a.tripNumber ?? a.trip}: ${a.reason}`,
      300
    );
  },
  prepareArgs: async (actor, raw, ctx) => {
    const args = raw as FailStopArgs;
    const reason = await actingReason(actor, ctx);
    if (reason) return { error: reason };
    let trip: Awaited<ReturnType<typeof resolveTripRef>>;
    try {
      trip = await resolveTripRef(args.trip);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'No se encontró el viaje' };
    }
    const stop = await prisma.tripStop.findUnique({
      where: { id: args.stopId },
      select: { id: true, tripId: true, status: true, deliveryOrderId: true },
    });
    if (!stop || stop.tripId !== trip.id)
      return { error: `La parada ${args.stopId} no es del viaje ${trip.number}` };
    if (stop.status === 'done' || stop.status === 'failed') {
      return {
        error: `La parada ya está ${stop.status === 'done' ? 'entregada' : 'marcada como fallida'}`,
      };
    }
    const order = await prisma.deliveryOrder.findUnique({
      where: { id: stop.deliveryOrderId },
      select: { caseId: true },
    });
    if (order) {
      try {
        await assertCaseInAgentScope(actor, order.caseId, ctx);
      } catch (err) {
        return {
          error:
            err instanceof Error
              ? err.message
              : 'El expediente de la parada está fuera de tu alcance',
        };
      }
    }
    return { args: { ...args, trip: trip.id, tripNumber: trip.number } };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as FailStopArgs;
    await assertMayAct(actor, ctx);
    const trip = await resolveTripRef(args.trip);
    await loadOperationsCommands();
    const { failStopCommand } = await import('@/modules/logistics/logistics-commands');
    const result = unwrapCommand(
      await failStopCommand(
        actor,
        { tripId: trip.id, stopId: args.stopId, reason: args.reason },
        {
          commandId: transitionCommandId('reportFailedStop', ctx),
          actorType: isBotActor(actor) ? 'ai' : 'user',
        }
      )
    );
    return { tripNumber: trip.number, ...result.data, commandStatus: result.status };
  },
});
