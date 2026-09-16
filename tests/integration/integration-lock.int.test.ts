import { describe, expect, it } from 'vitest';

import { prisma } from '@/lib/prisma';

import {
  assertDisposableIntegrationUrl,
  databaseNameOf,
  INTEGRATION_LOCK_CLASS_ID,
  INTEGRATION_LOCK_OBJ_ID,
  singleConnectionUrl,
} from './integration-lock';

/**
 * Ejercita la exclusión mutua entre corridas de integración.
 *
 * No siembra ni borra nada: sólo lee `pg_locks`, así que convive con la
 * limpieza por truncado del resto de las suites.
 */

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || '';
const describeDb = integrationUrl ? describe : describe.skip;

describeDb('exclusión mutua entre corridas de integración', () => {
  it('el globalSetup dejó tomado el candado de aviso de esta corrida', async () => {
    const [{ held }] = await prisma.$queryRaw<Array<{ held: bigint }>>`
      SELECT count(*) AS held
        FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid = ${INTEGRATION_LOCK_CLASS_ID}
         AND objid = ${INTEGRATION_LOCK_OBJ_ID}
         AND granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    // Si esto falla, el globalSetup no corrió y dos corridas simultáneas vuelven
    // a poder truncarse las tablas entre sí (deadlock 40P01, FK de Notification,
    // unicidad de Responsible.area).
    expect(Number(held)).toBeGreaterThanOrEqual(1);
  });

  it('una segunda corrida no puede tomar el mismo candado mientras esta lo tiene', async () => {
    // `pg_try_advisory_lock` es reentrante por SESIÓN, así que hay que pedirlo
    // desde otra conexión para reproducir lo que hace la otra corrida.
    const { PrismaClient } = await import('@prisma/client');
    const other = new PrismaClient({
      datasources: { db: { url: singleConnectionUrl(integrationUrl) } },
    });
    try {
      const [{ locked }] = await other.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_lock(${INTEGRATION_LOCK_CLASS_ID}::int, ${INTEGRATION_LOCK_OBJ_ID}::int) AS locked`;
      if (locked) {
        await other.$queryRaw`
          SELECT pg_advisory_unlock(${INTEGRATION_LOCK_CLASS_ID}::int, ${INTEGRATION_LOCK_OBJ_ID}::int)`;
      }
      expect(locked).toBe(false);
    } finally {
      await other.$disconnect();
    }
  });

  it('la URL de una sola conexión conserva la base y fija connection_limit', () => {
    const single = new URL(singleConnectionUrl('postgresql://u@localhost:5432/unik_schema_check'));
    expect(single.pathname).toBe('/unik_schema_check');
    expect(single.searchParams.get('connection_limit')).toBe('1');
    expect(databaseNameOf(single.toString())).toBe('unik_schema_check');
  });

  it('el candado se niega a abrirse sobre una base no desechable o remota', () => {
    expect(() =>
      assertDisposableIntegrationUrl('postgresql://u@localhost:5432/unik_system')
    ).toThrow(/no parece desechable/);
    expect(() =>
      assertDisposableIntegrationUrl('postgresql://u@db.railway.app:5432/unik_schema_check')
    ).toThrow(/base local/);
    expect(() =>
      assertDisposableIntegrationUrl('postgresql://u@localhost:5432/unik_schema_check')
    ).not.toThrow();
  });
});
