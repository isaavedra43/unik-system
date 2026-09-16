import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Lo que `refreshProjections` recibe: el job es el único que lo llama así. */
interface RefreshCall {
  full?: boolean;
  keys?: readonly string[];
  signal?: AbortSignal;
}

const mocks = vi.hoisted(() => {
  /** Las llamadas a `refreshProjections`, en orden: el job es su único llamador. */
  const refreshCalls: RefreshCall[] = [];
  return {
    refreshCalls,
    registerJobHandler: vi.fn(),
    registerRecurringJob: vi.fn(),
    enqueueJob: vi.fn(async (input: unknown) => ({ id: 'job-1', input, deduplicated: false })),
    registerDashboardSnapshotProvider: vi.fn(),
    computeControlTowerOverview: vi.fn(async () => ({ computedAt: 'ahora' })),
    refresh: vi.fn(async (options: RefreshCall = {}) => {
      refreshCalls.push(options);
      return {
        startedAt: '2026-09-15T18:00:00.000Z',
        durationMs: 12,
        full: options.full === true,
        window: { from: '2026-09-13T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' },
        runs: [{ key: 'variants' as const, ok: true, durationMs: 4, written: 3, detail: 'ok' }],
        failed: 0,
      };
    }),
  };
});

vi.mock('@/modules/jobs/job-queue', () => ({
  JOB_PRIORITY: { interactive: 10, maintenance: 90 },
  registerJobHandler: mocks.registerJobHandler,
  enqueueJob: mocks.enqueueJob,
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({
  registerRecurringJob: mocks.registerRecurringJob,
}));
vi.mock('@/modules/areas/dashboard-service', () => ({
  DASHBOARD_SCOPE_CONTROL_TOWER: 'control_tower',
  registerDashboardSnapshotProvider: mocks.registerDashboardSnapshotProvider,
}));
vi.mock('./control-tower-service', () => ({
  CONTROL_TOWER_SCOPE_KEY: '',
  computeControlTowerOverview: mocks.computeControlTowerOverview,
}));
vi.mock('./projections-service', () => ({
  PROJECTION_KEYS: ['variants', 'step_metrics', 'handoffs', 'block_causes'] as const,
  refreshProjections: mocks.refresh,
}));

import {
  CT_PROJECTIONS_REFRESH_EVERY_MS,
  CT_PROJECTIONS_REFRESH_JOB,
  enqueueProjectionsRefresh,
  projectionsDedupeKey,
  registerControlTowerJobs,
  runProjectionsRefreshJob,
} from './control-tower-jobs';

/**
 * Trabajo de fondo de las proyecciones. Lo que importa: la cadencia del plan,
 * que diez clics de "Reconstruir" sean UNA corrida, que la reconstrucción
 * completa no se trague el tic incremental, y que un payload inválido falle
 * fuerte en vez de recalcular algo distinto en silencio.
 */

interface FakeJob {
  payload: unknown;
  signal?: AbortSignal;
  log: ReturnType<typeof vi.fn>;
}

function job(payload: unknown): FakeJob {
  return { payload, log: vi.fn() };
}

describe('registro', () => {
  it('registra el handler, la cadencia de 15 minutos y el scope del tablero', () => {
    // El módulo se registra al importarse; esta llamada extra es idempotente.
    registerControlTowerJobs();
    expect(mocks.registerJobHandler).toHaveBeenCalledWith(
      CT_PROJECTIONS_REFRESH_JOB,
      expect.any(Function),
      { timeoutMs: 10 * 60_000 }
    );
    expect(mocks.registerRecurringJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CT_PROJECTIONS_REFRESH_JOB,
        everyMs: CT_PROJECTIONS_REFRESH_EVERY_MS,
      })
    );
    expect(CT_PROJECTIONS_REFRESH_EVERY_MS).toBe(15 * 60_000);
    expect(mocks.registerDashboardSnapshotProvider).toHaveBeenCalledWith(
      expect.objectContaining({ scopeType: 'control_tower', scopeKey: '' })
    );
  });

  it('no vuelve a registrarse si alguien lo llama dos veces', () => {
    const before = mocks.registerJobHandler.mock.calls.length;
    registerControlTowerJobs();
    registerControlTowerJobs();
    expect(mocks.registerJobHandler.mock.calls.length).toBe(before);
  });

  it('el scope del tablero calcula el resumen de la Torre', async () => {
    const provider = mocks.registerDashboardSnapshotProvider.mock.calls[0][0];
    const now = new Date('2026-09-15T18:00:00.000Z');
    await provider.compute({ now });
    expect(mocks.computeControlTowerOverview).toHaveBeenCalledWith({ now });
  });
});

describe('projectionsDedupeKey', () => {
  it('separa la corrida incremental de la reconstrucción completa', () => {
    expect(projectionsDedupeKey(false)).toBe(`${CT_PROJECTIONS_REFRESH_JOB}:incremental`);
    expect(projectionsDedupeKey(true)).toBe(`${CT_PROJECTIONS_REFRESH_JOB}:full`);
    expect(projectionsDedupeKey(true)).not.toBe(projectionsDedupeKey(false));
  });
});

describe('runProjectionsRefreshJob', () => {
  beforeEach(() => {
    mocks.refresh.mockClear();
    mocks.refreshCalls.length = 0;
  });

  it('un payload vacío corre las cuatro proyecciones en modo incremental', async () => {
    await runProjectionsRefreshJob(job({}) as never);
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ full: false }));
    expect(mocks.refreshCalls[0]).toMatchObject({ full: false });
    expect(Object.keys(mocks.refreshCalls[0])).not.toContain('keys');
  });

  it('pasa full y las claves pedidas', async () => {
    await runProjectionsRefreshJob(job({ full: true, keys: ['variants'] }) as never);
    expect(mocks.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ full: true, keys: ['variants'] })
    );
  });

  it('propaga la señal de cancelación del job', async () => {
    const controller = new AbortController();
    const context = { ...job({}), signal: controller.signal };
    await runProjectionsRefreshJob(context as never);
    expect(mocks.refreshCalls[0].signal).toBe(controller.signal);
  });

  it('una clave de proyección inventada hace fallar el job en vez de recalcular otra cosa', async () => {
    await expect(runProjectionsRefreshJob(job({ keys: ['no_existe'] }) as never)).rejects.toThrow(
      /Invalid ct\.projections_refresh payload/
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('deja en la bitácora del job lo que escribió cada proyección', async () => {
    const context = job({});
    await runProjectionsRefreshJob(context as never);
    expect(context.log).toHaveBeenCalledWith(
      'projections_refreshed',
      expect.objectContaining({ failed: 0, runs: 'variants:3' })
    );
  });
});

describe('enqueueProjectionsRefresh', () => {
  beforeEach(() => {
    mocks.enqueueJob.mockClear();
  });

  it('encola con la llave de deduplicación del modo y prioridad de mantenimiento', async () => {
    await enqueueProjectionsRefresh();
    expect(mocks.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CT_PROJECTIONS_REFRESH_JOB,
        dedupeKey: projectionsDedupeKey(false),
        priority: 90,
        maxAttempts: 1,
        payload: {},
      })
    );
  });

  it('cuando lo pide una persona sube la prioridad y deja su autoría', async () => {
    await enqueueProjectionsRefresh({ full: true, requestedByUserId: 'u1' });
    expect(mocks.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: projectionsDedupeKey(true),
        priority: 10,
        createdBy: 'u1',
        payload: { full: true },
      })
    );
  });

  it('las claves pedidas viajan en el payload', async () => {
    await enqueueProjectionsRefresh({ keys: ['handoffs'] });
    expect(mocks.enqueueJob.mock.calls[0][0]).toMatchObject({
      payload: { keys: ['handoffs'] },
    });
  });
});
