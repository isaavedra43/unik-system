import { z } from 'zod';
import { normalizeUnit } from '@/modules/inventory/stock-math';
import { MANUFACTURING_TIMEZONE, type CapacityUnit } from './manufacturing-types';

/**
 * Capacity rules of the work centers (plan 6.2). Pure module.
 *
 * - Shifts: `[{name, start: "HH:mm", end: "HH:mm", days: [1..7]}]` in local time
 *   of the plant (ISO weekdays, 1 = Monday). A shift whose end is not after its
 *   start crosses midnight. Shifts of a center never overlap.
 * - Load of a shift: operations are attached to the shift window that contains
 *   their planned start (or the next window when planned outside shifts). The
 *   load unit is the center's `capacityUnit`: minutes of the operation, or the
 *   order quantity when it is expressed in m² / pieces (other units add no load).
 * - `planSlot`: first window from `earliestStart` where the existing load plus the
 *   request fits the capacity; when none fits within the horizon (or the request
 *   alone is bigger than a shift) the slot is flagged `overloaded` so the caller
 *   raises the warning and the work item.
 */

const EPS = 1e-6;
const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const MAX_WINDOW_DAYS = 400;

export interface ShiftDefinition {
  name: string;
  /** HH:mm local time. */
  start: string;
  /** HH:mm local time; not after `start` = ends the next day. */
  end: string;
  /** ISO weekdays of the start (1 = Monday … 7 = Sunday). */
  days: number[];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const shiftSchema = z
  .object({
    name: z.string().trim().min(1, 'Falta el nombre del turno').max(60),
    start: z.string().trim().regex(HHMM, 'Hora de inicio inválida (HH:mm)'),
    end: z.string().trim().regex(HHMM, 'Hora de fin inválida (HH:mm)'),
    days: z.array(z.number().int().min(1).max(7)).min(1, 'Indica los días del turno').max(7),
  })
  .refine((shift) => shift.start !== shift.end, {
    message: 'El turno no puede empezar y terminar a la misma hora',
    path: ['end'],
  });

export const shiftsSchema = z.array(shiftSchema).max(10, 'Máximo 10 turnos por centro');

export function minutesOfDay(hhmm: string): number {
  const match = HHMM.exec(hhmm.trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Length of a shift in minutes (a shift crossing midnight ends the next day). */
export function shiftDurationMinutes(shift: Pick<ShiftDefinition, 'start' | 'end'>): number {
  const start = minutesOfDay(shift.start);
  const end = minutesOfDay(shift.end);
  return end > start ? end - start : DAY_MINUTES - start + end;
}

export type ShiftsValidation =
  | { ok: true; shifts: ShiftDefinition[] }
  | { ok: false; message: string };

function weekIntervals(shift: ShiftDefinition): Array<[number, number]> {
  const duration = shiftDurationMinutes(shift);
  const start = minutesOfDay(shift.start);
  const intervals: Array<[number, number]> = [];
  for (const day of shift.days) {
    const from = (day - 1) * DAY_MINUTES + start;
    const to = from + duration;
    if (to <= WEEK_MINUTES) intervals.push([from, to]);
    else {
      intervals.push([from, WEEK_MINUTES]);
      intervals.push([0, to - WEEK_MINUTES]);
    }
  }
  return intervals;
}

/** Parses and checks the shifts of a work center: valid hours, days, unique names, no overlaps. */
export function validateShifts(value: unknown): ShiftsValidation {
  const parsed = shiftsSchema.safeParse(value ?? []);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `turno ${Number(issue.path[0]) + 1}: ` : '';
    return { ok: false, message: `Turnos inválidos: ${path}${issue?.message ?? 'formato incorrecto'}` };
  }
  const shifts: ShiftDefinition[] = parsed.data.map((shift) => ({
    name: shift.name,
    start: shift.start,
    end: shift.end,
    days: [...new Set(shift.days)].sort((a, b) => a - b),
  }));
  const names = new Set<string>();
  for (const shift of shifts) {
    const key = shift.name.toLocaleLowerCase('es-MX');
    if (names.has(key)) return { ok: false, message: `El turno "${shift.name}" está repetido` };
    names.add(key);
  }
  for (let i = 0; i < shifts.length; i++) {
    for (let j = i + 1; j < shifts.length; j++) {
      const a = weekIntervals(shifts[i]);
      const b = weekIntervals(shifts[j]);
      const overlaps = a.some(([a1, a2]) => b.some(([b1, b2]) => a1 < b2 && b1 < a2));
      if (overlaps) {
        return {
          ok: false,
          message: `Los turnos "${shifts[i].name}" y "${shifts[j].name}" se enciman`,
        };
      }
    }
  }
  return { ok: true, shifts };
}

/** Tolerant read of stored shifts (invalid entries are ignored). */
export function parseStoredShifts(value: unknown): ShiftDefinition[] {
  if (!Array.isArray(value)) return [];
  const out: ShiftDefinition[] = [];
  for (const entry of value) {
    const parsed = shiftSchema.safeParse(entry);
    if (parsed.success) {
      out.push({ ...parsed.data, days: [...new Set(parsed.data.days)].sort((a, b) => a - b) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Time zone helpers (Intl, no external data)
// ---------------------------------------------------------------------------

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, formatter);
  }
  return formatter;
}

export function zonedParts(date: Date, tz: string = MANUFACTURING_TIMEZONE): ZonedParts {
  const parts = formatterFor(tz).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

function offsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / MINUTE_MS);
}

/** UTC instant of a local wall time in `tz`. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string = MANUFACTURING_TIMEZONE
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMinutes(new Date(guess), tz);
  let result = guess - first * MINUTE_MS;
  const second = offsetMinutes(new Date(result), tz);
  if (second !== first) result = guess - second * MINUTE_MS;
  return new Date(result);
}

/** Local calendar day `YYYY-MM-DD` of an instant. */
export function localDayKey(date: Date, tz: string = MANUFACTURING_TIMEZONE): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function splitDayKey(key: string): [number, number, number] {
  const [y, m, d] = key.split('-').map(Number);
  return [y, m, d];
}

export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = splitDayKey(key);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a `YYYY-MM-DD` key. */
export function isoWeekdayOfKey(key: string): number {
  const [y, m, d] = splitDayKey(key);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

// ---------------------------------------------------------------------------
// Shift windows and load
// ---------------------------------------------------------------------------

export interface ShiftWindow {
  shiftName: string;
  /** Local day where the shift starts. */
  day: string;
  start: Date;
  end: Date;
}

/** Shift windows overlapping `[from, to)`, sorted by start. */
export function listShiftWindows(
  shifts: readonly ShiftDefinition[],
  from: Date,
  to: Date,
  tz: string = MANUFACTURING_TIMEZONE
): ShiftWindow[] {
  if (shifts.length === 0 || !(to.getTime() > from.getTime())) return [];
  const windows: ShiftWindow[] = [];
  const lastKey = localDayKey(to, tz);
  let key = addDaysToKey(localDayKey(from, tz), -1);
  for (let guard = 0; key <= lastKey && guard < MAX_WINDOW_DAYS; guard++) {
    const weekday = isoWeekdayOfKey(key);
    const [y, m, d] = splitDayKey(key);
    for (const shift of shifts) {
      if (!shift.days.includes(weekday)) continue;
      const startMinutes = minutesOfDay(shift.start);
      const endMinutes = minutesOfDay(shift.end);
      const start = zonedTimeToUtc(y, m, d, Math.floor(startMinutes / 60), startMinutes % 60, tz);
      const [ey, em, ed] = splitDayKey(endMinutes > startMinutes ? key : addDaysToKey(key, 1));
      const end = zonedTimeToUtc(ey, em, ed, Math.floor(endMinutes / 60), endMinutes % 60, tz);
      if (end.getTime() > from.getTime() && start.getTime() < to.getTime()) {
        windows.push({ shiftName: shift.name, day: key, start, end });
      }
    }
    key = addDaysToKey(key, 1);
  }
  return windows.sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.shiftName.localeCompare(b.shiftName)
  );
}

/** Load that an operation adds to a center, in the center's capacity unit (minutes default when unknown). */
export function capacityLoad(
  capacityUnit: CapacityUnit,
  input: { minutes?: number | null; quantity?: number | null; unit?: string | null; defaultMinutes?: number }
): number {
  if (capacityUnit === 'minutes') return Math.max(0, input.minutes ?? input.defaultMinutes ?? 0);
  if (!isLoadComparable(capacityUnit, input.unit)) return 0;
  return Math.max(0, input.quantity ?? 0);
}

/** Whether a quantity in `unit` adds load to a center measured in `capacityUnit`. */
export function isLoadComparable(capacityUnit: CapacityUnit, unit: string | null | undefined): boolean {
  if (capacityUnit === 'minutes') return true;
  const normalized = normalizeUnit(unit);
  if (capacityUnit === 'm2') return normalized === 'm2';
  return normalized === 'pz' || normalized === 'pieces';
}

/**
 * Minutes planned for an operation: preparation plus the standard minutes of
 * the BOM batch scaled to the planned quantity (rounded up).
 */
export function plannedOperationMinutes(
  stdMinutes: number,
  setupMinutes: number,
  plannedQty: number,
  batchQty: number
): number {
  const std = Math.max(0, stdMinutes);
  const setup = Math.max(0, setupMinutes);
  const batch = batchQty > EPS ? batchQty : 1;
  return setup + Math.ceil((std * Math.max(0, plannedQty)) / batch - EPS);
}

export interface CapacityLoadItem {
  id: string;
  start: Date;
  load: number;
}

export interface ShiftLoad extends ShiftWindow {
  capacity: number;
  load: number;
  available: number;
  utilizationPct: number;
  overloaded: boolean;
  itemIds: string[];
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function utilizationPct(load: number, capacity: number): number {
  if (capacity <= EPS) return load > EPS ? 999.9 : 0;
  return Math.round((load / capacity) * 1000) / 10;
}

/**
 * Index of the window an item planned at `at` belongs to: the window that
 * contains it or, planned outside shifts, the next one. -1 when none.
 */
export function windowIndexFor(
  windows: ReadonlyArray<Pick<ShiftWindow, 'start' | 'end'>>,
  at: Date
): number {
  const time = at.getTime();
  return windows.findIndex((window) => window.end.getTime() > time);
}

export function computeShiftLoads(input: {
  shifts: readonly ShiftDefinition[];
  capacityPerShift: number;
  from: Date;
  to: Date;
  items: readonly CapacityLoadItem[];
  tz?: string;
}): ShiftLoad[] {
  const windows = listShiftWindows(input.shifts, input.from, input.to, input.tz);
  const capacity = Math.max(0, input.capacityPerShift);
  const loads: ShiftLoad[] = windows.map((window) => ({
    ...window,
    capacity,
    load: 0,
    available: capacity,
    utilizationPct: 0,
    overloaded: false,
    itemIds: [],
  }));
  if (loads.length === 0) return loads;
  for (const item of input.items) {
    const index = windowIndexFor(loads, item.start);
    if (index < 0) continue;
    // Before the first listed window and outside it: the item is outside the range.
    if (index === 0 && item.start.getTime() < loads[0].start.getTime() && item.start < input.from) {
      continue;
    }
    const window = loads[index];
    window.load = round(window.load + Math.max(0, item.load));
    window.itemIds.push(item.id);
  }
  for (const window of loads) {
    window.available = round(capacity - window.load);
    window.utilizationPct = utilizationPct(window.load, capacity);
    window.overloaded = window.load > capacity + EPS;
  }
  return loads;
}

export interface PlanSlotInput {
  shifts: readonly ShiftDefinition[];
  capacityPerShift: number;
  capacityUnit: CapacityUnit;
  /** Operations already planned at the center (other orders). */
  existing: readonly CapacityLoadItem[];
  /** Load (capacity unit) and duration of the operation being planned. */
  request: { load: number; minutes: number };
  earliestStart: Date;
  horizonDays?: number;
  tz?: string;
}

export interface PlanSlotResult {
  status: 'fits' | 'overloaded' | 'no_shifts';
  start: Date;
  end: Date;
  /** Chosen window including the request (null without shifts). */
  window: ShiftLoad | null;
  loadBefore: number;
  loadAfter: number;
  capacity: number;
  overloaded: boolean;
  /** The request alone is bigger than one shift. */
  exceedsSingleShift: boolean;
}

/** First shift window with room for the request (see the module comment). */
export function planSlot(input: PlanSlotInput): PlanSlotResult {
  const capacity = Math.max(0, input.capacityPerShift);
  const requestLoad = Math.max(0, input.request.load);
  const minutes = Math.max(0, Math.round(input.request.minutes));
  const horizonDays = Math.min(Math.max(input.horizonDays ?? 30, 1), 365);
  const earliest = input.earliestStart;
  const exceedsSingleShift = requestLoad > capacity + EPS;
  const loads = computeShiftLoads({
    shifts: input.shifts,
    capacityPerShift: capacity,
    from: earliest,
    to: new Date(earliest.getTime() + horizonDays * DAY_MINUTES * MINUTE_MS),
    items: input.existing,
    tz: input.tz,
  });
  if (loads.length === 0) {
    return {
      status: 'no_shifts',
      start: earliest,
      end: new Date(earliest.getTime() + minutes * MINUTE_MS),
      window: null,
      loadBefore: 0,
      loadAfter: requestLoad,
      capacity,
      overloaded: false,
      exceedsSingleShift,
    };
  }
  const pick = (window: ShiftLoad, status: 'fits' | 'overloaded'): PlanSlotResult => {
    const queued =
      input.capacityUnit === 'minutes'
        ? window.start.getTime() + Math.round(window.load) * MINUTE_MS
        : window.start.getTime();
    const startTime = Math.max(earliest.getTime(), Math.min(queued, window.end.getTime()));
    const loadAfter = round(window.load + requestLoad);
    const chosen: ShiftLoad = {
      ...window,
      load: loadAfter,
      available: round(capacity - loadAfter),
      utilizationPct: utilizationPct(loadAfter, capacity),
      overloaded: loadAfter > capacity + EPS,
      itemIds: [...window.itemIds],
    };
    return {
      status,
      start: new Date(startTime),
      end: new Date(startTime + minutes * MINUTE_MS),
      window: chosen,
      loadBefore: window.load,
      loadAfter,
      capacity,
      overloaded: chosen.overloaded,
      exceedsSingleShift,
    };
  };
  if (!exceedsSingleShift) {
    const free = loads.find((window) => window.load + requestLoad <= capacity + EPS);
    if (free) return pick(free, 'fits');
    return pick(loads[0], 'overloaded');
  }
  return pick(loads.find((window) => window.load <= EPS) ?? loads[0], 'overloaded');
}

export interface LoadSummary {
  windows: number;
  overloadedWindows: number;
  peakUtilizationPct: number;
  totalLoad: number;
  totalCapacity: number;
}

export function summarizeShiftLoads(loads: readonly ShiftLoad[]): LoadSummary {
  return {
    windows: loads.length,
    overloadedWindows: loads.filter((window) => window.overloaded).length,
    peakUtilizationPct: loads.reduce((peak, window) => Math.max(peak, window.utilizationPct), 0),
    totalLoad: round(loads.reduce((sum, window) => sum + window.load, 0)),
    totalCapacity: round(loads.reduce((sum, window) => sum + window.capacity, 0)),
  };
}

/**
 * In a center measured by quantity (m², pieces) an order loads its planned
 * quantity once, however many of its operations run there: only its first
 * operation (earliest start, then lowest sequence) keeps the load. Minutes
 * centers keep every operation's minutes.
 */
export function perOrderLoads<T extends { id: string; productionOrderId: string; start: Date; seq?: number | null; load: number }>(
  capacityUnit: CapacityUnit,
  items: readonly T[]
): T[] {
  if (capacityUnit === 'minutes') return [...items];
  const first = new Map<string, T>();
  for (const item of items) {
    const current = first.get(item.productionOrderId);
    if (
      !current ||
      item.start.getTime() < current.start.getTime() ||
      (item.start.getTime() === current.start.getTime() && (item.seq ?? 0) < (current.seq ?? 0))
    ) {
      first.set(item.productionOrderId, item);
    }
  }
  return items.map((item) => (first.get(item.productionOrderId)?.id === item.id ? item : { ...item, load: 0 }));
}
