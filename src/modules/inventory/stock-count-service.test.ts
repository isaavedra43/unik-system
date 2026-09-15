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
  cancelStockCount,
  closeStockCount,
  decideStockCountAdjustment,
  recordStockCountLine,
  reserveStockForDemand,
  resolveStockCountDispute,
  startStockCount,
  type CountLineData,
} from './inventory-commands';
import type { CountDTO } from './inventory-dto';
import type { CloseCountResult } from './stock-count-service';
import {
  seedDemand,
  seedProduct,
  seedProfile,
  seedStockItem,
  seedWarehouse,
} from './testing/inventory-fixtures';

const { fake, locks } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
const DAY = 86_400_000;
const ITEM = 'item-perla';
const ALL = [
  'inventory.view',
  'inventory.count',
  'inventory.adjust',
  'inventory.reserve',
  'inventory.manage',
];

let manager: CurrentUser;
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
  counter = seedUser(fake, {
    id: 'counter',
    permissions: ['inventory.view', 'inventory.count'],
  }).currentUser;
  seedResponsible(fake, { area: 'inventario', userId: 'manager' });
  const { warehouse, general } = seedWarehouse(fake, { key: 'centro', name: 'Bodega Centro' });
  warehouseId = warehouse.id;
  generalId = general.id;
  seedProduct(fake, { zohoItemId: ITEM, name: 'Loseta Perla', sku: 'LOS-PER', unit: 'M2' });
});

const events = (type: string) =>
  fake.rows('operationalEvent').filter((event) => event.type === type);
const profile = () => fake.rows('productInventoryProfile').find((row) => row.zohoItemId === ITEM)!;

async function openCount(actor: CurrentUser, now = NOW): Promise<string> {
  const result = await startStockCount(actor, { warehouseId }, { now });
  expect(result.status).toBe('completed');
  return (result.data as { count: CountDTO }).count.id;
}

function seeded(confidence: string, known: number, consecutiveGoodCounts = 0) {
  seedProfile(fake, {
    zohoItemId: ITEM,
    baseUnit: 'm2',
    confidence,
    consecutiveGoodCounts,
    tolerancePct: 2,
  });
  return seedStockItem(fake, {
    id: 'stock-1',
    zohoItemId: ITEM,
    warehouseId,
    locationId: generalId,
    baseline: known,
  });
}

describe('conteos', () => {
  it('desde UNCOUNTED: línea base y PROVISIONAL; segundo conteo dentro de tolerancia: CONTROLLED', async () => {
    const countId = await openCount(counter);
    const line = await recordStockCountLine(
      counter,
      { countId, zohoItemId: ITEM, countedQty: 50 },
      { now: NOW }
    );
    expect(line.status).toBe('completed');
    expect(line.data).toMatchObject({
      expected: '0',
      counted: '50',
      diff: '50',
      baseUnit: 'm2',
      confidence: 'UNCOUNTED',
    });
    expect(events('stock.counted')).toHaveLength(1);

    const closed = await closeStockCount(counter, { countId }, { now: NOW });
    expect(closed.status).toBe('completed');
    expect(closed.data).toMatchObject({
      lines: 1,
      baselines: 1,
      accepted: 1,
      pending: 0,
      controlled: [],
    });
    expect(profile()).toMatchObject({
      confidence: 'PROVISIONAL',
      consecutiveGoodCounts: 1,
      baseUnit: 'm2',
      lastCountAt: NOW,
    });
    expect(profile().tolerancePct.toString()).toBe('2');
    const row = fake.rows('stockItem')[0];
    expect(row).toMatchObject({ locationId: generalId, lastCountedAt: NOW });
    expect(row.knownQty.toString()).toBe('50');
    expect(
      fake.rows('stockMovement').map((m) => [m.kind, m.quantity.toString(), m.referenceType])
    ).toEqual([['baseline', '50', 'stock_count_line']]);
    expect(fake.rows('stockCount')[0]).toMatchObject({ status: 'closed', closedAt: NOW });

    const later = new Date(NOW.getTime() + DAY);
    const secondId = await openCount(manager, later);
    await recordStockCountLine(
      manager,
      { countId: secondId, stockItemId: row.id, countedQty: '49.5' },
      { now: later }
    );
    const closedAgain = await closeStockCount(manager, { countId: secondId }, { now: later });
    expect(closedAgain.data).toMatchObject({ adjusted: 1, controlled: [ITEM], disputed: 0 });
    expect(profile()).toMatchObject({
      confidence: 'CONTROLLED',
      consecutiveGoodCounts: 2,
      controlledAt: later,
    });
    expect(row.knownQty.toString()).toBe('49.5');
    expect(fake.rows('stockMovement').map((m) => [m.kind, m.quantity.toString()])).toEqual([
      ['baseline', '50'],
      ['adjust', '-0.5'],
    ]);
    expect(events('stock.controlled')).toHaveLength(1);
    expect(events('stock.count_closed')).toHaveLength(2);
  });

  it('dentro de tolerancia sin permiso de ajuste: línea pendiente con trabajo de aprobación; al aprobar se ajusta', async () => {
    const row = seeded('PROVISIONAL', 100, 1);
    const countId = await openCount(counter);
    await recordStockCountLine(
      counter,
      { countId, stockItemId: row.id, countedQty: 99 },
      { now: NOW }
    );
    const closed = await closeStockCount(counter, { countId }, { now: NOW });
    const data = closed.data as CloseCountResult;
    expect(data).toMatchObject({ pending: 1, adjusted: 0, controlled: [ITEM] });
    expect(row.knownQty.toString()).toBe('100');
    const workItem = fake.rows('workItem').find((w) => w.id === data.workItemIds[0])!;
    expect(workItem).toMatchObject({
      kind: 'approval',
      areaKey: 'inventario',
      objectType: 'stock_count_line',
      ownerUserId: 'manager',
      status: 'open',
    });
    expect(events('stock.adjustment_pending')).toHaveLength(1);

    const lineId = fake.rows('stockCountLine')[0].id;
    const denied = await decideStockCountAdjustment(
      counter,
      { lineId, decision: 'approve' },
      { now: NOW }
    );
    expect(denied).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });

    const approved = await decideStockCountAdjustment(
      manager,
      { lineId, decision: 'approve' },
      { now: NOW }
    );
    expect(approved.status).toBe('completed');
    expect(row.knownQty.toString()).toBe('99');
    expect(fake.rows('stockCountLine')[0].resolution).toBe('adjusted');
    expect(workItem).toMatchObject({ status: 'done', completedBy: 'manager' });
    expect(events('workitem.completed')).toHaveLength(1);

    const repeated = await decideStockCountAdjustment(
      manager,
      { lineId, decision: 'reject' },
      { now: NOW }
    );
    expect(repeated).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
  });

  it('fuera de tolerancia: DISPUTED con incidencia y seguimiento; bloquea reservas; al resolver vuelve a PROVISIONAL', async () => {
    const row = seeded('CONTROLLED', 100, 4);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 5 });
    const countId = await openCount(counter);
    await recordStockCountLine(
      counter,
      { countId, stockItemId: row.id, countedQty: 80 },
      { now: NOW }
    );
    const closed = await closeStockCount(counter, { countId }, { now: NOW });
    const data = closed.data as CloseCountResult;
    expect(data).toMatchObject({ disputed: 1, disputedItems: [ITEM] });
    expect(profile()).toMatchObject({ confidence: 'DISPUTED', consecutiveGoodCounts: 0 });
    expect(row.knownQty.toString()).toBe('100');
    const incident = fake.rows('incident')[0];
    expect(incident).toMatchObject({
      kind: 'count_dispute',
      severity: 'high',
      status: 'open',
      dedupeKey: `count_dispute:${countId}:${ITEM}`,
    });
    const followup = fake.rows('workItem').find((w) => w.objectType === 'incident')!;
    expect(followup).toMatchObject({
      kind: 'incident_followup',
      objectId: incident.id,
      status: 'open',
    });
    expect(fake.rows('stockCountLine')[0].resolution).toBe('disputed');

    const blocked = await reserveStockForDemand(
      manager,
      {
        caseId: 'case1',
        demandId: 'd1',
        zohoItemId: ITEM,
        warehouseId,
        quantity: 5,
        allowProvisional: true,
      },
      { now: NOW }
    );
    expect(blocked).toMatchObject({ status: 'rejected', errorCode: 'stock_disputed' });

    const lineId = fake.rows('stockCountLine')[0].id;
    const withoutNote = await resolveStockCountDispute(
      manager,
      { lineId, decision: 'adjust', note: '' },
      { now: NOW }
    );
    expect(withoutNote).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });

    const resolved = await resolveStockCountDispute(
      manager,
      { lineId, decision: 'adjust', confirmedQty: 81, note: 'Recuento con supervisor: 81 m²' },
      { now: NOW }
    );
    expect(resolved.status).toBe('completed');
    expect(resolved.data).toMatchObject({
      confidence: 'PROVISIONAL',
      disputeResolved: true,
      resolvedIncidentIds: [incident.id],
    });
    expect(row.knownQty.toString()).toBe('81');
    expect(row.lastCountedAt).toEqual(NOW);
    expect(fake.rows('stockCountLine')[0]).toMatchObject({
      resolution: 'adjusted',
      withinTolerance: false,
    });
    expect(fake.rows('stockCountLine')[0].countedQty.toString()).toBe('81');
    expect(profile()).toMatchObject({ confidence: 'PROVISIONAL', consecutiveGoodCounts: 1 });
    expect(incident).toMatchObject({
      status: 'resolved',
      resolvedBy: 'manager',
      resolution: 'Recuento con supervisor: 81 m²',
    });
    expect(followup.status).toBe('done');
    expect(events('stock.dispute_resolved')).toHaveLength(1);
    expect(events('incident.resolved')).toHaveLength(1);
  });

  it('resolver conservando el saldo en libros no mueve inventario', async () => {
    const row = seeded('PROVISIONAL', 40, 1);
    const countId = await openCount(counter);
    await recordStockCountLine(
      counter,
      { countId, stockItemId: row.id, countedQty: 10 },
      { now: NOW }
    );
    await closeStockCount(counter, { countId }, { now: NOW });
    const lineId = fake.rows('stockCountLine')[0].id;
    const result = await resolveStockCountDispute(
      manager,
      { lineId, decision: 'keep_book', note: 'Faltaba contar la tarima 2' },
      { now: NOW }
    );
    expect(result.status).toBe('completed');
    expect(fake.rows('stockMovement')).toHaveLength(0);
    expect(row.knownQty.toString()).toBe('40');
    expect(fake.rows('stockCountLine')[0].resolution).toBe('accepted');
    expect(profile().confidence).toBe('PROVISIONAL');
  });

  it('recapturar la misma existencia actualiza la línea; no se cierra vacío ni se captura en conteos cerrados', async () => {
    const row = seeded('PROVISIONAL', 20, 0);
    const emptyId = await openCount(counter);
    expect(await closeStockCount(counter, { countId: emptyId }, { now: NOW })).toMatchObject({
      status: 'rejected',
      errorCode: 'empty_count',
    });
    expect((await cancelStockCount(counter, { countId: emptyId }, { now: NOW })).status).toBe(
      'completed'
    );

    const countId = await openCount(counter);
    await recordStockCountLine(
      counter,
      { countId, stockItemId: row.id, countedQty: 18 },
      { now: NOW }
    );
    const recount = await recordStockCountLine(
      counter,
      { countId, stockItemId: row.id, countedQty: 20 },
      { now: NOW }
    );
    expect((recount.data as CountLineData).recount).toBe(true);
    expect(fake.rows('stockCountLine')).toHaveLength(1);
    expect(fake.rows('stockCountLine')[0].countedQty.toString()).toBe('20');

    await closeStockCount(counter, { countId }, { now: NOW });
    const late = await recordStockCountLine(
      counter,
      { countId, stockItemId: row.id, countedQty: 1 },
      { now: NOW }
    );
    expect(late).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
    const negative = await recordStockCountLine(
      counter,
      { countId: await openCount(counter), stockItemId: row.id, countedQty: -1 },
      { now: NOW }
    );
    expect(negative).toMatchObject({ status: 'rejected', errorCode: 'invalid_quantity' });
  });

  it('cerrar con una versión vieja se rechaza (agregado versionado)', async () => {
    const row = seeded('PROVISIONAL', 5, 0);
    const countId = await openCount(counter);
    await recordStockCountLine(
      counter,
      { countId, stockItemId: row.id, countedQty: 5 },
      { now: NOW }
    );
    const first = await closeStockCount(manager, { countId }, { now: NOW, expectedVersion: 1 });
    expect(first).toMatchObject({ status: 'completed', aggregateVersion: 2 });
    const stale = await closeStockCount(manager, { countId }, { now: NOW, expectedVersion: 1 });
    expect(stale).toMatchObject({ status: 'rejected', errorCode: 'version_conflict' });
  });

  it('contar exige permiso de conteo', async () => {
    const viewer = seedUser(fake, { id: 'viewer', permissions: ['inventory.view'] }).currentUser;
    expect(await startStockCount(viewer, { warehouseId }, { now: NOW })).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });
  });
});
