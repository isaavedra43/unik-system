/**
 * Shared date helpers for AI tools.
 *
 * IMPORTANT: `orderDate` in the database is a PostgreSQL DATE field
 * (no time component). It is stored as UTC midnight (2026-09-09 00:00:00Z).
 *
 * These helpers create UTC-midnight Date objects so that Prisma `gte`/`lte`
 * comparisons match correctly regardless of the server's timezone.
 *
 * The "today" / "yesterday" concepts use the AMERICA/MEXICO_CITY timezone
 * (UTC-6) to determine which calendar date to query, then create UTC-midnight
 * Date objects for that date. This ensures "hoy" matches what the user in
 * Mexico considers "today", regardless of the server's timezone.
 */

import { z } from 'zod';

/**
 * The timezone used for all "today"/"yesterday"/"this week" calculations.
 * UNIK operates in Mexico, so we use America/Mexico_City (UTC-6).
 */
const UNIK_TIMEZONE = 'America/Mexico_City';

/**
 * Returns the current date components (year, month, day) in the UNIK timezone
 * (America/Mexico_City), regardless of the server's local timezone.
 */
function getCurrentDateInUnikTz(): { year: number; month: number; day: number; dayOfWeek: number } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: UNIK_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const year = parseInt(parts.find((p) => p.type === 'year')?.value ?? '2026', 10);
  const month = parseInt(parts.find((p) => p.type === 'month')?.value ?? '1', 10) - 1; // 0-indexed
  const day = parseInt(parts.find((p) => p.type === 'day')?.value ?? '1', 10);
  const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[weekdayStr] ?? 0;
  return { year, month, day, dayOfWeek };
}

/**
 * Creates a UTC-midnight Date for the given date components.
 */
function utcDateFromComponents(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

/**
 * Creates a UTC end-of-day Date (23:59:59.999Z) for the given date components.
 */
function utcEndOfDayFromComponents(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
}

/**
 * Date range shortcuts understood by resolveDateRange.
 * "all" means no date filter (all history).
 */
export const DATE_SHORTCUTS = [
  'today',
  'yesterday',
  'this_week',
  'this_month',
  'last_month',
  'last_7_days',
  'last_30_days',
  'this_year',
  'last_year',
  'custom',
  'all',
] as const;

type DateRangeShortcut = (typeof DATE_SHORTCUTS)[number];

/**
 * Simple string enum schema for date range — compatible with OpenAI
 * function calling (no union/anyOf which OpenAI doesn't support well).
 *
 * The AI should pass one of these string values. For custom ranges,
 * the AI can pass dateFrom + dateTo as separate YYYY-MM-DD strings.
 */
export const dateRangeSchema = z
  .enum(DATE_SHORTCUTS)
  .default('today')
  .describe(
    'Período de tiempo. VALORES: "today" (hoy), "yesterday" (ayer), "this_week" (esta semana), "this_month" (este mes), "last_month" (mes pasado), "last_7_days" (últimos 7 días), "last_30_days" (últimos 30 días), "this_year" (este año, del 1 de enero a hoy), "last_year" (el año pasado completo), "custom" (fecha específica — requiere dateFrom y dateTo), "all" (todo). ' +
    'PARA FECHAS ESPECÍFICAS usa "custom" + dateFrom + dateTo. NUNCA uses "today" cuando el usuario pide una fecha específica. ' +
    'Si no estás seguro del período, usa "today" por defecto.'
  );

/**
 * Resolves a date range shortcut into UTC Date objects suitable for Prisma
 * queries on @db.Date fields.
 *
 * Returns { from: Date, to: Date } where:
 * - from = UTC midnight of the start date
 * - to = UTC end-of-day (23:59:59.999Z) of the end date
 *
 * For "all", returns { from: null, to: null } meaning no date filter.
 *
 * All "today"/"yesterday"/"this_week"/"this_month" calculations use the
 * America/Mexico_City timezone, NOT the server's local timezone.
 */
export function resolveDateRange(
  range: DateRangeShortcut | string | undefined
): { from: Date | null; to: Date | null } {
  const today = getCurrentDateInUnikTz();

  if (range === undefined || range === 'today') {
    return {
      from: utcDateFromComponents(today.year, today.month, today.day),
      to: utcEndOfDayFromComponents(today.year, today.month, today.day),
    };
  }

  if (range === 'yesterday') {
    const y = new Date(Date.UTC(today.year, today.month, today.day));
    y.setUTCDate(y.getUTCDate() - 1);
    return {
      from: new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate())),
      to: new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate(), 23, 59, 59, 999)),
    };
  }

  if (range === 'this_week') {
    // Monday-based week start
    const diff = (today.dayOfWeek + 6) % 7;
    const monday = new Date(Date.UTC(today.year, today.month, today.day));
    monday.setUTCDate(monday.getUTCDate() - diff);
    return {
      from: new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate())),
      to: utcEndOfDayFromComponents(today.year, today.month, today.day),
    };
  }

  if (range === 'this_month') {
    return {
      from: utcDateFromComponents(today.year, today.month, 1),
      to: utcEndOfDayFromComponents(today.year, today.month, today.day),
    };
  }

  if (range === 'last_month') {
    // First day of last month to last day of last month
    const lastMonthYear = today.month === 0 ? today.year - 1 : today.year;
    const lastMonth = today.month === 0 ? 11 : today.month - 1;
    const lastDayOfLastMonth = new Date(Date.UTC(today.year, today.month, 0)).getUTCDate();
    return {
      from: utcDateFromComponents(lastMonthYear, lastMonth, 1),
      to: utcEndOfDayFromComponents(lastMonthYear, lastMonth, lastDayOfLastMonth),
    };
  }

  if (range === 'last_7_days') {
    const sevenDaysAgo = new Date(Date.UTC(today.year, today.month, today.day));
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
    return {
      from: new Date(Date.UTC(sevenDaysAgo.getUTCFullYear(), sevenDaysAgo.getUTCMonth(), sevenDaysAgo.getUTCDate())),
      to: utcEndOfDayFromComponents(today.year, today.month, today.day),
    };
  }

  if (range === 'last_30_days') {
    const thirtyDaysAgo = new Date(Date.UTC(today.year, today.month, today.day));
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 29);
    return {
      from: new Date(Date.UTC(thirtyDaysAgo.getUTCFullYear(), thirtyDaysAgo.getUTCMonth(), thirtyDaysAgo.getUTCDate())),
      to: utcEndOfDayFromComponents(today.year, today.month, today.day),
    };
  }

  if (range === 'this_year') {
    return {
      from: utcDateFromComponents(today.year, 0, 1),
      to: utcEndOfDayFromComponents(today.year, today.month, today.day),
    };
  }

  if (range === 'last_year') {
    return {
      from: utcDateFromComponents(today.year - 1, 0, 1),
      to: utcEndOfDayFromComponents(today.year - 1, 11, 31),
    };
  }

  if (range === 'all' || range === 'custom') {
    return { from: null, to: null };
  }

  // Unknown string — default to today
  return {
    from: utcDateFromComponents(today.year, today.month, today.day),
    to: utcEndOfDayFromComponents(today.year, today.month, today.day),
  };
}

/**
 * Formats a Date as YYYY-MM-DD using UTC parts.
 */
export function formatDate(date: Date | null | undefined): string | null {
  if (!date) return null;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Builds a Prisma where clause for a date field from a resolved date range.
 * Returns an empty object if from/to are null (meaning "all history").
 *
 * Generic version: pass the field name (default: "date").
 */
export function buildDateWhere(
  range: DateRangeShortcut | string | undefined,
  fieldName: string = 'date'
): Record<string, unknown> {
  const { from, to } = resolveDateRange(range);
  if (from === null || to === null) return {};
  return { [fieldName]: { gte: from, lte: to } };
}

/**
 * Builds a Prisma where clause for a date field from EITHER a dateRange shortcut
 * OR explicit dateFrom/dateTo strings (YYYY-MM-DD).
 *
 * If dateFrom/dateTo are provided, they take priority over dateRange.
 * Generic version: pass the field name (default: "date").
 */
export function buildDateWhereFlexible(
  range: DateRangeShortcut | string | undefined,
  dateFrom?: string,
  dateTo?: string,
  fieldName: string = 'date'
): Record<string, unknown> {
  // Explicit dates take priority
  if (dateFrom && dateTo) {
    const from = new Date(`${dateFrom}T00:00:00Z`);
    const to = new Date(`${dateTo}T23:59:59.999Z`);
    return { [fieldName]: { gte: from, lte: to } };
  }
  if (dateFrom) {
    const from = new Date(`${dateFrom}T00:00:00Z`);
    return { [fieldName]: { gte: from } };
  }
  if (dateTo) {
    const to = new Date(`${dateTo}T23:59:59.999Z`);
    return { [fieldName]: { lte: to } };
  }
  // Fall back to shortcut
  return buildDateWhere(range, fieldName);
}

/**
 * Builds a Prisma where clause for orderDate from a resolved date range.
 * Returns an empty object if from/to are null (meaning "all history").
 *
 * Backward-compatible wrapper around buildDateWhere with fieldName="orderDate".
 */
export function buildOrderDateWhere(
  range: DateRangeShortcut | string | undefined
): Record<string, unknown> {
  return buildDateWhere(range, 'orderDate');
}

/**
 * Builds a Prisma where clause for orderDate from EITHER a dateRange shortcut
 * OR explicit dateFrom/dateTo strings (YYYY-MM-DD).
 *
 * If dateFrom/dateTo are provided, they take priority over dateRange.
 * This lets the IA query specific months like "agosto" → dateFrom="2026-08-01", dateTo="2026-08-31".
 *
 * Backward-compatible wrapper around buildDateWhereFlexible with fieldName="orderDate".
 */
export function buildOrderDateWhereFlexible(
  range: DateRangeShortcut | string | undefined,
  dateFrom?: string,
  dateTo?: string
): Record<string, unknown> {
  return buildDateWhereFlexible(range, dateFrom, dateTo, 'orderDate');
}
