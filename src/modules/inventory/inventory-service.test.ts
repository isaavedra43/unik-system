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

import { executeCommand } from '@/modules/operations/commands';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedArea, seedResponsible, seedUser } from '@/modules/operations/testing/fixtures';
import {
  INVENTORY_COMMANDS,
  adjustStock,
  blockStockQuantity,
  consumeStockReservation,
  moveStock,
  releaseStockReservation,
  reserveStockForDemand,
  unblockStockQuantity,
  type MoveData,
  type ReserveData,
} from './inventory-commands';
import { getStockSnapshot, verifyAvailability } from './inventory-service';
import {
  seedDemand,
  seedLocation,
  seedProduct,
  seedProfile,
  seedStockItem,
  seedWarehouse,
  type SeedProfileInput,
} from './testing/inventory-fixtures';

const { fake, locks } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
const HOUR = 3_600_000;
const ITEM = 'item-loseta';
const ALL = [
  'inventory.view',
  'inventory.count',
  'inventory.adjust',
  'inventory.reserve',
  'inventory.manage',
];
const tx = fake.client as unknown as Prisma.TransactionClient;

let manager: CurrentUser;
let seller: CurrentUser;
let counter: CurrentUser;
let warehouseId: string;
let generalId: string;

beforeEach(() => {
  fake.tables.clear();
  locks.reset();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  seedArea(fake, 'inventario');
  seedArea(fake, 'administracion');
  manager = seedUser(fake, { id: 'manager', permissions: ALL }).currentUser;
  seller = seedUser(fake, {
    id: 'seller',
    permissions: ['inventory.view', 'inventory.reserve'],
  }).currentUser;
  counter = seedUser(fake, {
    id: 'counter',
    permissions: ['inventory.view', 'inventory.count'],
  }).currentUser;
  seedResponsible(fake, { area: 'inventario', userId: 'manager' });
  const { warehouse, general } = seedWarehouse(fake, {
    key: 'centro',
    name: 'Bodega Centro',
    zohoLocationId: 'zloc-1',
  });
  warehouseId = warehouse.id;
  generalId = general.id;
  seedProduct(fake, {
    zohoItemId: ITEM,
    name: 'Loseta Perla 60x60',
    sku: 'LOS-PER-60',
    unit: 'm2',
    stockOnHand: 999,
    availableStock: 999,
  });
});

function stockWith(
  quantity: number,
  profile: Partial<SeedProfileInput> = {},
  lastCountedAt = new Date(NOW.getTime() - HOUR)
) {
  seedProfile(fake, {
    zohoItemId: ITEM,
    baseUnit: 'm2',
    confidence: 'CONTROLLED',
    consecutiveGoodCounts: 2,
    conversions: [{ unit: 'caja', factor: '1.44' }],
    ...profile,
  });
  return seedStockItem(fake, {
    id: 'stock-general',
    zohoItemId: ITEM,
    warehouseId,
    locationId: generalId,
    baseline: quantity,
    lastCountedAt,
  });
}

function reserve(
  actor: CurrentUser,
  input: Partial<Parameters<typeof reserveStockForDemand>[1]>,
  options: { commandId?: string } = {}
) {
  return reserveStockForDemand(
    actor,
    { caseId: 'case1', demandId: 'd1', zohoItemId: ITEM, warehouseId, quantity: 1, ...input },
    { now: NOW, ...options }
  );
}

const stock = (id = 'stock-general') => fake.rows('stockItem').find((row) => row.id === id)!;
const events = (type: string) =>
  fake.rows('operationalEvent').filter((event) => event.type === type);

describe('reserveStock', () => {
  it('reserva existencia CONTROLLED, baja el disponible y liga la reserva a la necesidad', async () => {
    stockWith(10);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 8, unit: 'm2' });

    const result = await reserve(seller, { quantity: 8 });

    expect(result.status).toBe('completed');
    const data = result.data as ReserveData;
    expect(data).toMatchObject({
      provisional: false,
      confidence: 'CONTROLLED',
      quantity: '8',
      availableBefore: '10',
      availableAfter: '2',
    });
    expect(stock().reserved.toString()).toBe('8');
    expect(fake.rows('stockReservation')).toHaveLength(1);
    expect(fake.rows('stockReservation')[0]).toMatchObject({
      caseId: 'case1',
      demandId: 'd1',
      status: 'active',
      confidenceAtReserve: 'CONTROLLED',
    });
    expect(events('stock.reserved')).toHaveLength(1);
    expect(events('stock.reserved')[0]).toMatchObject({ caseId: 'case1', areaKey: 'inventario' });
    expect(fake.rows('objectRelation')).toEqual([
      expect.objectContaining({
        fromType: 'stock_reservation',
        toType: 'case_demand',
        toId: 'd1',
        relation: 'reserved_for',
      }),
    ]);
    const availability = await verifyAvailability(tx, { zohoItemId: ITEM, warehouseId });
    expect(availability.available.toString()).toBe('2');
  });

  it('dos reservas simultáneas se serializan: la segunda se rechaza y nunca queda negativo', async () => {
    stockWith(10);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 8 });
    seedDemand(fake, { id: 'd2', caseId: 'case2', zohoItemId: ITEM, quantity: 5 });

    const [first, second] = await Promise.all([
      reserve(seller, { quantity: 8 }),
      reserve(manager, { caseId: 'case2', demandId: 'd2', quantity: 5 }),
    ]);

    expect([first.status, second.status].sort()).toEqual(['completed', 'rejected']);
    const winner = first.status === 'completed' ? first : second;
    const loser = first.status === 'completed' ? second : first;
    expect(loser.errorCode).toBe('insufficient_stock');
    expect(stock().reserved.toString()).toBe((winner.data as ReserveData).quantity);
    expect(fake.rows('stockReservation')).toHaveLength(1);
    const availability = await verifyAvailability(tx, { zohoItemId: ITEM, warehouseId });
    expect(availability.available.gte(0)).toBe(true);
    expect(locks.acquired.filter((key) => key === 'item:stock-general')).toHaveLength(2);
  });

  it('en secuencia, la segunda reserva que excede el disponible se rechaza', async () => {
    stockWith(10);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 8 });
    seedDemand(fake, { id: 'd2', caseId: 'case2', zohoItemId: ITEM, quantity: 5 });
    await reserve(seller, { quantity: 8 });
    const second = await reserve(seller, { caseId: 'case2', demandId: 'd2', quantity: 5 });
    expect(second).toMatchObject({ status: 'rejected', errorCode: 'insufficient_stock' });
    expect(stock().reserved.toString()).toBe('8');
  });

  it('repetir el mismo commandId (cola offline) devuelve el resultado guardado sin reservar dos veces', async () => {
    stockWith(10);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 8 });
    const first = await reserve(seller, { quantity: 8 }, { commandId: 'offline-1' });
    const repeated = await reserve(seller, { quantity: 8 }, { commandId: 'offline-1' });
    expect(first.status).toBe('completed');
    expect(repeated.replayed).toBe(true);
    expect(repeated.data).toEqual(first.data);
    expect(fake.rows('stockReservation')).toHaveLength(1);
    expect(stock().reserved.toString()).toBe('8');
  });

  it('reparte entre ubicaciones cuando ninguna alcanza sola', async () => {
    stockWith(4);
    seedLocation(fake, { id: 'loc-a', warehouseId, code: 'RACK-A' });
    seedStockItem(fake, {
      id: 'stock-a',
      zohoItemId: ITEM,
      warehouseId,
      locationId: 'loc-a',
      baseline: 7,
      lastCountedAt: NOW,
    });
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 9 });
    const result = await reserve(seller, { quantity: 9 });
    expect(result.status).toBe('completed');
    expect(
      (result.data as ReserveData).reservations.map((r) => [r.stockItemId, r.quantity])
    ).toEqual([
      ['stock-a', '7'],
      ['stock-general', '2'],
    ]);
  });

  it('PROVISIONAL: sin decisión explícita se rechaza; con decisión humana y conteo reciente se reserva como provisional', async () => {
    stockWith(10, { confidence: 'PROVISIONAL', consecutiveGoodCounts: 1 });
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 4 });

    const denied = await reserve(seller, { quantity: 4 });
    expect(denied).toMatchObject({ status: 'rejected', errorCode: 'provisional_not_allowed' });
    expect(fake.rows('stockReservation')).toHaveLength(0);

    const allowed = await reserve(seller, { quantity: 4, allowProvisional: true });
    expect(allowed.status).toBe('completed');
    expect(allowed.data).toMatchObject({ provisional: true, confidence: 'PROVISIONAL' });
    expect(fake.rows('stockReservation')[0].confidenceAtReserve).toBe('PROVISIONAL');
    expect(events('stock.reserved_provisional')).toHaveLength(1);
    expect(events('stock.reserved')).toHaveLength(0);
  });

  it('PROVISIONAL con verificación de más de 72 horas se rechaza aunque haya decisión', async () => {
    stockWith(10, { confidence: 'PROVISIONAL' }, new Date(NOW.getTime() - 100 * HOUR));
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 4 });
    const result = await reserve(seller, { quantity: 4, allowProvisional: true });
    expect(result).toMatchObject({
      status: 'rejected',
      errorCode: 'provisional_verification_stale',
    });
  });

  it('una IA no puede decidir reservar existencia provisional', async () => {
    stockWith(10, { confidence: 'PROVISIONAL' });
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 1 });
    const bot = seedUser(fake, { id: 'bot-inventario', isBot: true, permissions: ALL }).currentUser;
    const result = await executeCommand(
      {
        commandId: 'ai-reserve-1',
        type: INVENTORY_COMMANDS.reserve,
        actor: { type: 'ai', id: bot.id },
        aggregate: { type: 'case_demand', id: 'd1' },
        payload: {
          caseId: 'case1',
          demandId: 'd1',
          zohoItemId: ITEM,
          warehouseId,
          quantity: 1,
          allowProvisional: true,
        },
      },
      bot,
      { now: NOW }
    );
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'provisional_requires_human' });
  });

  it.each([
    ['UNCOUNTED', 'stock_uncounted'],
    ['DISPUTED', 'stock_disputed'],
  ])('existencia %s nunca se reserva', async (confidence, errorCode) => {
    stockWith(10, { confidence });
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 1 });
    const result = await reserve(manager, { quantity: 1, allowProvisional: true });
    expect(result).toMatchObject({ status: 'rejected', errorCode });
  });

  it('valida que la necesidad pertenezca al expediente y al artículo, y exige permiso', async () => {
    stockWith(10);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: 'otro-item', quantity: 1 });
    expect(await reserve(seller, { caseId: 'case9' })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_payload',
    });
    expect(await reserve(seller, {})).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_payload',
    });
    expect(await reserve(counter, {})).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });
  });
});

describe('reserveStock — a demand is never promised twice', () => {
  it('caps reservations at what the demand still needs, whatever the command id', async () => {
    stockWith(10);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 3 });

    const first = await reserve(seller, { quantity: 3 });
    const again = await reserve(seller, { quantity: 3 }); // double click, new commandId
    const extra = await reserve(seller, { quantity: 1 });

    expect(first.status).toBe('completed');
    expect(again).toMatchObject({ status: 'rejected', errorCode: 'demand_over_reserved' });
    expect(extra).toMatchObject({ status: 'rejected', errorCode: 'demand_over_reserved' });
    expect(fake.rows('stockReservation').filter((r) => r.status === 'active')).toHaveLength(1);
    expect(stock().reserved.toString()).toBe('3');
    expect(
      (await verifyAvailability(tx, { zohoItemId: ITEM, warehouseId })).available.toString()
    ).toBe('7');
  });

  it('caps an allocation at its own quantity and counts what was already delivered', async () => {
    stockWith(20);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 10 });
    fake.seed('demandAllocation', {
      id: 'a1',
      demandId: 'd1',
      caseId: 'case1',
      source: 'stock',
      quantity: 4,
    });

    const over = await reserve(seller, { allocationId: 'a1', quantity: 5 });
    expect(over).toMatchObject({ status: 'rejected', errorCode: 'demand_over_reserved' });
    const ok = await reserve(seller, { allocationId: 'a1', quantity: 4 });
    expect(ok.status).toBe('completed');
    const twice = await reserve(seller, { allocationId: 'a1', quantity: 1 });
    expect(twice).toMatchObject({ status: 'rejected', errorCode: 'demand_over_reserved' });

    // 6 of 10 delivered: only 0 remain beyond the 4 already reserved.
    const demand = fake.rows('caseDemand').find((d) => d.id === 'd1')!;
    demand.fulfilledQuantity = new (await import('@prisma/client')).Prisma.Decimal(6);
    const afterDelivery = await reserve(seller, { quantity: 1 });
    expect(afterDelivery).toMatchObject({ status: 'rejected', errorCode: 'demand_over_reserved' });
  });

  it('rejects a demand whose unit does not convert to the base unit of the item', async () => {
    stockWith(10);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 3, unit: 'rollo' });
    const result = await reserve(seller, { quantity: 1 });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'invalid_unit' });
    expect(fake.rows('stockReservation')).toHaveLength(0);
  });
});

describe('releaseReservation / consumeReservation', () => {
  it('consumir parcialmente registra la salida; liberar regresa el disponible y no se libera dos veces', async () => {
    stockWith(10);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 8 });
    const reserved = await reserve(seller, { quantity: 8 });
    const reservationId = (reserved.data as ReserveData).primaryReservationId;

    const partial = await consumeStockReservation(
      manager,
      { reservationId, quantity: 5, referenceType: 'delivery_order', referenceId: 'DO-1' },
      { now: NOW }
    );
    expect(partial.status).toBe('completed');
    const reservation = fake.rows('stockReservation')[0];
    expect(reservation).toMatchObject({ status: 'active' });
    expect(reservation.quantity.toString()).toBe('3');
    expect(stock().issued.toString()).toBe('5');
    expect(stock().reserved.toString()).toBe('3');
    expect(stock().knownQty.toString()).toBe('5');
    expect(fake.rows('stockMovement')[0]).toMatchObject({
      kind: 'issue',
      referenceType: 'delivery_order',
      referenceId: 'DO-1',
    });
    expect(events('stock.reservation_consumed')).toHaveLength(1);

    const released = await releaseStockReservation(
      seller,
      { reservationId, reason: 'Cambio de pedido' },
      { now: NOW }
    );
    expect(released.status).toBe('completed');
    expect(fake.rows('stockReservation')[0]).toMatchObject({ status: 'released', releasedAt: NOW });
    expect(stock().reserved.toString()).toBe('0');
    expect(
      (await verifyAvailability(tx, { zohoItemId: ITEM, warehouseId })).available.toString()
    ).toBe('5');

    const again = await releaseStockReservation(seller, { reservationId }, { now: NOW });
    expect(again).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
  });

  it('consumir la reserva completa la marca consumida', async () => {
    stockWith(10);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 4 });
    const reserved = await reserve(seller, { quantity: 4 });
    const reservationId = (reserved.data as ReserveData).primaryReservationId;
    const result = await consumeStockReservation(manager, { reservationId }, { now: NOW });
    expect(result.status).toBe('completed');
    expect(fake.rows('stockReservation')[0].status).toBe('consumed');
    expect(stock().reserved.toString()).toBe('0');
    expect(stock().knownQty.toString()).toBe('6');
    expect(await consumeStockReservation(manager, { reservationId }, { now: NOW })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
    });
  });
});

describe('recordInventoryMovement', () => {
  it('traspaso: salida y entrada bajo un solo comando con la misma referencia', async () => {
    stockWith(10);
    seedLocation(fake, { id: 'loc-rack-a', warehouseId, code: 'RACK-A' });

    const result = await moveStock(
      manager,
      {
        kind: 'transfer',
        zohoItemId: ITEM,
        fromWarehouseId: warehouseId,
        fromStockItemId: 'stock-general',
        toWarehouseId: warehouseId,
        toLocationCode: 'rack-a',
        quantity: 4,
      },
      { now: NOW, commandId: 'transfer-1' }
    );

    expect(result.status).toBe('completed');
    const destination = fake.rows('stockItem').find((row) => row.locationId === 'loc-rack-a')!;
    expect(stock().knownQty.toString()).toBe('6');
    expect(destination.knownQty.toString()).toBe('4');
    const movements = fake.rows('stockMovement');
    expect(movements.map((m) => m.kind).sort()).toEqual(['transfer_in', 'transfer_out']);
    expect(
      movements.every((m) => m.referenceType === 'stock_transfer' && m.referenceId === 'transfer-1')
    ).toBe(true);
    expect(movements.every((m) => m.commandId === 'transfer-1')).toBe(true);
    expect(events('stock.transferred')).toHaveLength(1);
    expect((result.data as MoveData).movements).toHaveLength(2);
  });

  it('no traspasa existencia controlada comprometida en reservas', async () => {
    stockWith(10);
    seedLocation(fake, { id: 'loc-rack-a', warehouseId, code: 'RACK-A' });
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 8 });
    await reserve(seller, { quantity: 8 });
    const result = await moveStock(
      manager,
      {
        kind: 'transfer',
        zohoItemId: ITEM,
        fromWarehouseId: warehouseId,
        toWarehouseId: warehouseId,
        toLocationId: 'loc-rack-a',
        quantity: 4,
      },
      { now: NOW }
    );
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'insufficient_stock' });
    expect(stock().knownQty.toString()).toBe('10');
    expect(fake.rows('stockMovement')).toHaveLength(0);
  });

  it('un contenedor se traspasa completo', async () => {
    seedProfile(fake, {
      zohoItemId: ITEM,
      baseUnit: 'm2',
      confidence: 'CONTROLLED',
      trackingPolicy: 'roll',
    });
    seedLocation(fake, { id: 'loc-rack-a', warehouseId, code: 'RACK-A' });
    seedStockItem(fake, {
      id: 'roll-1',
      zohoItemId: ITEM,
      warehouseId,
      locationId: generalId,
      containerKey: 'RL-000001',
      baseline: 30,
    });
    const partial = await moveStock(
      manager,
      {
        kind: 'transfer',
        zohoItemId: ITEM,
        fromWarehouseId: warehouseId,
        fromStockItemId: 'roll-1',
        toWarehouseId: warehouseId,
        toLocationId: 'loc-rack-a',
        quantity: 10,
      },
      { now: NOW }
    );
    expect(partial).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
    const whole = await moveStock(
      manager,
      {
        kind: 'transfer',
        zohoItemId: ITEM,
        fromWarehouseId: warehouseId,
        fromStockItemId: 'roll-1',
        toWarehouseId: warehouseId,
        toLocationId: 'loc-rack-a',
        quantity: 30,
      },
      { now: NOW }
    );
    expect(whole.status).toBe('completed');
    expect(fake.rows('stockItem').find((r) => r.locationId === 'loc-rack-a')).toMatchObject({
      containerKey: 'RL-000001',
    });
  });

  it('una entrada en cajas se convierte a la unidad base y la salida controlada no excede el disponible', async () => {
    stockWith(10);
    const receipt = await moveStock(
      manager,
      {
        kind: 'receipt',
        zohoItemId: ITEM,
        warehouseId,
        quantity: 3,
        unit: 'Cajas',
        referenceType: 'purchase_receipt',
        referenceId: 'RC-1',
      },
      { now: NOW }
    );
    expect(receipt.status).toBe('completed');
    expect(stock().knownQty.toString()).toBe('14.32');
    expect(stock().receipts.toString()).toBe('4.32');
    const movement = fake.rows('stockMovement')[0];
    expect(movement.quantity.toString()).toBe('4.32');
    expect(movement.originalQuantity.toString()).toBe('3');
    expect(movement.originalUnit).toBe('caja');
    expect(events('stock.received')).toHaveLength(1);

    const tooMuch = await moveStock(
      manager,
      { kind: 'issue', zohoItemId: ITEM, warehouseId, quantity: 15 },
      { now: NOW }
    );
    expect(tooMuch).toMatchObject({ status: 'rejected', errorCode: 'insufficient_stock' });
    const exact = await moveStock(
      manager,
      { kind: 'issue', zohoItemId: ITEM, warehouseId, quantity: '14.32' },
      { now: NOW }
    );
    expect(exact.status).toBe('completed');
    expect(stock().knownQty.toString()).toBe('0');
  });

  it('una unidad sin conversión se rechaza', async () => {
    stockWith(10);
    const result = await moveStock(
      manager,
      { kind: 'receipt', zohoItemId: ITEM, warehouseId, quantity: 1, unit: 'tarima' },
      { now: NOW }
    );
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'invalid_unit' });
  });

  it('una salida de existencia no controlada puede dejar negativo, pero abre incidencia', async () => {
    stockWith(2, { confidence: 'PROVISIONAL' });
    const result = await moveStock(
      manager,
      { kind: 'issue', zohoItemId: ITEM, warehouseId, quantity: 5 },
      { now: NOW }
    );
    expect(result.status).toBe('completed');
    expect(stock().knownQty.toString()).toBe('-3');
    expect(fake.rows('incident')).toEqual([
      expect.objectContaining({
        kind: 'stock_conflict',
        areaKey: 'inventario',
        severity: 'medium',
      }),
    ]);
    expect(events('stock.negative')).toHaveLength(1);
  });

  it('una salida sin reserva de existencia no controlada que deja reservas sin cobertura abre incidencia alta', async () => {
    stockWith(10, { confidence: 'PROVISIONAL' });
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 10 });
    const reserved = await reserve(manager, { quantity: 10, allowProvisional: true });
    expect(reserved.status).toBe('completed');

    const issue = await moveStock(
      seller.id === 'seller' ? manager : manager,
      { kind: 'issue', zohoItemId: ITEM, warehouseId, quantity: 10 },
      { now: NOW }
    );
    expect(issue.status).toBe('completed');
    expect(stock().knownQty.toString()).toBe('0');
    expect(fake.rows('incident')).toEqual([
      expect.objectContaining({
        kind: 'stock_conflict',
        severity: 'high',
        title: expect.stringContaining('Reservas sin cobertura'),
      }),
    ]);
  });

  it('la merma no se puede traspasar a una ubicación disponible', async () => {
    seedProfile(fake, {
      zohoItemId: ITEM,
      baseUnit: 'm2',
      confidence: 'CONTROLLED',
      consecutiveGoodCounts: 2,
    });
    const produced = await moveStock(
      manager,
      { kind: 'produce', zohoItemId: ITEM, warehouseId, locationCode: 'SCRAP', quantity: 5 },
      { now: NOW }
    );
    expect(produced.status).toBe('completed');
    const unblock = await unblockStockQuantity(
      manager,
      {
        stockItemId: fake.rows('stockItem')[0].id as string,
        quantity: 5,
        reason: 'Intento',
      },
      { now: NOW }
    );
    expect(unblock).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });

    const transfer = await moveStock(
      manager,
      {
        kind: 'transfer',
        zohoItemId: ITEM,
        fromWarehouseId: warehouseId,
        fromLocationCode: 'SCRAP',
        toWarehouseId: warehouseId,
        toLocationCode: 'GENERAL',
        quantity: 5,
      },
      { now: NOW }
    );
    expect(transfer).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
    expect(
      (await verifyAvailability(tx, { zohoItemId: ITEM, warehouseId })).available.toString()
    ).toBe('0');
  });

  it('bloquear resta del disponible sin cambiar el conocido; ajustar exige permiso y nunca deja negativo', async () => {
    stockWith(10);
    const blocked = await blockStockQuantity(
      manager,
      { stockItemId: 'stock-general', quantity: 3, reason: 'Piezas dañadas' },
      { now: NOW }
    );
    expect(blocked.status).toBe('completed');
    expect(stock().blocked.toString()).toBe('3');
    expect(stock().knownQty.toString()).toBe('10');
    expect(
      (await verifyAvailability(tx, { zohoItemId: ITEM, warehouseId })).available.toString()
    ).toBe('7');

    const overUnblock = await unblockStockQuantity(
      manager,
      { stockItemId: 'stock-general', quantity: 5, reason: 'Revisado' },
      { now: NOW }
    );
    expect(overUnblock).toMatchObject({ status: 'rejected', errorCode: 'invalid_quantity' });

    const forbidden = await adjustStock(
      counter,
      { zohoItemId: ITEM, warehouseId, quantity: -2, reason: 'Rotura' },
      { now: NOW }
    );
    expect(forbidden).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });

    const adjusted = await adjustStock(
      manager,
      { zohoItemId: ITEM, warehouseId, quantity: -2, reason: 'Rotura' },
      { now: NOW }
    );
    expect(adjusted.status).toBe('completed');
    expect(stock().knownQty.toString()).toBe('8');
    expect(
      fake
        .rows('stockMovement')
        .find((m) => m.kind === 'adjust')
        ?.quantity.toString()
    ).toBe('-2');

    const negative = await adjustStock(
      manager,
      { zohoItemId: ITEM, warehouseId, quantity: -20, reason: 'Error' },
      { now: NOW }
    );
    expect(negative).toMatchObject({ status: 'rejected', errorCode: 'negative_stock' });
  });

  it('producción: el sobrante con medidas crea un contenedor CT- trazable y la merma queda bloqueada', async () => {
    seedProfile(fake, {
      zohoItemId: ITEM,
      baseUnit: 'm2',
      confidence: 'CONTROLLED',
      consecutiveGoodCounts: 2,
    });
    const leftover = await moveStock(
      manager,
      {
        kind: 'produce',
        zohoItemId: ITEM,
        warehouseId,
        quantity: '0.8',
        originProductionOrderId: 'OP-000001',
        dimensions: { largo: 120, ancho: 60, unidad: 'cm' },
        referenceType: 'production_order',
        referenceId: 'OP-000001',
      },
      { now: NOW }
    );
    expect(leftover.status).toBe('completed');
    expect((leftover.data as MoveData).containerKey).toBe('CT-000001');
    const leftoverRow = fake.rows('stockItem').find((row) => row.containerKey === 'CT-000001')!;
    expect(leftoverRow).toMatchObject({
      originProductionOrderId: 'OP-000001',
      dimensions: { largo: 120, ancho: 60, unidad: 'cm' },
    });
    expect(events('stock.container_created')).toHaveLength(1);

    const scrap = await moveStock(
      manager,
      {
        kind: 'produce',
        zohoItemId: ITEM,
        warehouseId,
        locationCode: 'SCRAP',
        quantity: '0.2',
        referenceType: 'production_order',
        referenceId: 'OP-000001',
      },
      { now: NOW }
    );
    expect(scrap.status).toBe('completed');
    const scrapLocation = fake.rows('storageLocation').find((l) => l.code === 'SCRAP')!;
    const scrapRow = fake.rows('stockItem').find((row) => row.locationId === scrapLocation.id)!;
    expect(scrapRow.blocked.toString()).toBe('0.2');

    const availability = await verifyAvailability(tx, { zohoItemId: ITEM, warehouseId });
    expect(availability.known.toString()).toBe('0.8');
    expect(availability.available.toString()).toBe('0.8');
  });
});

describe('verifyAvailability / getStockSnapshot', () => {
  it('suma ubicaciones, calcula faltante y muestra Zoho sólo como dato informativo', async () => {
    stockWith(10);
    seedLocation(fake, { id: 'loc-a', warehouseId, code: 'RACK-A' });
    seedStockItem(fake, {
      id: 'stock-a',
      zohoItemId: ITEM,
      warehouseId,
      locationId: 'loc-a',
      baseline: 5,
      reserved: 2,
    });

    const availability = await verifyAvailability(tx, {
      zohoItemId: ITEM,
      warehouseId,
      quantityBase: 14,
    });
    expect(availability).toMatchObject({
      confidence: 'CONTROLLED',
      canPromise: false,
      requiresCount: false,
      baseUnit: 'm2',
    });
    expect(availability.known.toString()).toBe('15');
    expect(availability.available.toString()).toBe('13');
    expect(availability.shortfall.toString()).toBe('1');
    expect(availability.zoho?.stockOnHand?.toString()).toBe('999');
    expect(availability.items).toHaveLength(2);

    const snapshot = await getStockSnapshot({ warehouseId });
    expect(snapshot.products).toHaveLength(1);
    expect(snapshot.products[0]).toMatchObject({
      zohoItemId: ITEM,
      productName: 'Loseta Perla 60x60',
      confidence: 'CONTROLLED',
      totals: { known: '15', reserved: '2', available: '13', legacyClaims: '0' },
      zoho: { stockOnHand: '999', availableStock: '999' },
    });
    expect(snapshot.products[0].items.map((i) => i.locationCode).sort()).toEqual([
      'GENERAL',
      'RACK-A',
    ]);
  });

  it('un artículo sin perfil se reporta como UNCOUNTED y requiere conteo', async () => {
    const availability = await verifyAvailability(tx, { zohoItemId: ITEM, quantityBase: 1 });
    expect(availability).toMatchObject({
      confidence: 'UNCOUNTED',
      profileExists: false,
      requiresCount: true,
      canPromise: false,
    });
    expect(availability.shortfall.toString()).toBe('1');
    await expect(getStockSnapshot({})).rejects.toMatchObject({ code: 'invalid_payload' });
  });
});
