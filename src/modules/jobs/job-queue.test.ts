import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * enqueueJob: dedupe by key, key release after terminal states, transaction
 * client support, recovery from a concurrent unique violation (P2002) outside a
 * transaction, and waking the worker only when the new row is visible.
 *
 * These mocks do not model PostgreSQL transactions (abort after a failed
 * statement, rollback). That is why the transactional path never relies on
 * catching P2002: it uses INSERT … ON CONFLICT DO NOTHING (createManyAndReturn
 * with skipDuplicates), whose concurrent behavior was checked against a
 * disposable PostgreSQL database.
 */

const { rootJobs } = vi.hoisted(() => ({
  rootJobs: {
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    createManyAndReturn: vi.fn(),
  },
}));

vi.mock('@/lib/prisma', () => ({ prisma: { backgroundJob: rootJobs } }));

import {
  enqueueJob,
  isJobDedupeConflictError,
  JOB_PRIORITY,
  JobDedupeConflictError,
  wakeJobWorker,
} from './job-queue';

type WorkerScope = typeof globalThis & {
  __unikJobWorker?: {
    started: boolean;
    workerId: string;
    active: number;
    wake: (() => void) | null;
    stopped: boolean;
  };
};

const wake = vi.fn();

function makeTx() {
  const jobs = {
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    createManyAndReturn: vi.fn(),
  };
  return { jobs, tx: { backgroundJob: jobs } as unknown as Prisma.TransactionClient };
}

function uniqueViolation(target: unknown = ['dedupeKey']) {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`dedupeKey`)',
    { code: 'P2002', clientVersion: 'test', meta: { target } }
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  rootJobs.create.mockResolvedValue({ id: 'job-new' });
  // A worker waiting for work in this process.
  (globalThis as WorkerScope).__unikJobWorker = {
    started: true,
    workerId: 'test-worker',
    active: 0,
    wake,
    stopped: false,
  };
});

afterEach(() => {
  delete (globalThis as WorkerScope).__unikJobWorker;
});

describe('enqueueJob sin transacción', () => {
  it('crea el job con los valores por defecto y despierta al worker', async () => {
    const res = await enqueueJob({ type: 'demo.run', payload: { a: 1 } });

    expect(res).toEqual({ id: 'job-new', status: 'pending', deduplicated: false });
    expect(rootJobs.findUnique).not.toHaveBeenCalled();
    expect(rootJobs.create).toHaveBeenCalledWith({
      data: {
        type: 'demo.run',
        payload: { a: 1 },
        priority: JOB_PRIORITY.normal,
        runAt: expect.any(Date),
        maxAttempts: 3,
        dedupeKey: null,
        groupKey: null,
        createdBy: null,
      },
    });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it.each(['pending', 'running'])(
    'devuelve el job %s existente con la misma llave',
    async (status) => {
      rootJobs.findUnique.mockResolvedValueOnce({ id: 'job-1', status });

      const res = await enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1' });

      expect(res).toEqual({ id: 'job-1', status, deduplicated: true });
      expect(rootJobs.findUnique).toHaveBeenCalledWith({ where: { dedupeKey: 'k1' } });
      expect(rootJobs.update).not.toHaveBeenCalled();
      expect(rootJobs.create).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
    }
  );

  it.each(['completed', 'failed', 'cancelled'])(
    'libera la llave de un job %s y crea uno nuevo',
    async (status) => {
      rootJobs.findUnique.mockResolvedValueOnce({ id: 'job-old', status });

      const res = await enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1' });

      expect(rootJobs.update).toHaveBeenCalledWith({
        where: { id: 'job-old' },
        data: { dedupeKey: null },
      });
      expect(rootJobs.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ dedupeKey: 'k1' }),
      });
      expect(res).toEqual({ id: 'job-new', status: 'pending', deduplicated: false });
    }
  );

  it('ante P2002 por dedupeKey devuelve el job ganador como deduplicado', async () => {
    rootJobs.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'job-winner', status: 'running' });
    rootJobs.create.mockRejectedValueOnce(uniqueViolation());

    const res = await enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1' });

    expect(res).toEqual({ id: 'job-winner', status: 'running', deduplicated: true });
    expect(rootJobs.findUnique).toHaveBeenCalledTimes(2);
    expect(wake).not.toHaveBeenCalled();
  });

  it('propaga P2002 de otro campo, sin dedupeKey o si el ganador ya no existe', async () => {
    rootJobs.findUnique.mockResolvedValueOnce(null);
    const otherField = uniqueViolation(['id']);
    rootJobs.create.mockRejectedValueOnce(otherField);
    await expect(enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1' })).rejects.toBe(
      otherField
    );

    const noKey = uniqueViolation();
    rootJobs.create.mockRejectedValueOnce(noKey);
    await expect(enqueueJob({ type: 'demo.run', payload: {} })).rejects.toBe(noKey);

    rootJobs.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const vanished = uniqueViolation();
    rootJobs.create.mockRejectedValueOnce(vanished);
    await expect(enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1' })).rejects.toBe(
      vanished
    );
  });

  it('propaga errores que no son de unicidad', async () => {
    rootJobs.findUnique.mockResolvedValueOnce(null);
    const boom = new Error('connection lost');
    rootJobs.create.mockRejectedValueOnce(boom);

    await expect(enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1' })).rejects.toBe(boom);
    expect(rootJobs.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueJob dentro de una transacción', () => {
  it('inserta con ON CONFLICT DO NOTHING en el cliente de la transacción', async () => {
    const { jobs, tx } = makeTx();
    jobs.findUnique.mockResolvedValueOnce({ id: 'job-old', status: 'completed' });
    jobs.createManyAndReturn.mockResolvedValueOnce([{ id: 'job-tx' }]);

    const res = await enqueueJob({
      type: 'ops.case.start',
      payload: { zohoSalesOrderId: 'so-1' },
      dedupeKey: 'case:so:so-1',
      priority: JOB_PRIORITY.interactive,
      tx,
    });

    expect(res).toEqual({ id: 'job-tx', status: 'pending', deduplicated: false });
    expect(jobs.findUnique).toHaveBeenCalledWith({ where: { dedupeKey: 'case:so:so-1' } });
    expect(jobs.update).toHaveBeenCalledWith({
      where: { id: 'job-old' },
      data: { dedupeKey: null },
    });
    expect(jobs.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: 'ops.case.start',
          priority: JOB_PRIORITY.interactive,
          dedupeKey: 'case:so:so-1',
        }),
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    expect(jobs.create).not.toHaveBeenCalled();
    expect(rootJobs.findUnique).not.toHaveBeenCalled();
    expect(rootJobs.update).not.toHaveBeenCalled();
    expect(rootJobs.create).not.toHaveBeenCalled();
  });

  it('no despierta al worker antes del commit', async () => {
    const { jobs, tx } = makeTx();
    jobs.create.mockResolvedValueOnce({ id: 'job-plain' });
    jobs.findUnique.mockResolvedValueOnce(null);
    jobs.createManyAndReturn.mockResolvedValueOnce([{ id: 'job-keyed' }]);

    await expect(enqueueJob({ type: 'demo.run', payload: {}, tx })).resolves.toEqual({
      id: 'job-plain',
      status: 'pending',
      deduplicated: false,
    });
    await expect(
      enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1', tx })
    ).resolves.toEqual({ id: 'job-keyed', status: 'pending', deduplicated: false });

    expect(jobs.create).toHaveBeenCalledTimes(1);
    expect(wake).not.toHaveBeenCalled();
  });

  it('deduplica contra un job pendiente', async () => {
    const { jobs, tx } = makeTx();
    jobs.findUnique.mockResolvedValueOnce({ id: 'job-1', status: 'pending' });

    const res = await enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1', tx });

    expect(res).toEqual({ id: 'job-1', status: 'pending', deduplicated: true });
    expect(jobs.createManyAndReturn).not.toHaveBeenCalled();
    expect(rootJobs.findUnique).not.toHaveBeenCalled();
  });

  it('si otra transacción confirmó la misma llave devuelve su job sin lanzar P2002', async () => {
    const { jobs, tx } = makeTx();
    jobs.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'job-winner', status: 'running' });
    jobs.createManyAndReturn.mockResolvedValueOnce([]);

    const res = await enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1', tx });

    expect(res).toEqual({ id: 'job-winner', status: 'running', deduplicated: true });
    expect(jobs.findUnique).toHaveBeenNthCalledWith(2, { where: { dedupeKey: 'k1' } });
    expect(jobs.create).not.toHaveBeenCalled();
    expect(rootJobs.findUnique).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it('reintenta la inserción si el ganador liberó la llave entre ambas sentencias', async () => {
    const { jobs, tx } = makeTx();
    jobs.findUnique.mockResolvedValue(null);
    jobs.createManyAndReturn.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'job-retry' }]);

    const res = await enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1', tx });

    expect(res).toEqual({ id: 'job-retry', status: 'pending', deduplicated: false });
    expect(jobs.createManyAndReturn).toHaveBeenCalledTimes(2);
  });

  it('lanza JobDedupeConflictError si la llave sigue en conflicto', async () => {
    const { jobs, tx } = makeTx();
    jobs.findUnique.mockResolvedValue(null);
    jobs.createManyAndReturn.mockResolvedValue([]);

    const attempt = enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1', tx });

    await expect(attempt).rejects.toBeInstanceOf(JobDedupeConflictError);
    await expect(attempt).rejects.toMatchObject({ dedupeKey: 'k1' });
    expect(jobs.createManyAndReturn).toHaveBeenCalledTimes(2);
  });

  it('isJobDedupeConflictError reconoce también el error de otra copia compilada', async () => {
    const { jobs, tx } = makeTx();
    jobs.findUnique.mockResolvedValue(null);
    jobs.createManyAndReturn.mockResolvedValue([]);

    const thrown = await enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1', tx }).catch(
      (err: unknown) => err
    );
    expect(isJobDedupeConflictError(thrown)).toBe(true);

    // Misma forma que el error de otra capa de webpack: clase distinta, misma
    // marca `Symbol.for`. Con `instanceof` a secas esto daría false y el motor
    // de comandos dejaría de reintentar.
    const FOREIGN_BRAND: unique symbol = Symbol.for('unik.jobs.dedupeConflict');
    class ForeignJobDedupeConflictError extends Error {
      readonly [FOREIGN_BRAND] = true;
      readonly dedupeKey = 'k1';
    }
    expect(new ForeignJobDedupeConflictError() instanceof JobDedupeConflictError).toBe(false);
    expect(isJobDedupeConflictError(new ForeignJobDedupeConflictError())).toBe(true);

    // Y nada más pasa la guarda: ni un error suelto ni un impostor por nombre.
    expect(isJobDedupeConflictError(new Error('boom'))).toBe(false);
    expect(isJobDedupeConflictError({ name: 'JobDedupeConflictError', dedupeKey: 'k1' })).toBe(
      false
    );
    expect(isJobDedupeConflictError(null)).toBe(false);
    expect(isJobDedupeConflictError(undefined)).toBe(false);
  });

  it('propaga los errores de la base sin intentar recuperarse', async () => {
    const { jobs, tx } = makeTx();
    jobs.findUnique.mockResolvedValueOnce(null);
    const boom = new Error('connection lost');
    jobs.createManyAndReturn.mockRejectedValueOnce(boom);

    await expect(enqueueJob({ type: 'demo.run', payload: {}, dedupeKey: 'k1', tx })).rejects.toBe(
      boom
    );
    expect(jobs.findUnique).toHaveBeenCalledTimes(1);
    expect(rootJobs.findUnique).not.toHaveBeenCalled();
  });
});

describe('wakeJobWorker', () => {
  it('despierta al worker que espera trabajo y no falla si no hay ninguno', () => {
    wakeJobWorker();
    expect(wake).toHaveBeenCalledTimes(1);

    (globalThis as WorkerScope).__unikJobWorker!.wake = null;
    expect(() => wakeJobWorker()).not.toThrow();
  });
});
