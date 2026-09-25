import { afterEach, describe, expect, it, vi } from 'vitest';
import { rateLimit, resetRateLimits } from './rate-limit';

afterEach(() => {
  vi.useRealTimers();
  resetRateLimits();
});

describe('rateLimit', () => {
  it('allows up to the limit within the window', () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimit('k', 5, 60_000).ok).toBe(true);
    }
    expect(rateLimit('k', 5, 60_000).ok).toBe(false);
  });

  it('returns a Retry-After estimate when blocked', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    rateLimit('k', 2, 10_000);
    rateLimit('k', 2, 10_000);
    const blocked = rateLimit('k', 2, 10_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(10);
  });

  it('frees capacity as hits slide out of the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    rateLimit('k', 2, 10_000);
    vi.setSystemTime(5_000);
    rateLimit('k', 2, 10_000);
    expect(rateLimit('k', 2, 10_000).ok).toBe(false);
    vi.setSystemTime(10_001); // first hit expired
    expect(rateLimit('k', 2, 10_000).ok).toBe(true);
  });

  it('tracks keys independently', () => {
    rateLimit('a', 1, 60_000);
    expect(rateLimit('a', 1, 60_000).ok).toBe(false);
    expect(rateLimit('b', 1, 60_000).ok).toBe(true);
  });

  it('blocked attempts do not consume quota', () => {
    rateLimit('k', 2, 60_000);
    rateLimit('k', 2, 60_000);
    rateLimit('k', 2, 60_000); // blocked
    rateLimit('k', 2, 60_000); // blocked again — still 2 real hits
    expect(rateLimit('k', 2, 60_000).ok).toBe(false);
  });
});
