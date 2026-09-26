import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, hostOf, initials, threadGroupOf, timeAgo } from './format';

describe('universo format helpers', () => {
  it('formats sizes and durations for people', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(5_700)).toBe('5.7 s');
    expect(formatDuration(184_000)).toBe('3 min 4 s');
    expect(formatDuration(0)).toBe('');
  });

  it('groups threads by recency, favourites first', () => {
    const now = new Date('2026-09-26T15:00:00');
    expect(threadGroupOf('2026-09-26T09:00:00', false, now)).toBe('today');
    expect(threadGroupOf('2026-09-25T20:00:00', false, now)).toBe('yesterday');
    expect(threadGroupOf('2026-09-21T10:00:00', false, now)).toBe('week');
    expect(threadGroupOf('2026-09-05T10:00:00', false, now)).toBe('month');
    expect(threadGroupOf('2026-06-01T10:00:00', false, now)).toBe('older');
    expect(threadGroupOf('2026-06-01T10:00:00', true, now)).toBe('starred');
  });

  it('never throws on junk', () => {
    expect(hostOf('not a url')).toBe('not a url');
    expect(hostOf('https://www.example.com/a')).toBe('example.com');
    expect(initials('Iván Saavedra')).toBe('IS');
    expect(initials('')).toBe('U');
    expect(timeAgo('garbage')).toBe('');
  });
});
