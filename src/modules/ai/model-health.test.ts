import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyModelError,
  isModelHealthy,
  modelHealthSnapshot,
  reportModelFailure,
  reportModelSuccess,
  resetModelHealth,
} from './model-health';
import { AiApiError } from './providers/types';

beforeEach(() => resetModelHealth());

describe('classifyModelError', () => {
  it('recognizes configuration errors, limits and outages', () => {
    expect(classifyModelError(new AiApiError('bad key', 'auth', 401))).toBe('auth');
    expect(
      classifyModelError(new AiApiError('The model `gpt-9` does not exist', 'unknown', 404))
    ).toBe('not_found');
    expect(classifyModelError(new AiApiError('slow down', 'rate_limit', 429))).toBe('rate_limit');
    expect(classifyModelError(new AiApiError('bad gateway', 'server', 502))).toBe('server');
    expect(classifyModelError(new Error('Request timed out'))).toBe('timeout');
    expect(classifyModelError(new Error('empty answer'))).toBe('empty');
  });
});

describe('circuit breaker', () => {
  it('opens on failure, closes after the window, and resets on success', () => {
    const t0 = 1_000_000;
    reportModelFailure('m1', new AiApiError('down', 'server', 503), t0);
    expect(isModelHealthy('m1', t0 + 1_000)).toBe(false);
    expect(isModelHealthy('m1', t0 + 3 * 60_000)).toBe(true);
    expect(modelHealthSnapshot(t0)[0]).toMatchObject({ model: 'm1', lastKind: 'server' });

    reportModelFailure('m2', new AiApiError('no key', 'auth', 401), t0);
    expect(isModelHealthy('m2', t0 + 20 * 60_000)).toBe(false);
    reportModelSuccess('m2');
    expect(isModelHealthy('m2', t0)).toBe(true);
  });

  it('backs off longer on repeated failures', () => {
    const t0 = 5_000_000;
    reportModelFailure('m3', new AiApiError('down', 'server', 500), t0);
    reportModelFailure('m3', new AiApiError('down', 'server', 500), t0);
    // second failure → 4 min window
    expect(isModelHealthy('m3', t0 + 3 * 60_000)).toBe(false);
    expect(isModelHealthy('m3', t0 + 5 * 60_000)).toBe(true);
  });
});
