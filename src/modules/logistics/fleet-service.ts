import { z } from 'zod';
import type { Driver, Prisma, Vehicle } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { OperationsError, requireCommandContext } from '@/modules/operations/commands';
import {
  describeAvailability,
  driverAvailability,
  formatDay,
  normalizeVehicleCode,
  parseDay,
  vehicleAvailability,
  type Availability,
  type FleetTripRef,
} from './fleet-rules';
import {
  dayText,
  idText,
  logisticsError,
  requireDay,
  toNumber,
  type Tx,
} from './logistics-helpers';
import {
  LOGISTICS_EVENTS,
  LOGISTICS_OBJECT_TYPES,
  LOGISTICS_REALTIME,
  TRIP_ACTIVE_STATUSES,
} from './types';

/**
 * Fleet: vehicles and drivers (plan section 4) and their availability per day
 * considering active trips and vehicle maintenance.
 *
 * Writes run inside the commands `fleet.vehicle.create|update` and
 * `fleet.driver.create|update` (permission `logistics.manage_fleet`); reads
 * are plain queries for the dispatch board and the AI tools.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const capacity = z.number().finite().min(0).max(1_000_000).nullable().optional();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const vehicleCreateSchema = z.object({
  code: z.string().trim().min(1).max(40),
  plate: z.string().trim().min(1).max(20),
  label: z.string().trim().min(1).max(120),
  capacityKg: capacity,
  capacityM2: capacity,
  capacityPieces: z.number().int().min(0).max(1_000_000).nullable().optional(),
  /** Unavailable until this day, inclusive. */
  maintenanceUntil: dayText.nullable().optional(),
  active: z.boolean().optional(),
});
export type VehicleCreateInput = z.infer<typeof vehicleCreateSchema>;

export const vehicleUpdateSchema = vehicleCreateSchema.partial().extend({ vehicleId: idText });
export type VehicleUpdateInput = z.infer<typeof vehicleUpdateSchema>;

export const driverCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: optionalText(40),
  licenseNumber: optionalText(60),
  /** Links the driver to a system user (driver PWA). */
  userId: idText.nullable().optional(),
  active: z.boolean().optional(),
});
export type DriverCreateInput = z.infer<typeof driverCreateSchema>;

export const driverUpdateSchema = driverCreateSchema.partial().extend({ driverId: idText });
export type DriverUpdateInput = z.infer<typeof driverUpdateSchema>;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface VehicleDTO {
  id: string;
  code: string;
  plate: string;
  label: string;
  capacityKg: number | null;
  capacityM2: number | null;
  capacityPieces: number | null;
  maintenanceUntil: string | null;
  active: boolean;
}

export interface DriverDTO {
  id: string;
  name: string;
  phone: string | null;
  licenseNumber: string | null;
  userId: string | null;
  active: boolean;
}

export function toVehicleDTO(vehicle: Vehicle): VehicleDTO {
  return {
    id: vehicle.id,
    code: vehicle.code,
    plate: vehicle.plate,
    label: vehicle.label,
    capacityKg: toNumber(vehicle.capacityKg),
    capacityM2: toNumber(vehicle.capacityM2),
    capacityPieces: vehicle.capacityPieces,
    maintenanceUntil: vehicle.maintenanceUntil ? formatDay(vehicle.maintenanceUntil) : null,
    active: vehicle.active,
  };
}

export function toDriverDTO(driver: Driver): DriverDTO {
  return {
    id: driver.id,
    name: driver.name,
    phone: driver.phone,
    licenseNumber: driver.licenseNumber,
    userId: driver.userId,
    active: driver.active,
  };
}

// ---------------------------------------------------------------------------
// Commands (inside executeCommand)
// ---------------------------------------------------------------------------

async function activeTripsOf(
  tx: Tx,
  where: { vehicleId?: string; driverId?: string }
): Promise<Array<{ id: string; number: string; date: Date; status: string }>> {
  return tx.trip.findMany({
    where: { ...where, status: { in: [...TRIP_ACTIVE_STATUSES] } },
    select: { id: true, number: true, date: true, status: true },
    orderBy: { date: 'asc' },
  });
}

function tripList(trips: Array<{ number: string }>): string {
  return trips
    .slice(0, 5)
    .map((t) => t.number)
    .join(', ');
}

function emitFleet(
  tx: Tx,
  type: string,
  objectType: string,
  objectId: string,
  payload: Record<string, unknown>
): void {
  const ctx = requireCommandContext(tx);
  ctx.emit(type, payload, { areaKey: 'logistica', objectType, objectId });
  ctx.realtime(LOGISTICS_REALTIME.dispatchChannel, 'logistics.fleet', {
    commandId: ctx.commandId,
    objectType,
    objectId,
    type,
  });
}

export async function createVehicle(tx: Tx, input: VehicleCreateInput): Promise<Vehicle> {
  requireCommandContext(tx);
  const code = normalizeVehicleCode(input.code);
  const [created] = await tx.vehicle.createManyAndReturn({
    data: [
      {
        code,
        plate: input.plate.trim().toUpperCase(),
        label: input.label,
        capacityKg: input.capacityKg ?? null,
        capacityM2: input.capacityM2 ?? null,
        capacityPieces: input.capacityPieces ?? null,
        maintenanceUntil: input.maintenanceUntil
          ? requireDay(input.maintenanceUntil, 'el fin del mantenimiento')
          : null,
        active: input.active ?? true,
      },
    ],
    // ON CONFLICT DO NOTHING: a duplicate code never aborts the command transaction.
    skipDuplicates: true,
  });
  if (!created)
    throw logisticsError('duplicate_code', `Ya existe un vehículo con el código ${code}`);
  emitFleet(tx, LOGISTICS_EVENTS.fleet.vehicleCreated, LOGISTICS_OBJECT_TYPES.vehicle, created.id, {
    vehicleId: created.id,
    code: created.code,
    plate: created.plate,
  });
  return created;
}

export async function updateVehicle(tx: Tx, input: VehicleUpdateInput): Promise<Vehicle> {
  requireCommandContext(tx);
  const vehicle = await tx.vehicle.findUnique({ where: { id: input.vehicleId } });
  if (!vehicle) throw new OperationsError('not_found', 'No se encontró el vehículo');

  const data: Prisma.VehicleUpdateInput = {};
  if (input.code !== undefined) {
    const code = normalizeVehicleCode(input.code);
    if (code !== vehicle.code) {
      const taken = await tx.vehicle.findFirst({
        where: { code, id: { not: vehicle.id } },
        select: { id: true },
      });
      if (taken)
        throw logisticsError('duplicate_code', `Ya existe un vehículo con el código ${code}`);
      data.code = code;
    }
  }
  if (input.plate !== undefined) data.plate = input.plate.trim().toUpperCase();
  if (input.label !== undefined) data.label = input.label;
  if (input.capacityKg !== undefined) data.capacityKg = input.capacityKg;
  if (input.capacityM2 !== undefined) data.capacityM2 = input.capacityM2;
  if (input.capacityPieces !== undefined) data.capacityPieces = input.capacityPieces;

  const trips = await activeTripsOf(tx, { vehicleId: vehicle.id });
  if (input.active === false && vehicle.active && trips.length > 0) {
    throw logisticsError(
      'in_use',
      `No se puede desactivar el vehículo: tiene viajes activos (${tripList(trips)})`,
      { tripIds: trips.map((t) => t.id) }
    );
  }
  if (input.active !== undefined) data.active = input.active;
  if (input.maintenanceUntil !== undefined) {
    const until = input.maintenanceUntil
      ? requireDay(input.maintenanceUntil, 'el fin del mantenimiento')
      : null;
    if (until) {
      const clashing = trips.filter((t) => t.date.getTime() <= until.getTime());
      if (clashing.length > 0) {
        throw logisticsError(
          'in_use',
          `El mantenimiento choca con viajes activos del vehículo (${tripList(clashing)})`,
          { tripIds: clashing.map((t) => t.id) }
        );
      }
    }
    data.maintenanceUntil = until;
  }

  const updated = await tx.vehicle.update({ where: { id: vehicle.id }, data });
  emitFleet(tx, LOGISTICS_EVENTS.fleet.vehicleUpdated, LOGISTICS_OBJECT_TYPES.vehicle, vehicle.id, {
    vehicleId: vehicle.id,
    changes: Object.keys(data),
  });
  return updated;
}

async function assertLinkableUser(tx: Tx, userId: string): Promise<void> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { isActive: true, isBot: true },
  });
  if (!user || !user.isActive || user.isBot) {
    throw new OperationsError('invalid_payload', 'El usuario del chofer no existe o está inactivo');
  }
}

export async function createDriver(tx: Tx, input: DriverCreateInput): Promise<Driver> {
  requireCommandContext(tx);
  if (input.userId) await assertLinkableUser(tx, input.userId);
  const [created] = await tx.driver.createManyAndReturn({
    data: [
      {
        name: input.name,
        phone: input.phone || null,
        licenseNumber: input.licenseNumber || null,
        userId: input.userId ?? null,
        active: input.active ?? true,
      },
    ],
    skipDuplicates: true,
  });
  if (!created) {
    throw logisticsError('driver_user_taken', 'Ese usuario ya está ligado a otro chofer');
  }
  emitFleet(tx, LOGISTICS_EVENTS.fleet.driverCreated, LOGISTICS_OBJECT_TYPES.driver, created.id, {
    driverId: created.id,
    name: created.name,
    userId: created.userId,
  });
  return created;
}

export async function updateDriver(tx: Tx, input: DriverUpdateInput): Promise<Driver> {
  requireCommandContext(tx);
  const driver = await tx.driver.findUnique({ where: { id: input.driverId } });
  if (!driver) throw new OperationsError('not_found', 'No se encontró el chofer');

  const data: Prisma.DriverUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.phone !== undefined) data.phone = input.phone || null;
  if (input.licenseNumber !== undefined) data.licenseNumber = input.licenseNumber || null;
  if (input.userId !== undefined && input.userId !== driver.userId) {
    if (input.userId) {
      await assertLinkableUser(tx, input.userId);
      const taken = await tx.driver.findFirst({
        where: { userId: input.userId, id: { not: driver.id } },
        select: { id: true },
      });
      if (taken)
        throw logisticsError('driver_user_taken', 'Ese usuario ya está ligado a otro chofer');
    }
    data.userId = input.userId;
  }
  if (input.active === false && driver.active) {
    const trips = await activeTripsOf(tx, { driverId: driver.id });
    if (trips.length > 0) {
      throw logisticsError(
        'in_use',
        `No se puede desactivar al chofer: tiene viajes activos (${tripList(trips)})`,
        { tripIds: trips.map((t) => t.id) }
      );
    }
  }
  if (input.active !== undefined) data.active = input.active;

  const updated = await tx.driver.update({ where: { id: driver.id }, data });
  emitFleet(tx, LOGISTICS_EVENTS.fleet.driverUpdated, LOGISTICS_OBJECT_TYPES.driver, driver.id, {
    driverId: driver.id,
    changes: Object.keys(data),
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

async function tripsUpTo(
  db: Tx,
  day: Date,
  where: Prisma.TripWhereInput = {}
): Promise<FleetTripRef[]> {
  return db.trip.findMany({
    where: { ...where, status: { in: [...TRIP_ACTIVE_STATUSES] }, date: { lte: day } },
    select: { id: true, vehicleId: true, driverId: true, status: true, date: true, number: true },
  });
}

/**
 * Checks vehicle and driver inside a command. `allowBusy` skips the "already
 * has a trip that day" rule (a delivery can join the vehicle's trip).
 */
export async function assertFleetAvailable(
  tx: Tx,
  input: {
    vehicleId: string;
    driverId: string;
    day: Date;
    ignoreTripId?: string | null;
    allowBusy?: boolean;
  }
): Promise<{ vehicle: Vehicle; driver: Driver }> {
  const [vehicle, driver] = await Promise.all([
    tx.vehicle.findUnique({ where: { id: input.vehicleId } }),
    tx.driver.findUnique({ where: { id: input.driverId } }),
  ]);
  if (!vehicle) throw new OperationsError('not_found', 'No se encontró el vehículo');
  if (!driver) throw new OperationsError('not_found', 'No se encontró el chofer');
  const trips = await tripsUpTo(tx, input.day, {
    OR: [{ vehicleId: vehicle.id }, { driverId: driver.id }],
  });
  const strip = (a: Availability): Availability => {
    if (!input.allowBusy) return a;
    const reasons = a.reasons.filter((r) => r !== 'busy');
    return { available: reasons.length === 0, reasons, busyTripIds: [] };
  };
  const vehicleState = strip(vehicleAvailability(vehicle, trips, input.day, input.ignoreTripId));
  const driverState = strip(driverAvailability(driver, trips, input.day, input.ignoreTripId));
  const problems = [
    describeAvailability(`El vehículo ${vehicle.code}`, vehicleState),
    describeAvailability(`El chofer ${driver.name}`, driverState),
  ].filter((p): p is string => p !== null);
  if (problems.length > 0) {
    throw logisticsError('fleet_unavailable', `${problems.join('; ')} el ${formatDay(input.day)}`, {
      vehicle: vehicleState,
      driver: driverState,
    });
  }
  return { vehicle, driver };
}

export interface FleetAvailabilityDTO {
  date: string;
  vehicles: Array<VehicleDTO & { available: boolean; reasons: string[]; busyTripIds: string[] }>;
  drivers: Array<DriverDTO & { available: boolean; reasons: string[]; busyTripIds: string[] }>;
}

export async function listVehicles(
  options: { includeInactive?: boolean } = {}
): Promise<VehicleDTO[]> {
  const rows = await prisma.vehicle.findMany({
    where: options.includeInactive ? {} : { active: true },
    orderBy: { code: 'asc' },
  });
  return rows.map(toVehicleDTO);
}

export async function listDrivers(
  options: { includeInactive?: boolean } = {}
): Promise<DriverDTO[]> {
  const rows = await prisma.driver.findMany({
    where: options.includeInactive ? {} : { active: true },
    orderBy: { name: 'asc' },
  });
  return rows.map(toDriverDTO);
}

/** Every vehicle and driver with its availability on `day` (YYYY-MM-DD). */
export async function getFleetAvailability(day: string): Promise<FleetAvailabilityDTO> {
  const date = parseDay(day);
  if (!date) throw new OperationsError('invalid_payload', 'Revisa la fecha (formato AAAA-MM-DD)');
  const [vehicles, drivers, trips] = await Promise.all([
    prisma.vehicle.findMany({ orderBy: { code: 'asc' } }),
    prisma.driver.findMany({ orderBy: { name: 'asc' } }),
    tripsUpTo(prisma, date),
  ]);
  return {
    date: formatDay(date),
    vehicles: vehicles.map((vehicle) => ({
      ...toVehicleDTO(vehicle),
      ...vehicleAvailability(vehicle, trips, date),
    })),
    drivers: drivers.map((driver) => ({
      ...toDriverDTO(driver),
      ...driverAvailability(driver, trips, date),
    })),
  };
}
