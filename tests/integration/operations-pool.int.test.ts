import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Pool size vs. command transactions (finding: global client inside a command).
 *
 * Every command holds one connection for its transaction. Anything inside it
 * that asked the pool for a second connection (responsibles, notification
 * preferences, the operations configuration after its cache expired) blocked
 * once there were as many concurrent commands as connections. Here the pool
 * has TWO connections and THREE commands run at once: each one creates a work
 * item (area responsible), notifies its owner (preferences) and reads the
 * configuration with an expired cache. They must all complete.
 *
 * Runs only with UNIK_INTEGRATION_DATABASE_URL (a local disposable database with
 * every migration). It inserts its own rows (prefix `itpool_`) and removes them.
 */

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim();
const suite = integrationUrl ? describe : describe.skip;

function withSmallPool(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '2');
  parsed.searchParams.set('pool_timeout', '5');
  return parsed.toString();
}

const USERS = ['itpool_owner', 'itpool_backup'];

suite('pool de 2 conexiones con 3 comandos concurrentes', () => {
  let client: PrismaClient;
  /** The shared `inventario` area row points at this test's responsible and is restored after. */
  let originalArea: { responsibleArea: string } | null = null;

  beforeAll(async () => {
    client = new PrismaClient({ datasources: { db: { url: withSmallPool(integrationUrl!) } } });
    // `@/lib/prisma` reuses the global client: every module of this file uses the small pool.
    (globalThis as typeof globalThis & { prisma?: PrismaClient }).prisma = client;
    const [{ name }] = await client.$queryRaw<
      Array<{ name: string }>
    >`SELECT current_database() AS name`;
    if (name === 'unik_system' || !/(check|test|integration|scratch|ci)/i.test(name)) {
      throw new Error(`[integration] La base "${name}" no parece desechable`);
    }
    await cleanup(client);
    for (const id of USERS) {
      await client.user.create({
        data: {
          id,
          username: id,
          name: id,
          passwordHash: 'integration',
          mustChangePassword: false,
        },
      });
    }
    originalArea = await client.area.findUnique({
      where: { key: 'inventario' },
      select: { responsibleArea: true },
    });
    await client.area.upsert({
      where: { key: 'inventario' },
      create: { key: 'inventario', label: 'Inventario', responsibleArea: 'itpool_inventario' },
      update: { responsibleArea: 'itpool_inventario' },
    });
    await client.responsible.create({
      data: {
        area: 'itpool_inventario',
        label: 'Inventario (prueba de pool)',
        userId: 'itpool_owner',
        backupUserId: 'itpool_backup',
      },
    });
  });

  afterAll(async () => {
    if (!client) return;
    await cleanup(client);
    if (originalArea) {
      await client.area.update({
        where: { key: 'inventario' },
        data: { responsibleArea: originalArea.responsibleArea },
      });
    } else {
      await client.area.deleteMany({ where: { key: 'inventario' } });
    }
    await client.$disconnect();
  });

  it('terminan sin agotar el pool: responsables, preferencias y configuración usan la transacción', async () => {
    const { prisma } = await import('@/lib/prisma');
    expect(prisma).toBe(client);
    const { executeCommand, registerCommand } = await import('@/modules/operations/commands');
    const { invalidateOperationsConfigCache } =
      await import('@/modules/operations/operations-config');
    const { getOperationsConfig } = await import('@/modules/operations/operations-config');

    registerCommand('it.pool_probe', {
      schema: z.object({ n: z.number().int() }),
      aggregate: 'none',
      audit: 'never',
      async handler(tx, cmd, ctx) {
        // Hold the transaction connection while the others start theirs.
        await tx.$queryRaw`SELECT 1 AS slept FROM pg_sleep(0.3)`;
        invalidateOperationsConfigCache();
        const config = await getOperationsConfig();
        const item = await ctx.createWorkItem({
          areaKey: 'inventario',
          kind: 'action',
          title: `Prueba de pool ${cmd.payload.n}`,
          slaMinutes: config.slaDefaults.action,
        });
        return { data: { workItemId: item.id, ownerUserId: item.ownerUserId } };
      },
    });

    const startedAt = Date.now();
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        executeCommand<{ workItemId: string; ownerUserId: string }>(
          {
            commandId: `itpool-${n}-${startedAt}`,
            type: 'it.pool_probe',
            actor: { type: 'system', id: 'it.pool' },
            aggregate: { type: 'test', id: `itpool-${n}` },
            payload: { n },
          },
          null
        )
      )
    );

    expect(results.map((r) => r.status)).toEqual(['completed', 'completed', 'completed']);
    expect(results.every((r) => r.data?.ownerUserId === 'itpool_owner')).toBe(true);
    expect(
      await client.notification.count({
        where: { userId: 'itpool_owner', entityId: { in: results.map((r) => r.data!.workItemId) } },
      })
    ).toBe(3);
    // Serialized by the pool (2 at a time), far below the 10 s transaction wait.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

async function cleanup(db: PrismaClient): Promise<void> {
  await db.notification.deleteMany({ where: { userId: { in: USERS } } });
  await db.operationalEvent.deleteMany({ where: { actorId: 'it.pool' } });
  await db.operationalCommand.deleteMany({ where: { type: 'it.pool_probe' } });
  await db.workItem.deleteMany({ where: { ownerUserId: { in: USERS } } });
  await db.responsible.deleteMany({ where: { area: 'itpool_inventario' } });
  await db.user.deleteMany({ where: { id: { in: USERS } } });
}
