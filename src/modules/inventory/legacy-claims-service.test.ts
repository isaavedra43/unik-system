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
  claimLegacyStock,
  confirmLegacyStockClaim,
  expireDueLegacyClaims,
  releaseLegacyStockClaim,
  reserveStockForDemand,
  type ClaimData,
} from './inventory-commands';
import { verifyAvailability } from './inventory-service';
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
const ITEM = 'item-adhesivo';
const tx = fake.client as unknown as Prisma.TransactionClient;

let seller: CurrentUser;
let warehouseId: string;

beforeEach(() => {
  fake.tables.clear();
  locks.reset();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  seedArea(fake, 'inventario');
  seedArea(fake, 'administracion');
  seller = seedUser(fake, {
    id: 'seller',
    permissions: ['inventory.view', 'inventory.reserve'],
  }).currentUser;
  seedResponsible(fake, { area: 'inventario', userId: 'seller' });
  const { warehouse, general } = seedWarehouse(fake, { key: 'centro' });
  warehouseId = warehouse.id;
  seedProduct(fake, { zohoItemId: ITEM, name: 'Adhesivo gris', unit: 'bulto' });
  seedProfile(fake, {
    zohoItemId: ITEM,
    baseUnit: 'kg',
    confidence: 'CONTROLLED',
    consecutiveGoodCounts: 2,
    conversions: [{ unit: 'bulto', factor: 20 }],
  });
  seedStockItem(fake, {
    id: 'stock-1',
    zohoItemId: ITEM,
    warehouseId,
    locationId: general.id,
    baseline: 400,
  });
});

function claim(input: Partial<Parameters<typeof claimLegacyStock>[1]> = {}, now = NOW) {
  return claimLegacyStock(
    seller,
    {
      zohoItemId: ITEM,
      warehouseId,
      quantity: 5,
      unit: 'bulto',
      source: 'pre_cutover_order',
      reference: 'SO-00123',
      ...input,
    },
    { now }
  );
}

const available = async () =>
  (await verifyAvailability(tx, { zohoItemId: ITEM, warehouseId })).available.toString();
const events = (type: string) =>
  fake.rows('operationalEvent').filter((event) => event.type === type);

describe('reclamos legados', () => {
  it('un reclamo resta del disponible y vence por TTL de la configuración', async () => {
    const result = await claim();
    expect(result.status).toBe('completed');
    expect(result.data as ClaimData).toMatchObject({
      availableBefore: '400',
      availableAfter: '300',
      exceedsAvailable: false,
    });
    const row = fake.rows('legacyCommitmentClaim')[0];
    expect(row).toMatchObject({
      status: 'claimed',
      unit: 'kg',
      claimedBy: 'seller',
      reference: 'SO-00123',
    });
    expect(row.quantity.toString()).toBe('100');
    expect(row.expiresAt).toEqual(new Date(NOW.getTime() + 14 * DAY));
    expect(await available()).toBe('300');
    expect(
      (await verifyAvailability(tx, { zohoItemId: ITEM, warehouseId })).legacyClaims.toString()
    ).toBe('100');
    expect(events('stock.legacy_claimed')[0].payload).toMatchObject({
      capturedQuantity: '5',
      capturedUnit: 'bulto',
    });
  });

  it('la existencia reclamada no se puede reservar para otra venta', async () => {
    await claim({ quantity: 15 });
    seedDemand(fake, { id: 'd-other', caseId: 'case-other', zohoItemId: ITEM, quantity: 150 });
    const result = await reserveStockForDemand(
      seller,
      { caseId: 'case-other', demandId: 'd-other', zohoItemId: ITEM, warehouseId, quantity: 150 },
      { now: NOW }
    );
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'insufficient_stock' });
  });

  it('confirmar el reclamo lo convierte en reserva del expediente sin mover el disponible', async () => {
    const claimed = await claim();
    const claimId = (claimed.data as ClaimData).claim.id;
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 100, unit: 'kg' });

    const confirmed = await confirmLegacyStockClaim(
      seller,
      { claimId, caseId: 'case1', demandId: 'd1' },
      { now: NOW }
    );

    expect(confirmed.status).toBe('completed');
    expect(fake.rows('legacyCommitmentClaim')[0]).toMatchObject({
      status: 'confirmed',
      caseId: 'case1',
      resolvedAt: NOW,
    });
    expect(fake.rows('stockReservation')).toHaveLength(1);
    expect(fake.rows('stockReservation')[0]).toMatchObject({
      caseId: 'case1',
      demandId: 'd1',
      status: 'active',
    });
    expect(fake.rows('stockReservation')[0].quantity.toString()).toBe('100');
    const availability = await verifyAvailability(tx, { zohoItemId: ITEM, warehouseId });
    expect(availability.available.toString()).toBe('300');
    expect(availability.legacyClaims.toString()).toBe('0');
    expect(availability.reserved.toString()).toBe('100');
    expect(fake.rows('objectRelation')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromType: 'legacy_claim',
          toType: 'stock_reservation',
          relation: 'converted_to',
        }),
      ])
    );
    expect(events('stock.legacy_confirmed')).toHaveLength(1);

    const again = await confirmLegacyStockClaim(
      seller,
      { claimId, caseId: 'case1', demandId: 'd1' },
      { now: NOW }
    );
    expect(again).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
  });

  it('no confirma un reclamo sobre una necesidad que ya tiene su existencia reservada', async () => {
    const claimed = await claim({ quantity: 3 });
    const claimId = (claimed.data as ClaimData).claim.id;
    seedDemand(fake, { id: 'd2', caseId: 'case2', zohoItemId: ITEM, quantity: 100, unit: 'kg' });
    const reserved = await reserveStockForDemand(
      seller,
      { caseId: 'case2', demandId: 'd2', zohoItemId: ITEM, warehouseId, quantity: 80, unit: 'kg' },
      { now: NOW }
    );
    expect(reserved.status).toBe('completed');

    const confirmed = await confirmLegacyStockClaim(
      seller,
      { claimId, caseId: 'case2', demandId: 'd2' },
      { now: NOW }
    );

    // Same rule as every reservation (assertReservationCapacity), checked before the claim changes.
    expect(confirmed).toMatchObject({ status: 'rejected', errorCode: 'demand_over_reserved' });
    expect(confirmed.message).toContain('sólo faltan 20 kg');
    expect(fake.rows('legacyCommitmentClaim')[0].status).toBe('claimed');
    expect(fake.rows('stockReservation').filter((r) => r.status === 'active')).toHaveLength(1);
    expect(await available()).toBe('260');
  });

  it('liberar el reclamo devuelve el disponible', async () => {
    const claimed = await claim({ quantity: 3 });
    const claimId = (claimed.data as ClaimData).claim.id;
    expect(await available()).toBe('340');
    const released = await releaseLegacyStockClaim(
      seller,
      { claimId, reason: 'El cliente canceló' },
      { now: NOW }
    );
    expect(released.status).toBe('completed');
    expect(fake.rows('legacyCommitmentClaim')[0].status).toBe('released');
    expect(await available()).toBe('400');
  });

  it('un reclamo mayor que la existencia controlada se registra y abre incidencia', async () => {
    const result = await claim({ quantity: 25 });
    expect(result.status).toBe('completed');
    expect(result.data as ClaimData).toMatchObject({
      exceedsAvailable: true,
      availableAfter: '-100',
    });
    expect(fake.rows('incident')).toEqual([
      expect.objectContaining({ kind: 'stock_conflict', severity: 'medium' }),
    ]);
  });

  it('el supervisor expira los reclamos vencidos una sola vez; un vencido no se confirma', async () => {
    const claimed = await claim({ expiresAt: new Date(NOW.getTime() + DAY).toISOString() });
    const claimId = (claimed.data as ClaimData).claim.id;
    const notDue = await expireDueLegacyClaims({ now: NOW });
    expect(notDue).toEqual({ checked: 0, expired: 0, rejected: 0 });

    const later = new Date(NOW.getTime() + 2 * DAY);
    seedDemand(fake, { id: 'd1', caseId: 'case1', zohoItemId: ITEM, quantity: 100 });
    const lateConfirm = await confirmLegacyStockClaim(
      seller,
      { claimId, caseId: 'case1', demandId: 'd1' },
      { now: later }
    );
    expect(lateConfirm).toMatchObject({ status: 'rejected', errorCode: 'legacy_claim_expired' });

    const sweep = await expireDueLegacyClaims({ now: later });
    expect(sweep).toEqual({ checked: 1, expired: 1, rejected: 0 });
    expect(fake.rows('legacyCommitmentClaim')[0].status).toBe('expired');
    expect(
      fake.rows('operationalCommand').some((c) => c.id === `sup:legacy_expire:${claimId}`)
    ).toBe(true);
    expect(await expireDueLegacyClaims({ now: later })).toEqual({
      checked: 0,
      expired: 0,
      rejected: 0,
    });
    expect(await available()).toBe('400');
  });

  it('valida vencimiento, origen y permiso', async () => {
    expect(await claim({ expiresAt: new Date(NOW.getTime() - DAY).toISOString() })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_payload',
    });
    expect(await claim({ source: 'desconocido' as 'verbal' })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_payload',
    });
    const viewer = seedUser(fake, { id: 'viewer', permissions: ['inventory.view'] }).currentUser;
    const forbidden = await claimLegacyStock(
      viewer,
      { zohoItemId: ITEM, warehouseId, quantity: 1, source: 'verbal' },
      { now: NOW }
    );
    expect(forbidden).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
  });
});
