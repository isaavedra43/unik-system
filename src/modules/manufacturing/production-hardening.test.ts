import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Manufacturing hardening on FakePrisma with the real inventory (review of
 * phase 4): a release never gives back material nobody consumed, the intake
 * never turns a product into itself and uses the active BOM (grossed up by its
 * scrap and yield), the balance counts each substitute once and the input of
 * defective pieces, a demand without allocation still gets its reservation,
 * committed stock is not consumed by over-consumption, a prepared order keeps
 * its work center, cancelling cancels pending incident approvals, a draft does
 * not advance the case and the group lock is taken before the row counter.
 */

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('./testing/manufacturing-fixtures');
  const inventory = await import('@/modules/inventory/testing/inventory-fixtures');
  const fake = fixtures.createManufacturingFake();
  const locks = inventory.createLockEmulation(fake);
  const lockCalls: string[] = [];
  const lockModule = locks.module as Record<string, (...args: never[]) => Promise<unknown>>;
  for (const name of ['lockStockItem', 'lockStockItemsForProduct'] as const) {
    const original = lockModule[name];
    lockModule[name] = (async (...args: never[]) => {
      lockCalls.push(name);
      return original(...args);
    }) as never;
  }
  return {
    fake,
    locks,
    lockCalls,
    notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({ id: '1', channel: '', type: '', payload: {}, createdAt: '' })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/inventory/inventory-locks', () => mocks.locks.module);
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  wakeJobWorker: vi.fn(),
  registerJobHandler: vi.fn(),
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: vi.fn() }));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const { withManufacturingPermissions } = await import('./testing/permissions-mock');
  return withManufacturingPermissions(await importOriginal<typeof import('@/modules/auth/permissions')>());
});

import type { ProductionOrder } from '@prisma/client';
import { seedProduct, seedProfile } from '@/modules/inventory/testing/inventory-fixtures';
import type { CommandResult } from '@/modules/operations/commands';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import {
  cancelProductionOrder,
  createTransformationOrder,
  finishOperation,
  inspectProductionOrder,
  prepareProductionOrder,
  recordConsumption,
  recordOutput,
  releaseProductionOrder,
  reserveMaterials,
  scheduleProductionOrder,
  startOperation,
} from './manufacturing-commands';
import { unitsResolver, type Db } from './manufacturing-helpers';
import { runIntakeRequestJob } from './manufacturing-jobs';
import { traceStockItem } from './manufacturing-queries';
import { loadProductionFacts } from './production-facts';
import {
  D,
  MFG_NOW,
  WAREHOUSE_ID,
  makeManufacturingJob,
  seedManufactureAllocation,
  seedManufacturingTeam,
  seedMaterial,
  seedWorkCenterRow,
  type ManufacturingTeam,
} from './testing/manufacturing-fixtures';

const { fake, locks, lockCalls } = mocks;
let team: ManufacturingTeam;
const at = (minutes: number) => ({ now: new Date(MFG_NOW.getTime() + minutes * 60_000) });
const rows = (model: string) => fake.rows(model);
const row = (model: string, id: string) => {
  const found = rows(model).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`${model} ${id} not found`);
  return found;
};

async function ok<T>(promise: Promise<CommandResult<T>>): Promise<T> {
  const result = await promise;
  if (result.status === 'rejected') throw new Error(`Comando rechazado ${result.errorCode}: ${result.message}`);
  return result.data as T;
}

function seedOutput(zohoItemId: string, unit: string) {
  seedProduct(fake, { zohoItemId, name: `Producto ${zohoItemId}`, sku: zohoItemId.toUpperCase(), unit });
  seedProfile(fake, { zohoItemId, baseUnit: unit, confidence: 'CONTROLLED' });
}

/** Order created with its materials reserved, prepared and with its operation started. */
async function startedOrder(input: Record<string, unknown>) {
  const created = await ok(createTransformationOrder(team.planner, { workCenterId: 'wc_corte', reserveNow: true, ...input } as never, at(0)));
  const orderId = created.productionOrderId;
  await ok(prepareProductionOrder(team.planner, { productionOrderId: orderId }, at(1)));
  const started = await ok(startOperation(team.operator, { productionOrderId: orderId }, at(2)));
  return { orderId, operationId: started.operationId, created };
}

beforeEach(() => {
  fake.tables.clear();
  locks.reset();
  lockCalls.length = 0;
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  team = seedManufacturingTeam(fake);
  seedWorkCenterRow(fake);
});

describe('liberación', () => {
  it('no libera material asignado sin consumo ni merma sin base (m² → piezas)', async () => {
    seedMaterial(fake, { zohoItemId: 'lamina', quantity: 50, name: 'Lámina' });
    seedOutput('caja', 'pz');
    const link = seedManufactureAllocation(fake, { zohoItemId: 'caja', quantity: 4, unit: 'pz', withRequest: false });
    const { orderId, operationId } = await startedOrder({ demandAllocationId: link.allocation.id, inputs: [{ zohoItemId: 'lamina', qty: 10, unit: 'm2' }] });
    await ok(finishOperation(team.operator, { productionOrderId: orderId, operationId }, at(3)));
    await ok(inspectProductionOrder(team.inspector, { productionOrderId: orderId, result: 'pass' }, at(4)));
    await ok(recordOutput(team.operator, { productionOrderId: orderId, kind: 'finished', qty: 4 }, at(5)));
    await ok(recordOutput(team.operator, { productionOrderId: orderId, kind: 'scrap', zohoItemId: 'lamina', qty: 6 }, at(6)));

    const blocked = await releaseProductionOrder(team.planner, { productionOrderId: orderId }, at(7));
    expect(blocked).toMatchObject({ status: 'rejected', errorCode: 'release_blocked' });
    expect(blocked.message).toContain('No se registró el consumo de');
    expect(blocked.message).toContain('merma registrada de un material sin consumo');
    expect(Number(rows('stockItem').find((s) => s.zohoItemId === 'lamina')!.assignedToProduction)).toBe(10);

    await ok(recordConsumption(team.operator, { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 10 }] }, at(8)));
    const again = await ok(releaseProductionOrder(team.planner, { productionOrderId: orderId }, at(9)));
    expect(again.blockers.map((b) => b.code)).not.toContain('not_consumed');
    expect(again.blockers.map((b) => b.code)).not.toContain('scrap_pending');
  });

  it('una orden de una partida sin asignación de manufactura reserva lo producido para esa venta', async () => {
    seedMaterial(fake, { zohoItemId: 'lamina', quantity: 50 });
    seedOutput('placa', 'm2');
    const link = seedManufactureAllocation(fake, { zohoItemId: 'placa', quantity: 20, withRequest: false });
    const { orderId, operationId } = await startedOrder({
      caseId: link.opCase.id,
      demandId: link.demand.id,
      outputZohoItemId: 'placa',
      plannedQty: 20,
      plannedUnit: 'm2',
      inputs: [{ zohoItemId: 'lamina', qty: 20, unit: 'm2' }],
    });
    await ok(recordConsumption(team.operator, { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 20 }] }, at(3)));
    await ok(finishOperation(team.operator, { productionOrderId: orderId, operationId }, at(4)));
    await ok(inspectProductionOrder(team.inspector, { productionOrderId: orderId, result: 'pass' }, at(5)));
    await ok(recordOutput(team.operator, { productionOrderId: orderId, kind: 'finished', qty: 20 }, at(6)));
    const released = await ok(releaseProductionOrder(team.planner, { productionOrderId: orderId }, at(7)));
    expect(released).toMatchObject({ released: true });
    expect(released.reservationId).toBeTruthy();
    expect(rows('stockReservation').find((r) => r.id === released.reservationId)).toMatchObject({
      demandId: link.demand.id,
      allocationId: null,
      status: 'active',
    });
  });
});

describe('toma de solicitudes de transformación', () => {
  it('nunca fabrica un producto a partir de sí mismo y usa la BOM activa con su merma y rendimiento', async () => {
    seedMaterial(fake, { zohoItemId: 'lamina', quantity: 200 });
    seedOutput('placa', 'm2');
    const self = seedManufactureAllocation(fake, { caseId: 'case_1', zohoItemId: 'placa', quantity: 10 });
    const blocked = await runIntakeRequestJob(makeManufacturingJob({ requestId: self.request!.id as string }), at(0));
    expect(blocked).toMatchObject({ outcome: 'request_blocked' });
    expect(row('areaRequest', self.request!.id as string).status).toBe('blocked');
    expect(rows('productionOrder')).toHaveLength(0);
    expect(rows('areaRequest').filter((r) => r.kind === 'material_shortfall')).toHaveLength(0);

    fake.seed('bom', { id: 'bom_placa', outputZohoItemId: 'placa', kind: 'assembly', status: 'active', outputQty: D(1), outputUnit: 'm2', expectedYield: D(0.95), scrapAllowancePct: D(5) });
    fake.seed('bomLine', { bomId: 'bom_placa', inputZohoItemId: 'lamina', qtyPerOutput: D(1), unit: 'm2', scrapPct: D(5) });
    fake.seed('bomOperation', { bomId: 'bom_placa', seq: 1, workCenterId: 'wc_corte', name: 'Corte', stdMinutes: 2 });
    const fromBom = seedManufactureAllocation(fake, { caseId: 'case_2', zohoItemId: 'placa', quantity: 10 });
    const created = await runIntakeRequestJob(makeManufacturingJob({ requestId: fromBom.request!.id as string }, 'job_bom'), at(1));
    expect(created).toMatchObject({ outcome: 'created' });
    const order = rows('productionOrder').find((o) => o.demandAllocationId === fromBom.allocation.id)!;
    expect(order).toMatchObject({ kind: 'bom', bomId: 'bom_placa', status: 'reserved' });
    const assigned = rows('materialConsumption')
      .filter((c) => c.productionOrderId === order.id && c.kind === 'planned')
      .reduce((sum, c) => sum + Number(c.qtyPlanned), 0);
    // 10 m² × 1.05 expected scrap ÷ 0.95 yield.
    expect(assigned).toBeCloseTo(11.05, 2);
  });

  it('rechaza una transformación del producto sobre sí mismo salvo confirmación expresa', async () => {
    seedMaterial(fake, { zohoItemId: 'placa', quantity: 30 });
    const rejected = await createTransformationOrder(team.planner, { outputZohoItemId: 'placa', plannedQty: 5, inputs: [{ zohoItemId: 'placa', qty: 5 }] }, at(0));
    expect(rejected).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
    const cut = await createTransformationOrder(team.planner, { outputZohoItemId: 'placa', plannedQty: 5, inputs: [{ zohoItemId: 'placa', qty: 5 }], allowSameItem: true }, at(1));
    expect(cut.status).toBe('completed');
  });
});

describe('balance de material', () => {
  async function factsFor(order: Record<string, unknown>, consumptions: Array<Record<string, unknown>>, outputs: Array<Record<string, unknown>>) {
    const seeded = fake.seed('productionOrder', {
      id: 'op_seed',
      number: 'OP-900001',
      outputZohoItemId: 'placa',
      plannedQty: D(10),
      plannedUnit: 'm2',
      status: 'completed',
      inputs: [{ zohoItemId: 'lamina', qty: 10, unit: 'm2', substituteZohoItemIds: [] }],
      outputWarehouseId: WAREHOUSE_ID,
      releaseTarget: 'inventory',
      priority: 'normal',
      createdByUserId: 'u_planner',
      ...order,
    });
    for (const consumption of consumptions) {
      fake.seed('materialConsumption', { productionOrderId: 'op_seed', unit: 'm2', recordedByUserId: 'u_operator', ...consumption });
    }
    for (const output of outputs) fake.seed('productionOutput', { productionOrderId: 'op_seed', unit: 'm2', recordedByUserId: 'u_operator', ...output });
    const db = fake.client as unknown as Db;
    return loadProductionFacts(db, seeded as unknown as ProductionOrder, unitsResolver(db, 'read'));
  }

  it('cuenta una vez un sustituto consumido en varias filas', async () => {
    seedMaterial(fake, { zohoItemId: 'lamina', quantity: 0 });
    seedMaterial(fake, { zohoItemId: 'sustituto', quantity: 20 });
    seedOutput('placa', 'm2');
    const facts = await factsFor(
      {},
      [
        { kind: 'substitution', inputZohoItemId: 'sustituto', substitutedForZohoItemId: 'lamina', qtyActual: D(5), stockMovementId: 'mv_1' },
        { kind: 'substitution', inputZohoItemId: 'sustituto', substitutedForZohoItemId: 'lamina', qtyActual: D(5), stockMovementId: 'mv_2' },
      ],
      [{ kind: 'finished', zohoItemId: 'placa', qty: D(10) }]
    );
    expect(facts.balance.lines[0]).toMatchObject({ consumed: 10, accounted: 10, difference: 0 });
    expect(facts.balance.balanced).toBe(true);
  });

  it('las piezas defectuosas del producto usaron material: el balance cuadra', async () => {
    seedMaterial(fake, { zohoItemId: 'lamina', quantity: 0, tolerancePct: 1 });
    seedOutput('placa', 'm2');
    const facts = await factsFor(
      {},
      [{ kind: 'actual', inputZohoItemId: 'lamina', qtyActual: D(10), qtyPlanned: D(10), stockMovementId: 'mv_1' }],
      [
        { kind: 'finished', zohoItemId: 'placa', qty: D(9.8) },
        { kind: 'scrap', zohoItemId: 'placa', qty: D(0.2) },
      ]
    );
    expect(facts.balance.lines[0]).toMatchObject({ expectedUse: 10, difference: 0 });
    expect(facts.balance.balanced).toBe(true);
  });
});

describe('piso de producción', () => {
  it('toma el candado del grupo antes que el contador; no consume existencia comprometida ni de otra bodega', async () => {
    const { stockItem } = seedMaterial(fake, { zohoItemId: 'lamina', quantity: 200 });
    seedOutput('placa', 'm2');
    const { orderId } = await startedOrder({ outputZohoItemId: 'placa', plannedQty: 100, plannedUnit: 'm2', inputs: [{ zohoItemId: 'lamina', qty: 105, unit: 'm2' }] });
    const other = seedMaterial(fake, { zohoItemId: 'lamina', quantity: 50, warehouseId: 'wh_otro' });

    lockCalls.length = 0;
    await ok(recordConsumption(team.operator, { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 10 }] }, at(3)));
    const firstGroup = lockCalls.indexOf('lockStockItemsForProduct');
    const firstRow = lockCalls.indexOf('lockStockItem');
    expect(firstGroup).toBeGreaterThanOrEqual(0);
    expect(firstRow === -1 || firstGroup < firstRow).toBe(true);

    const outside = await recordConsumption(
      team.operator,
      { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 200, stockItemId: other.stockItem.id as string }] },
      at(4)
    );
    expect(outside.status).toBe('rejected');

    // The rest of the principal row is promised to other sales: over-consumption does not take it.
    row('stockItem', stockItem.id as string).reserved = D(95);
    const committed = await recordConsumption(
      team.operator,
      { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 110, stockItemId: stockItem.id as string }] },
      at(5)
    );
    expect(committed).toMatchObject({ status: 'rejected', errorCode: 'insufficient_stock' });
    expect(committed.message).toContain('comprometida');
  });

  it('una orden preparada no cambia de centro; cancelar cancela sus aprobaciones de sustitución pendientes', async () => {
    seedMaterial(fake, { zohoItemId: 'lamina', quantity: 200 });
    seedMaterial(fake, { zohoItemId: 'lamina_b', quantity: 30 });
    seedOutput('placa', 'm2');
    seedWorkCenterRow(fake, { id: 'wc_otro', key: 'otro', name: 'Otro centro' });
    const created = await ok(
      createTransformationOrder(team.planner, { outputZohoItemId: 'placa', plannedQty: 10, plannedUnit: 'm2', inputs: [{ zohoItemId: 'lamina', qty: 10 }], workCenterId: 'wc_corte', reserveNow: true }, at(0))
    );
    const orderId = created.productionOrderId;
    await ok(prepareProductionOrder(team.planner, { productionOrderId: orderId }, at(1)));
    const moved = await scheduleProductionOrder(team.planner, { productionOrderId: orderId, workCenterId: 'wc_otro' }, at(2));
    expect(moved).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });

    await ok(startOperation(team.operator, { productionOrderId: orderId }, at(3)));
    await ok(recordConsumption(team.operator, { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina_b', qty: 3, substituteFor: 'lamina' }] }, at(4)));
    const approval = rows('approvalRequest').find((a) => a.targetType === 'material_consumption' && a.status === 'pending')!;
    expect(approval).toBeTruthy();
    await ok(cancelProductionOrder(team.planner, { productionOrderId: orderId, reason: 'El cliente canceló la venta' }, at(5)));
    expect(row('approvalRequest', approval.id as string).status).toBe('cancelled');
    expect(rows('workItem').filter((w) => w.objectType === 'approval_request' && w.objectId === approval.id).every((w) => w.status === 'cancelled')).toBe(true);
  });

  it('un borrador no compromete la asignación del expediente hasta reservar', async () => {
    seedMaterial(fake, { zohoItemId: 'lamina', quantity: 200 });
    seedOutput('placa', 'm2');
    const link = seedManufactureAllocation(fake, { zohoItemId: 'placa', quantity: 10, withRequest: false });
    const draft = await ok(
      createTransformationOrder(team.planner, { demandAllocationId: link.allocation.id as string, inputs: [{ zohoItemId: 'lamina', qty: 10 }], workCenterId: 'wc_corte' }, at(0))
    );
    expect(draft.status).toBe('draft');
    expect(row('demandAllocation', link.allocation.id as string)).toMatchObject({ status: 'planned', linkedId: null });
    await ok(reserveMaterials(team.planner, { productionOrderId: draft.productionOrderId }, at(1)));
    expect(row('demandAllocation', link.allocation.id as string)).toMatchObject({
      status: 'requested',
      linkedType: 'production_order',
      linkedId: draft.productionOrderId,
    });
  });
});

describe('trazabilidad', () => {
  it('una fila con producto de varias órdenes lista todas y rastrea la más reciente', async () => {
    const { stockItem } = seedMaterial(fake, { zohoItemId: 'placa', quantity: 0 });
    for (const [index, id] of ['op_a', 'op_b'].entries()) {
      fake.seed('productionOrder', {
        id,
        number: `OP-00010${index}`,
        outputZohoItemId: 'placa',
        plannedQty: D(5),
        plannedUnit: 'm2',
        status: 'released',
        inputs: [{ zohoItemId: 'lamina', qty: 5, unit: 'm2' }],
        outputWarehouseId: WAREHOUSE_ID,
        releaseTarget: 'inventory',
        priority: 'normal',
        createdByUserId: 'u_planner',
      });
      fake.seed('stockMovement', {
        stockItemId: stockItem.id,
        zohoItemId: 'placa',
        warehouseId: WAREHOUSE_ID,
        kind: 'produce',
        quantity: D(5 + index),
        originalQuantity: D(5 + index),
        originalUnit: 'm2',
        referenceType: 'production_order',
        referenceId: id,
        actorId: 'u_operator',
        occurredAt: new Date(MFG_NOW.getTime() + index * 60_000),
      });
    }
    row('stockItem', stockItem.id as string).originProductionOrderId = 'op_a';
    const trace = await traceStockItem(team.viewer, stockItem.id as string);
    expect(trace.productions.map((p) => [p.number, p.quantity])).toEqual([
      ['OP-000101', '6'],
      ['OP-000100', '5'],
    ]);
    expect(trace.production?.order.number).toBe('OP-000101');
  });
});
