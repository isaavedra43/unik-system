import { PrismaClient } from '@prisma/client';

import {
  assertDisposableIntegrationUrl,
  databaseNameOf,
  INTEGRATION_LOCK_CLASS_ID,
  INTEGRATION_LOCK_OBJ_ID,
  singleConnectionUrl,
} from './integration-lock';

/**
 * `globalSetup` del proyecto vitest `integration`.
 *
 * Toma un candado de aviso de sesión sobre la base desechable antes del primer
 * archivo y lo suelta al terminar, para que dos corridas simultáneas se
 * serialicen en vez de truncarse las tablas la una a la otra. Ver
 * `integration-lock.ts` para el porqué.
 *
 * Si no hay `UNIK_INTEGRATION_DATABASE_URL` no hace nada: las suites ya se
 * omiten solas con un aviso.
 */

/** Cada cuánto se reintenta tomar el candado. */
const RETRY_MS = 500;
/** Cuánto se espera como máximo antes de rendirse con un mensaje claro. */
const MAX_WAIT_MS = Number(process.env.UNIK_INTEGRATION_LOCK_TIMEOUT_MS ?? 15 * 60 * 1000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  const rawUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim();
  if (!rawUrl) return undefined;

  assertDisposableIntegrationUrl(rawUrl);
  const name = databaseNameOf(rawUrl);

  const client = new PrismaClient({
    datasources: { db: { url: singleConnectionUrl(rawUrl) } },
  });

  const tryLock = async () => {
    const [{ locked }] = await client.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(${INTEGRATION_LOCK_CLASS_ID}::int, ${INTEGRATION_LOCK_OBJ_ID}::int) AS locked`;
    return locked;
  };

  try {
    const startedAt = Date.now();
    let warned = false;
    while (!(await tryLock())) {
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        throw new Error(
          `[integration] Otra corrida sigue usando la base "${name}" después de ` +
            `${Math.round(MAX_WAIT_MS / 1000)} s. Espera a que termine o apunta ` +
            'UNIK_INTEGRATION_DATABASE_URL a otra base desechable.'
        );
      }
      if (!warned) {
        warned = true;
        console.warn(
          `[integration] Otra corrida está usando la base "${name}"; esperando a que libere el candado…`
        );
      }
      await sleep(RETRY_MS);
    }
  } catch (error) {
    await client.$disconnect();
    throw error;
  }

  return async () => {
    try {
      await client.$queryRaw`
        SELECT pg_advisory_unlock(${INTEGRATION_LOCK_CLASS_ID}::int, ${INTEGRATION_LOCK_OBJ_ID}::int)`;
    } finally {
      await client.$disconnect();
    }
  };
}
