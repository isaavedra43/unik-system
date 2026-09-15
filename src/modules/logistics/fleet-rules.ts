/**
 * Pure availability rules of the fleet (plan section 4, `fleet-service.ts`):
 * a vehicle or driver is available on a day when it is active, a vehicle is
 * not in maintenance that day, and neither has another active trip that day
 * (a trip still `en_route` from a previous day also keeps them busy).
 *
 * Days are `@db.Date` values: midnight UTC of the calendar day.
 * No Prisma, no server imports.
 */

export type AvailabilityReason = 'inactive' | 'maintenance' | 'busy';

export const AVAILABILITY_REASON_LABELS: Record<AvailabilityReason, string> = {
  inactive: 'está inactivo',
  maintenance: 'está en mantenimiento',
  busy: 'ya tiene un viaje activo ese día',
};

export interface FleetTripRef {
  id: string;
  vehicleId: string;
  driverId: string;
  status: string;
  date: Date;
  number?: string | null;
}

export interface Availability {
  available: boolean;
  reasons: AvailabilityReason[];
  busyTripIds: string[];
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' → midnight UTC; null when the text is not a real calendar day. */
export function parseDay(day: string): Date | null {
  const match = DAY_PATTERN.exec(day.trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === day.trim() ? date : null;
}

export function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isSameDay(a: Date, b: Date): boolean {
  return formatDay(a) === formatDay(b);
}

/** Calendar day in Mexico City for an instant ('YYYY-MM-DD'). */
export function mexicoCityDay(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function busyTrips(
  trips: FleetTripRef[],
  day: Date,
  matches: (trip: FleetTripRef) => boolean,
  ignoreTripId?: string | null
): string[] {
  return trips
    .filter((trip) => trip.id !== ignoreTripId && matches(trip))
    .filter(
      (trip) =>
        (trip.status === 'planned' && isSameDay(trip.date, day)) ||
        (trip.status === 'en_route' && trip.date.getTime() <= day.getTime())
    )
    .map((trip) => trip.id);
}

function result(reasons: AvailabilityReason[], busyTripIds: string[]): Availability {
  return { available: reasons.length === 0, reasons, busyTripIds };
}

export function vehicleAvailability(
  vehicle: { id: string; active: boolean; maintenanceUntil: Date | null },
  trips: FleetTripRef[],
  day: Date,
  ignoreTripId?: string | null
): Availability {
  const reasons: AvailabilityReason[] = [];
  if (!vehicle.active) reasons.push('inactive');
  if (vehicle.maintenanceUntil && vehicle.maintenanceUntil.getTime() >= day.getTime()) {
    reasons.push('maintenance');
  }
  const busy = busyTrips(trips, day, (trip) => trip.vehicleId === vehicle.id, ignoreTripId);
  if (busy.length > 0) reasons.push('busy');
  return result(reasons, busy);
}

export function driverAvailability(
  driver: { id: string; active: boolean },
  trips: FleetTripRef[],
  day: Date,
  ignoreTripId?: string | null
): Availability {
  const reasons: AvailabilityReason[] = [];
  if (!driver.active) reasons.push('inactive');
  const busy = busyTrips(trips, day, (trip) => trip.driverId === driver.id, ignoreTripId);
  if (busy.length > 0) reasons.push('busy');
  return result(reasons, busy);
}

export function describeAvailability(subject: string, availability: Availability): string | null {
  if (availability.available) return null;
  return `${subject} ${availability.reasons.map((r) => AVAILABILITY_REASON_LABELS[r]).join(' y ')}`;
}

/** Vehicle codes are stored uppercase without inner spaces (e.g. "cam 01" → "CAM-01"). */
export function normalizeVehicleCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '-');
}
