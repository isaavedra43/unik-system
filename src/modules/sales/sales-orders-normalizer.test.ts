import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * Characterization tests for the Zoho sales order normalizer (plan Entrega 0). They pin the
 * current behaviour before the Operations hook touches this file: snapshot → SalesOrder /
 * SalesOrderItem mapping, snapshot bookkeeping, stale-snapshot skip, item replacement, the
 * recorded change event id and the batch summary.
 */

const { db, notifyUser } = await vi.hoisted(async () => {
  const { FakePrisma } = await import('../comms/testing/fake-prisma');
  return {
    db: new FakePrisma({
      uniques: {
        salesOrder: [['zohoSalesOrderId']],
        entityChangeEvent: [['sourceSnapshotId']],
      },
    }),
    notifyUser: vi.fn(async () => ({ id: 'n1', inApp: true, push: false, suppressed: false })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: db.client }));

/** Savepoints of the Operations hooks (FakePrisma has no SQL): recorded, always accepted. */
const savepoints: string[] = [];
db.onRaw((query) => {
  if (/SAVEPOINT/.test(query.sql)) {
    savepoints.push(query.sql);
    return 0;
  }
  throw new Error(`SQL inesperado en la prueba: ${query.sql}`);
});
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser }));
vi.mock('./entity-watch-service', () => ({ getActiveWatchers: vi.fn(async () => []) }));

import {
  NORMALIZATION_ERROR_CODE,
  NormalizationAlreadyRunningError,
  normalizePendingSalesOrderSnapshots,
  normalizeSalesOrderSnapshot,
} from './sales-orders-normalizer';
import { SALES_ORDER_ENTITY_TYPE } from './sales-orders-change-events';

type SnapshotInput = Parameters<typeof normalizeSalesOrderSnapshot>[0];
type Row = Record<string, unknown>;

const NORMALIZER_VERSION = 2;
const STATE_KEY = '__unikZohoSalesOrdersNormalizerState';
const REMOTE_AT = new Date('2026-09-01T16:00:00.000Z');

function zohoOrder(overrides: Row = {}): Row {
  return {
    salesorder_id: 'zso-1',
    salesorder_number: 'SO-0001',
    reference_number: 'REF-9',
    date: '2026-09-01',
    created_time: '2026-09-01T09:30:00.000Z',
    order_status: 'confirmed',
    current_sub_status: 'cs_listo',
    paid_status: 'unpaid',
    invoiced_status: 'not_invoiced',
    shipped_status: 'pending',
    customer_id: 'zc-1',
    customer_name: 'Cliente Uno',
    contact_person_details: [
      { phone: '', mobile: '5550001111', email: '' },
      { phone: null, mobile: null, email: 'compras@cliente.mx' },
    ],
    salesperson_id: 'sp-1',
    salesperson_name: 'Vendedora Uno',
    payment_terms_label: 'Contado',
    delivery_method: null,
    delivery_method_id: 'dm-1',
    location_id: 'loc-1',
    location_name: 'Bodega Norte',
    branch_id: 'br-1',
    branch_name: 'Matriz',
    shipping_address: {
      attention: 'Recibe Juan',
      address: 'RECOGE EN BODEGA',
      street2: 'Int 2',
      city: 'Monterrey',
      state: 'NL',
      zip: '64000',
      country: 'México',
      phone: '8110000000',
    },
    currency_code: 'MXN',
    sub_total: 1000.5,
    discount_total: 0,
    tax_total: 160.08,
    shipping_charge: 50,
    adjustment: -0.58,
    total: 1210,
    balance: 1210,
    notes: 'Entregar por la tarde',
    custom_field_hash: {
      cf_la_venta_se_realizo_en_alma_unformatted: 'true',
      cf_la_venta_se_realizo_en_alma: 'No',
    },
    line_items: [
      {
        line_item_id: 'li-1',
        item_id: 'it-1',
        sku: 'LAM-01',
        name: null,
        item_name: 'Lámina galvanizada',
        description: 'Cal. 26',
        quantity: 10,
        unit: 'pza',
        rate: 100.05,
        discount_amount: 0,
        tax_name: 'IVA',
        tax_percentage: '16',
        tax_amount: 999,
        line_item_taxes: [
          { tax_name: 'IVA', tax_amount: 150.08 },
          { tax_name: 'IEPS', tax_amount: 10 },
        ],
        item_total: 1000.5,
        item_order: 3,
        location_id: 'loc-1',
        location_name: 'Bodega Norte',
      },
      {
        line_item_id: 'li-2',
        item_id: 'it-2',
        sku: 'TOR-01',
        name: 'Tornillo',
        quantity: 5,
        rate: 0,
        tax_amount: 0,
        item_total: 0,
      },
    ],
    ...overrides,
  };
}

function seedSnapshot(id: string, payload: unknown, overrides: Row = {}): Row {
  return db.seed('integrationSnapshot', {
    id,
    source: 'zoho',
    entityType: 'sales_order',
    externalId: 'zso-1',
    remoteModifiedAt: REMOTE_AT,
    normalizationVersion: 0,
    normalizedAt: null,
    normalizationErrorCode: null,
    payload,
    createdAt: new Date('2026-09-01T16:00:05.000Z'),
    ...overrides,
  });
}

function snapshot(id: string): Row {
  const row = db.rows('integrationSnapshot').find((r) => r.id === id);
  if (!row) throw new Error(`snapshot ${id} not seeded`);
  return row;
}

function input(id: string): SnapshotInput {
  const row = snapshot(id);
  return {
    id: row.id as string,
    source: row.source as string,
    entityType: row.entityType as string,
    externalId: row.externalId as string,
    remoteModifiedAt: row.remoteModifiedAt as Date,
    normalizationVersion: row.normalizationVersion as number,
    payload: row.payload as Prisma.JsonValue,
  };
}

function itemsByOrder(): Row[] {
  return [...db.rows('salesOrderItem')].sort(
    (a, b) => (a.sortOrder as number) - (b.sortOrder as number)
  );
}

function str(value: unknown): string | null {
  return value instanceof Prisma.Decimal ? value.toString() : (value as null);
}

let info: MockInstance<(...args: unknown[]) => void>;

function logged(event: string): Row[] {
  return info.mock.calls
    .map(([line]) => JSON.parse(String(line)) as Row)
    .filter((entry) => entry.event === event);
}

beforeEach(() => {
  db.tables.clear();
  notifyUser.mockClear();
  (globalThis as Row)[STATE_KEY] = { batchInProgress: false };
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
});

describe('normalizeSalesOrderSnapshot', () => {
  it('primera importación (forma directa): mapea la orden, sus partidas y marca el snapshot', async () => {
    seedSnapshot('snap-1', zohoOrder());

    const result = await normalizeSalesOrderSnapshot(input('snap-1'));

    const orders = db.rows('salesOrder');
    expect(orders).toHaveLength(1);
    const [order] = orders;
    expect(result).toEqual({ salesOrderId: order.id, status: 'normalized' });
    expect(order).toMatchObject({
      zohoSalesOrderId: 'zso-1',
      salesOrderNumber: 'SO-0001',
      referenceNumber: 'REF-9',
      orderDate: new Date('2026-09-01T00:00:00.000Z'),
      createdTime: new Date('2026-09-01T09:30:00.000Z'),
      status: 'confirmed',
      subStatus: 'cs_listo',
      paidStatus: 'unpaid',
      invoicedStatus: 'not_invoiced',
      shippedStatus: 'pending',
      zohoCustomerId: 'zc-1',
      customerName: 'Cliente Uno',
      // First non-empty phone, falling back to the first non-empty mobile; first non-empty email.
      customerPhone: '5550001111',
      customerEmail: 'compras@cliente.mx',
      zohoSalespersonId: 'sp-1',
      salespersonName: 'Vendedora Uno',
      paymentMethod: 'Contado',
      // Without delivery_method the shipping address line is used as delivery instruction.
      deliveryMethod: 'RECOGE EN BODEGA',
      deliveryMethodId: 'dm-1',
      locationId: 'loc-1',
      locationName: 'Bodega Norte',
      branchId: 'br-1',
      branchName: 'Matriz',
      shippingAttention: 'Recibe Juan',
      shippingAddressLine1: 'RECOGE EN BODEGA',
      shippingAddressLine2: 'Int 2',
      shippingCity: 'Monterrey',
      shippingState: 'NL',
      shippingPostalCode: '64000',
      shippingCountry: 'México',
      shippingPhone: '8110000000',
      currencyCode: 'MXN',
      notes: 'Entregar por la tarde',
      // The unformatted custom field wins over the formatted one.
      saleMadeInWarehouse: true,
      sourceRemoteModifiedAt: REMOTE_AT,
      sourceSnapshotId: 'snap-1',
    });
    expect(order.normalizedAt).toBeInstanceOf(Date);
    expect({
      subtotal: str(order.subtotal),
      discountTotal: str(order.discountTotal),
      taxTotal: str(order.taxTotal),
      shippingCharge: str(order.shippingCharge),
      adjustment: str(order.adjustment),
      total: str(order.total),
      balance: str(order.balance),
    }).toEqual({
      subtotal: '1000.5',
      discountTotal: '0',
      taxTotal: '160.08',
      shippingCharge: '50',
      adjustment: '-0.58',
      total: '1210',
      balance: '1210',
    });

    const items = itemsByOrder();
    expect(items).toHaveLength(2);
    expect(items.every((row) => row.salesOrderId === order.id)).toBe(true);
    expect(items[0]).toMatchObject({
      zohoLineItemId: 'li-2',
      zohoItemId: 'it-2',
      name: 'Tornillo',
      // Without item_order the position (index + 1) is used.
      sortOrder: 2,
      unit: null,
      locationId: null,
    });
    expect(items[1]).toMatchObject({
      zohoLineItemId: 'li-1',
      zohoItemId: 'it-1',
      sku: 'LAM-01',
      // name falls back to item_name.
      name: 'Lámina galvanizada',
      description: 'Cal. 26',
      unit: 'pza',
      taxName: 'IVA',
      sortOrder: 3,
      locationId: 'loc-1',
      locationName: 'Bodega Norte',
    });
    expect({
      quantity: str(items[1].quantity),
      rate: str(items[1].rate),
      discountAmount: str(items[1].discountAmount),
      taxPercentage: str(items[1].taxPercentage),
      // line_item_taxes are summed and win over tax_amount.
      taxAmount: str(items[1].taxAmount),
      lineTotal: str(items[1].lineTotal),
    }).toEqual({
      quantity: '10',
      rate: '100.05',
      discountAmount: '0',
      taxPercentage: '16',
      taxAmount: '160.08',
      lineTotal: '1000.5',
    });
    expect({
      taxAmount: str(items[0].taxAmount),
      discountAmount: str(items[0].discountAmount),
      taxPercentage: str(items[0].taxPercentage),
    }).toEqual({ taxAmount: '0', discountAmount: null, taxPercentage: null });

    expect(snapshot('snap-1')).toMatchObject({
      normalizationVersion: NORMALIZER_VERSION,
      normalizationErrorCode: null,
    });
    expect(snapshot('snap-1').normalizedAt).toBeInstanceOf(Date);
    expect(db.rows('entityChangeEvent')).toHaveLength(0);
    expect(logged('zoho.sales_orders.normalization.completed')).toEqual([
      {
        event: 'zoho.sales_orders.normalization.completed',
        snapshotId: 'snap-1',
        externalId: 'zso-1',
        normalizerVersion: NORMALIZER_VERSION,
        salesOrderId: order.id,
        changeEventId: null,
      },
    ]);
  });

  it('acepta el envoltorio de la API de Zoho ({ code: 0, salesorder })', async () => {
    seedSnapshot('snap-w', { code: 0, message: 'success', salesorder: zohoOrder() });

    const result = await normalizeSalesOrderSnapshot(input('snap-w'));

    expect(result.status).toBe('normalized');
    expect(db.rows('salesOrder')).toHaveLength(1);
    expect(db.rows('salesOrder')[0]).toMatchObject({
      zohoSalesOrderId: 'zso-1',
      sourceSnapshotId: 'snap-w',
    });
    expect(db.rows('salesOrderItem')).toHaveLength(2);
  });

  it('tolera campos ausentes o con formato inválido dejándolos en null', async () => {
    seedSnapshot(
      'snap-t',
      zohoOrder({
        date: '01/09/2026',
        created_time: 'no-es-fecha',
        delivery_method: 'Paquetería',
        shipping_address: undefined,
        contact_person_details: [],
        custom_field_hash: { cf_la_venta_se_realizo_en_alma: 'No' },
        total: undefined,
        line_items: null,
      })
    );

    await normalizeSalesOrderSnapshot(input('snap-t'));

    const [order] = db.rows('salesOrder');
    expect(order).toMatchObject({
      orderDate: null,
      createdTime: null,
      deliveryMethod: 'Paquetería',
      shippingAddressLine1: null,
      shippingCity: null,
      customerPhone: null,
      customerEmail: null,
      // Falls back to the formatted custom field.
      saleMadeInWarehouse: false,
      total: null,
    });
    expect(db.rows('salesOrderItem')).toHaveLength(0);
  });

  it.each([
    ['envoltorio con código de error', { code: 1001, message: 'Invalid' }],
    ['envoltorio sin salesorder', { code: 0, message: 'success' }],
    ['objeto sin salesorder_id', { salesorder_number: 'SO-0001' }],
    ['arreglo en lugar de objeto', ['zso-1']],
    ['salesorder_id con tipos inválidos', zohoOrder({ total: 'mil' })],
  ])(
    'forma inválida (%s): marca el snapshot como fallido y no escribe la orden',
    async (_, payload) => {
      seedSnapshot('snap-bad', payload, { normalizationVersion: 1 });

      await expect(normalizeSalesOrderSnapshot(input('snap-bad'))).rejects.toMatchObject({
        name: 'NormalizationError',
        errorCode: NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
        snapshotId: 'snap-bad',
      });

      expect(snapshot('snap-bad')).toMatchObject({
        normalizedAt: null,
        normalizationVersion: 1,
        normalizationErrorCode: NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
      });
      expect(db.rows('salesOrder')).toHaveLength(0);
      expect(logged('zoho.sales_orders.normalization.failed')).toEqual([
        {
          event: 'zoho.sales_orders.normalization.failed',
          snapshotId: 'snap-bad',
          externalId: 'zso-1',
          normalizerVersion: NORMALIZER_VERSION,
          errorCode: NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
        },
      ]);
    }
  );

  it('snapshot de otra fuente o entidad: falla sin tocar la orden', async () => {
    seedSnapshot('snap-inv', zohoOrder(), { entityType: 'invoice' });

    await expect(normalizeSalesOrderSnapshot(input('snap-inv'))).rejects.toMatchObject({
      errorCode: NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
    });

    expect(snapshot('snap-inv').normalizationErrorCode).toBe(
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID
    );
    expect(db.rows('salesOrder')).toHaveLength(0);
  });

  it('snapshot más viejo que la orden guardada: se omite pero queda procesado', async () => {
    seedSnapshot('snap-1', zohoOrder());
    const first = await normalizeSalesOrderSnapshot(input('snap-1'));
    seedSnapshot('snap-old', zohoOrder({ order_status: 'closed' }), {
      remoteModifiedAt: new Date('2026-09-01T15:00:00.000Z'),
    });

    const result = await normalizeSalesOrderSnapshot(input('snap-old'));

    expect(result).toEqual({ salesOrderId: first.salesOrderId, status: 'skipped' });
    expect(db.rows('salesOrder')[0]).toMatchObject({
      status: 'confirmed',
      sourceSnapshotId: 'snap-1',
    });
    expect(snapshot('snap-old')).toMatchObject({
      normalizationVersion: NORMALIZER_VERSION,
      normalizationErrorCode: null,
    });
    expect(snapshot('snap-old').normalizedAt).toBeInstanceOf(Date);
    expect(db.rows('entityChangeEvent')).toHaveLength(0);
  });

  it('reimportación con cambios: reemplaza partidas, registra el evento y devuelve su id en el log', async () => {
    seedSnapshot('snap-1', zohoOrder());
    const first = await normalizeSalesOrderSnapshot(input('snap-1'));
    db.seed('entityWatch', {
      entityType: SALES_ORDER_ENTITY_TYPE,
      entityId: first.salesOrderId,
      userId: 'u1',
      isActive: true,
    });
    const [firstItem] = (zohoOrder().line_items as Row[]).slice(0, 1);
    seedSnapshot(
      'snap-2',
      zohoOrder({ shipped_status: 'fulfilled', line_items: [{ ...firstItem, quantity: 12 }] }),
      { remoteModifiedAt: new Date('2026-09-01T17:00:00.000Z') }
    );

    const result = await normalizeSalesOrderSnapshot(input('snap-2'));

    expect(result).toEqual({ salesOrderId: first.salesOrderId, status: 'normalized' });
    expect(db.rows('salesOrder')).toHaveLength(1);
    expect(db.rows('salesOrder')[0]).toMatchObject({
      shippedStatus: 'fulfilled',
      sourceSnapshotId: 'snap-2',
    });
    const items = itemsByOrder();
    expect(items).toHaveLength(1);
    expect(items[0].zohoLineItemId).toBe('li-1');
    expect(str(items[0].quantity)).toBe('12');

    const events = db.rows('entityChangeEvent');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityType: SALES_ORDER_ENTITY_TYPE,
      entityId: first.salesOrderId,
      sourceSnapshotId: 'snap-2',
      changes: {
        fields: { shippedStatus: { before: 'pending', after: 'fulfilled' } },
        items: {
          added: [],
          removed: ['li-2'],
          modified: { 'li-1': { quantity: { before: '10', after: '12' } } },
        },
      },
    });
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', changeEventId: events[0].id })
    );
    expect(logged('zoho.sales_orders.normalization.completed').at(-1)).toMatchObject({
      snapshotId: 'snap-2',
      changeEventId: events[0].id,
    });
  });

  it('reimportación sin cambios significativos: no registra evento y el log lleva changeEventId null', async () => {
    seedSnapshot('snap-1', zohoOrder());
    await normalizeSalesOrderSnapshot(input('snap-1'));
    seedSnapshot('snap-2', zohoOrder(), {
      remoteModifiedAt: new Date('2026-09-01T17:00:00.000Z'),
    });

    const result = await normalizeSalesOrderSnapshot(input('snap-2'));

    expect(result.status).toBe('normalized');
    expect(db.rows('salesOrder')[0].sourceSnapshotId).toBe('snap-2');
    expect(db.rows('salesOrderItem')).toHaveLength(2);
    expect(db.rows('entityChangeEvent')).toHaveLength(0);
    expect(logged('zoho.sales_orders.normalization.completed').at(-1)).toMatchObject({
      snapshotId: 'snap-2',
      changeEventId: null,
    });
  });
});

describe('normalizePendingSalesOrderSnapshots', () => {
  it('procesa sólo snapshots pendientes de órdenes, en orden de llegada, y resume el lote', async () => {
    seedSnapshot('snap-a', zohoOrder(), { createdAt: new Date('2026-09-01T16:01:00.000Z') });
    seedSnapshot(
      'snap-b',
      { code: 57, message: 'error' },
      { externalId: 'zso-2', createdAt: new Date('2026-09-01T16:02:00.000Z') }
    );
    seedSnapshot('snap-e', zohoOrder({ order_status: 'closed' }), {
      normalizationVersion: 1,
      remoteModifiedAt: new Date('2026-09-01T15:00:00.000Z'),
      createdAt: new Date('2026-09-01T16:03:00.000Z'),
    });
    // Already at the current normalizer version: not pending.
    seedSnapshot('snap-c', zohoOrder({ salesorder_id: 'zso-3' }), {
      normalizationVersion: NORMALIZER_VERSION,
    });
    // Another entity type: not pending for this normalizer.
    seedSnapshot('snap-d', zohoOrder({ salesorder_id: 'zso-4' }), { entityType: 'invoice' });

    const result = await normalizePendingSalesOrderSnapshots({ limit: 50 });

    expect(result).toEqual({
      seen: 3,
      normalized: 1,
      skipped: 1,
      failed: 1,
      alreadyRunning: false,
    });
    expect(db.rows('salesOrder').map((r) => r.zohoSalesOrderId)).toEqual(['zso-1']);
    expect(db.rows('salesOrder')[0].status).toBe('confirmed');
    expect(snapshot('snap-b')).toMatchObject({
      normalizedAt: null,
      normalizationVersion: 0,
      normalizationErrorCode: NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
    });
    expect(snapshot('snap-c').normalizedAt).toBeNull();
    expect(snapshot('snap-d').normalizedAt).toBeNull();
    expect(logged('zoho.sales_orders.normalization.batch_completed')).toEqual([
      {
        event: 'zoho.sales_orders.normalization.batch_completed',
        seen: 3,
        normalized: 1,
        skipped: 1,
        failed: 1,
        normalizerVersion: NORMALIZER_VERSION,
      },
    ]);
    expect((globalThis as Row)[STATE_KEY]).toEqual({ batchInProgress: false });
  });

  it('un error inesperado cuenta como fallido con UNEXPECTED_ERROR y no detiene el lote', async () => {
    seedSnapshot('snap-a', zohoOrder(), { createdAt: new Date('2026-09-01T16:01:00.000Z') });
    seedSnapshot('snap-b', zohoOrder({ salesorder_id: 'zso-2' }), {
      externalId: 'zso-2',
      createdAt: new Date('2026-09-01T16:02:00.000Z'),
    });
    const upsert = vi
      .spyOn(db.client.salesOrder, 'upsert')
      .mockRejectedValueOnce(new Error('conexión perdida'));

    const result = await normalizePendingSalesOrderSnapshots({ limit: 50 });

    upsert.mockRestore();
    expect(result).toMatchObject({ seen: 2, normalized: 1, failed: 1 });
    expect(snapshot('snap-a')).toMatchObject({
      normalizedAt: null,
      normalizationVersion: 0,
      normalizationErrorCode: NORMALIZATION_ERROR_CODE.UNEXPECTED_ERROR,
    });
    expect(db.rows('salesOrder').map((r) => r.zohoSalesOrderId)).toEqual(['zso-2']);
  });

  it('limita el lote entre 1 y 500 snapshots', async () => {
    for (const n of [1, 2, 3]) {
      seedSnapshot(`snap-${n}`, zohoOrder({ salesorder_id: `zso-${n}` }), {
        externalId: `zso-${n}`,
        createdAt: new Date(`2026-09-01T16:0${n}:00.000Z`),
      });
    }

    expect((await normalizePendingSalesOrderSnapshots({ limit: 0 })).seen).toBe(1);
    expect((await normalizePendingSalesOrderSnapshots({ limit: 1000 })).seen).toBe(2);
  });

  it('rechaza un segundo lote concurrente en la misma instancia', async () => {
    (globalThis as Row)[STATE_KEY] = { batchInProgress: true };

    await expect(normalizePendingSalesOrderSnapshots({ limit: 10 })).rejects.toBeInstanceOf(
      NormalizationAlreadyRunningError
    );
    expect((globalThis as Row)[STATE_KEY]).toEqual({ batchInProgress: true });
  });
});

describe('ganchos de Operaciones (plan 2.4)', () => {
  async function useOperationsConfig(settings: Row, isEnabled = true) {
    const { invalidateOperationsConfigCache } =
      await import('@/modules/operations/operations-config');
    db.seed('integrationConfig', {
      source: 'operations',
      displayName: 'Operaciones',
      isEnabled,
      settings,
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    invalidateOperationsConfigCache();
  }

  const jobs = () => db.rows('backgroundJob');

  it('primera importación elegible: encola ops.case.start en la transacción de la normalización', async () => {
    await useOperationsConfig({ cutoverDate: '2026-08-01T00:00:00.000Z' });
    seedSnapshot('snap-1', zohoOrder());

    const result = await normalizeSalesOrderSnapshot(input('snap-1'));

    expect(result.status).toBe('normalized');
    expect(jobs()).toEqual([
      expect.objectContaining({
        type: 'ops.case.start',
        dedupeKey: 'case:so:zso-1',
        payload: { zohoSalesOrderId: 'zso-1' },
        priority: 10,
        maxAttempts: 3,
        createdBy: 'sales-orders-normalizer',
      }),
    ]);
    expect(logged('zoho.sales_orders.operations_hook')).toEqual([
      expect.objectContaining({
        snapshotId: 'snap-1',
        action: 'start_enqueued',
        jobId: jobs()[0].id,
      }),
    ]);
  });

  it('no elegible (anterior al corte, borrador o núcleo apagado): no encola nada', async () => {
    await useOperationsConfig({ cutoverDate: '2026-09-02T00:00:00.000Z' });
    seedSnapshot('snap-1', zohoOrder());
    await normalizeSalesOrderSnapshot(input('snap-1'));
    expect(jobs()).toHaveLength(0);

    db.tables.clear();
    await useOperationsConfig({ cutoverDate: '2026-08-01T00:00:00.000Z' });
    seedSnapshot('snap-2', zohoOrder({ order_status: 'draft' }));
    await normalizeSalesOrderSnapshot(input('snap-2'));
    expect(jobs()).toHaveLength(0);

    db.tables.clear();
    await useOperationsConfig({ cutoverDate: '2026-08-01T00:00:00.000Z' }, false);
    seedSnapshot('snap-3', zohoOrder());
    await normalizeSalesOrderSnapshot(input('snap-3'));
    expect(jobs()).toHaveLength(0);
    expect(db.rows('salesOrder')).toHaveLength(1);
  });

  it('reimportación con cambios y expediente vivo: encola ops.case.replan con el id del cambio', async () => {
    await useOperationsConfig({ cutoverDate: '2026-08-01T00:00:00.000Z' });
    seedSnapshot('snap-1', zohoOrder());
    await normalizeSalesOrderSnapshot(input('snap-1'));
    db.seed('operationalCase', {
      id: 'case-1',
      kind: 'sales_fulfillment',
      sourceType: 'sales_order',
      sourceId: 'zso-1',
      status: 'open',
    });
    seedSnapshot('snap-2', zohoOrder({ line_items: [(zohoOrder().line_items as Row[])[0]] }), {
      remoteModifiedAt: new Date('2026-09-01T17:00:00.000Z'),
    });

    await normalizeSalesOrderSnapshot(input('snap-2'));

    const [changeEvent] = db.rows('entityChangeEvent');
    expect(jobs().map((job) => [job.type, job.dedupeKey])).toEqual([
      ['ops.case.start', 'case:so:zso-1'],
      ['ops.case.replan', `replan:so:zso-1:${changeEvent.id}`],
    ]);
    expect(jobs()[1]).toMatchObject({
      payload: { caseId: 'case-1', zohoSalesOrderId: 'zso-1', changeEventId: changeEvent.id },
      groupKey: 'case:case-1',
    });
  });

  it('un error SQL dentro del gancho se revierte al savepoint y la normalización se guarda', async () => {
    await useOperationsConfig({ cutoverDate: '2026-08-01T00:00:00.000Z' });
    seedSnapshot('snap-1', zohoOrder());
    await normalizeSalesOrderSnapshot(input('snap-1'));
    savepoints.length = 0;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = vi
      .spyOn(db.client.operationalCase, 'findFirst')
      .mockRejectedValueOnce(new Error('relation "OperationalCase" does not exist'));
    seedSnapshot('snap-2', zohoOrder({ line_items: [(zohoOrder().line_items as Row[])[0]] }), {
      remoteModifiedAt: new Date('2026-09-01T17:00:00.000Z'),
    });

    const result = await normalizeSalesOrderSnapshot(input('snap-2'));

    failing.mockRestore();
    expect(result.status).toBe('normalized');
    expect(snapshot('snap-2')).toMatchObject({ normalizationErrorCode: null });
    expect(savepoints).toEqual([
      'SAVEPOINT ops_sales_order_hook',
      'ROLLBACK TO SAVEPOINT ops_sales_order_hook',
    ]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"event":"hook_failed"'));
    error.mockRestore();
  });

  it('un error dentro del gancho no rompe la normalización', async () => {
    await useOperationsConfig({ cutoverDate: '2026-08-01T00:00:00.000Z' });
    const { invalidateOperationsConfigCache } =
      await import('@/modules/operations/operations-config');
    invalidateOperationsConfigCache();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = vi
      .spyOn(db.client.integrationConfig, 'findUnique')
      .mockRejectedValueOnce(new Error('base de datos no disponible'));
    seedSnapshot('snap-1', zohoOrder());

    const result = await normalizeSalesOrderSnapshot(input('snap-1'));

    failing.mockRestore();
    expect(result.status).toBe('normalized');
    expect(db.rows('salesOrder')).toHaveLength(1);
    expect(snapshot('snap-1')).toMatchObject({
      normalizationErrorCode: null,
      normalizationVersion: NORMALIZER_VERSION,
    });
    expect(jobs()).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"event":"hook_failed"'));
    error.mockRestore();
  });
});
