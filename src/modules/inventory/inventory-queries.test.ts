import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError, type CurrentUser } from '@/modules/auth/authorization';

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('./testing/inventory-fixtures');
  return { fake: fixtures.createInventoryFake() };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));

import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { makeCurrentUser } from '@/modules/operations/testing/fixtures';
import {
  getConfidenceSummary,
  getItemAvailability,
  listActiveReservations,
  listCountLinesAwaitingDecision,
  listDisputedSkusBlockingCases,
  listLegacyClaims,
  listLocationsWithoutRecentCount,
  listPendingCounts,
  listStockByConfidence,
  listStockMovements,
  normalizePage,
} from './inventory-queries';
import {
  seedDemand,
  seedLocation,
  seedProduct,
  seedProfile,
  seedStockItem,
  seedWarehouse,
} from './testing/inventory-fixtures';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
const DAY = 86_400_000;
const viewer: CurrentUser = makeCurrentUser({ id: 'viewer', permissionKeys: ['inventory.view'] });
const outsider: CurrentUser = makeCurrentUser({ id: 'outsider' });

let warehouseId: string;
let generalId: string;

beforeEach(() => {
  fake.tables.clear();
  invalidateOperationsConfigCache();
  const { warehouse, general } = seedWarehouse(fake, { key: 'centro', name: 'Bodega Centro' });
  warehouseId = warehouse.id;
  generalId = general.id;
  seedProduct(fake, { zohoItemId: 'item-a', name: 'Loseta A', sku: 'LA', stockOnHand: 77 });
  seedProduct(fake, { zohoItemId: 'item-b', name: 'Loseta B', sku: 'LB' });
  seedProduct(fake, { zohoItemId: 'item-c', name: 'Adhesivo C', sku: 'AC' });
  seedProfile(fake, { zohoItemId: 'item-a', baseUnit: 'm2', confidence: 'CONTROLLED' });
  seedProfile(fake, { zohoItemId: 'item-b', baseUnit: 'm2', confidence: 'DISPUTED' });
  seedProfile(fake, { zohoItemId: 'item-c', baseUnit: 'kg', confidence: 'PROVISIONAL' });
  seedStockItem(fake, {
    id: 's-a',
    zohoItemId: 'item-a',
    warehouseId,
    locationId: generalId,
    baseline: 50,
    reserved: 10,
    lastCountedAt: new Date(NOW.getTime() - 40 * DAY),
  });
  seedStockItem(fake, {
    id: 's-b',
    zohoItemId: 'item-b',
    warehouseId,
    locationId: generalId,
    baseline: 20,
  });
  seedLocation(fake, { id: 'loc-fresh', warehouseId, code: 'RACK-F' });
  seedStockItem(fake, {
    id: 's-c',
    zohoItemId: 'item-c',
    warehouseId,
    locationId: 'loc-fresh',
    baseline: 5,
    lastCountedAt: new Date(NOW.getTime() - 2 * DAY),
  });
  fake.seed('legacyCommitmentClaim', {
    zohoItemId: 'item-a',
    warehouseId,
    quantity: new Prisma.Decimal(4),
    unit: 'm2',
    source: 'verbal',
    claimedBy: 'viewer',
    expiresAt: new Date(NOW.getTime() - DAY),
  });
});

describe('paginación y permisos', () => {
  it('normalizePage acota página y tamaño', () => {
    expect(normalizePage({})).toEqual({ page: 1, pageSize: 50, skip: 0 });
    expect(normalizePage({ page: 3, pageSize: 1000 })).toEqual({
      page: 3,
      pageSize: 200,
      skip: 400,
    });
    expect(normalizePage({ page: -2, pageSize: 0 })).toEqual({ page: 1, pageSize: 1, skip: 0 });
  });

  it('sin inventory.view no se consulta nada', async () => {
    await expect(listStockByConfidence(outsider)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(listDisputedSkusBlockingCases(outsider)).rejects.toBeInstanceOf(
      AuthorizationError
    );
  });
});

describe('existencias por confianza', () => {
  it('filtra por nivel y búsqueda y calcula disponible con reclamos; Zoho es informativo', async () => {
    const all = await listStockByConfidence(viewer, { pageSize: 10 });
    expect(all.total).toBe(3);
    const controlled = await listStockByConfidence(viewer, { confidence: 'CONTROLLED' });
    expect(controlled.rows).toEqual([
      expect.objectContaining({
        zohoItemId: 'item-a',
        productName: 'Loseta A',
        confidenceLabel: 'Controlado',
        known: '50',
        reserved: '10',
        legacyClaims: '4',
        available: '36',
        zohoStockOnHand: '77',
      }),
    ]);
    const search = await listStockByConfidence(viewer, { search: 'Adhesivo' });
    expect(search.rows.map((r) => r.zohoItemId)).toEqual(['item-c']);
    const byWarehouse = await listStockByConfidence(viewer, { warehouseId: 'otra', pageSize: 5 });
    expect(byWarehouse.total).toBe(0);
  });

  it('resumen por nivel de confianza', async () => {
    expect(await getConfidenceSummary(viewer)).toEqual([
      { confidence: 'UNCOUNTED', label: 'Sin contar', items: 0 },
      { confidence: 'PROVISIONAL', label: 'Provisional', items: 1 },
      { confidence: 'CONTROLLED', label: 'Controlado', items: 1 },
      { confidence: 'DISPUTED', label: 'En disputa', items: 1 },
    ]);
  });

  it('disponibilidad de un artículo como DTO', async () => {
    const dto = await getItemAvailability(viewer, {
      zohoItemId: 'item-a',
      warehouseId,
      quantityBase: 30,
    });
    expect(dto).toMatchObject({
      available: '36',
      canPromise: true,
      confidenceLabel: 'Controlado',
      legacyClaims: '4',
    });
  });
});

describe('movimientos, reservas, conteos y reclamos', () => {
  it('movimientos paginados con ubicación y producto', async () => {
    fake.seed('stockMovement', {
      stockItemId: 's-a',
      zohoItemId: 'item-a',
      warehouseId,
      kind: 'receipt',
      quantity: new Prisma.Decimal(5),
      originalQuantity: new Prisma.Decimal(5),
      originalUnit: 'm2',
      actorId: 'viewer',
      occurredAt: NOW,
    });
    const page = await listStockMovements(viewer, {
      zohoItemId: 'item-a',
      kinds: ['receipt', 'issue'],
    });
    expect(page.rows).toEqual([
      expect.objectContaining({
        kind: 'receipt',
        kindLabel: 'Entrada',
        quantity: '5',
        productName: 'Loseta A',
        locationCode: 'GENERAL',
      }),
    ]);
  });

  it('reservas activas con expediente y marca de antigüedad', async () => {
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: 'item-a', quantity: 10 });
    fake.seed('stockReservation', {
      stockItemId: 's-a',
      zohoItemId: 'item-a',
      warehouseId,
      caseId: 'case1',
      demandId: 'd1',
      quantity: new Prisma.Decimal(10),
      confidenceAtReserve: 'CONTROLLED',
      createdAt: new Date(NOW.getTime() - 9 * DAY),
    });
    const page = await listActiveReservations(viewer, { now: NOW });
    expect(page.rows).toEqual([
      expect.objectContaining({
        caseNumber: 'EXP-000001',
        productName: 'Loseta A',
        ageDays: 9,
        stale: true,
        quantity: '10',
      }),
    ]);
    expect((await listActiveReservations(viewer, { olderThanDays: 10, now: NOW })).total).toBe(0);
  });

  it('conteos abiertos y líneas que esperan decisión', async () => {
    fake.seed('stockCount', {
      id: 'count-open',
      warehouseId,
      status: 'in_progress',
      startedBy: 'viewer',
    });
    fake.seed('stockCount', {
      id: 'count-closed',
      warehouseId,
      status: 'closed',
      startedBy: 'viewer',
      closedAt: NOW,
    });
    const line = (id: string, countId: string, resolution: string, withinTolerance: boolean) =>
      fake.seed('stockCountLine', {
        id,
        countId,
        stockItemId: 's-b',
        expectedQty: new Prisma.Decimal(20),
        countedQty: new Prisma.Decimal(12),
        unit: 'm2',
        diffQty: new Prisma.Decimal(-8),
        withinTolerance,
        resolution,
        countedBy: 'viewer',
      });
    line('l-open', 'count-open', 'pending', false);
    line('l-disputed', 'count-closed', 'disputed', false);

    const pending = await listPendingCounts(viewer);
    expect(pending.rows).toEqual([
      expect.objectContaining({
        id: 'count-open',
        lines: 1,
        outOfTolerance: 1,
        warehouseName: 'Bodega Centro',
      }),
    ]);
    const awaiting = await listCountLinesAwaitingDecision(viewer);
    expect(awaiting.rows).toEqual([
      expect.objectContaining({
        id: 'l-disputed',
        resolutionLabel: 'En disputa',
        productName: 'Loseta B',
        locationCode: 'GENERAL',
      }),
    ]);
  });

  it('reclamos legados con marca de vencido', async () => {
    const page = await listLegacyClaims(viewer, { status: 'claimed', now: NOW });
    expect(page.rows).toEqual([
      expect.objectContaining({
        zohoItemId: 'item-a',
        expired: true,
        sourceLabel: 'Acuerdo verbal',
      }),
    ]);
  });
});

describe('vistas de control', () => {
  it('ubicaciones con existencias sin conteo reciente, las nunca contadas primero', async () => {
    seedLocation(fake, { id: 'loc-empty', warehouseId, code: 'RACK-VACIO' });
    const page = await listLocationsWithoutRecentCount(viewer, { days: 30, now: NOW });
    expect(page.rows).toEqual([
      expect.objectContaining({
        code: 'GENERAL',
        stockItems: 2,
        daysSinceCount: 40,
        lastCountedAt: new Date(NOW.getTime() - 40 * DAY).toISOString(),
      }),
    ]);
    const strict = await listLocationsWithoutRecentCount(viewer, { days: 1, now: NOW });
    expect(strict.rows.map((r) => r.code)).toEqual(['GENERAL', 'RACK-F']);
  });

  it('artículos en disputa que bloquean expedientes abiertos', async () => {
    seedDemand(fake, { id: 'd-open', caseId: 'case-open', zohoItemId: 'item-b', quantity: 3 });
    seedDemand(fake, { id: 'd-closed', caseId: 'case-closed', zohoItemId: 'item-b', quantity: 1 });
    fake.rows('operationalCase').find((c) => c.id === 'case-closed')!.status = 'closed';
    fake.seed('incident', {
      areaKey: 'inventario',
      kind: 'count_dispute',
      title: 'Diferencia de conteo',
      dedupeKey: 'count_dispute:count-x:item-b',
      severity: 'high',
    });
    const page = await listDisputedSkusBlockingCases(viewer);
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({
      zohoItemId: 'item-b',
      productName: 'Loseta B',
      cases: [expect.objectContaining({ caseId: 'case-open', demandIds: ['d-open'] })],
      incidents: [expect.objectContaining({ severity: 'high' })],
    });
  });
});
