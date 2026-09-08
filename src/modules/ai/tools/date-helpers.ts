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
  'custom',
  'all',
] as const;

export type DateRangeShortcut = (typeof DATE_SHORTCUTS)[number];

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
    'Período de tiempo. VALORES: "today" (hoy), "yesterday" (ayer), "this_week" (esta semana), "this_month" (este mes), "last_month" (mes pasado), "last_7_days" (últimos 7 días), "last_30_days" (últimos 30 días), "custom" (fecha específica — requiere dateFrom y dateTo), "all" (todo). ' +
    'PARA FECHAS ESPECÍFICAS usa "custom" + dateFrom + dateTo. NUNCA uses "today" cuando el usuario pide una fecha específica. ' +
    'Si no estás seguro del período, usa "today" por defecto.'
  );

/**
 * Creates a UTC-midnight Date for the given local date components.
 */
function utcDateFromLocal(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/**
 * Creates a UTC end-of-day Date (23:59:59.999Z) for the given local date.
 */
function utcEndOfDayFromLocal(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999));
}

/**
 * Resolves a date range shortcut into UTC Date objects suitable for Prisma
 * queries on @db.Date fields.
 *
 * Returns { from: Date, to: Date } where:
 * - from = UTC midnight of the start date
 * - to = UTC end-of-day (23:59:59.999Z) of the end date
 *
 * For "all", returns { from: null, to: null } meaning no date filter.
 */
export function resolveDateRange(
  range: DateRangeShortcut | string | undefined
): { from: Date | null; to: Date | null } {
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
    const diff = (day + 6) % 7;
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

  if (range === 'last_month') {
    // First day of last month to last day of last month
    const firstOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0); // day 0 of current month = last day of prev
    return {
      from: utcDateFromLocal(firstOfLastMonth),
      to: utcEndOfDayFromLocal(lastOfLastMonth),
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

  if (range === 'all' || range === 'custom') {
    return { from: null, to: null };
  }

  // Unknown string — default to today
  return {
    from: utcDateFromLocal(now),
    to: utcEndOfDayFromLocal(now),
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
 * Builds a Prisma where clause for orderDate from a resolved date range.
 * Returns an empty object if from/to are null (meaning "all history").
 */
export function buildOrderDateWhere(
  range: DateRangeShortcut | string | undefined
): Record<string, unknown> {
  const { from, to } = resolveDateRange(range);
  if (from === null || to === null) return {};
  return { orderDate: { gte: from, lte: to } };
}

/**
 * Builds a Prisma where clause for orderDate from EITHER a dateRange shortcut
 * OR explicit dateFrom/dateTo strings (YYYY-MM-DD).
 *
 * If dateFrom/dateTo are provided, they take priority over dateRange.
 * This lets the IA query specific months like "agosto" → dateFrom="2026-08-01", dateTo="2026-08-31".
 */
export function buildOrderDateWhereFlexible(
  range: DateRangeShortcut | string | undefined,
  dateFrom?: string,
  dateTo?: string
): Record<string, unknown> {
  // Explicit dates take priority
  if (dateFrom && dateTo) {
    const from = new Date(`${dateFrom}T00:00:00Z`);
    const to = new Date(`${dateTo}T23:59:59.999Z`);
    return { orderDate: { gte: from, lte: to } };
  }
  if (dateFrom) {
    const from = new Date(`${dateFrom}T00:00:00Z`);
    return { orderDate: { gte: from } };
  }
  if (dateTo) {
    const to = new Date(`${dateTo}T23:59:59.999Z`);
    return { orderDate: { lte: to } };
  }
  // Fall back to shortcut
  return buildOrderDateWhere(range);
}
