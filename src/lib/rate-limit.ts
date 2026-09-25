/**
 * In-memory sliding-window rate limiter (per runtime instance).
 *
 * Middleware-safe: only Web-standard APIs (Map + Date.now), no Node deps.
 * On multi-instance deployments each instance enforces its own window — the
 * effective global limit is roughly `limit × instances`, which is still a
 * hard ceiling on spray/spam and a stepping stone to a Redis-backed limiter.
 */

const buckets = new Map<string, number[]>();

/** Hard cap on tracked keys so a spray of distinct keys can't grow the map. */
const MAX_KEYS = 20_000;
/** Keys idle longer than this are garbage-collected under memory pressure. */
const IDLE_SWEEP_MS = 15 * 60 * 1000;

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the oldest hit leaves the window (for Retry-After). */
  retryAfterSeconds: number;
}

function sweepIdle(now: number): void {
  const cutoff = now - IDLE_SWEEP_MS;
  for (const [key, hits] of buckets) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) buckets.delete(key);
  }
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const windowStart = now - windowMs;

  let hits = buckets.get(key);
  if (!hits) {
    if (buckets.size >= MAX_KEYS) {
      sweepIdle(now);
      // Still saturated: drop all counters (fail-open on the limiter itself —
      // limits reset, access is never denied by a full map).
      if (buckets.size >= MAX_KEYS) buckets.clear();
    }
    hits = [];
    buckets.set(key, hits);
  }

  let i = 0;
  while (i < hits.length && hits[i] <= windowStart) i++;
  if (i > 0) hits.splice(0, i);

  if (hits.length >= limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000)),
    };
  }
  hits.push(now);
  return { ok: true, retryAfterSeconds: 0 };
}

/** Test helper: clears every bucket. */
export function resetRateLimits(): void {
  buckets.clear();
}
