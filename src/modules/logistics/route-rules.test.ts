import { describe, expect, it } from 'vitest';
import {
  checkCapacity,
  computeEtas,
  computeLoad,
  haversineKm,
  isPieceUnit,
  orderStops,
  planRoute,
  type LoadLine,
  type RouteStopInput,
} from './route-rules';

const START = new Date('2026-09-15T14:00:00.000Z'); // 08:00 Mexico City
const minutes = (n: number) => new Date(START.getTime() + n * 60_000);
const ORIGIN = { lat: 19.4, lng: -99.1 };

describe('load', () => {
  it('recognizes piece units', () => {
    expect(isPieceUnit('Pza.')).toBe(true);
    expect(isPieceUnit('piezas')).toBe(true);
    expect(isPieceUnit('Caja')).toBe(true);
    expect(isPieceUnit('m2')).toBe(false);
    expect(isPieceUnit('kg')).toBe(false);
  });

  it('adds kg, m² and pieces from the profile factors', () => {
    const lines: LoadLine[] = [
      {
        deliveryOrderId: 'd1',
        label: 'PISO-60',
        quantity: 10,
        unit: 'm2',
        weightKgPerUnit: 20,
        areaM2PerUnit: 1,
      },
      {
        deliveryOrderId: 'd1',
        label: 'ZOCLO',
        quantity: 5,
        unit: 'pz',
        weightKgPerUnit: 2.5,
        areaM2PerUnit: null,
      },
      {
        deliveryOrderId: 'd2',
        label: 'ADHESIVO',
        quantity: 3.2,
        unit: 'pz',
        weightKgPerUnit: null,
        areaM2PerUnit: 0.1,
      },
      { deliveryOrderId: 'd2', label: 'VACIA', quantity: 0, unit: 'pz' },
    ];
    expect(computeLoad(lines)).toEqual({
      kg: 212.5,
      m2: 10.32,
      pieces: 1 + 5 + 4,
      linesWithoutWeight: ['ADHESIVO'],
      linesWithoutArea: ['ZOCLO'],
    });
  });

  it('flags capacity overruns as errors and missing data as warnings', () => {
    const load = computeLoad([
      {
        deliveryOrderId: 'd1',
        label: 'PISO-60',
        quantity: 10,
        unit: 'm2',
        weightKgPerUnit: 20,
        areaM2PerUnit: 1,
      },
      { deliveryOrderId: 'd1', label: 'SIN-PESO', quantity: 30, unit: 'pz' },
    ]);
    const violations = checkCapacity({ capacityKg: 150, capacityM2: 20, capacityPieces: 20 }, load);
    expect(violations.map((v) => [v.code, v.severity])).toEqual([
      ['missing_weight', 'warning'],
      ['capacity_kg', 'error'],
      ['missing_area', 'warning'],
      ['capacity_pieces', 'error'],
    ]);
    expect(violations[1].message).toBe('La carga de 200 kg supera la capacidad de 150 kg');
    expect(checkCapacity({}, load)).toEqual([]);
  });
});

describe('route', () => {
  it('measures great-circle distance', () => {
    const zocalo = { lat: 19.4326, lng: -99.1332 };
    const angel = { lat: 19.427, lng: -99.1677 };
    const km = haversineKm(zocalo, angel);
    expect(km).toBeGreaterThan(3.4);
    expect(km).toBeLessThan(3.9);
  });

  it('orders by nearest neighbour without windows', () => {
    const stops: RouteStopInput[] = [
      { id: 'far', lat: 19.5, lng: -99.2 },
      { id: 'near', lat: 19.41, lng: -99.11 },
      { id: 'mid', lat: 19.45, lng: -99.15 },
    ];
    const route = orderStops(stops, { origin: ORIGIN, startAt: START });
    expect(route.stops.map((s) => s.id)).toEqual(['near', 'mid', 'far']);
    expect(route.stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
    expect(route.violations).toEqual([]);
    expect(route.totalDistanceKm).toBeGreaterThan(15);
  });

  it('serves first a far stop whose window would be missed by going to the nearest one', () => {
    const stops: RouteStopInput[] = [
      { id: 'near', lat: 19.401, lng: -99.101 },
      { id: 'urgent', lat: 19.5, lng: -99.2, windowEnd: minutes(35) },
    ];
    const route = orderStops(stops, { origin: ORIGIN, startAt: START });
    expect(route.stops.map((s) => s.id)).toEqual(['urgent', 'near']);
    expect(route.violations).toEqual([]);
    expect(route.stops[0].etaAt!.getTime()).toBeLessThanOrEqual(minutes(35).getTime());
  });

  it('warns when a window cannot be met and waits for a window that has not opened', () => {
    const late = computeEtas([{ id: 'late', lat: 19.5, lng: -99.2, windowEnd: minutes(10) }], {
      origin: ORIGIN,
      startAt: START,
    });
    expect(late.violations).toMatchObject([
      { code: 'window_missed', severity: 'warning', stopId: 'late' },
    ]);
    expect(late.stops[0].late).toBe(true);

    const early = computeEtas(
      [{ id: 'early', lat: 19.401, lng: -99.101, windowStart: minutes(60) }],
      {
        origin: ORIGIN,
        startAt: START,
      }
    );
    expect(early.stops[0].etaAt).toEqual(minutes(60));
    expect(early.stops[0].waitMinutes).toBeGreaterThan(50);
    expect(early.stops[0].departAt).toEqual(minutes(80));
  });

  it('puts stops without coordinates last, without ETA', () => {
    const route = orderStops(
      [
        { id: 'blind', lat: null, lng: null },
        { id: 'seen', lat: 19.41, lng: -99.11 },
      ],
      { origin: ORIGIN, startAt: START }
    );
    expect(route.stops.map((s) => [s.id, s.etaAt === null])).toEqual([
      ['seen', false],
      ['blind', true],
    ]);
    expect(route.violations).toMatchObject([{ code: 'missing_coordinates', stopId: 'blind' }]);
  });

  it('plans a full route and marks capacity errors as blocking; keepOrder respects the given order', () => {
    const plan = planRoute({
      vehicle: { capacityKg: 100 },
      lines: [
        { deliveryOrderId: 'a', label: 'PISO', quantity: 10, unit: 'm2', weightKgPerUnit: 20 },
      ],
      stops: [
        { id: 'far', lat: 19.5, lng: -99.2 },
        { id: 'near', lat: 19.41, lng: -99.11 },
      ],
      options: { origin: ORIGIN, startAt: START },
      keepOrder: true,
    });
    expect(plan.blocking).toBe(true);
    expect(plan.stops.map((s) => s.id)).toEqual(['far', 'near']);
    expect(plan.load.kg).toBe(200);
  });
});
