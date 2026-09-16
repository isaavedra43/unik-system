import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentSession, CurrentUser } from '@/modules/auth/authorization';

/**
 * Las acciones del área Inventario, ejercidas de punta a punta contra el falso
 * de Prisma: la acción del servidor → el permiso → el comando → el servicio →
 * las filas.
 *
 * Existe por el hueco del plan §3.3: los comandos de decidir un ajuste,
 * resolver una disputa, registrar un movimiento y manejar un reclamo legado
 * estaban registrados y NADIE los invocaba, así que una línea en disputa se
 * quedaba en disputa para siempre (y con ella el artículo, que ya nunca se
 * podía prometer). Aquí se prueba justamente la parte que faltaba: el camino
 * que una persona recorre desde el producto.
 */

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('@/modules/inventory/testing/inventory-fixtures');
  const fake = fixtures.createInventoryFake();
  return {
    fake,
    locks: fixtures.createLockEmulation(fake),
    session: { value: null as CurrentSession | null },
    notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({
      id: '1',
      channel: '',
      type: '',
      payload: {},
      createdAt: '',
    })),
    revalidatePath: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
  revalidateTag: vi.fn(),
}));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/inventory/inventory-locks', () => mocks.locks.module);
vi.mock('@/modules/auth/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/auth/authorization')>();
  return { ...actual, getCurrentSession: async () => mocks.session.value };
});

import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedArea, seedResponsible, seedUser } from '@/modules/operations/testing/fixtures';
import {
  closeStockCount,
  recordStockCountLine,
  startStockCount,
} from '@/modules/inventory/inventory-commands';
import type { CountDTO } from '@/modules/inventory/inventory-dto';
import {
  seedDemand,
  seedProduct,
  seedProfile,
  seedStockItem,
  seedWarehouse,
} from '@/modules/inventory/testing/inventory-fixtures';
import {
  claimLegacyStockAction,
  confirmLegacyClaimAction,
  decideCountAdjustmentAction,
  recordStockActionAction,
  releaseLegacyClaimAction,
  resolveCountDisputeAction,
} from './actions';

const { fake, locks } = mocks;
const ITEM = 'item-loseta';

let manager: CurrentUser;
let counter: CurrentUser;
let warehouseId: string;
let otherWarehouseId: string;
let generalId: string;

function signIn(user: CurrentUser): void {
  mocks.session.value = {
    sessionId: `session-${user.id}`,
    user,
  } as unknown as CurrentSession;
}

function rows(model: string) {
  return fake.rows(model);
}

const countLines = () => rows('stockCountLine');
const profile = () =>
  rows('productInventoryProfile').find((row) => row.zohoItemId === ITEM) as Record<string, unknown>;
const stockRow = (id: string) =>
  rows('stockItem').find((row) => row.id === id) as Record<string, unknown>;

beforeEach(() => {
  fake.tables.clear();
  locks.reset();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  seedArea(fake, 'inventario');
  seedArea(fake, 'administracion');
  manager = seedUser(fake, {
    id: 'manager',
    permissions: [
      'inventory.view',
      'inventory.count',
      'inventory.adjust',
      'inventory.reserve',
      'inventory.manage',
    ],
  }).currentUser;
  counter = seedUser(fake, {
    id: 'counter',
    permissions: ['inventory.view', 'inventory.count'],
  }).currentUser;
  seedResponsible(fake, { area: 'inventario', userId: 'manager' });
  const centro = seedWarehouse(fake, { key: 'centro', name: 'Bodega Centro' });
  warehouseId = centro.warehouse.id;
  generalId = centro.general.id;
  otherWarehouseId = seedWarehouse(fake, { key: 'norte', name: 'Bodega Norte' }).warehouse.id;
  seedProduct(fake, { zohoItemId: ITEM, name: 'Loseta Perla', sku: 'LOS-PER', unit: 'M2' });
  seedProfile(fake, {
    zohoItemId: ITEM,
    baseUnit: 'm2',
    confidence: 'CONTROLLED',
    consecutiveGoodCounts: 2,
    tolerancePct: 2,
  });
  seedStockItem(fake, {
    id: 'stock-1',
    zohoItemId: ITEM,
    warehouseId,
    locationId: generalId,
    baseline: 100,
  });
  signIn(manager);
});

/** Counts `countedQty` against the 100 m2 on the books and closes the count. */
async function countAndClose(countedQty: number, actor: CurrentUser = counter): Promise<string> {
  const started = await startStockCount(actor, { warehouseId });
  const countId = (started.data as { count: CountDTO }).count.id;
  await recordStockCountLine(actor, { countId, stockItemId: 'stock-1', countedQty });
  await closeStockCount(actor, { countId });
  return countId;
}

describe('decidir el ajuste de una diferencia dentro de tolerancia', () => {
  it('autoriza el ajuste, mueve el libro y cierra el trabajo que lo pedía', async () => {
    await countAndClose(101);
    const line = countLines()[0];
    expect(line.resolution).toBe('pending');
    const workItem = rows('workItem').find((row) => row.objectType === 'stock_count_line');
    expect(workItem).toBeDefined();

    const result = await decideCountAdjustmentAction({
      lineId: String(line.id),
      decision: 'approve',
      note: 'Sobraba una pieza en el rack',
    });

    expect(result).toMatchObject({ ok: true });
    expect(countLines()[0].resolution).toBe('adjusted');
    expect(String(stockRow('stock-1').knownQty)).toBe('101');
    expect(
      rows('stockMovement').some(
        (movement) => movement.kind === 'adjust' && movement.referenceId === line.id
      )
    ).toBe(true);
    expect(rows('workItem').find((row) => row.id === workItem!.id)?.status).toBe('done');
  });

  it('rechazar conserva el saldo en libros y no registra movimiento', async () => {
    await countAndClose(101);
    const line = countLines()[0];

    const result = await decideCountAdjustmentAction({
      lineId: String(line.id),
      decision: 'reject',
    });

    expect(result.ok).toBe(true);
    expect(countLines()[0].resolution).toBe('accepted');
    expect(String(stockRow('stock-1').knownQty)).toBe('100');
    expect(rows('stockMovement').some((movement) => movement.kind === 'adjust')).toBe(false);
  });

  it('sin el permiso de ajustar la acción se niega antes de tocar nada', async () => {
    await countAndClose(101);
    const line = countLines()[0];
    signIn(counter);

    const result = await decideCountAdjustmentAction({
      lineId: String(line.id),
      decision: 'approve',
    });

    expect(result).toStrictEqual({
      ok: false,
      error: 'No tienes permiso para ajustar inventario',
    });
    expect(countLines()[0].resolution).toBe('pending');
  });
});

describe('resolver una diferencia en disputa', () => {
  it('devuelve el artículo a PROVISIONAL y ajusta a la cantidad reconfirmada', async () => {
    await countAndClose(150);
    const line = countLines()[0];
    expect(line.resolution).toBe('disputed');
    expect(profile().confidence).toBe('DISPUTED');

    const result = await resolveCountDisputeAction({
      lineId: String(line.id),
      decision: 'adjust',
      confirmedQty: '140',
      note: 'Recontado con dos personas: hay 140',
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.data.disputeResolved).toBe(true);
    expect(countLines()[0].resolution).toBe('adjusted');
    expect(String(stockRow('stock-1').knownQty)).toBe('140');
    expect(profile().confidence).toBe('PROVISIONAL');
  });

  it('conservar el saldo en libros también cierra la disputa', async () => {
    await countAndClose(150);
    const line = countLines()[0];

    const result = await resolveCountDisputeAction({
      lineId: String(line.id),
      decision: 'keep_book',
      note: 'El conteo se capturó en la ubicación equivocada',
    });

    expect(result.ok).toBe(true);
    expect(countLines()[0].resolution).toBe('accepted');
    expect(String(stockRow('stock-1').knownQty)).toBe('100');
    expect(profile().confidence).toBe('PROVISIONAL');
  });

  it('sin explicación no se resuelve: el motor exige la nota', async () => {
    await countAndClose(150);
    const line = countLines()[0];

    const result = await resolveCountDisputeAction({
      lineId: String(line.id),
      decision: 'adjust',
      note: '   ',
    });

    expect(result.ok).toBe(false);
    expect(countLines()[0].resolution).toBe('disputed');
    expect(profile().confidence).toBe('DISPUTED');
  });
});

describe('movimientos capturados desde el producto', () => {
  it('una entrada suma al libro y deja su movimiento', async () => {
    const result = await recordStockActionAction({
      kind: 'receipt',
      zohoItemId: ITEM,
      warehouseId,
      quantity: '20',
      unit: 'm2',
      reason: 'Devolución de obra',
      reference: 'REM-88',
    });

    expect(result).toMatchObject({ ok: true });
    expect(String(stockRow('stock-1').knownQty)).toBe('120');
    const movement = rows('stockMovement').find((row) => row.kind === 'receipt');
    expect(movement).toMatchObject({ referenceType: 'manual', referenceId: 'REM-88' });
  });

  it('una salida resta del libro', async () => {
    const result = await recordStockActionAction({
      kind: 'issue',
      zohoItemId: ITEM,
      warehouseId,
      quantity: '15',
      unit: 'm2',
    });

    expect(result.ok).toBe(true);
    expect(String(stockRow('stock-1').knownQty)).toBe('85');
  });

  it('un traspaso es un solo comando con salida y entrada', async () => {
    const result = await recordStockActionAction({
      kind: 'transfer',
      zohoItemId: ITEM,
      warehouseId,
      toWarehouseId: otherWarehouseId,
      quantity: '30',
      unit: 'm2',
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.data.movementIds).toHaveLength(2);
    expect(String(stockRow('stock-1').knownQty)).toBe('70');
    const destination = rows('stockItem').find((row) => row.warehouseId === otherWarehouseId);
    expect(String(destination?.knownQty)).toBe('30');
  });

  it('el ajuste lleva signo y exige el permiso de ajustar', async () => {
    signIn(counter);
    const denied = await recordStockActionAction({
      kind: 'adjust',
      zohoItemId: ITEM,
      warehouseId,
      quantity: '-5',
      reason: 'Merma encontrada',
    });
    expect(denied).toStrictEqual({
      ok: false,
      error: 'No tienes permiso para ajustar inventario',
    });

    signIn(manager);
    const done = await recordStockActionAction({
      kind: 'adjust',
      zohoItemId: ITEM,
      warehouseId,
      quantity: '-5',
      unit: 'm2',
      reason: 'Merma encontrada',
    });
    expect(done).toMatchObject({ ok: true });
    expect(String(stockRow('stock-1').knownQty)).toBe('95');
  });

  it('bloquear y desbloquear actúan sobre una fila concreta', async () => {
    const blocked = await recordStockActionAction({
      kind: 'block',
      zohoItemId: ITEM,
      warehouseId,
      stockItemId: 'stock-1',
      quantity: '10',
      unit: 'm2',
      reason: 'Material mojado en revisión',
    });
    expect(blocked).toMatchObject({ ok: true });
    expect(String(stockRow('stock-1').blocked)).toBe('10');

    const released = await recordStockActionAction({
      kind: 'unblock',
      zohoItemId: ITEM,
      warehouseId,
      stockItemId: 'stock-1',
      quantity: '4',
      unit: 'm2',
      reason: 'Se secó y pasó calidad',
    });
    expect(released).toMatchObject({ ok: true });
    expect(String(stockRow('stock-1').blocked)).toBe('6');
  });
});

describe('reclamos legados', () => {
  it('se registra, resta del disponible y se confirma contra la necesidad de un expediente', async () => {
    const claimed = await claimLegacyStockAction({
      zohoItemId: ITEM,
      warehouseId,
      quantity: '25',
      unit: 'm2',
      source: 'pre_cutover_order',
      reference: 'SO-9001 (antes del corte)',
    });

    expect(claimed).toMatchObject({ ok: true });
    expect(claimed.ok && claimed.data.availableAfter).toBe('75');
    const claim = rows('legacyCommitmentClaim')[0];
    expect(claim).toMatchObject({ status: 'claimed', reference: 'SO-9001 (antes del corte)' });

    const demand = seedDemand(fake, {
      caseId: 'case-1',
      zohoItemId: ITEM,
      quantity: 25,
      unit: 'm2',
    });
    const confirmed = await confirmLegacyClaimAction({
      claimId: String(claim.id),
      caseId: 'case-1',
      demandId: String(demand.id),
    });

    expect(confirmed).toMatchObject({ ok: true });
    expect(rows('legacyCommitmentClaim')[0].status).toBe('confirmed');
    expect(rows('stockReservation').some((row) => row.demandId === demand.id)).toBe(true);
  });

  it('liberarlo devuelve la cantidad al disponible', async () => {
    const claimed = await claimLegacyStockAction({
      zohoItemId: ITEM,
      warehouseId,
      quantity: '25',
      source: 'verbal',
      reference: 'Acuerdo con don Julio',
    });
    expect(claimed.ok).toBe(true);
    const claim = rows('legacyCommitmentClaim')[0];

    const released = await releaseLegacyClaimAction({
      claimId: String(claim.id),
      reason: 'El cliente compró en otro lado',
    });

    expect(released).toMatchObject({ ok: true });
    expect(rows('legacyCommitmentClaim')[0].status).toBe('released');
  });

  it('sin el permiso de reservar no se compromete nada', async () => {
    signIn(counter);
    const result = await claimLegacyStockAction({
      zohoItemId: ITEM,
      warehouseId,
      quantity: '5',
      source: 'other',
      reference: 'Prueba',
    });

    expect(result).toStrictEqual({
      ok: false,
      error: 'No tienes permiso para reservar ni comprometer inventario',
    });
    expect(rows('legacyCommitmentClaim')).toHaveLength(0);
  });
});

describe('sesión', () => {
  it('sin sesión ninguna acción escribe', async () => {
    mocks.session.value = null;
    const result = await recordStockActionAction({
      kind: 'receipt',
      zohoItemId: ITEM,
      warehouseId,
      quantity: '10',
    });

    expect(result).toStrictEqual({
      ok: false,
      error: 'Tu sesión expiró; vuelve a iniciar sesión',
    });
    expect(rows('stockMovement')).toHaveLength(0);
  });
});
