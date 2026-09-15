import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * recordSalesOrderChange returns the id of the change event it records, or
 * null when nothing is recorded (first import, no changes, repeated snapshot).
 */

const { db, notifyUser } = await vi.hoisted(async () => {
  const { FakePrisma } = await import('../comms/testing/fake-prisma');
  return {
    db: new FakePrisma({ uniques: { entityChangeEvent: [['sourceSnapshotId']] } }),
    notifyUser: vi.fn(async () => ({ id: 'n1', inApp: true, push: false, suppressed: false })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: db.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser }));
vi.mock('./entity-watch-service', () => ({ getActiveWatchers: vi.fn(async () => []) }));

import {
  recordSalesOrderChange,
  SALES_ORDER_ENTITY_TYPE,
  type ItemSnapshot,
  type SalesOrderSnapshot,
} from './sales-orders-change-events';

const tx = db.client as unknown as Prisma.TransactionClient;

function order(overrides: Partial<SalesOrderSnapshot> = {}): SalesOrderSnapshot {
  return {
    id: 'so1',
    status: 'confirmed',
    subStatus: null,
    paidStatus: 'unpaid',
    invoicedStatus: null,
    shippedStatus: 'pending',
    customerName: 'Cliente Uno',
    customerPhone: null,
    salespersonName: null,
    paymentMethod: null,
    deliveryMethod: null,
    locationName: 'Bodega Norte',
    branchName: null,
    shippingAddressLine1: null,
    shippingCity: null,
    shippingState: null,
    shippingPostalCode: null,
    subtotal: new Prisma.Decimal('100'),
    discountTotal: null,
    taxTotal: new Prisma.Decimal('16'),
    shippingCharge: null,
    adjustment: null,
    total: new Prisma.Decimal('116'),
    balance: new Prisma.Decimal('116'),
    saleMadeInWarehouse: false,
    ...overrides,
  };
}

function item(overrides: Partial<ItemSnapshot> = {}): ItemSnapshot {
  return {
    zohoLineItemId: 'li1',
    zohoItemId: 'it1',
    sku: 'SKU-1',
    name: 'Lámina',
    quantity: new Prisma.Decimal('2'),
    rate: new Prisma.Decimal('50'),
    discountAmount: null,
    taxPercentage: new Prisma.Decimal('16'),
    lineTotal: new Prisma.Decimal('100'),
    ...overrides,
  };
}

function record(
  snapshotId: string,
  before: SalesOrderSnapshot | null,
  after: SalesOrderSnapshot,
  items: { before?: ItemSnapshot[]; after?: ItemSnapshot[] } = {}
) {
  return recordSalesOrderChange(
    tx,
    'so1',
    'SO-0001',
    snapshotId,
    new Date('2026-09-01T10:00:00Z'),
    before,
    before ? (items.before ?? [item()]) : [],
    after,
    items.after ?? [item()]
  );
}

beforeEach(() => {
  db.tables.clear();
  notifyUser.mockClear();
});

describe('recordSalesOrderChange', () => {
  it('primera importación: devuelve null y no crea evento', async () => {
    const id = await record('snap-1', null, order());

    expect(id).toBeNull();
    expect(db.rows('entityChangeEvent')).toHaveLength(0);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('cambio real: devuelve el id del evento y notifica a los observadores activos', async () => {
    db.seed('entityWatch', {
      entityType: SALES_ORDER_ENTITY_TYPE,
      entityId: 'so1',
      userId: 'u1',
      isActive: true,
    });
    db.seed('entityWatch', {
      entityType: SALES_ORDER_ENTITY_TYPE,
      entityId: 'so1',
      userId: 'u2',
      isActive: false,
    });

    const id = await record('snap-2', order(), order({ shippedStatus: 'fulfilled' }));

    const events = db.rows('entityChangeEvent');
    expect(events).toHaveLength(1);
    expect(id).toBe(events[0].id);
    expect(events[0]).toMatchObject({
      entityType: SALES_ORDER_ENTITY_TYPE,
      entityId: 'so1',
      sourceSnapshotId: 'snap-2',
      changes: { fields: { shippedStatus: { before: 'pending', after: 'fulfilled' } } },
    });
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        tx,
        userId: 'u1',
        changeEventId: id,
        dedupeKey: `change:${id}:u1`,
      })
    );
  });

  it('cambio sin observadores: también devuelve el id', async () => {
    const id = await record('snap-3', order(), order({ total: new Prisma.Decimal('120') }));

    expect(id).not.toBeNull();
    expect(db.rows('entityChangeEvent')[0].id).toBe(id);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('cambio sólo en partidas: devuelve el id', async () => {
    const id = await record('snap-4', order(), order(), {
      after: [item({ quantity: new Prisma.Decimal('3') })],
    });

    expect(id).not.toBeNull();
    expect(db.rows('entityChangeEvent')[0].changes).toEqual({
      items: {
        added: [],
        removed: [],
        modified: { li1: { quantity: { before: '2', after: '3' } } },
      },
    });
  });

  it('snapshot repetido: devuelve null y no duplica el evento', async () => {
    const first = await record('snap-5', order(), order({ status: 'closed' }));
    const second = await record('snap-5', order(), order({ status: 'closed' }));

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(db.rows('entityChangeEvent')).toHaveLength(1);
  });

  it('sin cambios significativos: devuelve null', async () => {
    const id = await record('snap-6', order(), order({ total: new Prisma.Decimal('116.00') }));

    expect(id).toBeNull();
    expect(db.rows('entityChangeEvent')).toHaveLength(0);
  });
});
