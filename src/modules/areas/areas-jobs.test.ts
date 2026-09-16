import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Registration and payload of `areas.dashboard_refresh`: the recurring cadence,
 * the dedupe key per scope, and the fact that an unknown area never turns into
 * a refresh of "nothing".
 */

const h = vi.hoisted(() => ({
  registerJobHandler: vi.fn(),
  registerRecurringJob: vi.fn(),
  enqueueJob: vi.fn(async () => ({ id: 'job-1', status: 'pending', deduplicated: false })),
  refresh: vi.fn(async () => ({ refreshed: [], failed: [], durationMs: 5 })),
}));

vi.mock('@/modules/jobs/job-queue', () => ({
  registerJobHandler: h.registerJobHandler,
  enqueueJob: h.enqueueJob,
  JOB_PRIORITY: { interactive: 10, normal: 100, maintenance: 300, bulk: 500 },
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: h.registerRecurringJob }));
vi.mock('./dashboard-service', () => ({ refreshDashboardSnapshots: h.refresh }));

import {
  AREAS_DASHBOARD_REFRESH_EVERY_MS,
  AREAS_DASHBOARD_REFRESH_JOB,
  areaDashboardDedupeKey,
  enqueueAreaDashboardRefresh,
  runDashboardRefreshJob,
} from './areas-jobs';

function job(payload: unknown) {
  return {
    id: 'job-1',
    type: AREAS_DASHBOARD_REFRESH_JOB,
    payload,
    attempt: 1,
    signal: new AbortController().signal,
    setProgress: vi.fn(async () => undefined),
    log: vi.fn(),
  };
}

beforeEach(() => {
  h.refresh.mockClear();
  h.enqueueJob.mockClear();
});

describe('registration', () => {
  it('registers the handler and the 5-minute cadence once', () => {
    expect(h.registerJobHandler).toHaveBeenCalledWith(
      AREAS_DASHBOARD_REFRESH_JOB,
      expect.any(Function),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(h.registerRecurringJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AREAS_DASHBOARD_REFRESH_JOB,
        everyMs: AREAS_DASHBOARD_REFRESH_EVERY_MS,
      })
    );
  });

  it('keeps the handler timeout under the cadence so two runs never overlap', () => {
    const options = h.registerJobHandler.mock.calls[0]?.[2] as { timeoutMs: number };
    expect(options.timeoutMs).toBeLessThan(AREAS_DASHBOARD_REFRESH_EVERY_MS);
  });
});

describe('runDashboardRefreshJob', () => {
  it('refreshes every scope when the payload is empty', async () => {
    await runDashboardRefreshJob(job({}), { refresh: h.refresh });
    expect(h.refresh).toHaveBeenCalledWith(
      expect.not.objectContaining({ areaKeys: expect.anything() })
    );
  });

  it('refreshes only the areas asked for', async () => {
    await runDashboardRefreshJob(job({ areaKeys: ['compras', 'logistica'] }), {
      refresh: h.refresh,
    });
    expect(h.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ areaKeys: ['compras', 'logistica'] })
    );
  });

  it('ignores unknown areas and falls back to refreshing everything', async () => {
    await runDashboardRefreshJob(job({ areaKeys: ['marketing'] }), { refresh: h.refresh });
    expect(h.refresh).toHaveBeenCalledWith(
      expect.not.objectContaining({ areaKeys: expect.anything() })
    );
  });

  it('rejects a payload that is not the expected shape', async () => {
    await expect(
      runDashboardRefreshJob(job({ areaKeys: 'compras' }), { refresh: h.refresh })
    ).rejects.toThrow(/Invalid areas.dashboard_refresh payload/);
  });
});

describe('enqueueAreaDashboardRefresh', () => {
  it('deduplicates per scope', () => {
    expect(areaDashboardDedupeKey('compras')).toBe('areas.dashboard_refresh:compras');
    expect(areaDashboardDedupeKey(null)).toBe('areas.dashboard_refresh:all');
    expect(areaDashboardDedupeKey('marketing')).toBe('areas.dashboard_refresh:all');
  });

  it('queues one area with its dedupe key', async () => {
    await enqueueAreaDashboardRefresh({ areaKey: 'inventario', requestedByUserId: 'u-1' });
    expect(h.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AREAS_DASHBOARD_REFRESH_JOB,
        payload: { areaKeys: ['inventario'] },
        dedupeKey: 'areas.dashboard_refresh:inventario',
        createdBy: 'u-1',
        priority: 10,
      })
    );
  });

  it('queues the whole refresh as maintenance when nobody asked for it', async () => {
    await enqueueAreaDashboardRefresh();
    expect(h.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {},
        dedupeKey: 'areas.dashboard_refresh:all',
        priority: 300,
      })
    );
  });
});
