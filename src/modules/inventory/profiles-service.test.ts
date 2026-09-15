import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('./testing/inventory-fixtures');
  const fake = fixtures.createInventoryFake();
  return {
    fake,
    locks: fixtures.createLockEmulation(fake),
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
vi.mock('./inventory-locks', () => mocks.locks.module);

import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedArea, seedResponsible, seedUser } from '@/modules/operations/testing/fixtures';
import { ensureInventoryProfile, updateInventoryProfile } from './inventory-commands';
import type { ProfileDTO } from './inventory-dto';
import {
  getOrCreateProfile,
  normalizeVariantAxes,
  toUnitProfile,
  validateConversions,
} from './profiles-service';
import {
  seedProduct,
  seedProfile,
  seedStockItem,
  seedWarehouse,
} from './testing/inventory-fixtures';

const { fake, locks } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
const tx = fake.client as unknown as Prisma.TransactionClient;

let manager: CurrentUser;

beforeEach(() => {
  fake.tables.clear();
  locks.reset();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  seedArea(fake, 'inventario');
  manager = seedUser(fake, {
    id: 'manager',
    permissions: ['inventory.view', 'inventory.manage'],
  }).currentUser;
  seedResponsible(fake, { area: 'inventario', userId: 'manager' });
});

describe('validateConversions / normalizeVariantAxes', () => {
  it('normaliza unidades y admite la unidad base sólo con factor 1', () => {
    expect(
      validateConversions('M2', [
        { unit: 'Cajas', factor: '1.44', decimals: 0 },
        { unit: 'm²', factor: '1', decimals: 2 },
      ])
    ).toEqual({
      ok: true,
      conversions: [
        { unit: 'caja', factor: '1.44', decimals: 0 },
        { unit: 'm2', factor: '1', decimals: 2 },
      ],
    });
    expect(validateConversions('m2', [{ unit: 'm2', factor: '2' }])).toMatchObject({ ok: false });
    expect(
      validateConversions('m2', [
        { unit: 'caja', factor: '1' },
        { unit: 'CAJAS', factor: '2' },
      ])
    ).toMatchObject({
      ok: false,
      message: 'La unidad caja está repetida',
    });
    expect(validateConversions('', [])).toMatchObject({ ok: false });
  });

  it('normaliza ejes de variante y rechaza inválidos', () => {
    expect(normalizeVariantAxes(['Color', 'medida', 'COLOR'])).toEqual(['color', 'medida']);
    expect(normalizeVariantAxes(['9x'])).toBeNull();
  });
});

describe('getOrCreateProfile', () => {
  it('crea el perfil UNCOUNTED con la unidad de Zoho normalizada y 2 % de tolerancia; es idempotente', async () => {
    seedProduct(fake, { zohoItemId: 'item-1', unit: 'PZA.' });
    const created = await getOrCreateProfile(tx, 'item-1');
    expect(created).toMatchObject({
      zohoItemId: 'item-1',
      baseUnit: 'pz',
      confidence: 'UNCOUNTED',
      defaultSource: 'stock',
      variantAxes: [],
    });
    expect(created.tolerancePct.toString()).toBe('2');
    const again = await getOrCreateProfile(tx, 'item-1');
    expect(again.id).toBe(created.id);
    expect(fake.rows('productInventoryProfile')).toHaveLength(1);
    expect(toUnitProfile(created)).toEqual({ baseUnit: 'pz', conversions: [] });
  });

  it('sin producto sincronizado usa pieza como unidad base', async () => {
    expect((await getOrCreateProfile(tx, 'item-sin-zoho')).baseUnit).toBe('pz');
    await expect(getOrCreateProfile(tx, '  ')).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('el comando profile.ensure devuelve el DTO', async () => {
    seedProduct(fake, { zohoItemId: 'item-2', unit: 'm2' });
    const result = await ensureInventoryProfile(manager, { zohoItemId: 'item-2' }, { now: NOW });
    expect(result.status).toBe('completed');
    expect((result.data as { profile: ProfileDTO }).profile).toMatchObject({
      baseUnit: 'm2',
      confidenceLabel: 'Sin contar',
    });
  });
});

describe('profile.update', () => {
  it('actualiza conversiones, tolerancia, ejes y política con la versión como guarda', async () => {
    const profile = seedProfile(fake, { zohoItemId: 'item-1', baseUnit: 'm2' });
    const result = await updateInventoryProfile(
      manager,
      {
        profileId: profile.id,
        conversions: [{ unit: 'Caja', factor: 1.44 }],
        tolerancePct: 1.5,
        variantAxes: ['Color', 'medida'],
        trackingPolicy: 'lot',
        weightKgPerBaseUnit: 22.5,
      },
      { now: NOW, expectedVersion: 1 }
    );
    expect(result).toMatchObject({ status: 'completed', aggregateVersion: 2 });
    const dto = (result.data as { profile: ProfileDTO }).profile;
    expect(dto).toMatchObject({
      conversions: [{ unit: 'caja', factor: '1.44' }],
      tolerancePct: '1.5',
      variantAxes: ['color', 'medida'],
      trackingPolicy: 'lot',
      weightKgPerBaseUnit: '22.5',
    });
    expect(
      fake.rows('operationalEvent').find((e) => e.type === 'inventory.profile_updated')?.payload
    ).toMatchObject({
      fields: [
        'conversions',
        'tolerancePct',
        'trackingPolicy',
        'variantAxes',
        'weightKgPerBaseUnit',
      ],
    });

    const stale = await updateInventoryProfile(
      manager,
      { profileId: profile.id, isBulk: true },
      { now: NOW, expectedVersion: 1 }
    );
    expect(stale).toMatchObject({ status: 'rejected', errorCode: 'version_conflict' });
  });

  it('congela la unidad base con movimientos y no quita ejes usados por existencias', async () => {
    const profile = seedProfile(fake, {
      zohoItemId: 'item-1',
      baseUnit: 'm2',
      variantAxes: ['color', 'medida'],
    });
    const { warehouse, general } = seedWarehouse(fake, { key: 'centro' });
    seedStockItem(fake, {
      zohoItemId: 'item-1',
      warehouseId: warehouse.id,
      locationId: general.id,
      variantKey: 'color=gris',
      baseline: 4,
    });
    fake.seed('stockMovement', {
      stockItemId: 'x',
      zohoItemId: 'item-1',
      warehouseId: warehouse.id,
      kind: 'baseline',
      quantity: 4,
      originalQuantity: 4,
      originalUnit: 'm2',
      actorId: 'manager',
    });

    expect(
      await updateInventoryProfile(manager, { profileId: profile.id, baseUnit: 'pz' }, { now: NOW })
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
    });
    expect(
      await updateInventoryProfile(
        manager,
        { profileId: profile.id, variantAxes: ['medida'] },
        { now: NOW }
      )
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
    });
    const removeUnused = await updateInventoryProfile(
      manager,
      { profileId: profile.id, variantAxes: ['color'] },
      { now: NOW }
    );
    expect(removeUnused.status).toBe('completed');
  });

  it('congela la unidad base mientras un expediente abierto tiene partidas del artículo', async () => {
    const profile = seedProfile(fake, { zohoItemId: 'item-1', baseUnit: 'm2' });
    fake.seed('caseDemand', {
      id: 'd-open',
      caseId: 'case-1',
      lineRef: 'li-1',
      zohoItemId: 'item-1',
      name: 'Loseta',
      quantity: 12,
      unit: 'm2',
      baseQuantity: 12,
      baseUnit: 'm2',
      status: 'verifying',
    });
    const blocked = await updateInventoryProfile(
      manager,
      { profileId: profile.id, baseUnit: 'pz' },
      { now: NOW }
    );
    expect(blocked).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
    expect(blocked.message).toContain('partidas de expedientes abiertos');

    fake.rows('caseDemand')[0].status = 'fulfilled';
    const allowed = await updateInventoryProfile(
      manager,
      { profileId: profile.id, baseUnit: 'pz' },
      { now: NOW }
    );
    expect(allowed.status).toBe('completed');
  });

  it('valida conversiones y permiso', async () => {
    const profile = seedProfile(fake, { zohoItemId: 'item-1', baseUnit: 'm2' });
    expect(
      await updateInventoryProfile(
        manager,
        { profileId: profile.id, conversions: [{ unit: 'm2', factor: 3 }] },
        { now: NOW }
      )
    ).toMatchObject({ status: 'rejected', errorCode: 'invalid_unit' });
    expect(
      await updateInventoryProfile(
        manager,
        { profileId: profile.id, conversions: [{ unit: 'caja', factor: -1 }] },
        { now: NOW }
      )
    ).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
    const viewer = seedUser(fake, { id: 'viewer', permissions: ['inventory.view'] }).currentUser;
    expect(
      await updateInventoryProfile(viewer, { profileId: profile.id, isBulk: true }, { now: NOW })
    ).toMatchObject({
      errorCode: 'forbidden',
    });
  });
});
