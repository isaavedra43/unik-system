import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * IntegrationConfig default-row seeding under concurrency.
 *
 * At boot every Zoho scheduler loads the config at the same time; on an empty
 * table all of them see no row and try to insert it. The stub below enforces
 * the `source` unique constraint like PostgreSQL (P2002) so the race is real.
 */

const { db } = await vi.hoisted(async () => {
  const { Prisma } = await import('@prisma/client');

  interface ConfigRow {
    id: string;
    source: string;
    displayName: string;
    isEnabled: boolean;
    settings: unknown;
    createdAt: Date;
    updatedAt: Date;
  }

  const rows: ConfigRow[] = [];
  let seq = 0;
  const copy = (row: ConfigRow): ConfigRow => ({ ...row });

  const store = {
    rows,
    conflicts: 0,
    reset() {
      rows.length = 0;
      store.conflicts = 0;
    },
    insert(data: Pick<ConfigRow, 'source' | 'displayName' | 'isEnabled' | 'settings'>): ConfigRow {
      if (rows.some((r) => r.source === data.source)) {
        store.conflicts += 1;
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`source`)',
          { code: 'P2002', clientVersion: 'test', meta: { target: ['source'] } }
        );
      }
      const row = { id: `cfg_${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return copy(row);
    },
    integrationConfig: {
      findUnique: async (args: { where: { source: string } }) => {
        const row = rows.find((r) => r.source === args.where.source);
        return row ? copy(row) : null;
      },
      findMany: async () => [...rows].sort((a, b) => a.source.localeCompare(b.source)).map(copy),
      create: async (args: {
        data: Pick<ConfigRow, 'source' | 'displayName' | 'isEnabled' | 'settings'>;
      }) => store.insert(args.data),
    },
  };

  return { db: store };
});

vi.mock('@/lib/prisma', () => ({ prisma: { integrationConfig: db.integrationConfig } }));

type Service = typeof import('./integration-config-service');
let service: Service;

beforeEach(async () => {
  db.reset();
  // The service keeps a module-level cache; load a fresh copy per test.
  vi.resetModules();
  service = await import('./integration-config-service');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IntegrationConfig default row', () => {
  it('seeds a single row when many loaders race on an empty table', async () => {
    const { getIntegrationSettings, listIntegrationConfigs, DEFAULT_SETTINGS } = service;

    const settingsLoads = Array.from({ length: 10 }, () => getIntegrationSettings('zoho'));
    const listLoads = Array.from({ length: 3 }, () => listIntegrationConfigs());
    const [settings, lists] = await Promise.all([
      Promise.all(settingsLoads),
      Promise.all(listLoads),
    ]);

    // The race actually happened: some inserts lost against the unique constraint.
    expect(db.conflicts).toBeGreaterThan(0);

    expect(db.rows).toHaveLength(1);
    const [row] = db.rows;
    expect(row).toMatchObject({
      source: 'zoho',
      displayName: 'Zoho Inventory',
      isEnabled: DEFAULT_SETTINGS.zoho.schedulerEnabled,
      settings: DEFAULT_SETTINGS.zoho,
    });

    for (const result of settings) expect(result).toEqual(DEFAULT_SETTINGS.zoho);
    for (const list of lists) {
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(row.id);
    }
  });

  it('uses and caches the row inserted by another instance after the miss', async () => {
    const { getIntegrationSettings, isIntegrationEnabled, DEFAULT_SETTINGS } = service;

    // Another process inserts its row between our read and our insert.
    const findUnique = vi
      .spyOn(db.integrationConfig, 'findUnique')
      .mockImplementationOnce(async () => {
        db.insert({
          source: 'zoho',
          displayName: 'Zoho Inventory',
          isEnabled: true,
          settings: { ...DEFAULT_SETTINGS.zoho, checkIntervalMs: 1234 },
        });
        return null;
      });

    const settings = await getIntegrationSettings('zoho');

    expect(db.conflicts).toBe(1);
    expect(db.rows).toHaveLength(1);
    // The miss, then the re-read after the conflict.
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(settings.checkIntervalMs).toBe(1234);

    // The cache holds the winner's row: this read must not touch the DB.
    findUnique.mockClear();
    await expect(isIntegrationEnabled('zoho')).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('still propagates insert errors other than a unique conflict', async () => {
    const { getIntegrationSettings } = service;

    vi.spyOn(db.integrationConfig, 'create').mockRejectedValueOnce(new Error('connection refused'));

    await expect(getIntegrationSettings('zoho')).rejects.toThrow('connection refused');
    expect(db.rows).toHaveLength(0);
  });
});
