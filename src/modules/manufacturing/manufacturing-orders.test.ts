import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Manufacturing on FakePrisma: intake of the case engine's transformation
 * requests, capacity planning with overload warnings (schedule and hourly job),
 * versioned BOMs with orders from the active revision and quality gates,
 * release to logistics, queries of the board and permissions.
 */

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('./testing/manufacturing-fixtures');
  const inventory = await import('@/modules/inventory/testing/inventory-fixtures');
  const fake = fixtures.createManufacturingFake();
  return {
    fake,
    locks: inventory.createLockEmulation(fake),
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
vi.mock('@/modules/inventory/inventory-locks', () => mocks.locks.module);
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  wakeJobWorker: vi.fn(),
  registerJobHandler: vi.fn(),
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: vi.fn() }));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const { withManufacturingPermissions } = await import('./testing/permissions-mock');
  return withManufacturingPermissions(
    await importOriginal<typeof import('@/modules/auth/permissions')>()
  );
});

import { AuthorizationError } from '@/modules/auth/authorization';
import { seedProduct, seedProfile } from '@/modules/inventory/testing/inventory-fixtures';
import { executeCommand, type CommandResult } from '@/modules/operations/commands';
import type { OperationalEventRecord } from '@/modules/operations/events-service';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import {
  activateBom,
  createBom,
  createProductionOrderFromBom,
  createTransformationOrder,
  finishOperation,
  inspectProductionOrder,
  planManufacturingJobs,
  prepareProductionOrder,
  recordConsumption,
  recordOutput,
  releaseProductionOrder,
  reserveMaterials,
  runManufacturingSystemCommand,
  startOperation,
  updateBomDraft,
} from './manufacturing-commands';
import { runCapacityAlertsJob, runIntakeRequestJob } from './manufacturing-jobs';
import {
  getProductionBoard,
  getWorkCenterLoad,
  listBoms,
  listProductionOrders,
  listWorkCenters,
} from './manufacturing-queries';
import { MANUFACTURING_COMMANDS } from './manufacturing-types';
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

const { fake, locks } = mocks;
let team: ManufacturingTeam;

const at = (minutes: number) => ({ now: new Date(MFG_NOW.getTime() + minutes * 60_000) });
const rows = (model: string) => fake.rows(model);
const row = (model: string, id: string) => {
  const found = fake.rows(model).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`${model} ${id} not found`);
  return found;
};
const num = (value: unknown) => Number(String(value));
const eventsOf = (type: string) =>
  fake.rows('operationalEvent').filter((event) => event.type === type);

async function ok<D>(promise: Promise<CommandResult<D>>): Promise<D> {
  const result = await promise;
  if (result.status === 'rejected')
    throw new Error(`Comando rechazado ${result.errorCode}: ${result.message}`);
  return result.data as D;
}

function event(input: {
  type: string;
  caseId?: string | null;
  payload: Record<string, unknown>;
}): OperationalEventRecord {
  return {
    id: '1',
    type: input.type,
    actorType: 'system',
    actorId: null,
    commandId: null,
    caseId: input.caseId ?? null,
    areaKey: null,
    objectType: null,
    objectId: null,
    payload: input.payload,
    occurredAt: MFG_NOW.toISOString(),
    recordedAt: MFG_NOW.toISOString(),
  };
}

function seedPlacaAndLamina(material = 500) {
  seedMaterial(fake, {
    zohoItemId: 'lamina',
    quantity: material,
    name: 'Lámina MDF',
    sku: 'LAMINA',
  });
  seedProduct(fake, { zohoItemId: 'placa', name: 'Placa 60x60', sku: 'PLACA-60', unit: 'm2' });
  seedProfile(fake, { zohoItemId: 'placa', baseUnit: 'm2', confidence: 'CONTROLLED' });
}

beforeEach(() => {
  fake.tables.clear();
  locks.reset();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  team = seedManufacturingTeam(fake);
  seedWorkCenterRow(fake);
});

describe('intake of transformation requests', () => {
  it('plans the intake job inside the transaction and turns the request into a linked order', async () => {
    seedPlacaAndLamina();
    const { allocation, request } = seedManufactureAllocation(fake, {
      zohoItemId: 'placa',
      quantity: 100,
      sourceSku: 'LAMINA',
      targetSku: 'PLACA-60',
    });
    const jobs = await planManufacturingJobs(fake.client as never, [
      event({
        type: 'request.created',
        caseId: 'case_1',
        payload: { requestId: request!.id, kind: 'transformation', toAreaKey: 'manufactura' },
      }),
      event({
        type: 'request.created',
        caseId: 'case_1',
        payload: { requestId: 'other', kind: 'purchase_shortfall', toAreaKey: 'compras' },
      }),
      event({ type: 'stock.received', payload: { zohoItemId: 'lamina' } }),
    ]);
    expect(jobs).toEqual([
      expect.objectContaining({
        type: 'manufacturing.intake_request',
        payload: { requestId: request!.id },
        dedupeKey: `mfg-intake:${request!.id}`,
        groupKey: 'case:case_1',
      }),
    ]);

    const outcome = await runIntakeRequestJob(
      makeManufacturingJob({ requestId: request!.id as string }),
      at(0)
    );
    expect(outcome).toMatchObject({ outcome: 'created', requestId: request!.id });
    const [order] = rows('productionOrder');
    expect(order).toMatchObject({
      caseId: 'case_1',
      demandAllocationId: allocation.id,
      outputZohoItemId: 'placa',
      status: 'reserved',
      outputWarehouseId: WAREHOUSE_ID,
      inputs: [expect.objectContaining({ zohoItemId: 'lamina', qty: 100, unit: 'm2' })],
    });
    expect(row('areaRequest', request!.id as string).status).toBe('accepted');
    expect(
      rows('objectRelation').find((relation) => relation.relation === 'answers')
    ).toMatchObject({ fromId: order.id, toId: request!.id });
    expect(row('demandAllocation', allocation.id as string)).toMatchObject({
      linkedType: 'area_request',
      linkedId: request!.id,
    });

    const again = await runManufacturingSystemCommand({
      type: MANUFACTURING_COMMANDS.orderIntakeRequest,
      commandId: 'mfg:intake:again',
      aggregate: { type: 'area_request', id: request!.id as string },
      payload: { requestId: request!.id },
    });
    expect(again.data).toMatchObject({ outcome: 'existing', productionOrderId: order.id });
    expect(rows('productionOrder')).toHaveLength(1);
  });

  it('blocks a request whose product is not in the catalog', async () => {
    seedPlacaAndLamina();
    const { request } = seedManufactureAllocation(fake, {
      zohoItemId: 'placa',
      quantity: 10,
      sourceSku: 'NO-EXISTE',
      targetSku: 'placa',
    });
    const outcome = await runIntakeRequestJob(
      makeManufacturingJob({ requestId: request!.id as string }),
      at(0)
    );
    expect(outcome).toMatchObject({ outcome: 'request_blocked', productionOrderId: null });
    expect(row('areaRequest', request!.id as string).status).toBe('blocked');
    expect(rows('productionOrder')).toHaveLength(0);
    expect(await runIntakeRequestJob(makeManufacturingJob({}), at(0))).toMatchObject({
      outcome: 'skipped',
    });
  });

  it('only retries blocked orders when stock arrives or a shortfall request is resolved', async () => {
    expect(
      await planManufacturingJobs(fake.client as never, [
        event({ type: 'stock.received', payload: { zohoItemId: 'x' } }),
      ])
    ).toEqual([]);
    fake.seed('productionOrder', {
      id: 'po_blocked',
      number: 'OP-000900',
      outputZohoItemId: 'placa',
      plannedQty: D(1),
      plannedUnit: 'm2',
      outputWarehouseId: WAREHOUSE_ID,
      createdByUserId: 'u_planner',
      status: 'blocked',
    });
    const jobs = await planManufacturingJobs(fake.client as never, [
      event({ type: 'stock.received', payload: { zohoItemId: 'x' } }),
      event({ type: 'stock.consumed', payload: { zohoItemId: 'y' } }),
      event({ type: 'request.resolved', payload: { requestId: 'r1', kind: 'material_shortfall' } }),
    ]);
    expect(jobs.map((job) => job.dedupeKey)).toEqual(['mfg-retry:request:r1', 'mfg-retry:item:x']);
  });
});

describe('capacity', () => {
  it('flags an order bigger than a shift and warns once per shift', async () => {
    seedPlacaAndLamina();
    const created = await ok(
      createTransformationOrder(
        team.planner,
        {
          outputZohoItemId: 'placa',
          plannedQty: 150,
          inputs: [{ zohoItemId: 'lamina', qty: 155 }],
          workCenterId: 'wc_corte',
        },
        at(0)
      )
    );
    expect(created).toMatchObject({
      status: 'draft',
      outputWarehouseId: WAREHOUSE_ID,
      schedule: { overloaded: true },
    });
    const alert = row('workItem', created.schedule!.alertWorkItemIds[0]);
    expect(alert).toMatchObject({
      areaKey: 'manufactura',
      objectType: 'work_center_shift',
      ownerUserId: 'u_manufactura',
    });
    expect(alert.title).toMatch(/Sobrecarga en Corte: turno Matutino del 2026-09-15/);
    expect(eventsOf('manufacturing.capacity_overloaded')).toHaveLength(1);
  });

  it('plans the next free shift when the current one is full', async () => {
    seedPlacaAndLamina();
    const first = await ok(
      createTransformationOrder(
        team.planner,
        { outputZohoItemId: 'placa', plannedQty: 80, inputs: [{ zohoItemId: 'lamina', qty: 84 }] },
        at(0)
      )
    );
    expect(first.schedule).toMatchObject({
      plannedStartAt: MFG_NOW.toISOString(),
      overloaded: false,
    });
    const second = await ok(
      createTransformationOrder(
        team.planner,
        { outputZohoItemId: 'placa', plannedQty: 40, inputs: [{ zohoItemId: 'lamina', qty: 42 }] },
        at(0)
      )
    );
    expect(second.schedule).toMatchObject({
      plannedStartAt: '2026-09-16T14:00:00.000Z',
      overloaded: false,
    });
    expect(rows('workItem').filter((item) => item.objectType === 'work_center_shift')).toHaveLength(
      0
    );
  });

  it('raises the hourly alert for an overloaded shift only once', async () => {
    for (const [id, qty] of [
      ['po_a', 80],
      ['po_b', 60],
    ] as const) {
      fake.seed('productionOrder', {
        id,
        number: `OP-${id}`,
        outputZohoItemId: 'placa',
        plannedQty: D(qty),
        plannedUnit: 'm2',
        outputWarehouseId: WAREHOUSE_ID,
        createdByUserId: 'u_planner',
        status: 'reserved',
        workCenterId: 'wc_corte',
      });
      fake.seed('productionOperation', {
        id: `op_${id}`,
        productionOrderId: id,
        seq: 1,
        workCenterId: 'wc_corte',
        name: 'Corte',
        status: 'pending',
        plannedStartAt: MFG_NOW,
      });
    }
    const summary = await runCapacityAlertsJob(makeManufacturingJob({}), at(0));
    expect(summary).toMatchObject({ workCenters: 1, overloadedWindows: 1, alerts: 1, rejected: 0 });
    const again = await runCapacityAlertsJob(makeManufacturingJob({}, 'job_2'), at(60));
    expect(again).toMatchObject({ overloadedWindows: 1, alerts: 0 });
    expect(rows('workItem').filter((item) => item.objectType === 'work_center_shift')).toHaveLength(
      1
    );

    const load = await getWorkCenterLoad(team.viewer, { workCenterId: 'wc_corte', days: 1 }, at(0));
    expect(load.windows[0]).toMatchObject({
      shiftName: 'Matutino',
      day: '2026-09-15',
      load: 140,
      capacity: 100,
      overloaded: true,
      utilizationPct: 140,
    });
    expect(load.operations.map((op) => op.number).sort()).toEqual(['OP-po_a', 'OP-po_b']);
  });
});

describe('bills of materials', () => {
  const definition = {
    outputZohoItemId: 'mesa',
    kind: 'assembly' as const,
    outputQty: 1,
    outputUnit: 'pz',
    scrapAllowancePct: 3,
    lines: [
      {
        inputZohoItemId: 'tablero',
        qtyPerOutput: 1.2,
        unit: 'm2',
        substituteZohoItemIds: ['tablero-b'],
      },
      { inputZohoItemId: 'tornillo', qtyPerOutput: 8, unit: 'pz' },
    ],
    operations: [
      {
        seq: 10,
        workCenterId: 'wc_corte',
        name: 'Corte',
        stdMinutes: 20,
        setupMinutes: 10,
        qcRequired: true,
      },
      { seq: 20, workCenterId: 'wc_armado', name: 'Armado', stdMinutes: 15 },
    ],
  };

  function seedAssembly() {
    seedWorkCenterRow(fake, {
      id: 'wc_armado',
      key: 'armado',
      name: 'Armado',
      capacityUnit: 'minutes',
      capacityPerShift: D(480),
    });
    seedProduct(fake, { zohoItemId: 'mesa', name: 'Mesa', unit: 'pz' });
    seedProfile(fake, { zohoItemId: 'mesa', baseUnit: 'pz', confidence: 'CONTROLLED' });
    seedMaterial(fake, { zohoItemId: 'tablero', quantity: 50, unit: 'm2', sku: 'TABLERO' });
    seedMaterial(fake, { zohoItemId: 'tornillo', quantity: 200, unit: 'pz', sku: 'TORNILLO' });
  }

  it('versions BOMs, activates one revision at a time and validates substitutes', async () => {
    seedAssembly();
    const v1 = await ok(createBom(team.planner, definition, at(0)));
    expect(v1).toMatchObject({ version: 1, status: 'draft', kind: 'assembly' });
    expect(v1.lines[0]).toMatchObject({
      inputZohoItemId: 'tablero',
      qtyPerOutput: '1.2',
      substituteZohoItemIds: ['tablero-b'],
    });
    expect(v1.operations.map((op) => [op.seq, op.qcRequired])).toEqual([
      [10, true],
      [20, false],
    ]);
    const v2 = await ok(createBom(team.planner, definition, at(1)));
    expect(v2.version).toBe(2);

    const invalid = await createBom(team.planner, {
      ...definition,
      lines: [
        {
          inputZohoItemId: 'tablero',
          qtyPerOutput: 1,
          unit: 'm2',
          substituteZohoItemIds: ['tablero'],
        },
      ],
    });
    expect(invalid).toMatchObject({ status: 'rejected', errorCode: 'bom_invalid' });
    expect(
      await createBom(team.planner, {
        ...definition,
        operations: [{ seq: 1, workCenterId: 'wc_x', name: 'X', stdMinutes: 1 }],
      })
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'bom_invalid',
    });
    expect(await createBom(team.operator, definition)).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });

    const edited = await ok(
      updateBomDraft(team.planner, { ...definition, bomId: v2.id, scrapAllowancePct: 4 }, at(2))
    );
    expect(edited.scrapAllowancePct).toBe('4');
    await ok(activateBom(team.planner, { bomId: v1.id }, at(3)));
    expect((await ok(activateBom(team.planner, { bomId: v2.id }, at(4)))).status).toBe('active');
    expect(row('bom', v1.id).status).toBe('retired');
    expect(eventsOf('manufacturing.bom_retired')).toHaveLength(1);
    expect(await activateBom(team.planner, { bomId: v1.id }, at(5))).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
    });
    expect(
      await updateBomDraft(team.planner, { ...definition, bomId: v2.id }, at(6))
    ).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });

    const page = await listBoms(team.viewer, { outputZohoItemId: 'mesa' });
    expect(page.rows.map((bom) => [bom.version, bom.status])).toEqual([
      [2, 'active'],
      [1, 'retired'],
    ]);
  });

  it('creates an order from the active BOM with planned minutes and a quality gate between operations', async () => {
    seedAssembly();
    const bom = await ok(createBom(team.planner, definition, at(0)));
    await ok(activateBom(team.planner, { bomId: bom.id }, at(0)));
    const created = await ok(
      createProductionOrderFromBom(
        team.planner,
        { outputZohoItemId: 'mesa', plannedQty: 10, reserveNow: true },
        at(1)
      )
    );
    expect(created).toMatchObject({ kind: 'bom', status: 'reserved', workCenterId: 'wc_corte' });
    const orderId = created.productionOrderId;
    const ops = rows('productionOperation').sort((a, b) => Number(a.seq) - Number(b.seq));
    expect(ops.map((op) => [op.seq, op.name, op.workCenterId, op.plannedMinutes])).toEqual([
      [10, 'Corte', 'wc_corte', 210],
      [20, 'Armado', 'wc_armado', 150],
    ]);
    const stock = (item: string) =>
      rows('stockItem').find((candidate) => candidate.zohoItemId === item)!;
    expect([
      num(stock('tablero').assignedToProduction),
      num(stock('tornillo').assignedToProduction),
    ]).toEqual([12, 80]);

    await ok(prepareProductionOrder(team.planner, { productionOrderId: orderId }, at(2)));
    const first = await ok(startOperation(team.operator, { productionOrderId: orderId }, at(3)));
    expect(first.operationId).toBe(ops[0].id);
    await ok(
      finishOperation(
        team.operator,
        { productionOrderId: orderId, operationId: first.operationId },
        at(30)
      )
    );
    expect(
      rows('workItem').find((item) => item.objectType === 'production_operation')
    ).toMatchObject({ kind: 'verification', objectId: first.operationId });
    expect(
      await startOperation(
        team.operator,
        { productionOrderId: orderId, operationId: ops[1].id as string },
        at(31)
      )
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'operation_sequence',
    });
    await ok(
      inspectProductionOrder(
        team.inspector,
        { productionOrderId: orderId, operationId: first.operationId, result: 'pass' },
        at(32)
      )
    );
    expect(
      (await ok(startOperation(team.operator, { productionOrderId: orderId }, at(33)))).operationId
    ).toBe(ops[1].id);

    // A substitute listed in the BOM is consumed without approval.
    seedMaterial(fake, { zohoItemId: 'tablero-b', quantity: 5, unit: 'm2', sku: 'TABLERO-B' });
    const consumption = await ok(
      recordConsumption(
        team.operator,
        { productionOrderId: orderId, lines: [{ zohoItemId: 'tablero-b', qty: 2 }] },
        at(34)
      )
    );
    expect(consumption.lines[0]).toMatchObject({
      role: 'declared_substitute',
      approvalRequestId: null,
    });
  });
});

describe('release to logistics, queries and permissions', () => {
  async function completedOrder(releaseTarget: 'inventory' | 'logistics') {
    seedPlacaAndLamina();
    const { allocation } = seedManufactureAllocation(fake, {
      zohoItemId: 'placa',
      quantity: 20,
      withRequest: false,
    });
    const created = await ok(
      createTransformationOrder(
        team.planner,
        {
          demandAllocationId: allocation.id as string,
          inputs: [{ zohoItemId: 'lamina', qty: 20 }],
          workCenterId: 'wc_corte',
          releaseTarget,
          reserveNow: true,
        },
        at(0)
      )
    );
    const orderId = created.productionOrderId;
    expect(row('demandAllocation', allocation.id as string)).toMatchObject({
      linkedType: 'production_order',
      linkedId: orderId,
    });
    await ok(prepareProductionOrder(team.planner, { productionOrderId: orderId }, at(1)));
    const started = await ok(startOperation(team.operator, { productionOrderId: orderId }, at(2)));
    await ok(
      recordConsumption(
        team.operator,
        { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 20 }] },
        at(3)
      )
    );
    await ok(
      finishOperation(
        team.operator,
        { productionOrderId: orderId, operationId: started.operationId },
        at(4)
      )
    );
    await ok(
      inspectProductionOrder(team.inspector, { productionOrderId: orderId, result: 'pass' }, at(5))
    );
    await ok(
      recordOutput(team.operator, { productionOrderId: orderId, kind: 'finished', qty: 20 }, at(6))
    );
    return { orderId, allocation };
  }

  it('released to logistics: the allocation is ready and the case engine plans the whole delivery (no partial order)', async () => {
    const { orderId, allocation } = await completedOrder('logistics');
    const released = await ok(
      releaseProductionOrder(team.planner, { productionOrderId: orderId }, at(10))
    );
    expect(released).toMatchObject({ released: true, finishedGoodsRequestId: null });
    // Liberar NUNCA crea la orden de entrega (el motor de expedientes la planea),
    // así que el resultado ni siquiera tiene ese campo.
    expect(released).not.toHaveProperty('deliveryOrderId');
    expect(rows('deliveryOrder')).toHaveLength(0);
    expect(row('demandAllocation', allocation.id as string).status).toBe('ready');
    expect(
      rows('operationalEvent').find((event) => event.type === 'production.released')?.payload
    ).toMatchObject({ releaseTarget: 'logistics' });
  });

  it('lists orders with the actions each person may take and builds the floor board', async () => {
    seedPlacaAndLamina(30);
    const reserved = await ok(
      createTransformationOrder(
        team.planner,
        {
          outputZohoItemId: 'placa',
          plannedQty: 20,
          inputs: [{ zohoItemId: 'lamina', qty: 21 }],
          reserveNow: true,
        },
        at(0)
      )
    );
    const blocked = await ok(
      createTransformationOrder(
        team.planner,
        {
          outputZohoItemId: 'placa',
          plannedQty: 20,
          inputs: [{ zohoItemId: 'lamina', qty: 21 }],
          reserveNow: true,
        },
        at(1)
      )
    );
    expect([reserved.status, blocked.status]).toEqual(['reserved', 'blocked']);

    const forOperator = await listProductionOrders(team.operator, { sort: 'created' });
    expect(forOperator).toMatchObject({ total: 2, page: 1, pageCount: 1 });
    expect(forOperator.rows.map((order) => [order.number, order.allowedActions])).toEqual([
      ['OP-000002', []],
      ['OP-000001', []],
    ]);
    const forPlanner = await listProductionOrders(team.planner, { status: ['reserved'] });
    expect(forPlanner.rows).toHaveLength(1);
    expect(forPlanner.rows[0]).toMatchObject({
      number: 'OP-000001',
      workCenterName: 'Corte',
      outputSku: 'PLACA-60',
      allowedActions: ['schedule', 'reserve_materials', 'prepare', 'cancel'],
    });
    expect(
      (await listProductionOrders(team.viewer, { q: 'op-000002' })).rows.map(
        (order) => order.number
      )
    ).toEqual(['OP-000002']);
    await expect(listProductionOrders(team.stranger)).rejects.toBeInstanceOf(AuthorizationError);

    await ok(
      prepareProductionOrder(team.planner, { productionOrderId: reserved.productionOrderId }, at(2))
    );
    await ok(
      startOperation(team.operator, { productionOrderId: reserved.productionOrderId }, at(3))
    );
    const board = await getProductionBoard(team.viewer, { days: 1 }, at(3));
    expect(board.columns.map((column) => [column.status, column.count])).toEqual([
      ['blocked', 1],
      ['draft', 0],
      ['reserved', 0],
      ['prepared', 0],
      ['in_progress', 1],
      ['inspection', 0],
      ['completed', 0],
    ]);
    expect(board.workCenters[0]).toMatchObject({
      workCenter: { key: 'corte' },
      queued: 1,
      running: [{ number: 'OP-000001' }],
    });
    expect(board.workCenters[0].windows[0]).toMatchObject({ day: '2026-09-15', capacity: 100 });
    expect((await listWorkCenters(team.viewer)).map((center) => center.key)).toEqual(['corte']);
  });

  it('rejects commands without permission, from the wrong actor or on another order', async () => {
    seedPlacaAndLamina();
    const input = {
      outputZohoItemId: 'placa',
      plannedQty: 5,
      inputs: [{ zohoItemId: 'lamina', qty: 5 }],
    };
    expect(await createTransformationOrder(team.stranger, input, at(0))).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });
    const created = await ok(createTransformationOrder(team.planner, input, at(0)));
    expect(
      await reserveMaterials(team.operator, { productionOrderId: created.productionOrderId }, at(1))
    ).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    const mismatch = await executeCommand(
      {
        commandId: 'mismatch-1',
        type: MANUFACTURING_COMMANDS.orderReserveMaterials,
        actor: { type: 'user', id: team.planner.id },
        aggregate: { type: 'production_order', id: created.productionOrderId },
        payload: { productionOrderId: 'otra' },
      },
      team.planner
    );
    expect(mismatch).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
    expect(
      await reserveMaterials(
        team.planner,
        { productionOrderId: created.productionOrderId, allowProvisional: true },
        at(2)
      )
    ).toMatchObject({
      status: 'completed',
    });
    const intakeByUser = await executeCommand(
      {
        commandId: 'intake-user',
        type: MANUFACTURING_COMMANDS.orderIntakeRequest,
        actor: { type: 'user', id: team.planner.id },
        aggregate: { type: 'area_request', id: 'r1' },
        payload: { requestId: 'r1' },
      },
      team.planner
    );
    expect(intakeByUser).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
  });
});
