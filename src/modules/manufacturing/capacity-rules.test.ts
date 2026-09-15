import { describe, expect, it } from 'vitest';
import {
  addDaysToKey,
  capacityLoad,
  computeShiftLoads,
  isLoadComparable,
  isoWeekdayOfKey,
  listShiftWindows,
  localDayKey,
  parseStoredShifts,
  planSlot,
  plannedOperationMinutes,
  shiftDurationMinutes,
  summarizeShiftLoads,
  utilizationPct,
  validateShifts,
  windowIndexFor,
  zonedTimeToUtc,
  type ShiftDefinition,
} from './capacity-rules';

const UTC = 'UTC';
const at = (iso: string) => new Date(iso);
const WEEKDAYS: ShiftDefinition = { name: 'Día', start: '08:00', end: '16:00', days: [1, 2, 3, 4, 5] };

describe('validateShifts', () => {
  it('accepts valid shifts and normalizes the days', () => {
    const result = validateShifts([{ name: 'Matutino', start: '08:00', end: '16:00', days: [5, 1, 1, 3] }]);
    expect(result).toEqual({ ok: true, shifts: [{ name: 'Matutino', start: '08:00', end: '16:00', days: [1, 3, 5] }] });
    expect(validateShifts([])).toEqual({ ok: true, shifts: [] });
  });

  it('rejects invalid hours, empty days and a shift that starts and ends at once', () => {
    expect(validateShifts([{ name: 'A', start: '25:00', end: '16:00', days: [1] }]).ok).toBe(false);
    expect(validateShifts([{ name: 'A', start: '08:00', end: '16:00', days: [] }]).ok).toBe(false);
    expect(validateShifts([{ name: 'A', start: '08:00', end: '08:00', days: [1] }])).toMatchObject({
      ok: false,
      message: expect.stringMatching(/misma hora/),
    });
    expect(validateShifts([{ name: 'A', start: '08:00', end: '16:00', days: [8] }]).ok).toBe(false);
  });

  it('rejects repeated names regardless of case', () => {
    const result = validateShifts([
      { name: 'Noche', start: '22:00', end: '23:00', days: [1] },
      { name: 'noche', start: '08:00', end: '09:00', days: [2] },
    ]);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/repetido/) });
  });

  it('detects overlaps on the same day, across midnight and across the week', () => {
    expect(
      validateShifts([
        { name: 'A', start: '08:00', end: '16:00', days: [1] },
        { name: 'B', start: '15:00', end: '20:00', days: [1] },
      ]).ok
    ).toBe(false);
    expect(
      validateShifts([
        { name: 'Noche', start: '22:00', end: '06:00', days: [1] },
        { name: 'Madrugada', start: '05:00', end: '07:00', days: [2] },
      ]).ok
    ).toBe(false);
    expect(
      validateShifts([
        { name: 'Domingo', start: '22:00', end: '04:00', days: [7] },
        { name: 'Lunes', start: '03:00', end: '05:00', days: [1] },
      ]).ok
    ).toBe(false);
  });

  it('allows back-to-back shifts', () => {
    expect(
      validateShifts([
        { name: 'A', start: '08:00', end: '16:00', days: [1, 2] },
        { name: 'B', start: '16:00', end: '00:00', days: [1, 2] },
        { name: 'C', start: '00:00', end: '08:00', days: [2, 3] },
      ]).ok
    ).toBe(true);
  });

  it('reads stored shifts tolerantly', () => {
    expect(parseStoredShifts([WEEKDAYS, { name: 'mal', start: 'x' }, null])).toEqual([WEEKDAYS]);
    expect(parseStoredShifts('nope')).toEqual([]);
  });
});

describe('time helpers', () => {
  it('measures shifts that cross midnight', () => {
    expect(shiftDurationMinutes({ start: '08:00', end: '16:30' })).toBe(510);
    expect(shiftDurationMinutes({ start: '22:00', end: '06:00' })).toBe(480);
  });

  it('converts Mexico City wall time to UTC (UTC−6, no daylight saving)', () => {
    expect(zonedTimeToUtc(2026, 9, 15, 8, 0, 'America/Mexico_City').toISOString()).toBe('2026-09-15T14:00:00.000Z');
    expect(localDayKey(at('2026-09-16T03:00:00.000Z'), 'America/Mexico_City')).toBe('2026-09-15');
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(isoWeekdayOfKey('2026-09-14')).toBe(1);
    expect(isoWeekdayOfKey('2026-09-20')).toBe(7);
  });
});

describe('listShiftWindows', () => {
  it('lists the windows of the working days in the range', () => {
    const windows = listShiftWindows([WEEKDAYS], at('2026-09-14T00:00:00Z'), at('2026-09-16T00:00:00Z'), UTC);
    expect(windows.map((w) => [w.day, w.start.toISOString(), w.end.toISOString()])).toEqual([
      ['2026-09-14', '2026-09-14T08:00:00.000Z', '2026-09-14T16:00:00.000Z'],
      ['2026-09-15', '2026-09-15T08:00:00.000Z', '2026-09-15T16:00:00.000Z'],
    ]);
  });

  it('includes a window already running at `from` and skips the weekend', () => {
    const windows = listShiftWindows([WEEKDAYS], at('2026-09-18T12:00:00Z'), at('2026-09-22T00:00:00Z'), UTC);
    expect(windows.map((w) => w.day)).toEqual(['2026-09-18', '2026-09-21']);
  });

  it('keeps an overnight shift of the previous day that is still running', () => {
    const night: ShiftDefinition = { name: 'Noche', start: '22:00', end: '06:00', days: [1] };
    const windows = listShiftWindows([night], at('2026-09-15T02:00:00Z'), at('2026-09-15T12:00:00Z'), UTC);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ day: '2026-09-14', shiftName: 'Noche' });
    expect(windows[0].end.toISOString()).toBe('2026-09-15T06:00:00.000Z');
  });

  it('uses the plant time zone by default', () => {
    const windows = listShiftWindows([WEEKDAYS], at('2026-09-15T00:00:00Z'), at('2026-09-15T23:00:00Z'));
    expect(windows[0].start.toISOString()).toBe('2026-09-15T14:00:00.000Z');
  });

  it('returns nothing without shifts or with an empty range', () => {
    expect(listShiftWindows([], at('2026-09-14T00:00:00Z'), at('2026-09-16T00:00:00Z'), UTC)).toEqual([]);
    expect(listShiftWindows([WEEKDAYS], at('2026-09-16T00:00:00Z'), at('2026-09-14T00:00:00Z'), UTC)).toEqual([]);
  });
});

describe('load', () => {
  it('measures load in the capacity unit of the center', () => {
    expect(capacityLoad('minutes', { minutes: 90, quantity: 10, unit: 'm2' })).toBe(90);
    expect(capacityLoad('minutes', { minutes: null })).toBe(0);
    expect(capacityLoad('m2', { quantity: 12.5, unit: 'm²' })).toBe(12.5);
    expect(capacityLoad('pieces', { quantity: 4, unit: 'piezas' })).toBe(4);
    expect(capacityLoad('pieces', { quantity: 4, unit: 'm2' })).toBe(0);
    expect(isLoadComparable('m2', 'kg')).toBe(false);
    expect(isLoadComparable('minutes', 'kg')).toBe(true);
  });

  it('plans operation minutes from the BOM batch', () => {
    expect(plannedOperationMinutes(30, 15, 10, 5)).toBe(75);
    expect(plannedOperationMinutes(7, 0, 1, 3)).toBe(3);
    expect(plannedOperationMinutes(10, 5, 0, 1)).toBe(5);
    expect(plannedOperationMinutes(10, 0, 2, 0)).toBe(20);
  });

  it('attaches operations to the window that contains them or the next one', () => {
    const windows = listShiftWindows([WEEKDAYS], at('2026-09-14T00:00:00Z'), at('2026-09-16T00:00:00Z'), UTC);
    expect(windowIndexFor(windows, at('2026-09-14T09:00:00Z'))).toBe(0);
    expect(windowIndexFor(windows, at('2026-09-14T20:00:00Z'))).toBe(1);
    expect(windowIndexFor(windows, at('2026-09-16T20:00:00Z'))).toBe(-1);
    const loads = computeShiftLoads({
      shifts: [WEEKDAYS],
      capacityPerShift: 50,
      from: at('2026-09-14T00:00:00Z'),
      to: at('2026-09-16T00:00:00Z'),
      items: [
        { id: 'a', start: at('2026-09-14T09:00:00Z'), load: 30 },
        { id: 'b', start: at('2026-09-14T15:00:00Z'), load: 30 },
        { id: 'c', start: at('2026-09-14T20:00:00Z'), load: 10 },
        { id: 'old', start: at('2026-09-10T09:00:00Z'), load: 99 },
      ],
      tz: UTC,
    });
    expect(loads.map((w) => [w.load, w.overloaded, w.itemIds])).toEqual([
      [60, true, ['a', 'b']],
      [10, false, ['c']],
    ]);
    expect(loads[0]).toMatchObject({ available: -10, utilizationPct: 120 });
    expect(summarizeShiftLoads(loads)).toEqual({
      windows: 2,
      overloadedWindows: 1,
      peakUtilizationPct: 120,
      totalLoad: 70,
      totalCapacity: 100,
    });
  });

  it('reports utilization without capacity', () => {
    expect(utilizationPct(0, 0)).toBe(0);
    expect(utilizationPct(5, 0)).toBe(999.9);
    expect(utilizationPct(33, 100)).toBe(33);
  });
});

describe('planSlot', () => {
  const base = {
    shifts: [WEEKDAYS],
    capacityPerShift: 100,
    capacityUnit: 'm2' as const,
    tz: UTC,
    horizonDays: 5,
  };

  it('uses the first shift with room, starting no earlier than requested', () => {
    const slot = planSlot({
      ...base,
      existing: [],
      request: { load: 40, minutes: 60 },
      earliestStart: at('2026-09-14T10:00:00Z'),
    });
    expect(slot).toMatchObject({ status: 'fits', overloaded: false, loadBefore: 0, loadAfter: 40, capacity: 100 });
    expect(slot.start.toISOString()).toBe('2026-09-14T10:00:00.000Z');
    expect(slot.end.toISOString()).toBe('2026-09-14T11:00:00.000Z');
  });

  it('moves to the next shift when the first one is full', () => {
    const slot = planSlot({
      ...base,
      existing: [{ id: 'x', start: at('2026-09-14T08:00:00Z'), load: 80 }],
      request: { load: 40, minutes: 0 },
      earliestStart: at('2026-09-14T07:00:00Z'),
    });
    expect(slot.status).toBe('fits');
    expect(slot.start.toISOString()).toBe('2026-09-15T08:00:00.000Z');
    expect(slot.window?.day).toBe('2026-09-15');
  });

  it('flags an overload when no shift of the horizon has room', () => {
    const slot = planSlot({
      ...base,
      horizonDays: 1,
      existing: [{ id: 'x', start: at('2026-09-14T08:00:00Z'), load: 90 }],
      request: { load: 40, minutes: 30 },
      earliestStart: at('2026-09-14T08:00:00Z'),
    });
    expect(slot).toMatchObject({ status: 'overloaded', overloaded: true, loadBefore: 90, loadAfter: 130, exceedsSingleShift: false });
    expect(slot.window).toMatchObject({ overloaded: true, utilizationPct: 130 });
  });

  it('flags a request bigger than a shift and puts it on an empty shift', () => {
    const slot = planSlot({
      ...base,
      existing: [{ id: 'x', start: at('2026-09-14T08:00:00Z'), load: 10 }],
      request: { load: 150, minutes: 0 },
      earliestStart: at('2026-09-14T08:00:00Z'),
    });
    expect(slot).toMatchObject({ status: 'overloaded', exceedsSingleShift: true, overloaded: true, loadBefore: 0 });
    expect(slot.window?.day).toBe('2026-09-15');
  });

  it('queues minute-based work after the minutes already booked', () => {
    const slot = planSlot({
      ...base,
      capacityPerShift: 480,
      capacityUnit: 'minutes',
      existing: [{ id: 'x', start: at('2026-09-14T08:00:00Z'), load: 120 }],
      request: { load: 60, minutes: 60 },
      earliestStart: at('2026-09-14T08:00:00Z'),
    });
    expect(slot.start.toISOString()).toBe('2026-09-14T10:00:00.000Z');
    expect(slot.end.toISOString()).toBe('2026-09-14T11:00:00.000Z');
  });

  it('plans without shifts at the requested instant (nothing to check)', () => {
    const slot = planSlot({
      ...base,
      shifts: [],
      existing: [],
      request: { load: 10, minutes: 45 },
      earliestStart: at('2026-09-14T08:00:00Z'),
    });
    expect(slot).toMatchObject({ status: 'no_shifts', window: null, overloaded: false });
    expect(slot.end.toISOString()).toBe('2026-09-14T08:45:00.000Z');
  });
});

describe('load of an order in a work center', () => {
  it('minutes default when unknown; quantity centers count an order once', async () => {
    const { capacityLoad, perOrderLoads } = await import('./capacity-rules');
    expect(capacityLoad('minutes', { minutes: null, defaultMinutes: 60 })).toBe(60);
    expect(capacityLoad('minutes', { minutes: 0, defaultMinutes: 60 })).toBe(0);
    const at = (h: number) => new Date(Date.UTC(2026, 8, 15, h));
    const items = [
      { id: 'op1', productionOrderId: 'A', seq: 2, start: at(10), load: 50 },
      { id: 'op2', productionOrderId: 'A', seq: 1, start: at(9), load: 50 },
      { id: 'op3', productionOrderId: 'B', seq: 1, start: at(9), load: 20 },
      { id: 'op4', productionOrderId: 'B', seq: 2, start: at(9), load: 20 },
    ];
    expect(perOrderLoads('m2', items).map((i) => [i.id, i.load])).toEqual([
      ['op1', 0],
      ['op2', 50],
      ['op3', 20],
      ['op4', 0],
    ]);
    expect(perOrderLoads('minutes', items).map((i) => i.load)).toEqual([50, 50, 20, 20]);
  });
});
