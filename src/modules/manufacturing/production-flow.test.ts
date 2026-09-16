import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Production orders end to end on FakePrisma with the real command engine,
 * inventory and approvals (row locks emulated): transformation within and
 * beyond the scrap tolerance, substitutions with and without approval, a
 * material shortage that blocks and unblocks the order, quality failure with
 * rework, balance, traceability and cancellation.
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

import { moveStock } from '@/modules/inventory/inventory-commands';
import { seedProduct, seedProfile } from '@/modules/inventory/testing/inventory-fixtures';
import { decideApproval } from '@/modules/operations/approvals-service';
import type { CommandResult } from '@/modules/operations/commands';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedUser } from '@/modules/operations/testing/fixtures';
import {
  cancelProductionOrder,
  createTransformationOrder,
  finishOperation,
  inspectProductionOrder,
  pauseOperation,
  prepareProductionOrder,
  recordConsumption,
  recordOutput,
  releaseProductionOrder,
  requestScrapReview,
  reserveMaterials,
  startOperation,
} from './manufacturing-commands';
import { runRetryBlockedJob } from './manufacturing-jobs';
import {
  getProductionOrderDetail,
  getProductionTrace,
  traceStockItem,
} from './manufacturing-queries';
import {
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

function stockOf(zohoItemId: string, code = 'GENERAL', warehouseId = WAREHOUSE_ID) {
  const location = fake
    .rows('storageLocation')
    .find((candidate) => candidate.warehouseId === warehouseId && candidate.code === code);
  return fake
    .rows('stockItem')
    .find((stock) => stock.zohoItemId === zohoItemId && stock.locationId === location?.id);
}

async function ok<D>(promise: Promise<CommandResult<D>>): Promise<D> {
  const result = await promise;
  if (result.status === 'rejected')
    throw new Error(`Comando rechazado ${result.errorCode}: ${result.message}`);
  return result.data as D;
}

beforeEach(() => {
  fake.tables.clear();
  locks.reset();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  team = seedManufacturingTeam(fake);
  seedWorkCenterRow(fake);
});

async function transformationOrder(
  options: {
    material?: number;
    allocationQty?: number;
    inputQty?: number;
    allowance?: number;
    substitutes?: string[];
  } = {}
) {
  seedMaterial(fake, {
    zohoItemId: 'lamina',
    quantity: options.material ?? 200,
    name: 'Lámina MDF',
    sku: 'LAMINA',
    purchaseRate: 150,
  });
  seedProduct(fake, { zohoItemId: 'placa', name: 'Placa 60x60', sku: 'PLACA-60', unit: 'm2' });
  seedProfile(fake, { zohoItemId: 'placa', baseUnit: 'm2', confidence: 'CONTROLLED' });
  const link = seedManufactureAllocation(fake, {
    zohoItemId: 'placa',
    quantity: options.allocationQty ?? 100,
    sourceSku: 'LAMINA',
    targetSku: 'placa',
  });
  const created = await ok(
    createTransformationOrder(
      team.planner,
      {
        demandAllocationId: link.allocation.id as string,
        inputs: [
          {
            zohoItemId: 'lamina',
            qty: options.inputQty ?? 105,
            unit: 'm2',
            ...(options.substitutes ? { substituteZohoItemIds: options.substitutes } : {}),
          },
        ],
        scrapAllowancePct: options.allowance ?? 5,
        workCenterId: 'wc_corte',
        reserveNow: true,
      },
      at(0)
    )
  );
  return { ...link, created, orderId: created.productionOrderId };
}

async function throughStart(orderId: string): Promise<string> {
  await ok(prepareProductionOrder(team.planner, { productionOrderId: orderId }, at(1)));
  return (await ok(startOperation(team.operator, { productionOrderId: orderId }, at(10))))
    .operationId;
}

describe('transformation order', () => {
  it('transforms material within the scrap tolerance and releases it for the sale with full traceability', async () => {
    const { orderId, created, allocation, request } = await transformationOrder();
    expect(created).toMatchObject({
      number: 'OP-000001',
      kind: 'transformation',
      status: 'reserved',
      workCenterId: 'wc_corte',
      outputWarehouseId: WAREHOUSE_ID,
    });
    expect(created.materials).toMatchObject({
      complete: true,
      lines: [
        { zohoItemId: 'lamina', required: '105', assigned: '105', missing: '0', reason: 'ok' },
      ],
    });
    expect(num(stockOf('lamina')!.assignedToProduction)).toBe(105);
    expect(row('productionOrder', orderId)).toMatchObject({
      caseId: 'case_1',
      demandId: allocation.demandId,
      demandAllocationId: allocation.id,
      outputZohoItemId: 'placa',
    });
    const [operation] = rows('productionOperation');
    expect(operation).toMatchObject({ seq: 1, name: 'Corte/acabado', workCenterId: 'wc_corte' });
    expect((operation.plannedStartAt as Date).toISOString()).toBe(MFG_NOW.toISOString());

    const prepared = await ok(
      prepareProductionOrder(team.planner, { productionOrderId: orderId }, at(1))
    );
    expect(prepared.status).toBe('prepared');
    expect(row('workItem', prepared.workItemId)).toMatchObject({
      areaKey: 'inventario',
      objectType: 'production_order',
      objectId: orderId,
    });
    expect(row('workItem', prepared.workItemId).description).toMatch(/105 m2 de Lámina MDF/);

    const started = await ok(startOperation(team.operator, { productionOrderId: orderId }, at(10)));
    expect(started).toMatchObject({
      operationStatus: 'running',
      orderStatus: 'in_progress',
      resumed: false,
    });
    expect(row('demandAllocation', allocation.id as string).status).toBe('in_progress');
    expect(eventsOf('production.started')).toHaveLength(1);

    const paused = await ok(
      pauseOperation(
        team.operator,
        { productionOrderId: orderId, operationId: started.operationId },
        at(40)
      )
    );
    expect(paused.actualMinutes).toBe(30);
    expect(
      (await ok(startOperation(team.operator, { productionOrderId: orderId }, at(50)))).resumed
    ).toBe(true);

    const consumption = await ok(
      recordConsumption(
        team.operator,
        { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 104, unit: 'm2' }] },
        at(60)
      )
    );
    expect(consumption.lines[0]).toMatchObject({
      role: 'planned',
      quantity: '104',
      overAssignment: '0',
    });
    const lamina = stockOf('lamina')!;
    expect([num(lamina.consumed), num(lamina.assignedToProduction), num(lamina.knownQty)]).toEqual([
      104, 1, 96,
    ]);

    const finished = await ok(
      finishOperation(
        team.operator,
        { productionOrderId: orderId, operationId: started.operationId },
        at(80)
      )
    );
    expect(finished).toMatchObject({ orderStatus: 'inspection', actualMinutes: 60 });
    expect(row('workItem', finished.inspectionWorkItemId as string)).toMatchObject({
      kind: 'verification',
      areaKey: 'manufactura',
    });

    const scrap = await ok(
      recordOutput(
        team.operator,
        { productionOrderId: orderId, kind: 'scrap', qty: 4, unit: 'm2', reason: 'Recortes' },
        at(85)
      )
    );
    expect(scrap.scrap).toMatchObject({ exceeded: false, pending: false, maxPct: 3.85 });
    expect(num(stockOf('lamina', 'SCRAP')!.blocked)).toBe(4);
    expect(rows('approvalRequest')).toHaveLength(0);

    const early = await recordOutput(
      team.operator,
      { productionOrderId: orderId, kind: 'finished', qty: 100 },
      at(86)
    );
    expect(early).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
    const inspected = await ok(
      inspectProductionOrder(team.inspector, { productionOrderId: orderId, result: 'pass' }, at(90))
    );
    expect(inspected.orderStatus).toBe('completed');
    expect(row('workItem', finished.inspectionWorkItemId as string).status).toBe('done');

    const output = await ok(
      recordOutput(
        team.operator,
        { productionOrderId: orderId, kind: 'finished', qty: 100, unit: 'm2' },
        at(95)
      )
    );
    expect(output).toMatchObject({ producedQty: '100', quantity: '100' });
    expect(row('stockItem', output.stockItemId)).toMatchObject({
      zohoItemId: 'placa',
      originProductionOrderId: orderId,
    });
    expect(row('productionOutput', output.outputId).qualityCheckId).toBe(inspected.qualityCheckId);

    const released = await ok(
      releaseProductionOrder(team.planner, { productionOrderId: orderId }, at(100))
    );
    expect(released).toMatchObject({ released: true, status: 'released', materialsReleased: 1 });
    expect(num(stockOf('lamina')!.assignedToProduction)).toBe(0);
    expect(row('demandAllocation', allocation.id as string)).toMatchObject({
      status: 'ready',
      stockReservationId: released.reservationId,
      warehouseId: WAREHOUSE_ID,
    });
    expect(row('stockReservation', released.reservationId as string)).toMatchObject({
      demandId: allocation.demandId,
      allocationId: allocation.id,
      status: 'active',
    });
    expect(row('areaRequest', request!.id as string).status).toBe('resolved');
    expect(
      rows('areaRequest').find((candidate) => candidate.kind === 'finished_goods')
    ).toMatchObject({
      fromAreaKey: 'manufactura',
      toAreaKey: 'inventario',
      objectId: orderId,
    });
    expect(eventsOf('production.finished')[0]).toMatchObject({
      caseId: 'case_1',
      objectId: orderId,
    });

    const detail = await getProductionOrderDetail(team.viewer, orderId);
    expect(detail.balance).toMatchObject({ comparable: true, balanced: true, unaccounted: 0 });
    expect(detail.materials[0]).toMatchObject({
      required: '105',
      consumed: '104',
      held: '0',
      scrap: '4',
    });
    expect(detail.operations[0]).toMatchObject({ status: 'done', actualMinutes: 60 });

    const trace = await getProductionTrace(team.viewer, orderId);
    expect(trace.order).toMatchObject({
      number: 'OP-000001',
      caseNumber: 'EXP-000001',
      allocationId: allocation.id,
    });
    expect(trace.materials.map((material) => [material.zohoItemId, material.quantity])).toEqual([
      ['lamina', '104'],
    ]);
    expect(trace.outputs.map((out) => [out.kind, out.quantity])).toEqual([
      ['scrap', '4'],
      ['finished', '100'],
    ]);
    expect(trace.reservations).toHaveLength(1);
    expect((await traceStockItem(team.viewer, output.stockItemId)).production?.order.number).toBe(
      'OP-000001'
    );
  });

  it('asks for approval and opens an incident when scrap exceeds the tolerance and releases only once approved', async () => {
    const { orderId } = await transformationOrder({ allocationQty: 90 });
    const operationId = await throughStart(orderId);
    await ok(
      recordConsumption(
        team.operator,
        { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 105 }] },
        at(20)
      )
    );
    await ok(finishOperation(team.operator, { productionOrderId: orderId, operationId }, at(30)));

    const scrap = await ok(
      recordOutput(
        team.operator,
        { productionOrderId: orderId, kind: 'scrap', qty: 10, reason: 'Lámina astillada' },
        at(31)
      )
    );
    expect(scrap.scrap).toMatchObject({ exceeded: true, maxPct: 9.52, approvalStatus: 'pending' });
    const approval = row('approvalRequest', scrap.scrap!.approvalRequestId as string);
    expect(approval).toMatchObject({
      scope: 'production_incident',
      targetType: 'production_order_scrap',
      targetId: orderId,
      requestedByUserId: 'u_operator',
      status: 'pending',
      caseId: 'case_1',
    });
    expect(
      rows('workItem')
        .filter((item) => item.objectId === approval.id)
        .map((item) => item.ownerUserId)
    ).toEqual(['u_approver']);
    expect(rows('incident').find((incident) => incident.kind === 'excess_scrap')).toMatchObject({
      status: 'open',
      severity: 'high',
      caseId: 'case_1',
    });

    await ok(
      inspectProductionOrder(team.inspector, { productionOrderId: orderId, result: 'pass' }, at(35))
    );
    const leftover = await ok(
      recordOutput(
        team.operator,
        {
          productionOrderId: orderId,
          kind: 'leftover',
          qty: 5,
          dimensions: { largo: 1, ancho: 5, unidad: 'm' },
        },
        at(36)
      )
    );
    expect(leftover.containerKey).not.toBe('');
    expect(row('stockItem', leftover.stockItemId)).toMatchObject({
      originProductionOrderId: orderId,
      dimensions: { largo: 1, ancho: 5, unidad: 'm' },
    });
    await ok(
      recordOutput(team.operator, { productionOrderId: orderId, kind: 'finished', qty: 90 }, at(37))
    );

    const blocked = await releaseProductionOrder(
      team.planner,
      { productionOrderId: orderId },
      at(40)
    );
    expect(blocked).toMatchObject({ status: 'rejected', errorCode: 'release_blocked' });
    expect(blocked.message).toMatch(/espera aprobación/);

    await ok(
      decideApproval(
        team.approver,
        { approvalRequestId: approval.id as string, decision: 'approve' },
        at(45)
      )
    );
    expect(eventsOf('production.scrap_approved')).toHaveLength(1);
    const detail = await getProductionOrderDetail(team.viewer, orderId);
    expect(detail).toMatchObject({ scrapApproval: 'approved', release: { ready: true } });
    expect(
      (await ok(releaseProductionOrder(team.planner, { productionOrderId: orderId }, at(50))))
        .released
    ).toBe(true);
  });

  /**
   * Plan 6.6: la categoría `production_update` del catálogo tiene que producir
   * avisos de verdad. Quien abrió la orden y el dueño del expediente se enteran
   * de la merma fuera de tolerancia y de la liberación; los aprobadores reciben
   * aparte su `approval_requested`.
   */
  it('avisa production_update por merma fuera de tolerancia y por liberación', async () => {
    const { orderId } = await transformationOrder({ allocationQty: 90 });
    const operationId = await throughStart(orderId);
    const notices = (type: string) =>
      (mocks.notifyUser.mock.calls as unknown as Array<[Record<string, unknown>]>)
        .map(([input]) => input)
        .filter((input) => input.type === type);

    await ok(
      recordConsumption(
        team.operator,
        { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 105 }] },
        at(20)
      )
    );
    await ok(finishOperation(team.operator, { productionOrderId: orderId, operationId }, at(30)));
    await ok(
      recordOutput(
        team.operator,
        { productionOrderId: orderId, kind: 'scrap', qty: 10, reason: 'Lámina astillada' },
        at(31)
      )
    );

    const exceeded = notices('production_scrap_exceeded');
    expect(exceeded.map((input) => input.userId)).toEqual(['u_planner', 'owner']);
    expect(exceeded[0]).toMatchObject({
      category: 'production_update',
      actorUserId: 'u_operator',
      title: 'Merma fuera de tolerancia en OP-000001: 9.52 %',
      url: `/app/areas/manufactura/ordenes/${orderId}`,
      entityType: 'production_order',
      entityId: orderId,
    });

    const approval = rows('approvalRequest').find((candidate) => candidate.targetId === orderId)!;
    await ok(
      decideApproval(
        team.approver,
        { approvalRequestId: approval.id as string, decision: 'approve' },
        at(35)
      )
    );
    await ok(
      inspectProductionOrder(team.inspector, { productionOrderId: orderId, result: 'pass' }, at(36))
    );
    await ok(
      recordOutput(
        team.operator,
        {
          productionOrderId: orderId,
          kind: 'leftover',
          qty: 5,
          dimensions: { largo: 1, ancho: 5, unidad: 'm' },
        },
        at(37)
      )
    );
    await ok(
      recordOutput(team.operator, { productionOrderId: orderId, kind: 'finished', qty: 90 }, at(38))
    );
    expect(
      (await ok(releaseProductionOrder(team.planner, { productionOrderId: orderId }, at(40))))
        .released
    ).toBe(true);

    const released = notices('production_released');
    expect(released.map((input) => input.userId)).toEqual(['u_planner', 'owner']);
    expect(released[1]).toMatchObject({
      category: 'production_update',
      actorUserId: 'u_planner',
      title: 'Liberada: orden OP-000001',
      body: expect.stringContaining('90 m2'),
    });
  });

  it('keeps the release blocked after a rejected scrap until a new review is requested', async () => {
    const { orderId } = await transformationOrder({ allocationQty: 90 });
    const operationId = await throughStart(orderId);
    await ok(
      recordConsumption(
        team.operator,
        { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 100 }] },
        at(20)
      )
    );
    const scrap = await ok(
      recordOutput(team.operator, { productionOrderId: orderId, kind: 'scrap', qty: 10 }, at(21))
    );
    await ok(
      decideApproval(
        team.approver,
        {
          approvalRequestId: scrap.scrap!.approvalRequestId as string,
          decision: 'reject',
          note: 'Revisar corte',
        },
        at(22)
      )
    );
    await ok(finishOperation(team.operator, { productionOrderId: orderId, operationId }, at(30)));
    await ok(
      inspectProductionOrder(team.inspector, { productionOrderId: orderId, result: 'pass' }, at(31))
    );
    await ok(
      recordOutput(team.operator, { productionOrderId: orderId, kind: 'finished', qty: 90 }, at(32))
    );
    const rejected = await releaseProductionOrder(
      team.planner,
      { productionOrderId: orderId },
      at(33)
    );
    expect(rejected).toMatchObject({ status: 'rejected', errorCode: 'release_blocked' });
    expect(rejected.message).toMatch(/rechazada/);
    const review = await ok(
      requestScrapReview(
        team.operator,
        { productionOrderId: orderId, reason: 'Se re-midió la lámina' },
        at(34)
      )
    );
    expect(review.status).toBe('pending');
    expect(
      rows('approvalRequest').filter((approval) => approval.targetId === orderId)
    ).toHaveLength(2);
    expect(
      await requestScrapReview(
        team.operator,
        { productionOrderId: orderId, reason: 'Otra vez' },
        at(35)
      )
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'approval_pending',
    });
  });

  it('orders a rework when the inspection fails and inspects again', async () => {
    const { orderId } = await transformationOrder();
    const operationId = await throughStart(orderId);
    await ok(
      finishOperation(
        team.operator,
        { productionOrderId: orderId, operationId, actualMinutes: 45 },
        at(20)
      )
    );
    expect(row('productionOperation', operationId).actualMinutes).toBe(45);
    const failed = await ok(
      inspectProductionOrder(
        team.inspector,
        {
          productionOrderId: orderId,
          result: 'fail',
          notes: 'Cantos astillados',
          checklist: [
            { item: 'Medida', ok: true },
            { item: 'Cantos', ok: false },
          ],
          reworkOperationName: 'Pulido de cantos',
          reworkMinutes: 30,
        },
        at(25)
      )
    );
    expect(failed).toMatchObject({ result: 'fail', orderStatus: 'in_progress' });
    expect(row('incident', failed.incidentId as string)).toMatchObject({
      kind: 'quality_failure',
      severity: 'high',
      caseId: 'case_1',
    });
    expect(row('productionOperation', failed.reworkOperationId as string)).toMatchObject({
      seq: 2,
      name: 'Retrabajo: Pulido de cantos',
      status: 'pending',
      plannedMinutes: 30,
    });
    const rework = await ok(startOperation(team.operator, { productionOrderId: orderId }, at(30)));
    expect(rework.operationId).toBe(failed.reworkOperationId);
    expect(
      (
        await ok(
          finishOperation(
            team.operator,
            { productionOrderId: orderId, operationId: rework.operationId },
            at(60)
          )
        )
      ).orderStatus
    ).toBe('inspection');

    const bot = {
      ...seedUser(fake, { id: 'bot_mfg', isBot: true, permissions: ['manufacturing.inspect'] })
        .currentUser,
      isBot: true,
    };
    expect(
      await inspectProductionOrder(bot, { productionOrderId: orderId, result: 'pass' }, at(61))
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });
    expect(
      await inspectProductionOrder(
        team.inspector,
        { productionOrderId: orderId, result: 'conditional' },
        at(61)
      )
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_payload',
    });
    expect(
      (
        await ok(
          inspectProductionOrder(
            team.inspector,
            { productionOrderId: orderId, result: 'pass' },
            at(62)
          )
        )
      ).orderStatus
    ).toBe('completed');
  });

  it('cancels an order giving back its material and rejecting the transformation request', async () => {
    const { orderId, request } = await transformationOrder();
    const operationId = await throughStart(orderId);
    await ok(
      recordConsumption(
        team.operator,
        { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 40 }] },
        at(20)
      )
    );
    const cancelled = await ok(
      cancelProductionOrder(
        team.planner,
        { productionOrderId: orderId, reason: 'El cliente canceló' },
        at(30)
      )
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', materialsReleased: 1 });
    expect([
      num(stockOf('lamina')!.assignedToProduction),
      num(stockOf('lamina')!.consumed),
    ]).toEqual([0, 40]);
    expect(row('productionOperation', operationId).status).toBe('skipped');
    expect(row('areaRequest', request!.id as string).status).toBe('rejected');
    expect(
      rows('workItem')
        .filter((item) => item.objectId === orderId)
        .every((item) => item.status === 'cancelled')
    ).toBe(true);
    expect(eventsOf('production.cancelled')[0].payload).toMatchObject({
      postedConsumptions: 1,
      reason: 'El cliente canceló',
    });
    expect(
      await startOperation(team.operator, { productionOrderId: orderId }, at(31))
    ).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
  });
});

describe('substitutions', () => {
  it('holds a substitution outside the BOM until it is approved, and never posts a rejected one', async () => {
    seedMaterial(fake, {
      zohoItemId: 'lamina-x',
      quantity: 50,
      name: 'Lámina alterna',
      sku: 'LAMINA-X',
      purchaseRate: 120,
    });
    const { orderId } = await transformationOrder();
    await throughStart(orderId);

    const first = await ok(
      recordConsumption(
        team.operator,
        {
          productionOrderId: orderId,
          lines: [{ zohoItemId: 'lamina-x', qty: 20, substituteFor: 'lamina' }],
        },
        at(20)
      )
    );
    expect(first.lines[0]).toMatchObject({
      role: 'unplanned_substitute',
      posted: [],
      approvalStatus: 'pending',
    });
    const pending = rows('materialConsumption').find(
      (consumption) => consumption.kind === 'substitution'
    )!;
    expect(pending).toMatchObject({
      stockMovementId: null,
      substitutedForZohoItemId: 'lamina',
      approvalRequestId: first.lines[0].approvalRequestId,
    });
    expect(num(stockOf('lamina-x')!.consumed)).toBe(0);
    const approval = row('approvalRequest', pending.approvalRequestId as string);
    expect(approval).toMatchObject({
      scope: 'production_incident',
      targetType: 'material_consumption',
      targetId: pending.id,
    });
    expect(num(approval.amount)).toBe(2400);
    expect(
      rows('incident').find((incident) => incident.kind === 'production_substitution')
    ).toMatchObject({ status: 'open', caseId: 'case_1' });
    expect((await getProductionOrderDetail(team.viewer, orderId)).pendingSubstitutionIds).toEqual([
      pending.id,
    ]);

    await ok(
      decideApproval(
        team.approver,
        { approvalRequestId: approval.id as string, decision: 'approve' },
        at(25)
      )
    );
    expect(row('materialConsumption', pending.id as string).stockMovementId).toEqual(
      expect.any(String)
    );
    expect(num(stockOf('lamina-x')!.consumed)).toBe(20);
    expect(eventsOf('production.substitution_posted')).toHaveLength(1);

    const second = await ok(
      recordConsumption(
        team.operator,
        {
          productionOrderId: orderId,
          lines: [{ zohoItemId: 'lamina-x', qty: 5, substituteFor: 'lamina' }],
        },
        at(30)
      )
    );
    await ok(
      decideApproval(
        team.approver,
        {
          approvalRequestId: second.lines[0].approvalRequestId as string,
          decision: 'reject',
          note: 'No autorizado',
        },
        at(31)
      )
    );
    expect(num(stockOf('lamina-x')!.consumed)).toBe(20);
    expect(eventsOf('production.substitution_rejected')).toHaveLength(1);
    expect((await getProductionOrderDetail(team.viewer, orderId)).pendingSubstitutionIds).toEqual(
      []
    );
  });

  it('posts a substitute the BOM allows without approval and rejects unknown materials', async () => {
    seedMaterial(fake, { zohoItemId: 'lamina-b', quantity: 30, sku: 'LAMINA-B' });
    const { orderId } = await transformationOrder({ substitutes: ['lamina-b'] });
    await throughStart(orderId);
    const result = await ok(
      recordConsumption(
        team.operator,
        { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina-b', qty: 10 }] },
        at(20)
      )
    );
    expect(result.lines[0]).toMatchObject({ role: 'declared_substitute', approvalRequestId: null });
    expect(result.lines[0].posted).toHaveLength(1);
    expect(num(stockOf('lamina-b')!.consumed)).toBe(10);
    expect(rows('approvalRequest')).toHaveLength(0);
    expect(
      await recordConsumption(
        team.operator,
        { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina-z', qty: 1 }] },
        at(21)
      )
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_payload',
    });
    expect(
      await recordConsumption(
        team.operator,
        { productionOrderId: orderId, lines: [{ zohoItemId: 'lamina', qty: 500 }] },
        at(22)
      )
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'insufficient_stock',
    });
  });
});

describe('material shortage', () => {
  it('blocks the order and asks Compras, then unblocks it when the material arrives', async () => {
    const receiver = seedUser(fake, {
      id: 'u_almacen',
      permissions: ['inventory.view', 'inventory.manage'],
    }).currentUser;
    const { orderId, created } = await transformationOrder({ material: 60 });
    expect(created.status).toBe('blocked');
    expect(created.materials).toMatchObject({
      complete: false,
      lines: [{ assigned: '60', missing: '45', reason: 'insufficient' }],
    });
    expect(row('productionOrder', orderId).blockedReason).toMatch(
      /Faltan materiales: 45 m2 de Lámina MDF/
    );
    const shortfall = rows('areaRequest').find((request) => request.kind === 'material_shortfall')!;
    expect(shortfall).toMatchObject({
      fromAreaKey: 'manufactura',
      toAreaKey: 'compras',
      objectType: 'production_order',
      objectId: orderId,
      status: 'sent',
    });
    expect(shortfall.payload).toMatchObject({
      productionOrderId: orderId,
      sku: 'LAMINA',
      missingQty: 45,
      unit: 'm2',
    });
    expect(eventsOf('production.blocked')).toHaveLength(1);
    expect(
      await prepareProductionOrder(team.planner, { productionOrderId: orderId }, at(1))
    ).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });

    const retry = await ok(reserveMaterials(team.planner, { productionOrderId: orderId }, at(2)));
    expect(retry).toMatchObject({ status: 'blocked', complete: false });
    expect(
      rows('areaRequest').filter((request) => request.kind === 'material_shortfall')
    ).toHaveLength(1);
    expect(eventsOf('production.blocked')).toHaveLength(1);

    const receipt = await moveStock(receiver, {
      kind: 'receipt',
      zohoItemId: 'lamina',
      warehouseId: WAREHOUSE_ID,
      quantity: 50,
      unit: 'm2',
    });
    expect(receipt.status).toBe('completed');
    const job = rows('backgroundJob').find(
      (candidate) => candidate.type === 'manufacturing.retry_blocked'
    );
    expect(job).toMatchObject({
      dedupeKey: 'mfg-retry:item:lamina',
      payload: { zohoItemId: 'lamina' },
    });

    const summary = await runRetryBlockedJob(
      makeManufacturingJob(job!.payload as { zohoItemId: string }, 'job_retry'),
      at(5)
    );
    expect(summary).toMatchObject({ candidates: 1, attempted: 1, reserved: 1, stillBlocked: 0 });
    expect(row('productionOrder', orderId)).toMatchObject({
      status: 'reserved',
      blockedReason: null,
    });
    expect(row('areaRequest', shortfall.id as string).status).toBe('resolved');
    expect(num(stockOf('lamina')!.assignedToProduction)).toBe(105);
    expect(eventsOf('production.unblocked')).toHaveLength(1);
  });

  it('asks Inventario for a count instead of a purchase when the material was never counted', async () => {
    seedMaterial(fake, {
      zohoItemId: 'vidrio',
      quantity: 40,
      confidence: 'UNCOUNTED',
      sku: 'VIDRIO',
    });
    seedProduct(fake, { zohoItemId: 'espejo', name: 'Espejo', unit: 'm2' });
    const created = await ok(
      createTransformationOrder(
        team.planner,
        {
          outputZohoItemId: 'espejo',
          plannedQty: 10,
          inputs: [{ zohoItemId: 'vidrio', qty: 11 }],
          reserveNow: true,
        },
        at(0)
      )
    );
    expect(created).toMatchObject({
      status: 'blocked',
      materials: { lines: [{ reason: 'uncounted', missing: '11' }] },
    });
    expect(
      rows('areaRequest').filter((request) => request.kind === 'material_shortfall')
    ).toHaveLength(0);
    expect(
      rows('workItem').find((item) => item.objectType === 'production_material')
    ).toMatchObject({
      areaKey: 'inventario',
      kind: 'verification',
      objectId: `${created.productionOrderId}:vidrio`,
    });
  });
});
