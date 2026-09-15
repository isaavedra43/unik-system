/**
 * Pure routing rules for trips (plan section 6.3, `route-rules.ts`):
 *
 * - load of a trip in kg, m² and pieces from the delivered lines and the
 *   `ProductInventoryProfile` factors (weight / area per base unit);
 * - capacity check against the vehicle (`error` violations block the trip);
 * - stop order by nearest neighbour that respects delivery windows, with ETAs,
 *   waits and `warning` violations (late stop, stop without coordinates,
 *   missing weight/area data).
 *
 * No Prisma, no server imports. Distances are great-circle (haversine) and the
 * travel time uses an average urban speed; it is a planning aid, not a router.
 */

export const DEFAULT_AVERAGE_SPEED_KMH = 35;
export const DEFAULT_SERVICE_MINUTES = 20;
const EARTH_RADIUS_KM = 6371;
const EPSILON = 1e-6;

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface VehicleCapacity {
  capacityKg?: number | null;
  capacityM2?: number | null;
  capacityPieces?: number | null;
}

export interface LoadLine {
  deliveryOrderId: string;
  /** Shown in violations (e.g. SKU or product name). */
  label: string;
  /** In `unit` (base unit of the profile). */
  quantity: number;
  unit: string;
  weightKgPerUnit?: number | null;
  areaM2PerUnit?: number | null;
}

export interface LoadTotals {
  kg: number;
  m2: number;
  pieces: number;
  linesWithoutWeight: string[];
  linesWithoutArea: string[];
}

export type RouteViolationCode =
  | 'capacity_kg'
  | 'capacity_m2'
  | 'capacity_pieces'
  | 'window_missed'
  | 'missing_coordinates'
  | 'missing_weight'
  | 'missing_area';

export interface RouteViolation {
  code: RouteViolationCode;
  /** `error` blocks the trip unless a fleet manager overrides it. */
  severity: 'error' | 'warning';
  message: string;
  stopId?: string;
  limit?: number;
  value?: number;
}

export interface RouteStopInput {
  id: string;
  lat?: number | null;
  lng?: number | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  serviceMinutes?: number | null;
}

export interface RouteOptions {
  /** Warehouse or current position; without it the first stop has no travel time. */
  origin?: GeoPoint | null;
  startAt: Date;
  averageSpeedKmh?: number;
  serviceMinutes?: number;
}

export interface PlannedStop {
  id: string;
  sequence: number;
  etaAt: Date | null;
  departAt: Date | null;
  distanceKm: number | null;
  waitMinutes: number;
  late: boolean;
}

export interface RouteSequence {
  stops: PlannedStop[];
  violations: RouteViolation[];
  totalDistanceKm: number;
}

export interface RoutePlan extends RouteSequence {
  load: LoadTotals;
  /** True when at least one violation is an `error`. */
  blocking: boolean;
}

const PIECE_UNITS = new Set([
  'pz',
  'pza',
  'pzas',
  'pzs',
  'pieza',
  'piezas',
  'pc',
  'pcs',
  'u',
  'un',
  'und',
  'unidad',
  'unidades',
  'unit',
  'units',
  'ea',
  'each',
  'caja',
  'cajas',
  'rollo',
  'rollos',
  'placa',
  'placas',
  'hoja',
  'hojas',
  'bulto',
  'bultos',
  'saco',
  'sacos',
  'paquete',
  'paquetes',
  'tramo',
  'tramos',
]);

function normalizeUnit(unit: string): string {
  return unit.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').trim().toLowerCase();
}

/** Units counted piece by piece; anything else (m², kg, m, l…) is one bundle per line. */
export function isPieceUnit(unit: string): boolean {
  return PIECE_UNITS.has(normalizeUnit(unit));
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function finiteNonNegative(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function computeLoad(lines: LoadLine[]): LoadTotals {
  const totals: LoadTotals = {
    kg: 0,
    m2: 0,
    pieces: 0,
    linesWithoutWeight: [],
    linesWithoutArea: [],
  };
  for (const line of lines) {
    const quantity = Number.isFinite(line.quantity) ? Math.max(0, line.quantity) : 0;
    if (quantity === 0) continue;
    if (finiteNonNegative(line.weightKgPerUnit)) totals.kg += quantity * line.weightKgPerUnit;
    else totals.linesWithoutWeight.push(line.label);
    if (finiteNonNegative(line.areaM2PerUnit)) totals.m2 += quantity * line.areaM2PerUnit;
    else totals.linesWithoutArea.push(line.label);
    totals.pieces += isPieceUnit(line.unit) ? Math.ceil(quantity - EPSILON) : 1;
  }
  totals.kg = round(totals.kg, 3);
  totals.m2 = round(totals.m2, 3);
  return totals;
}

const numberFormat = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });
const fmt = (value: number) => numberFormat.format(value);

function preview(labels: string[]): string {
  const unique = [...new Set(labels)];
  return unique.length > 3
    ? `${unique.slice(0, 3).join(', ')} y ${unique.length - 3} más`
    : unique.join(', ');
}

/** Capacity violations; checks only the dimensions the vehicle declares. */
export function checkCapacity(vehicle: VehicleCapacity, load: LoadTotals): RouteViolation[] {
  const violations: RouteViolation[] = [];
  if (finiteNonNegative(vehicle.capacityKg)) {
    if (load.linesWithoutWeight.length > 0) {
      violations.push({
        code: 'missing_weight',
        severity: 'warning',
        message: `Sin peso por unidad en el perfil de: ${preview(load.linesWithoutWeight)}; el peso total puede ser mayor`,
      });
    }
    if (load.kg > vehicle.capacityKg + EPSILON) {
      violations.push({
        code: 'capacity_kg',
        severity: 'error',
        message: `La carga de ${fmt(load.kg)} kg supera la capacidad de ${fmt(vehicle.capacityKg)} kg`,
        limit: vehicle.capacityKg,
        value: load.kg,
      });
    }
  }
  if (finiteNonNegative(vehicle.capacityM2)) {
    if (load.linesWithoutArea.length > 0) {
      violations.push({
        code: 'missing_area',
        severity: 'warning',
        message: `Sin superficie por unidad en el perfil de: ${preview(load.linesWithoutArea)}; la superficie total puede ser mayor`,
      });
    }
    if (load.m2 > vehicle.capacityM2 + EPSILON) {
      violations.push({
        code: 'capacity_m2',
        severity: 'error',
        message: `La carga de ${fmt(load.m2)} m² supera la capacidad de ${fmt(vehicle.capacityM2)} m²`,
        limit: vehicle.capacityM2,
        value: load.m2,
      });
    }
  }
  if (finiteNonNegative(vehicle.capacityPieces) && load.pieces > vehicle.capacityPieces) {
    violations.push({
      code: 'capacity_pieces',
      severity: 'error',
      message: `La carga de ${fmt(load.pieces)} piezas supera la capacidad de ${fmt(vehicle.capacityPieces)} piezas`,
      limit: vehicle.capacityPieces,
      value: load.pieces,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Geography and time
// ---------------------------------------------------------------------------

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidPoint(point: Partial<GeoPoint> | null | undefined): point is GeoPoint {
  return (
    !!point &&
    typeof point.lat === 'number' &&
    typeof point.lng === 'number' &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lng) <= 180
  );
}

function pointOf(stop: RouteStopInput): GeoPoint | null {
  const candidate = { lat: stop.lat ?? undefined, lng: stop.lng ?? undefined };
  return isValidPoint(candidate) ? candidate : null;
}

const timeFormat = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City',
  hour: '2-digit',
  minute: '2-digit',
});

function formatTime(date: Date): string {
  try {
    return timeFormat.format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

function settings(options: RouteOptions) {
  const speed =
    typeof options.averageSpeedKmh === 'number' && options.averageSpeedKmh > 0
      ? options.averageSpeedKmh
      : DEFAULT_AVERAGE_SPEED_KMH;
  const service =
    typeof options.serviceMinutes === 'number' && options.serviceMinutes >= 0
      ? options.serviceMinutes
      : DEFAULT_SERVICE_MINUTES;
  return { speed, service };
}

function travelMs(km: number, speedKmh: number): number {
  return (km / speedKmh) * 3_600_000;
}

function serviceMs(stop: RouteStopInput, fallbackMinutes: number): number {
  const minutes =
    typeof stop.serviceMinutes === 'number' && stop.serviceMinutes >= 0
      ? stop.serviceMinutes
      : fallbackMinutes;
  return minutes * 60_000;
}

/** ETAs, waits and window/coordinate warnings for stops in the given order. */
export function computeEtas(orderedStops: RouteStopInput[], options: RouteOptions): RouteSequence {
  const { speed, service } = settings(options);
  let position: GeoPoint | null = isValidPoint(options.origin) ? options.origin : null;
  let clock = options.startAt.getTime();
  let totalDistanceKm = 0;
  const violations: RouteViolation[] = [];
  const stops = orderedStops.map((stop, index): PlannedStop => {
    const point = pointOf(stop);
    if (!point) {
      violations.push({
        code: 'missing_coordinates',
        severity: 'warning',
        stopId: stop.id,
        message: 'La parada no tiene coordenadas; se coloca al final y sin hora estimada',
      });
      return {
        id: stop.id,
        sequence: index + 1,
        etaAt: null,
        departAt: null,
        distanceKm: null,
        waitMinutes: 0,
        late: false,
      };
    }
    const km = position ? haversineKm(position, point) : 0;
    const arrival = clock + travelMs(km, speed);
    const windowStart = stop.windowStart?.getTime();
    const windowEnd = stop.windowEnd?.getTime();
    const eta = windowStart !== undefined && arrival < windowStart ? windowStart : arrival;
    const late = windowEnd !== undefined && eta > windowEnd;
    if (late) {
      violations.push({
        code: 'window_missed',
        severity: 'warning',
        stopId: stop.id,
        message: `Llegada estimada ${formatTime(new Date(eta))}, después del fin de la ventana (${formatTime(new Date(windowEnd!))})`,
      });
    }
    const depart = eta + serviceMs(stop, service);
    totalDistanceKm += km;
    position = point;
    clock = depart;
    return {
      id: stop.id,
      sequence: index + 1,
      etaAt: new Date(Math.round(eta)),
      departAt: new Date(Math.round(depart)),
      distanceKm: round(km, 2),
      waitMinutes: Math.round((eta - arrival) / 60_000),
      late,
    };
  });
  return { stops, violations, totalDistanceKm: round(totalDistanceKm, 2) };
}

interface Candidate {
  stop: RouteStopInput;
  point: GeoPoint;
  km: number;
  arrival: number;
  feasible: boolean;
}

function windowEndOf(stop: RouteStopInput): number {
  return stop.windowEnd ? stop.windowEnd.getTime() : Number.POSITIVE_INFINITY;
}

/** After serving `candidate`, can every other stop that is reachable now still be reached in time? */
function keepsOthersReachable(
  candidate: Candidate,
  others: Candidate[],
  speed: number,
  service: number
): boolean {
  const windowStart = candidate.stop.windowStart?.getTime();
  const start =
    (windowStart !== undefined && candidate.arrival < windowStart
      ? windowStart
      : candidate.arrival) + serviceMs(candidate.stop, service);
  for (const other of others) {
    if (other.stop.id === candidate.stop.id || !other.feasible || !other.stop.windowEnd) continue;
    const arrival = start + travelMs(haversineKm(candidate.point, other.point), speed);
    if (arrival > other.stop.windowEnd.getTime()) return false;
  }
  return true;
}

function pickBy(pool: Candidate[], compare: (a: Candidate, b: Candidate) => number): Candidate {
  return pool.reduce((best, current) => (compare(current, best) < 0 ? current : best));
}

const byDistance = (a: Candidate, b: Candidate) =>
  a.km - b.km || windowEndOf(a.stop) - windowEndOf(b.stop);
const byWindow = (a: Candidate, b: Candidate) =>
  windowEndOf(a.stop) - windowEndOf(b.stop) || a.km - b.km;

/**
 * Nearest neighbour respecting windows: among the stops still reachable in
 * time, prefer those that keep every other reachable stop on time and take
 * the nearest; when none is safe, serve the most urgent window first. Stops
 * without coordinates go last in their input order.
 */
export function orderStops(stops: RouteStopInput[], options: RouteOptions): RouteSequence {
  const { speed, service } = settings(options);
  const located = stops.filter((stop) => pointOf(stop) !== null);
  const unlocated = stops.filter((stop) => pointOf(stop) === null);
  const remaining = [...located];
  const ordered: RouteStopInput[] = [];
  let position: GeoPoint | null = isValidPoint(options.origin) ? options.origin : null;
  let clock = options.startAt.getTime();

  while (remaining.length > 0) {
    const candidates: Candidate[] = remaining.map((stop) => {
      const point = pointOf(stop)!;
      const km = position ? haversineKm(position, point) : 0;
      const arrival = clock + travelMs(km, speed);
      return { stop, point, km, arrival, feasible: arrival <= windowEndOf(stop) };
    });
    const feasible = candidates.filter((c) => c.feasible);
    let pick: Candidate;
    if (feasible.length > 0) {
      const safe = feasible.filter((c) => keepsOthersReachable(c, candidates, speed, service));
      pick = safe.length > 0 ? pickBy(safe, byDistance) : pickBy(feasible, byWindow);
    } else {
      pick = pickBy(candidates, byWindow);
    }
    ordered.push(pick.stop);
    remaining.splice(remaining.indexOf(pick.stop), 1);
    const windowStart = pick.stop.windowStart?.getTime();
    clock =
      (windowStart !== undefined && pick.arrival < windowStart ? windowStart : pick.arrival) +
      serviceMs(pick.stop, service);
    position = pick.point;
  }

  return computeEtas([...ordered, ...unlocated], options);
}

/** Full plan: load, capacity, stop order (or the given order) and violations. */
export function planRoute(input: {
  vehicle: VehicleCapacity;
  lines: LoadLine[];
  stops: RouteStopInput[];
  options: RouteOptions;
  keepOrder?: boolean;
}): RoutePlan {
  const load = computeLoad(input.lines);
  const capacity = checkCapacity(input.vehicle, load);
  const route = input.keepOrder
    ? computeEtas(input.stops, input.options)
    : orderStops(input.stops, input.options);
  const violations = [...capacity, ...route.violations];
  return {
    ...route,
    violations,
    load,
    blocking: violations.some((v) => v.severity === 'error'),
  };
}
