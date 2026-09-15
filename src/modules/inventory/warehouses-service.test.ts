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
import {
  createInventoryWarehouse,
  createStorageLocation,
  syncWarehousesFromZoho,
  updateInventoryWarehouse,
  updateStorageLocation,
} from './inventory-commands';
import type { LocationDTO, WarehouseDTO } from './inventory-dto';
import { seedStockItem, seedWarehouse } from './testing/inventory-fixtures';
import {
  ensureDefaultWarehouse,
  normalizeLocationCode,
  planWarehousesFromZohoLocations,
  resolveWarehouseForZohoLocation,
  slugifyWarehouseKey,
} from './warehouses-service';

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

function salesOrder(id: string, locationId: string | null, locationName: string | null) {
  fake.seed('salesOrder', { zohoSalesOrderId: id, locationId, locationName });
}

describe('reglas puras', () => {
  it('slugifyWarehouseKey y normalizeLocationCode', () => {
    expect(slugifyWarehouseKey('Bodega Centro (León)')).toBe('bodega-centro-leon');
    expect(slugifyWarehouseKey('!!!')).toBe('bodega');
    expect(normalizeLocationCode(' rack a 01 ')).toBe('RACK-A-01');
    expect(normalizeLocationCode('Pasillo Ñ/3')).toBe('PASILLO-N/3');
  });

  it('planea una bodega por ubicación de Zoho con el nombre más usado y claves únicas', () => {
    const plans = planWarehousesFromZohoLocations(
      [
        { zohoLocationId: 'z1', locationName: 'Matriz', orders: 10 },
        { zohoLocationId: 'z1', locationName: 'Matriz vieja', orders: 2 },
        { zohoLocationId: 'z2', locationName: 'Sucursal Norte', orders: 5 },
        { zohoLocationId: 'z3', locationName: 'Matriz', orders: 1 },
        { zohoLocationId: 'z4', locationName: null, orders: 1 },
        { zohoLocationId: 'z9', locationName: 'Ligada', orders: 50 },
        { zohoLocationId: null, locationName: 'Sin id', orders: 3 },
      ],
      [{ key: 'ligada', zohoLocationId: 'z9' }]
    );
    expect(plans).toEqual([
      { key: 'matriz', name: 'Matriz', zohoLocationId: 'z1', orders: 12 },
      { key: 'sucursal-norte', name: 'Sucursal Norte', zohoLocationId: 'z2', orders: 5 },
      { key: 'matriz-z3', name: 'Matriz', zohoLocationId: 'z3', orders: 1 },
      { key: 'bodega-z4', name: 'Bodega z4', zohoLocationId: 'z4', orders: 1 },
    ]);
  });
});

describe('ensureDefaultWarehouse', () => {
  it('crea bodegas desde las ubicaciones vistas en órdenes de venta, con GENERAL, de forma idempotente', async () => {
    salesOrder('so1', 'z1', 'Matriz');
    salesOrder('so2', 'z1', 'Matriz');
    salesOrder('so3', 'z2', 'Sucursal Norte');
    salesOrder('so4', null, null);

    const first = await ensureDefaultWarehouse(tx);
    expect(first.created.map((w) => w.key)).toEqual(['matriz', 'sucursal-norte']);
    expect(first.defaultWarehouse).toMatchObject({ key: 'matriz', zohoLocationId: 'z1' });
    expect(fake.rows('storageLocation').map((l) => l.code)).toEqual(['GENERAL', 'GENERAL']);

    const second = await ensureDefaultWarehouse(tx);
    expect(second.created).toHaveLength(0);
    expect(fake.rows('warehouse')).toHaveLength(2);
    expect(fake.rows('storageLocation')).toHaveLength(2);

    expect(await resolveWarehouseForZohoLocation(tx, 'z2')).toMatchObject({
      key: 'sucursal-norte',
    });
    expect(await resolveWarehouseForZohoLocation(tx, null)).toMatchObject({ key: 'matriz' });
    expect(await resolveWarehouseForZohoLocation(tx, 'desconocida')).toMatchObject({
      key: 'matriz',
    });
  });

  it('sin ubicaciones de Zoho crea la Bodega principal', async () => {
    const result = await ensureDefaultWarehouse(tx);
    expect(result.defaultWarehouse).toMatchObject({
      key: 'principal',
      name: 'Bodega principal',
      zohoLocationId: null,
    });
    expect(fake.rows('storageLocation')).toEqual([
      expect.objectContaining({ code: 'GENERAL', kind: 'floor' }),
    ]);
  });

  it('el comando de sincronización emite eventos de bodegas creadas', async () => {
    salesOrder('so1', 'z1', 'Matriz');
    const result = await syncWarehousesFromZoho(manager, { now: NOW });
    expect(result.status).toBe('completed');
    expect(result.data).toMatchObject({ created: 1 });
    expect(
      fake.rows('operationalEvent').filter((e) => e.type === 'inventory.warehouse_created')
    ).toHaveLength(1);
  });
});

describe('comandos de bodegas y ubicaciones', () => {
  it('crear bodega crea su ubicación GENERAL y rechaza claves o ubicaciones de Zoho repetidas', async () => {
    const created = await createInventoryWarehouse(
      manager,
      { name: 'Bodega Sur', zohoLocationId: 'z7' },
      { now: NOW }
    );
    expect(created.status).toBe('completed');
    const data = created.data as { warehouse: WarehouseDTO; general: LocationDTO };
    expect(data.warehouse).toMatchObject({
      key: 'bodega-sur',
      name: 'Bodega Sur',
      zohoLocationId: 'z7',
      active: true,
    });
    expect(data.general).toMatchObject({ code: 'GENERAL' });

    expect(
      await createInventoryWarehouse(manager, { name: 'Bodega Sur' }, { now: NOW })
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'duplicate',
    });
    expect(
      await createInventoryWarehouse(
        manager,
        { key: 'otra', name: 'Otra', zohoLocationId: 'z7' },
        { now: NOW }
      )
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'duplicate',
    });
    const viewer = seedUser(fake, { id: 'viewer', permissions: ['inventory.view'] }).currentUser;
    expect(await createInventoryWarehouse(viewer, { name: 'X' }, { now: NOW })).toMatchObject({
      errorCode: 'forbidden',
    });
  });

  it('crear ubicación normaliza el código y protege códigos del sistema y duplicados', async () => {
    const { warehouse } = seedWarehouse(fake, { key: 'centro' });
    const created = await createStorageLocation(
      manager,
      { warehouseId: warehouse.id, code: 'rack a 01', kind: 'rack' },
      { now: NOW }
    );
    expect(created.status).toBe('completed');
    expect((created.data as { location: LocationDTO }).location).toMatchObject({
      code: 'RACK-A-01',
      kind: 'rack',
      kindLabel: 'Rack',
    });
    expect(
      await createStorageLocation(
        manager,
        { warehouseId: warehouse.id, code: 'RACK-A-01' },
        { now: NOW }
      )
    ).toMatchObject({
      errorCode: 'duplicate',
    });
    expect(
      await createStorageLocation(
        manager,
        { warehouseId: warehouse.id, code: 'general' },
        { now: NOW }
      )
    ).toMatchObject({
      errorCode: 'invalid_payload',
    });
  });

  it('no desactiva ubicaciones o bodegas con existencias, ni GENERAL', async () => {
    const { warehouse, general } = seedWarehouse(fake, { key: 'centro' });
    fake.seed('storageLocation', {
      id: 'loc-a',
      warehouseId: warehouse.id,
      code: 'RACK-A',
      kind: 'rack',
    });
    seedStockItem(fake, {
      zohoItemId: 'item',
      warehouseId: warehouse.id,
      locationId: 'loc-a',
      baseline: 3,
    });

    expect(
      await updateStorageLocation(manager, { locationId: 'loc-a', active: false }, { now: NOW })
    ).toMatchObject({
      errorCode: 'invalid_state',
    });
    expect(
      await updateStorageLocation(manager, { locationId: general.id, active: false }, { now: NOW })
    ).toMatchObject({
      errorCode: 'invalid_state',
    });
    expect(
      await updateInventoryWarehouse(
        manager,
        { warehouseId: warehouse.id, active: false },
        { now: NOW }
      )
    ).toMatchObject({
      errorCode: 'invalid_state',
    });
    const renamed = await updateStorageLocation(
      manager,
      { locationId: 'loc-a', label: 'Rack de loseta' },
      { now: NOW }
    );
    expect(renamed.status).toBe('completed');
    expect(fake.rows('storageLocation').find((l) => l.id === 'loc-a')?.label).toBe(
      'Rack de loseta'
    );
  });
});
