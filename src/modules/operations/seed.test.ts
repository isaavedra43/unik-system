import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('./testing/fixtures');
  return {
    fake: createOpsFake(),
    notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({
      id: '1',
      channel: '',
      type: '',
      payload: {},
      createdAt: '',
    })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));

import { invalidateOperationsConfigCache, updateOperationsConfig } from './operations-config';
import { defaultAreaRows, ensureOperationsSeed } from './seed';
import { seedResponsible, seedUser } from './testing/fixtures';
import { AREA_KEYS } from './types';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
const NEXT_DAY = new Date('2026-09-16T15:00:00.000Z');

beforeEach(() => {
  fake.tables.clear();
  invalidateOperationsConfigCache();
  vi.clearAllMocks();
});

describe('ensureOperationsSeed', () => {
  it('creates the configuration row and the seven areas once', async () => {
    const first = await ensureOperationsSeed({ now: NOW });
    expect(first.areasCreated).toBe(7);
    expect(fake.rows('integrationConfig').map((r) => r.source)).toEqual(['operations']);
    expect(
      fake
        .rows('area')
        .map((a) => a.key)
        .sort()
    ).toEqual([...AREA_KEYS].sort());
    expect(fake.rows('area').find((a) => a.key === 'logistica')).toMatchObject({
      label: 'Logística',
      responsibleArea: 'logistica',
      active: true,
    });

    fake.rows('area').find((a) => a.key === 'ventas')!.label = 'Ventas mostrador';
    const second = await ensureOperationsSeed({ now: NOW });
    expect(second.areasCreated).toBe(0);
    expect(fake.rows('area')).toHaveLength(7);
    expect(fake.rows('area').find((a) => a.key === 'ventas')!.label).toBe('Ventas mostrador');
  });

  it('keeps the area order of the plan', () => {
    const rows = defaultAreaRows();
    expect(rows.map((r) => r.key)).toEqual([...AREA_KEYS]);
    expect(rows.every((r, i) => i === 0 || r.sortOrder > rows[i - 1].sortOrder)).toBe(true);
  });

  it('reports missing responsibles as incidents without inventing users', async () => {
    seedUser(fake, { id: 'seller' });
    seedResponsible(fake, { area: 'ventas', userId: 'seller' });

    const summary = await ensureOperationsSeed({ now: NOW });
    expect(summary.missingResponsibles).toEqual(AREA_KEYS.filter((k) => k !== 'ventas'));
    expect(summary.incidentsReported).toBe(6);
    expect(fake.rows('user').map((u) => u.id)).toEqual(['seller']);
    expect(
      fake.rows('incident').find((i) => i.dedupeKey === 'config:responsible_missing:compras')
    ).toMatchObject({
      kind: 'owner_absent',
      areaKey: 'administracion',
      severity: 'high',
      status: 'open',
    });
    expect(
      fake.rows('incident').find((i) => i.dedupeKey === 'config:responsible_missing:administracion')
    ).toMatchObject({ severity: 'critical' });

    // Same day: replayed, nothing new.
    const again = await ensureOperationsSeed({ now: NOW });
    expect(again.incidentsReported).toBe(0);
    expect(fake.rows('incident')).toHaveLength(6);
  });

  it('resolves the incident once the responsible is configured', async () => {
    await ensureOperationsSeed({ now: NOW });
    seedUser(fake, { id: 'buyer', name: 'Laura' });
    seedResponsible(fake, { area: 'compras', userId: 'buyer' });

    const summary = await ensureOperationsSeed({ now: NEXT_DAY });
    expect(summary.incidentsResolved).toBe(1);
    expect(
      fake.rows('incident').find((i) => i.dedupeKey === 'config:responsible_missing:compras')
    ).toMatchObject({ status: 'resolved' });
    expect(
      fake.rows('incident').find((i) => i.dedupeKey === 'config:responsible_missing:ventas')
    ).toMatchObject({ status: 'open' });
  });

  it('seeds areas but skips the check when the core is disabled', async () => {
    await updateOperationsConfig({ isEnabled: false });
    const summary = await ensureOperationsSeed({ now: NOW });
    expect(summary).toMatchObject({ areasCreated: 7, checkSkipped: 'core_disabled' });
    expect(fake.rows('incident')).toHaveLength(0);
  });
});
