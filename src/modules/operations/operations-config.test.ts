import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fake } = await vi.hoisted(async () => {
  const { createOpsFake } = await import('./testing/fixtures');
  return { fake: createOpsFake() };
});

vi.mock('@/lib/prisma', () => ({ prisma: fake.client }));

import { OperationsError } from './errors';
import {
  OPERATIONS_CONFIG_SOURCE,
  OPS_FLAGS,
  defaultOperationsSettings,
  getOperationsConfig,
  invalidateOperationsConfigCache,
  isOpsFlagEnabled,
  normalizeOperationsSettings,
  updateOperationsConfig,
} from './operations-config';

const NOW = new Date('2026-09-15T15:00:00.000Z');

function storedRow() {
  return fake.rows('integrationConfig').find((r) => r.source === OPERATIONS_CONFIG_SOURCE);
}

beforeEach(() => {
  fake.tables.clear();
  invalidateOperationsConfigCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeOperationsSettings', () => {
  it('fills every field from the defaults and flags the missing cutover', () => {
    const { settings, cutoverRepaired } = normalizeOperationsSettings(null, NOW);
    expect(settings).toEqual(defaultOperationsSettings(NOW));
    expect(cutoverRepaired).toBe(true);
  });

  it('keeps valid stored values and replaces only the invalid ones', () => {
    const { settings, cutoverRepaired } = normalizeOperationsSettings(
      {
        cutoverDate: '2026-09-01T00:00:00Z',
        flags: { crm: false, agents: 'yes' },
        pilotLocationIds: ['loc1', 'loc1', 'loc2'],
        slaDefaults: { action: 30, wait: -1 },
        escalation: { afterMinutes: [120, 0], ladder: ['backup'] },
        reservationAlertDays: 0,
        approvalThresholds: { procurementDoubleApprovalMxn: 80000, expenseAutoApproveMxn: 'mucho' },
      },
      NOW
    );
    expect(cutoverRepaired).toBe(false);
    expect(settings.cutoverDate).toBe('2026-09-01T00:00:00.000Z');
    expect(settings.flags.crm).toBe(false);
    expect(settings.flags.agents).toBe(true);
    expect(settings.pilotLocationIds).toEqual(['loc1', 'loc2']);
    expect(settings.slaDefaults.action).toBe(30);
    expect(settings.slaDefaults.wait).toBe(1440);
    expect(settings.escalation).toEqual({ afterMinutes: [0, 120, 480], ladder: ['backup'] });
    expect(settings.reservationAlertDays).toBe(7);
    expect(settings.approvalThresholds).toEqual({
      procurementDoubleApprovalMxn: 80000,
      expenseAutoApproveMxn: 2000,
    });
  });
});

describe('getOperationsConfig', () => {
  it('seeds the row on first read: every flag on and cutover at the seeding instant', async () => {
    const config = await getOperationsConfig();
    expect(config.isEnabled).toBe(true);
    for (const flag of OPS_FLAGS) expect(config.flags[flag]).toBe(flag !== 'crmSalesOrderWrite');
    expect(config.cutoverDate).toBe(NOW.toISOString());
    expect(config.pilotLocationIds).toEqual([]);
    expect(config.escalation).toEqual({
      afterMinutes: [0, 120, 480],
      ladder: ['backup', 'area_lead', 'administracion'],
    });
    expect(config.externalSyncStaleMinutes).toBe(15);
    expect(config.legacyClaimTtlDays).toBe(14);
    expect(config.reservationAlertDays).toBe(7);
    expect(config.provisionalVerificationMaxHours).toBe(72);
    expect(config.approvalThresholds).toEqual({
      procurementDoubleApprovalMxn: 50000,
      expenseAutoApproveMxn: 2000,
    });
    expect(storedRow()).toMatchObject({ displayName: 'Operaciones', isEnabled: true });
    expect(storedRow()!.settings.cutoverDate).toBe(NOW.toISOString());
  });

  it('serves reads from a 10 s cache and shares one load between concurrent callers', async () => {
    const findUnique = vi.spyOn(fake.client.integrationConfig, 'findUnique');
    const create = vi.spyOn(fake.client.integrationConfig, 'create');
    try {
      await Promise.all([getOperationsConfig(), getOperationsConfig(), getOperationsConfig()]);
      expect(create).toHaveBeenCalledTimes(1);
      const readsAfterLoad = findUnique.mock.calls.length;
      vi.setSystemTime(new Date(NOW.getTime() + 9_000));
      await getOperationsConfig();
      expect(findUnique.mock.calls.length).toBe(readsAfterLoad);
      vi.setSystemTime(new Date(NOW.getTime() + 11_000));
      await getOperationsConfig();
      expect(findUnique.mock.calls.length).toBeGreaterThan(readsAfterLoad);
    } finally {
      findUnique.mockRestore();
      create.mockRestore();
    }
  });

  it('tolerates a concurrent boot that created the row first (P2002 → re-read)', async () => {
    fake.seed('integrationConfig', {
      source: OPERATIONS_CONFIG_SOURCE,
      displayName: 'Operaciones',
      isEnabled: true,
      settings: {
        ...defaultOperationsSettings(new Date('2026-09-10T00:00:00Z')),
        flags: { crm: false },
      },
    });
    const findUnique = vi
      .spyOn(fake.client.integrationConfig, 'findUnique')
      .mockResolvedValueOnce(null);
    try {
      const config = await getOperationsConfig();
      expect(config.flags.crm).toBe(false);
      expect(config.cutoverDate).toBe('2026-09-10T00:00:00.000Z');
      expect(fake.rows('integrationConfig')).toHaveLength(1);
    } finally {
      findUnique.mockRestore();
    }
  });

  it('persists a repaired cutover once so it does not move on later reads', async () => {
    fake.seed('integrationConfig', {
      source: OPERATIONS_CONFIG_SOURCE,
      displayName: 'Operaciones',
      isEnabled: true,
      settings: { cutoverDate: 'no-es-fecha', flags: { finance: false } },
    });
    const first = await getOperationsConfig();
    expect(first.cutoverDate).toBe(NOW.toISOString());
    expect(first.flags.finance).toBe(false);
    expect(storedRow()!.settings.cutoverDate).toBe(NOW.toISOString());

    invalidateOperationsConfigCache();
    vi.setSystemTime(new Date(NOW.getTime() + 60 * 60_000));
    const later = await getOperationsConfig();
    expect(later.cutoverDate).toBe(NOW.toISOString());
  });
});

describe('updateOperationsConfig', () => {
  it('deep-merges the patch, invalidates the cache and audits the change', async () => {
    await getOperationsConfig();
    const updated = await updateOperationsConfig(
      {
        flags: { crm: false },
        approvalThresholds: { expenseAutoApproveMxn: 5000 },
        slaDefaults: { verification: 90 },
        pilotLocationIds: ['loc-norte'],
      },
      { actorUserId: 'admin' }
    );
    expect(updated.flags.crm).toBe(false);
    expect(updated.flags.salesToCase).toBe(true);
    expect(updated.approvalThresholds).toEqual({
      procurementDoubleApprovalMxn: 50000,
      expenseAutoApproveMxn: 5000,
    });
    expect(updated.slaDefaults.verification).toBe(90);
    expect(updated.slaDefaults.action).toBe(240);
    expect(updated.pilotLocationIds).toEqual(['loc-norte']);
    expect((await getOperationsConfig()).flags.crm).toBe(false);
    expect(fake.rows('auditLog')).toEqual([
      expect.objectContaining({
        actorUserId: 'admin',
        action: 'operations.config.updated',
        targetId: OPERATIONS_CONFIG_SOURCE,
      }),
    ]);
  });

  it('rejects unknown keys and out-of-range values with invalid_config', async () => {
    await expect(
      updateOperationsConfig({ flags: { teleport: true } } as never)
    ).rejects.toMatchObject({
      code: 'invalid_config',
      httpStatus: 422,
    });
    await expect(updateOperationsConfig({ reservationAlertDays: 0 })).rejects.toBeInstanceOf(
      OperationsError
    );
    await expect(
      updateOperationsConfig({ escalation: { afterMinutes: [480, 0] } })
    ).rejects.toMatchObject({
      code: 'invalid_config',
    });
    await expect(updateOperationsConfig({ cutoverDate: 'ayer' })).rejects.toMatchObject({
      code: 'invalid_config',
    });
  });

  it('reports config_conflict when the row keeps changing underneath', async () => {
    await getOperationsConfig();
    const updateMany = vi
      .spyOn(fake.client.integrationConfig, 'updateMany')
      .mockResolvedValue({ count: 0 } as never);
    try {
      await expect(updateOperationsConfig({ flags: { crm: false } })).rejects.toMatchObject({
        code: 'config_conflict',
      });
      expect(updateMany).toHaveBeenCalledTimes(2);
    } finally {
      updateMany.mockRestore();
    }
  });
});

describe('isOpsFlagEnabled', () => {
  it('is true by default for every flag except the real sales order write of CRM', async () => {
    for (const flag of OPS_FLAGS) expect(await isOpsFlagEnabled(flag)).toBe(flag !== 'crmSalesOrderWrite');
  });

  it('follows each flag and the row kill switch', async () => {
    await updateOperationsConfig({ flags: { agents: false } });
    expect(await isOpsFlagEnabled('agents')).toBe(false);
    expect(await isOpsFlagEnabled('supervisor')).toBe(true);

    await updateOperationsConfig({ isEnabled: false });
    for (const flag of OPS_FLAGS) expect(await isOpsFlagEnabled(flag)).toBe(false);
    expect(storedRow()!.isEnabled).toBe(false);
    // The kill switch keeps the individual flags intact.
    expect(storedRow()!.settings.flags.supervisor).toBe(true);
  });

  it('stores settings as plain JSON', async () => {
    await getOperationsConfig();
    const settings = storedRow()!.settings as Prisma.JsonObject;
    expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
  });
});
