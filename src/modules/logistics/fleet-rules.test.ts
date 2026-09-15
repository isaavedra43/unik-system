import { describe, expect, it } from 'vitest';
import {
  describeAvailability,
  driverAvailability,
  mexicoCityDay,
  normalizeVehicleCode,
  parseDay,
  vehicleAvailability,
  type FleetTripRef,
} from './fleet-rules';

const DAY = new Date('2026-09-15T00:00:00.000Z');
const vehicle = { id: 'v1', active: true, maintenanceUntil: null as Date | null };
const trip = (overrides: Partial<FleetTripRef>): FleetTripRef => ({
  id: 't1',
  vehicleId: 'v1',
  driverId: 'dr1',
  status: 'planned',
  date: DAY,
  ...overrides,
});

describe('days', () => {
  it('parses real calendar days only', () => {
    expect(parseDay('2026-09-15')).toEqual(DAY);
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('15-09-2026')).toBeNull();
  });

  it('computes the calendar day in Mexico City', () => {
    expect(mexicoCityDay(new Date('2026-09-16T03:00:00.000Z'))).toBe('2026-09-15');
    expect(mexicoCityDay(new Date('2026-09-16T07:00:00.000Z'))).toBe('2026-09-16');
  });
});

describe('vehicleAvailability', () => {
  it('is available when active, out of maintenance and without trips that day', () => {
    expect(vehicleAvailability(vehicle, [], DAY)).toEqual({
      available: true,
      reasons: [],
      busyTripIds: [],
    });
    expect(
      vehicleAvailability(vehicle, [trip({ date: new Date('2026-09-16T00:00:00.000Z') })], DAY)
        .available
    ).toBe(true);
    expect(vehicleAvailability(vehicle, [trip({ status: 'done' })], DAY).available).toBe(true);
  });

  it('blocks inactive vehicles and maintenance through the given day', () => {
    expect(vehicleAvailability({ ...vehicle, active: false }, [], DAY).reasons).toEqual([
      'inactive',
    ]);
    expect(vehicleAvailability({ ...vehicle, maintenanceUntil: DAY }, [], DAY).reasons).toEqual([
      'maintenance',
    ]);
    expect(
      vehicleAvailability(
        { ...vehicle, maintenanceUntil: new Date('2026-09-14T23:00:00.000Z') },
        [],
        DAY
      ).available
    ).toBe(true);
  });

  it('is busy with a planned trip that day or a trip still en route from before', () => {
    expect(vehicleAvailability(vehicle, [trip({})], DAY)).toEqual({
      available: false,
      reasons: ['busy'],
      busyTripIds: ['t1'],
    });
    expect(
      vehicleAvailability(
        vehicle,
        [trip({ status: 'en_route', date: new Date('2026-09-14T00:00:00.000Z') })],
        DAY
      ).reasons
    ).toEqual(['busy']);
    expect(vehicleAvailability(vehicle, [trip({})], DAY, 't1').available).toBe(true);
  });
});

describe('driverAvailability', () => {
  it('checks activity and trips of the driver', () => {
    expect(driverAvailability({ id: 'dr1', active: true }, [trip({})], DAY).reasons).toEqual([
      'busy',
    ]);
    expect(driverAvailability({ id: 'dr2', active: true }, [trip({})], DAY).available).toBe(true);
    const inactive = driverAvailability({ id: 'dr2', active: false }, [], DAY);
    expect(describeAvailability('El chofer Juan', inactive)).toBe('El chofer Juan está inactivo');
    expect(
      describeAvailability(
        'El chofer Juan',
        driverAvailability({ id: 'dr2', active: true }, [], DAY)
      )
    ).toBeNull();
  });
});

describe('normalizeVehicleCode', () => {
  it('uppercases and joins inner spaces', () => {
    expect(normalizeVehicleCode('  cam 01 ')).toBe('CAM-01');
  });
});
