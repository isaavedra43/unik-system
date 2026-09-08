/**
 * Shared date helpers for AI tools.
 *
 * IMPORTANT: `orderDate` in the database is a PostgreSQL DATE field
 * (no time component). It is stored as UTC midnight (2026-09-09 00:00:00Z).
 *
 * These helpers create UTC-midnight Date objects so that Prisma `gte`/`lte`
 * comparisons match correctly regardless of the server's timezone.
 *
 * The "today" / "yesterday" concepts use the SERVER's local timezone
 * (America/Mexico_City, UTC-6) to determine which calendar date to query,
 * then create UTC-midnight Date objects for that date.
 */

import { z } from 'zod';

export type DateRangeShortcut =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'last_7_days'
  | 'last_30_days';

export const dateRangeSchema = z.union([
  z.enum(['today', 'yesterday', 'this_week', 'this_month', 'last_7_days', 'last_30_days']),
  z.object({
    from: z.union([z.string(), z.date()]).describe('Fecha inicial (ISO o YYYY-MM-DD)'),
    to: z.union([z.string(), z.date()]).describe('Fecha final (ISO o YYYY-MM-DD)'),
  }),
]);

/**
 * Creates a UTC-midnight Date for the given local date components.
 * This ensures that Prisma comparisons with @db.Date fields work correctly.
 */
function utcDateFromLocal(d: Date): Date {
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  return new Date(Date.UTC(y, m, day));
}

/**
 * Creates a UTC end-of-day Date (23:59:59.999Z) for the given local date.
 */
function utcEndOfDayFromLocal(d: Date): Date {
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  return new Date(Date.UTC(y, m, day, 23, 59, 59, 999));
}

/**
 * Resolves a date range shortcut or explicit range into UTC Date objects
 * suitable for Prisma queries on @db.Date fields.
 *
 * Returns { from, to } where:
 * - from = UTC midnight of the start date
 * - to = UTC end-of-day (23:59:59.999Z) of the end date
 */
export function resolveDateRange(
  range: DateRangeShortcut | { from: string | Date; to: string | Date } | undefined
): { from: Date; to: Date } {
  const now = new Date();

  if (range === undefined || range === 'today') {
    return {
      from: utcDateFromLocal(now),
      to: utcEndOfDayFromLocal(now),
    };
  }

  if (range === 'yesterday') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return {
      from: utcDateFromLocal(y),
      to: utcEndOfDayFromLocal(y),
    };
  }

  if (range === 'this_week') {
    // Monday-based week start
    const day = now.getDay();
    const diff = (day + 6) % 7; // days since Monday
    const monday = new Date(now);
    monday.setDate(monday.getDate() - diff);
    return {
      from: utcDateFromLocal(monday),
      to: utcEndOfDayFromLocal(now),
    };
  }

  if (range === 'this_month') {
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
      from: utcDateFromLocal(firstOfMonth),
      to: utcEndOfDayFromLocal(now),
    };
  }

  if (range === 'last_7_days') {
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    return {
      from: utcDateFromLocal(sevenDaysAgo),
      to: utcEndOfDayFromLocal(now),
    };
  }

  if (range === 'last_30_days') {
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    return {
      from: utcDateFromLocal(thirtyDaysAgo),
      to: utcEndOfDayFromLocal(now),
    };
  }

  // Custom { from, to }
  const fromDate = typeof range.from === 'string' ? new Date(range.from) : range.from;
  const toDate = typeof range.to === 'string' ? new Date(range.to) : range.to;
  return {
    from: utcDateFromLocal(fromDate),
    to: utcEndOfDayFromLocal(toDate),
  };
}

/**
 * Formats a Date as YYYY-MM-DD using UTC parts.
 * Useful for displaying dates that come from @db.Date fields.
 */
export function formatDate(date: Date | null | undefined): string | null {
  if (!date) return null;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
