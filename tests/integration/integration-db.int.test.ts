import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/prisma';

import { assertDisposableDatabase, isRetryableLockError, truncateTables } from './integration-db';

/**
 * Ejercita la limpieza compartida de las suites de integración.
 *
 * El candado ENTRE corridas lo cubre `integration-lock.int.test.ts`. Aquí se
 * prueba el otro lado del problema, el de DENTRO de una corrida: un `TRUNCATE`
 * bloqueado por trabajo asíncrono que se fugó de la prueba anterior. Sin
 * `lock_timeout` eso terminaba en `40P01 deadlock detected` dentro del propio
 * `beforeEach`, el reset quedaba a medias y las pruebas siguientes fallaban con
 * errores que parecen de producto (`No record was found`, llaves foráneas
 * violadas justo después de crear la fila).
 *
 * No siembra nada que otra suite necesite: usa `RealtimeEvent`, que las tres
 * suites grandes ya vacían, y la deja vacía.
 */

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || '';
const describeDb = integrationUrl ? describe : describe.skip;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tabla desechable que ya vacían las suites grandes: sirve de conejillo. */
const PROBE_TABLE = 'RealtimeEvent';

describeDb('limpieza compartida de las suites de integración', () => {
  const clients: PrismaClient[] = [];

  function blockerClient(): PrismaClient {
    const client = new PrismaClient({ datasources: { db: { url: integrationUrl } } });
    clients.push(client);
    return client;
  }

  /** Mantiene un `AccessShareLock` abierto sobre la tabla durante `holdMs`. */
  function holdReadLock(holdMs: number): { done: Promise<void>; releasedAt: () => number } {
    let released = 0;
    const client = blockerClient();
    const done = client
      .$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(`SELECT count(*) FROM "${PROBE_TABLE}"`);
          await delay(holdMs);
          released = Date.now();
        },
        { timeout: 60_000, maxWait: 20_000 }
      )
      .then(() => undefined);
    return { done, releasedAt: () => released };
  }

  afterAll(async () => {
    await truncateTables([PROBE_TABLE]);
    await Promise.all(clients.map((client) => client.$disconnect().catch(() => {})));
  });

  it('vacía de verdad la tabla y reinicia la identidad', async () => {
    await prisma.realtimeEvent.create({
      data: { channel: 'it-db-helper', type: 'probe', payload: {} },
    });
    expect(await prisma.realtimeEvent.count()).toBeGreaterThan(0);

    await truncateTables([PROBE_TABLE]);

    expect(await prisma.realtimeEvent.count()).toBe(0);
    const created = await prisma.realtimeEvent.create({
      data: { channel: 'it-db-helper', type: 'probe', payload: {} },
    });
    expect(created.id).toBe(BigInt(1));
    await truncateTables([PROBE_TABLE]);
  });

  it('con la tabla bloqueada espera y reintenta hasta que la sueltan, sin interbloqueo', async () => {
    const blocker = holdReadLock(900);
    await delay(50);

    const startedAt = Date.now();
    await truncateTables([PROBE_TABLE], { lockTimeoutMs: 150, attempts: 30 });
    const finishedAt = Date.now();
    await blocker.done;

    expect(blocker.releasedAt()).toBeGreaterThan(0);
    // Sólo pudo terminar DESPUÉS de que soltaran el candado, y sin excepción.
    expect(finishedAt).toBeGreaterThanOrEqual(blocker.releasedAt());
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(700);
    expect(await prisma.realtimeEvent.count()).toBe(0);
  });

  it('si el bloqueo nunca se suelta falla con un mensaje que explica la causa', async () => {
    const blocker = holdReadLock(3_000);
    await delay(50);

    await expect(
      truncateTables([PROBE_TABLE], { lockTimeoutMs: 100, attempts: 3 })
    ).rejects.toThrow(/No se pudo vaciar la base tras 3 intentos/);

    await blocker.done;
  });

  it('un error que no es de bloqueo se propaga tal cual (no se reintenta)', async () => {
    await expect(truncateTables(['NoExisteEstaTabla'])).rejects.toThrow(/NoExisteEstaTabla/);
  });

  it('reconoce sólo los códigos de bloqueo pasajero', () => {
    expect(isRetryableLockError({ code: 'P2010', meta: { code: '40P01' } })).toBe(true);
    expect(isRetryableLockError({ code: 'P2010', meta: { code: '55P03' } })).toBe(true);
    expect(isRetryableLockError(new Error('ERROR: deadlock detected (40P01)'))).toBe(true);
    expect(isRetryableLockError({ code: 'P2010', meta: { code: '42P01' } })).toBe(false);
    expect(isRetryableLockError(new Error('relación inexistente'))).toBe(false);
    expect(isRetryableLockError(null)).toBe(false);
  });

  it('la guarda acepta esta base desechable y nombra las tablas que faltarían', async () => {
    const name = await assertDisposableDatabase({
      requiredTables: ['OperationalCase', PROBE_TABLE],
      missingLabel: 'operaciones',
    });
    expect(name).not.toBe('unik_system');

    await expect(
      assertDisposableDatabase({
        requiredTables: ['OperationalCase', 'TablaQueNoExiste'],
        missingLabel: 'un módulo inventado',
      })
    ).rejects.toThrow(/faltan: TablaQueNoExiste/);
  });
});
