/**
 * Relative time labels shared by the spaces of an area (panel and
 * communications). Pure and isomorphic: no React, no I/O and no locale
 * surprises, so the server render and the browser print the same text as long
 * as both use the clock the page passed down (`nowIso`).
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Milliseconds between `at` and `now`, or null when either instant is
 * unreadable. The clock accepts the ISO string the server passes down
 * (`nowIso`), a Date or a timestamp, so no caller has to convert it.
 */
export function elapsedSince(
  at: string | Date | null | undefined,
  now: Date | number | string
): number | null {
  if (at === null || at === undefined) return null;
  const instant = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(instant)) return null;
  const reference =
    typeof now === 'number' ? now : now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(reference)) return null;
  return reference - instant;
}

/**
 * "hace un momento", "hace 3 min", "hace 2 h", "hace 4 d". An instant in the
 * future (clock skew between the server and the browser) reads as "hace un
 * momento" instead of a negative number.
 */
export function relativeSince(
  at: string | Date | null | undefined,
  now: Date | number | string
): string {
  const elapsed = elapsedSince(at, now);
  if (elapsed === null) return 'sin fecha';
  if (elapsed < MINUTE_MS) return 'hace un momento';
  if (elapsed < HOUR_MS) return `hace ${Math.floor(elapsed / MINUTE_MS)} min`;
  if (elapsed < DAY_MS) return `hace ${Math.floor(elapsed / HOUR_MS)} h`;
  return `hace ${Math.floor(elapsed / DAY_MS)} d`;
}
