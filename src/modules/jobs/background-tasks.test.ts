import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  backgroundWorkDisabled,
  flushBackgroundTasks,
  pendingBackgroundTasks,
  runBackgroundTask,
} from './background-tasks';

/**
 * El contrato del que depende la reproducibilidad de `tests/integration`:
 * en un proceso SIN trabajador de fondo no puede quedar trabajo suelto
 * escribiendo en la base después de que la prueba terminó.
 */

const scope = globalThis as typeof globalThis & { __unikBackgroundTasks?: Set<Promise<void>> };

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('trabajo de fondo apuntado', () => {
  const originalWorker = process.env.UNIK_JOB_WORKER_ENABLED;
  const originalPhase = process.env.NEXT_PHASE;

  beforeEach(() => {
    scope.__unikBackgroundTasks = new Set();
    delete process.env.UNIK_JOB_WORKER_ENABLED;
    delete process.env.NEXT_PHASE;
  });

  afterEach(async () => {
    await flushBackgroundTasks(1_000);
    if (originalWorker === undefined) delete process.env.UNIK_JOB_WORKER_ENABLED;
    else process.env.UNIK_JOB_WORKER_ENABLED = originalWorker;
    if (originalPhase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = originalPhase;
  });

  it('con trabajador de fondo no bloquea a quien lo lanza, pero queda apuntado', async () => {
    const gate = deferred();
    let done = false;

    await runBackgroundTask('prueba', async () => {
      await gate.promise;
      done = true;
    });

    // Quien lo lanzó ya siguió: el trabajo sigue vivo por detrás.
    expect(done).toBe(false);
    expect(pendingBackgroundTasks()).toBe(1);

    gate.resolve();
    expect(await flushBackgroundTasks(1_000)).toBe(true);
    expect(done).toBe(true);
    expect(pendingBackgroundTasks()).toBe(0);
  });

  it('sin trabajador de fondo corre EN LÍNEA: al volver no queda nada vivo', async () => {
    process.env.UNIK_JOB_WORKER_ENABLED = 'false';
    expect(backgroundWorkDisabled()).toBe(true);
    let done = false;

    await runBackgroundTask('prueba', async () => {
      // Un tick de espera, como cualquier escritura real contra la base.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      done = true;
    });

    expect(done).toBe(true);
    expect(pendingBackgroundTasks()).toBe(0);
  });

  it('durante `next build` tampoco deja trabajo suelto', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    expect(backgroundWorkDisabled()).toBe(true);
    let done = false;
    await runBackgroundTask('prueba', async () => {
      done = true;
    });
    expect(done).toBe(true);
    expect(pendingBackgroundTasks()).toBe(0);
  });

  it('un fallo se registra y no se propaga ni deja la tarea apuntada', async () => {
    process.env.UNIK_JOB_WORKER_ENABLED = 'false';
    await expect(
      runBackgroundTask('prueba', async () => {
        throw new Error('la base rechazó la escritura');
      })
    ).resolves.toBeUndefined();
    expect(pendingBackgroundTasks()).toBe(0);
  });

  it('una tarea que lanza otra también se espera', async () => {
    let inner = false;
    await runBackgroundTask('externa', async () => {
      void runBackgroundTask('interna', async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        inner = true;
      });
    });
    expect(await flushBackgroundTasks(1_000)).toBe(true);
    expect(inner).toBe(true);
    expect(pendingBackgroundTasks()).toBe(0);
  });

  it('si el trabajo no termina, el vaciado se rinde en vez de colgarse', async () => {
    const gate = deferred();
    await runBackgroundTask('colgada', () => gate.promise);
    expect(await flushBackgroundTasks(50)).toBe(false);
    expect(pendingBackgroundTasks()).toBe(1);
    gate.resolve();
    expect(await flushBackgroundTasks(1_000)).toBe(true);
  });
});
