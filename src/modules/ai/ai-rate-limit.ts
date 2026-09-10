/**
 * Simple in-memory token bucket rate limiter for the AI assistant.
 * Sufficient for a single-server deployment. For multi-instance, consider
 * moving to Redis in the future.
 */

interface Bucket {
  count: number;
  resetAt: number;
  tokensUsedToday: number;
  dayResetAt: number;
}

const buckets = new Map<string, Bucket>();

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;
  tokensRemaining: number;
}

export function checkRateLimit(
  userId: string,
  maxMessagesPerMinute = 20,
  maxTokensPerDay = 100_000
): RateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(userId);

  if (!bucket) {
    bucket = {
      count: 0,
      resetAt: now + 60_000,
      tokensUsedToday: 0,
      dayResetAt: now + 86_400_000,
    };
    buckets.set(userId, bucket);
  }

  // Reset minute window
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60_000;
  }

  // Reset day window
  if (now > bucket.dayResetAt) {
    bucket.tokensUsedToday = 0;
    bucket.dayResetAt = now + 86_400_000;
  }

  if (bucket.count >= maxMessagesPerMinute) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(bucket.resetAt).toISOString(),
      tokensRemaining: Math.max(0, maxTokensPerDay - bucket.tokensUsedToday),
    };
  }

  if (bucket.tokensUsedToday >= maxTokensPerDay) {
    return {
      allowed: false,
      remaining: maxMessagesPerMinute - bucket.count,
      resetAt: new Date(bucket.dayResetAt).toISOString(),
      tokensRemaining: 0,
    };
  }

  bucket.count++;
  return {
    allowed: true,
    remaining: maxMessagesPerMinute - bucket.count,
    resetAt: new Date(bucket.resetAt).toISOString(),
    tokensRemaining: maxTokensPerDay - bucket.tokensUsedToday,
  };
}

export function recordTokenUsage(userId: string, tokens: number): void {
  const bucket = buckets.get(userId);
  if (bucket) {
    bucket.tokensUsedToday += tokens;
  }
}

// Periodic cleanup of inactive buckets (every 10 min)
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [userId, bucket] of buckets) {
      if (now > bucket.resetAt + 3_600_000 && now > bucket.dayResetAt + 3_600_000) {
        buckets.delete(userId);
      }
    }
  }, 600_000).unref?.();
}
