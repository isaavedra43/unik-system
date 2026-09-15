import { z } from 'zod';

/**
 * Calendar helpers of the finance module. Pure.
 *
 * Business dates are local days of Mexico City written as `YYYY-MM-DD`
 * ("date keys"). `@db.Date` columns (LedgerEntry.date, Expense.date…) are
 * stored at UTC midnight of that key, and `DateTime` due dates of obligations
 * use the same convention, so a key round-trips through the database without
 * shifting a day. Instants (`now`, `postedAt`) are converted to their local
 * day before comparing.
 */

export const FINANCE_TIMEZONE = 'America/Mexico_City';
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_KEY = /^(\d{4})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isDateKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = DATE_KEY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function isPeriodKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = PERIOD_KEY.exec(value);
  return match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 12;
}

export const dateKeySchema = z
  .string()
  .trim()
  .refine(isDateKey, { message: 'Fecha inválida (usa AAAA-MM-DD)' });

export const periodKeySchema = z
  .string()
  .trim()
  .refine(isPeriodKey, { message: 'Periodo inválido (usa AAAA-MM)' });

/** Local day (Mexico City) of an instant. */
export function localDateKey(instant: Date, timeZone: string = FINANCE_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Key of a value stored at UTC midnight (`@db.Date`, obligation due dates). */
export function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** UTC-midnight Date of a key, the storage form of business dates. */
export function toDbDate(key: string): Date {
  if (!isDateKey(key)) throw new Error(`Fecha inválida: ${key}`);
  return new Date(`${key}T00:00:00.000Z`);
}

export function addDaysToKey(key: string, days: number): string {
  return dateKeyOf(new Date(toDbDate(key).getTime() + Math.trunc(days) * DAY_MS));
}

/** Whole days from `fromKey` to `toKey` (negative when `toKey` is earlier). */
export function daysBetweenKeys(fromKey: string, toKey: string): number {
  return Math.round((toDbDate(toKey).getTime() - toDbDate(fromKey).getTime()) / DAY_MS);
}

/** 'YYYY-MM' of a date key, a period key or a UTC-midnight Date. */
export function periodKeyOfKey(value: string | Date): string {
  if (value instanceof Date) return dateKeyOf(value).slice(0, 7);
  if (isPeriodKey(value)) return value;
  if (!isDateKey(value)) throw new Error(`Fecha inválida: ${value}`);
  return value.slice(0, 7);
}

export interface PeriodBounds {
  periodKey: string;
  startKey: string;
  endKey: string;
  start: Date;
  /** UTC midnight of the last day (inclusive bound for `@db.Date` columns). */
  end: Date;
  /** UTC midnight of the first day of the next period (exclusive bound). */
  nextStart: Date;
}

export function periodBounds(periodKey: string): PeriodBounds {
  if (!isPeriodKey(periodKey)) throw new Error(`Periodo inválido: ${periodKey}`);
  const [year, month] = periodKey.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const nextStart = new Date(Date.UTC(year, month, 1));
  const end = new Date(nextStart.getTime() - DAY_MS);
  return {
    periodKey,
    startKey: dateKeyOf(start),
    endKey: dateKeyOf(end),
    start,
    end,
    nextStart,
  };
}

export function previousPeriodKey(periodKey: string): string {
  const { start } = periodBounds(periodKey);
  return dateKeyOf(new Date(start.getTime() - DAY_MS)).slice(0, 7);
}

/** Monday of the ISO week that contains `key`. */
export function weekStartKey(key: string): string {
  const date = toDbDate(key);
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  return addDaysToKey(key, -weekday);
}

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Local day of `instant` or the key itself. */
export function toDateKey(value: Date | string, timeZone: string = FINANCE_TIMEZONE): string {
  if (typeof value === 'string') {
    if (isDateKey(value)) return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Fecha inválida: ${value}`);
    return localDateKey(parsed, timeZone);
  }
  return localDateKey(value, timeZone);
}
