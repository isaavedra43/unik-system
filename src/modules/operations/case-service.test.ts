import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Case engine on FakePrisma (plan 9.1 `case-service`): case.start with
 * controlled, unknown and split stock, idempotency, the advance chain up to the
 * financial close, work item completion driving steps, reads and the
 * post-commit extension points. Row locks of the inventory are emulated.
 */

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('./testing/case-fixtures');
  const inventory = await import('@/modules/inventory/testing/inventory-fixtures');
  const fake = fixtures.createCaseFake();
  return {
    fake,
    locks: inventory.createLockEmulation(fake),
    notifyUser: vi.fn(async () => ({ id: 'n1', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async (channel: string, type: string, payload: unknown) => ({
      id: '1',
      channel,
      type,
      payload,
      createdAt: new Date().toISOString(),
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

import { areaSlug } from '@/modules/comms/responsibles-service';
import { seedResponsible, seedUser } from './testing/fixtures';
import {
  CASE_TEST_NOW,
  seedCaseTeam,
  seedItemStock,
  seedOperationsConfig,
  seedSalesOrder,
  type CaseTeam,
} from './testing/case-fixtures';
import {
  advanceCaseCommand,
  computeStepDueAt,
  deriveCasePhase,
  deriveCaseStatus,
  preparationBlockers,
  planCaseAdvanceJobs,
  getCaseSnapshot,
  listCases,
  onCaseStarted,
  startCaseManually,
  startSalesFulfillment,
} from './case-service';
import { invalidateOperationsConfigCache } from './operations-config';
import { clearProcessBlueprintCache } from './process-blueprints/registry';
import { SALES_FULFILLMENT_BLUEPRINT } from './process-blueprints/sales-fulfillment';
import { rejectAreaRequest } from './area-requests-service';
import { completeWorkItem } from './work-items-service';

const { fake } = mocks;
const NOW = CASE_TEST_NOW;
const OPEN = ['open', 'in_progress', 'waiting', 'escalated'];
let team: CaseTeam;

const stepOf = (stepKey: string, scopeKey = '') =>
  fake.rows('caseStep').find((s) => s.stepKey === stepKey && s.scopeKey === scopeKey);
const itemOf = (step: Record<string, unknown> | undefined) =>
  fake.rows('workItem').find((w) => step && w.stepId === step.id);
const openItems = () => fake.rows('workItem').filter((w) => OPEN.includes(w.status as string));
const eventTypes = () => fake.rows('operationalEvent').map((e) => e.type as string);
const caseRow = () => fake.rows('operationalCase')[0];

function systemStart(
  zohoSalesOrderId = 'zso-1',
  commandId = `ops:case.start:so:${zohoSalesOrderId}:job_1:1`
) {
  return startSalesFulfillment(zohoSalesOrderId, {
    commandId,
    actor: { type: 'system', id: 'job:ops.case.start' },
    now: NOW,
  });
}

beforeEach(() => {
  fake.tables.clear();
  mocks.locks.reset();
  mocks.notifyUser.mockClear();
  invalidateOperationsConfigCache();
  clearProcessBlueprintCache();
  team = seedCaseTeam(fake);
  seedOperationsConfig(fake);
});

describe('case.start', () => {
  it('stock CONTROLLED suficiente: verifica, planea y reserva solo; deja el trabajo de preparar pedido', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });

    const result = await systemStart();

    expect(result).toMatchObject({
      status: 'completed',
      data: { created: true, caseNumber: 'EXP-000001' },
    });
    expect(caseRow()).toMatchObject({
      caseSeq: 1,
      kind: 'sales_fulfillment',
      sourceType: 'sales_order',
      sourceId: 'zso-1',
      status: 'open',
      phase: 'preparing',
      ownerUserId: 'u_ventas',
    });
    const [demand] = fake.rows('caseDemand');
    expect(demand).toMatchObject({
      lineRef: 'li-1',
      status: 'allocated',
      unit: 'pz',
      baseUnit: 'pz',
    });
    expect(String(demand.baseQuantity)).toBe('10');

    const [allocation] = fake.rows('demandAllocation');
    const [reservation] = fake.rows('stockReservation');
    expect(allocation).toMatchObject({
      source: 'stock',
      status: 'reserved',
      stockReservationId: reservation.id,
    });
    expect(reservation).toMatchObject({
      status: 'active',
      allocationId: allocation.id,
      confidenceAtReserve: 'CONTROLLED',
    });
    expect(String(fake.rows('stockItem')[0].reserved)).toBe('10');

    expect(stepOf('verificar_disponibilidad', demand.id)!.status).toBe('done');
    expect(stepOf('plan_abastecimiento', demand.id)!.status).toBe('done');
    expect(stepOf('reservar_stock', allocation.id)!.status).toBe('done');
    const prepare = stepOf('preparar_pedido')!;
    expect(prepare.status).toBe('ready');
    expect(prepare.dueAt).toEqual(new Date(NOW.getTime() + 480 * 60_000));
    expect(stepOf('planear_entrega')!.status).toBe('pending');

    expect(openItems()).toHaveLength(1);
    expect(itemOf(prepare)).toMatchObject({
      areaKey: 'inventario',
      kind: 'action',
      status: 'open',
      ownerUserId: 'u_inventario',
      objectType: 'case_step',
      objectId: prepare.id,
      requiredEvidence: ['issue_movements'],
    });
    expect(result.createdWorkItemIds).toEqual([itemOf(prepare)!.id]);

    expect(eventTypes()).toEqual(
      expect.arrayContaining([
        'case.created',
        'demand.created',
        'step.ready',
        'demand.verified',
        'demand.allocated',
        'allocation.planned',
        'stock.reserved',
        'allocation.reserved',
        'workitem.created',
        'case.phase_changed',
      ])
    );
    expect(fake.rows('objectRelation')).toContainEqual(
      expect.objectContaining({
        fromType: 'operational_case',
        toType: 'sales_order',
        relation: 'fulfills',
      })
    );
    expect(fake.rows('processVersion')).toHaveLength(1);
    expect(mocks.notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u_inventario', category: 'ops_workitem' })
    );
  });

  it('stock desconocido: work item de verificación para el responsable de la bodega', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 30, confidence: 'UNCOUNTED' });
    seedUser(fake, { id: 'u_bodega', name: 'Jefe de bodega' });
    seedResponsible(fake, { area: areaSlug('inventario principal'), userId: 'u_bodega' });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });

    const result = await systemStart();

    expect(result.status).toBe('completed');
    const [demand] = fake.rows('caseDemand');
    expect(demand.status).toBe('verifying');
    expect(fake.rows('demandAllocation')).toHaveLength(0);
    expect(fake.rows('stockReservation')).toHaveLength(0);
    const verify = stepOf('verificar_disponibilidad', demand.id)!;
    expect(verify.status).toBe('ready');
    expect(stepOf('plan_abastecimiento', demand.id)!.status).toBe('pending');
    expect(openItems()).toHaveLength(1);
    const item = itemOf(verify)!;
    expect(item).toMatchObject({
      kind: 'verification',
      areaKey: 'inventario',
      ownerUserId: 'u_bodega',
      requiredEvidence: ['availability_result'],
    });
    expect(item.description).toContain('Existencia en sistema: 30 pz (UNCOUNTED)');
    expect(caseRow()).toMatchObject({ phase: 'planning', status: 'open' });
  });

  it('división existencia + compra: reserva lo disponible y pide la compra del faltante', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 6 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    await systemStart();
    const [demand] = fake.rows('caseDemand');

    const verifyItem = itemOf(stepOf('verificar_disponibilidad', demand.id))!;
    const verified = await completeWorkItem(
      team.byArea.inventario,
      verifyItem.id,
      { result: { availability_result: { counted: 6 } } },
      { now: NOW }
    );
    expect(verified.status).toBe('completed');
    const planStep = stepOf('plan_abastecimiento', demand.id)!;
    expect(planStep.status).toBe('ready');
    const planItem = itemOf(planStep)!;
    expect(planItem).toMatchObject({
      kind: 'approval',
      ownerUserId: 'u_ventas',
      requiredEvidence: ['allocation_plan'],
    });
    expect(planItem.description).toContain('Propuesta: 6 pz de existencia + 4 pz de compra');

    const planned = await completeWorkItem(
      team.byArea.ventas,
      planItem.id,
      { result: { allocation_plan: { acceptProposal: true } } },
      { now: NOW }
    );
    expect(planned.status).toBe('completed');

    const allocations = fake.rows('demandAllocation');
    const stock = allocations.find((a) => a.source === 'stock')!;
    const purchase = allocations.find((a) => a.source === 'purchase')!;
    expect(String(stock.quantity)).toBe('6');
    expect(stock.status).toBe('reserved');
    expect(String(purchase.quantity)).toBe('4');
    expect(purchase).toMatchObject({ status: 'requested', linkedType: 'area_request' });
    expect(String(fake.rows('stockReservation')[0].quantity)).toBe('6');

    const [request] = fake.rows('areaRequest');
    expect(request).toMatchObject({
      id: purchase.linkedId,
      kind: 'purchase_shortfall',
      fromAreaKey: 'inventario',
      toAreaKey: 'compras',
      objectType: 'demand_allocation',
      objectId: purchase.id,
      ownerUserId: 'u_compras',
      blocksDelivery: true,
    });
    expect(request.payload).toMatchObject({
      demandId: demand.id,
      allocationId: purchase.id,
      missingQty: 4,
      unit: 'pz',
    });

    expect(stepOf('solicitar_compra', purchase.id)!.status).toBe('done');
    const wait = stepOf('esperar_recepcion', purchase.id)!;
    expect(wait.status).toBe('waiting');
    expect(itemOf(wait)).toMatchObject({ kind: 'wait', status: 'waiting', areaKey: 'compras' });
    expect(stepOf('preparar_pedido')!.status).toBe('pending');
    expect(eventTypes()).toEqual(
      expect.arrayContaining([
        'demand.shortfall_confirmed',
        'request.created',
        'allocation.requested',
      ])
    );
    expect(caseRow().phase).toBe('sourcing');
  });

  it('valida el plan de abastecimiento antes de terminar el trabajo', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 6 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    await systemStart();
    const [demand] = fake.rows('caseDemand');
    await completeWorkItem(
      team.byArea.inventario,
      itemOf(stepOf('verificar_disponibilidad', demand.id))!.id,
      { result: { availability_result: 'ok' } },
      { now: NOW }
    );
    const planItem = itemOf(stepOf('plan_abastecimiento', demand.id))!;

    const mismatch = await completeWorkItem(
      team.byArea.ventas,
      planItem.id,
      { result: { allocation_plan: { lines: [{ source: 'purchase', quantity: 7 }] } } },
      { now: NOW }
    );
    expect(mismatch).toMatchObject({ status: 'rejected', errorCode: 'plan_quantity_mismatch' });
    const exceeded = await completeWorkItem(
      team.byArea.ventas,
      planItem.id,
      { result: { allocation_plan: { lines: [{ source: 'stock', quantity: 10 }] } } },
      { now: NOW }
    );
    expect(exceeded).toMatchObject({ status: 'rejected', errorCode: 'plan_stock_exceeded' });
    expect(fake.rows('demandAllocation')).toHaveLength(0);
    expect(stepOf('plan_abastecimiento', demand.id)!.status).toBe('ready');
  });

  it('es idempotente: el mismo comando se repite sin efecto y otro comando devuelve el mismo expediente', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });

    const first = await systemStart();
    const replay = await systemStart();
    const other = await systemStart('zso-1', 'ops:case.start:so:zso-1:job_2:1');

    expect(replay).toMatchObject({
      replayed: true,
      data: { caseId: first.data!.caseId, created: true },
    });
    expect(other).toMatchObject({
      status: 'completed',
      data: { caseId: first.data!.caseId, created: false },
    });
    expect(fake.rows('operationalCase')).toHaveLength(1);
    expect(fake.rows('caseDemand')).toHaveLength(1);
    expect(fake.rows('stockReservation')).toHaveLength(1);
    expect(fake.rows('sequence')[0].next).toBe(2);
  });

  it('respeta la política de arranque; «Iniciar seguimiento» salta el corte pero no el estado ni el permiso', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, {
      zohoSalesOrderId: 'zso-old',
      createdTime: new Date('2026-08-01T10:00:00.000Z'),
      lines: [{ quantity: 2 }],
    });
    seedSalesOrder(fake, {
      zohoSalesOrderId: 'zso-draft',
      status: 'draft',
      lines: [{ quantity: 2 }],
    });

    expect(await systemStart('zso-old')).toMatchObject({
      status: 'rejected',
      errorCode: 'case_not_eligible',
    });
    expect(await systemStart('zso-missing')).toMatchObject({
      status: 'rejected',
      errorCode: 'not_found',
    });
    expect(await startCaseManually(team.stranger, 'zso-old', { now: NOW })).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });
    expect(await startCaseManually(team.manager, 'zso-draft', { now: NOW })).toMatchObject({
      status: 'rejected',
      errorCode: 'case_not_eligible',
    });
    const manual = await startCaseManually(team.manager, 'zso-old', { now: NOW });
    expect(manual).toMatchObject({ status: 'completed', data: { created: true } });
    expect(
      fake.rows('operationalEvent').find((e) => e.type === 'case.created')!.payload
    ).toMatchObject({
      manual: true,
      basis: 'manual',
    });
  });

  it('el vendedor mapeado a un usuario activo es el dueño del expediente', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { salespersonName: 'Gestora', lines: [{ quantity: 1 }] });
    await systemStart();
    expect(caseRow().ownerUserId).toBe('u_manager');
  });
});

describe('advanceCase tras completar pasos', () => {
  it('does not let a preparation work item close with a free-text note', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    await systemStart();

    const result = await completeWorkItem(
      team.byArea.inventario,
      itemOf(stepOf('preparar_pedido'))!.id,
      { result: { issue_movements: 'Surtido completo' } },
      { now: NOW }
    );

    expect(result).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
    expect(stepOf('preparar_pedido')!.status).toBe('ready');
  });

  it('avanza de la preparación al cierre financiero con hechos de logística y Zoho', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    const { data } = await systemStart();
    const caseId = data!.caseId;

    // 1. Inventario prepara el pedido → el motor crea la orden de entrega.
    const prepared = await completeWorkItem(
      team.byArea.inventario,
      itemOf(stepOf('preparar_pedido'))!.id,
      { result: { issue_movements: { movementIds: ['movement_test'] } } },
      { now: NOW }
    );
    expect(prepared.status).toBe('completed');
    expect(fake.rows('demandAllocation')[0]).toMatchObject({ status: 'ready' });
    expect(stepOf('preparar_pedido')!.status).toBe('done');
    const [deliveryOrder] = fake.rows('deliveryOrder');
    expect(deliveryOrder).toMatchObject({
      caseId,
      mode: 'own_fleet',
      status: 'pending',
      addressLine: 'Av. Reforma 100',
      city: 'Monterrey',
    });
    expect(stepOf('planear_entrega')!.status).toBe('done');
    const transport = stepOf('asignar_transporte')!;
    expect(transport.status).toBe('ready');
    expect(itemOf(transport)).toMatchObject({
      kind: 'external_sync',
      areaKey: 'logistica',
      requiredEvidence: [],
    });
    expect(fake.rows('areaRequest').map((r) => r.kind)).toContain('create_package_in_zoho');
    expect(eventTypes()).toEqual(
      expect.arrayContaining(['order.prepared', 'allocation.ready', 'delivery.planned'])
    );

    // 2. Zoho confirma el embarque → se cierra el paso y queda "entregar".
    Object.assign(fake.rows('deliveryOrder')[0], {
      status: 'assigned',
      zohoSyncState: 'readback_ok',
    });
    const advanced = await advanceCaseCommand(caseId, { actor: team.manager, now: NOW });
    expect(advanced.status).toBe('completed');
    expect(stepOf('asignar_transporte')!.status).toBe('done');
    expect(itemOf(stepOf('asignar_transporte'))!.status).toBe('done');
    const deliver = stepOf('entregar')!;
    expect(deliver.status).toBe('ready');
    const deliverItem = itemOf(deliver)!;

    // Nadie puede cerrar "entregar" a mano sin la entrega registrada.
    const early = await completeWorkItem(team.byArea.logistica, deliverItem.id, {}, { now: NOW });
    expect(early).toMatchObject({ status: 'rejected', errorCode: 'step_condition_pending' });

    // 3. Entrega registrada → cierre operativo automático y espera del cierre financiero.
    Object.assign(fake.rows('deliveryOrder')[0], { status: 'delivered' });
    Object.assign(fake.rows('demandAllocation')[0], { status: 'delivered', deliveredQuantity: 10 });
    Object.assign(fake.rows('caseDemand')[0], { status: 'fulfilled', fulfilledQuantity: 10 });
    await advanceCaseCommand(caseId, { actor: team.manager, now: NOW });
    expect(stepOf('entregar')!.status).toBe('done');
    expect(stepOf('cierre_operativo')!.status).toBe('done');
    const financial = stepOf('cierre_financiero')!;
    expect(financial.status).toBe('waiting');
    expect(itemOf(financial)).toMatchObject({
      kind: 'wait',
      status: 'waiting',
      areaKey: 'contabilidad',
    });
    expect(caseRow()).toMatchObject({ status: 'ready_to_close', phase: 'closing' });

    // 4. Zoho factura y cobra → expediente cerrado, sin trabajo ni solicitudes abiertas.
    Object.assign(fake.rows('salesOrder')[0], { invoicedStatus: 'invoiced', paidStatus: 'paid' });
    await advanceCaseCommand(caseId, { actor: team.manager, now: NOW });
    expect(stepOf('cierre_financiero')!.status).toBe('done');
    expect(caseRow()).toMatchObject({ status: 'closed', closeReason: 'Proceso completado' });
    expect(caseRow().closedAt).toEqual(NOW);
    expect(openItems()).toHaveLength(0);
    expect(
      fake
        .rows('areaRequest')
        .every((r) => !['sent', 'acknowledged', 'accepted', 'blocked'].includes(r.status as string))
    ).toBe(true);
    expect(eventTypes()).toEqual(
      expect.arrayContaining([
        'case.delivered',
        'case.operational_closed',
        'case.financial_closed',
        'case.status_changed',
      ])
    );
  });

  it('un cliente que recoge omite la asignación de transporte', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { deliveryMethod: 'RECOGE EN BODEGA', lines: [{ quantity: 3 }] });
    await systemStart();
    await completeWorkItem(
      team.byArea.inventario,
      itemOf(stepOf('preparar_pedido'))!.id,
      { result: { issue_movements: { movementIds: ['movement_test'] } } },
      { now: NOW }
    );
    expect(fake.rows('deliveryOrder')[0]).toMatchObject({
      mode: 'customer_pickup',
      addressLine: null,
    });
    expect(stepOf('asignar_transporte')!.status).toBe('skipped');
    expect(stepOf('entregar')!.status).toBe('ready');
  });

  /**
   * Plan §4: `DeliveryOrder.mode` incluye `carrier`. Cuando Zoho dice que el
   * pedido sale por paquetería, la entrega nace así y no como «Flotilla
   * propia»: conserva su domicilio y sigue pidiendo asignar transporte, pero ya
   * no reclama unidad ni chofer nuestros.
   */
  it('un pedido por paquetería nace como entrega de transportista', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { deliveryMethod: 'PAQUETERÍA', lines: [{ quantity: 3 }] });
    await systemStart();
    await completeWorkItem(
      team.byArea.inventario,
      itemOf(stepOf('preparar_pedido'))!.id,
      { result: { issue_movements: { movementIds: ['movement_test'] } } },
      { now: NOW }
    );
    const delivery = fake.rows('deliveryOrder')[0];
    expect(delivery).toMatchObject({ mode: 'carrier', vehicleId: null, driverId: null });
    expect(delivery.addressLine).not.toBeNull();
    expect(stepOf('asignar_transporte')!.status).not.toBe('skipped');
  });

  it('sin trabajo abierto de un paso listo, el avance vuelve a crearlo (huérfano)', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    const { data } = await systemStart();
    const lost = itemOf(stepOf('preparar_pedido'))!;
    lost.status = 'cancelled';

    const result = await advanceCaseCommand(data!.caseId, { now: NOW });

    expect(result.status).toBe('completed');
    expect(result.createdWorkItemIds).toHaveLength(1);
    expect(openItems()).toHaveLength(1);
    expect(openItems()[0]).toMatchObject({
      stepId: stepOf('preparar_pedido')!.id,
      ownerUserId: 'u_inventario',
    });
  });
});

describe('lecturas', () => {
  it('getCaseSnapshot resume el expediente y respeta el acceso', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    const { data } = await systemStart();

    // Ten AI skips after the business facts never displace them from the last 10 lines.
    for (let i = 0; i < 10; i++) {
      fake.seed('operationalEvent', {
        id: BigInt(900_000 + i),
        caseId: data!.caseId,
        type: i % 2 === 0 ? 'ai.turn_skipped' : 'ai.turn',
        actorType: 'ai',
        occurredAt: NOW,
        recordedAt: NOW,
        payload: { reason: 'on_demand' },
      });
    }
    const snapshot = await getCaseSnapshot(data!.caseId, {
      actor: team.byArea.inventario,
      now: NOW,
    });
    expect(snapshot!.timeline.length).toBeGreaterThan(0);
    expect(snapshot!.timeline.some((event) => event.type.startsWith('ai.turn'))).toBe(false);

    expect(snapshot!.case).toMatchObject({
      caseNumber: 'EXP-000001',
      status: 'open',
      statusLabel: 'Abierto',
      phaseLabel: 'Preparación',
      ownerName: 'Responsable ventas',
      process: 'sales_fulfillment@1',
    });
    expect(snapshot!.demands).toEqual([
      expect.objectContaining({ quantity: '10', status: 'allocated' }),
    ]);
    expect(snapshot!.allocations).toEqual([
      expect.objectContaining({ source: 'stock', status: 'reserved' }),
    ]);
    expect(snapshot!.steps[0]).toMatchObject({
      stepKey: 'verificar_disponibilidad',
      label: 'Verificar disponibilidad',
    });
    expect(snapshot!.openWorkItems).toEqual([
      expect.objectContaining({ areaKey: 'inventario', overdue: false }),
    ]);
    expect(snapshot!.timeline.length).toBeLessThanOrEqual(10);
    expect(snapshot!.timeline[0].id > snapshot!.timeline[snapshot!.timeline.length - 1].id).toBe(
      true
    );

    await expect(getCaseSnapshot(data!.caseId, { actor: team.stranger })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await getCaseSnapshot('no-existe')).toBeNull();
  });

  it('listCases filtra, pagina y limita a los propios sin operations.view', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 100 });
    seedSalesOrder(fake, {
      zohoSalesOrderId: 'zso-1',
      salesOrderNumber: 'SO-1',
      lines: [{ quantity: 1 }],
    });
    seedSalesOrder(fake, {
      zohoSalesOrderId: 'zso-2',
      salesOrderNumber: 'SO-2',
      lines: [{ quantity: 1 }],
    });
    await systemStart('zso-1');
    await startSalesFulfillment('zso-2', {
      commandId: 'ops:case.start:so:zso-2:job_1:1',
      actor: { type: 'system', id: 'job' },
      now: new Date(NOW.getTime() + 60_000),
    });

    const firstPage = await listCases(team.manager, { limit: 1 }, { now: NOW });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]).toMatchObject({
      salesOrderNumber: 'SO-2',
      openWorkItems: 1,
      overdueWorkItems: 0,
    });
    const secondPage = await listCases(
      team.manager,
      { limit: 1, cursor: firstPage.nextCursor! },
      { now: NOW }
    );
    expect(secondPage.items.map((i) => i.salesOrderNumber)).toEqual(['SO-1']);
    expect(secondPage.nextCursor).toBeNull();

    expect((await listCases(team.manager, { q: 'EXP-000001' })).items).toHaveLength(1);
    expect((await listCases(team.manager, { scope: 'closed' })).items).toHaveLength(0);
    expect((await listCases(team.stranger)).items).toHaveLength(0);
    expect((await listCases(team.byArea.ventas)).items).toHaveLength(2);
    await expect(listCases(team.manager, { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });
});

describe('puntos de extensión', () => {
  it('onCaseStarted avisa después del commit y un listener que falla no afecta', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { lines: [{ quantity: 1 }] });
    const seen: string[] = [];
    const offOk = onCaseStarted((event) => {
      seen.push(`${event.caseNumber}:${event.zohoSalesOrderId}:${event.ownerUserId}`);
    });
    const offBroken = onCaseStarted(() => {
      throw new Error('sala no disponible');
    });
    try {
      const result = await systemStart();
      expect(result.status).toBe('completed');
      expect(seen).toEqual(['EXP-000001:zso-1:u_ventas']);
    } finally {
      offOk();
      offBroken();
    }
  });

  it('planCaseAdvanceJobs planea un avance por caso y comando, ignorando comandos del expediente', async () => {
    seedItemStock(fake, { zohoItemId: 'item-9', quantity: 1, confidence: 'UNCOUNTED' });
    fake.seed('caseDemand', {
      id: 'dm',
      caseId: 'c-count',
      lineRef: 'x',
      name: 'x',
      quantity: 1,
      unit: 'pz',
      baseQuantity: 1,
      baseUnit: 'pz',
      zohoItemId: 'item-9',
      status: 'verifying',
    });
    const event = (type: string, extra: Record<string, unknown>) => ({
      id: String(Math.random()),
      type,
      actorType: 'system',
      actorId: 'x',
      commandId: null,
      caseId: null,
      areaKey: null,
      objectType: null,
      objectId: null,
      payload: {},
      occurredAt: NOW.toISOString(),
      recordedAt: NOW.toISOString(),
      ...extra,
    });

    const planned = await planCaseAdvanceJobs(
      fake.client as never,
      [
        event('delivery.confirmed', { caseId: 'c1', commandId: 'cmd-1' }),
        event('zoho.shipment_confirmed', { caseId: 'c1', commandId: 'cmd-1' }),
        event('step.completed', { caseId: 'c2', commandId: 'cmd-1' }),
        event('stock.reserved', { caseId: 'c3', commandId: 'ops:case.advance:c3:job:1' }),
        event('stock.controlled', { commandId: 'cmd-2', payload: { zohoItemId: 'item-9' } }),
      ] as never
    );

    expect(planned.map((p) => p.caseId).sort()).toEqual(['c-count', 'c1']);
    expect(planned.map((p) => [p.job.type, p.job.dedupeKey, p.job.groupKey])).toEqual(
      expect.arrayContaining([
        ['ops.case.advance', 'case:advance:c1:cmd-1', 'case:c1'],
        ['ops.case.advance', 'case:advance:c-count:cmd-2', 'case:c-count'],
      ])
    );
  });

  it('el avance derivado se encola en la misma transacción que el hecho', async () => {
    const { executeCommand, registerCommand } = await import('./commands');
    registerCommand('test.case_fact', {
      schema: z.object({ caseId: z.string(), crash: z.boolean().optional() }),
      aggregate: 'none',
      async handler(_tx, cmd, ctx) {
        ctx.emit('delivery.confirmed', {}, { caseId: cmd.payload.caseId });
        if (cmd.payload.crash) throw new Error('fallo después del hecho');
      },
    });
    const run = (commandId: string, payload: Record<string, unknown>) =>
      executeCommand(
        {
          commandId,
          type: 'test.case_fact',
          actor: { type: 'system', id: 'test' },
          aggregate: { type: 'test', id: commandId },
          payload,
        },
        null,
        { now: NOW }
      );
    const advanceJobs = () =>
      fake.rows('backgroundJob').filter((j) => j.type === 'ops.case.advance');

    await expect(run('fact-crash', { caseId: 'c-tx', crash: true })).rejects.toThrow();
    expect(advanceJobs()).toHaveLength(0); // rolled back together with the fact

    await run('fact-ok', { caseId: 'c-tx' });
    expect(advanceJobs()).toEqual([
      expect.objectContaining({ dedupeKey: 'case:advance:c-tx:fact-ok', status: 'pending' }),
    ]);
  });
});

describe('reglas del motor que evitan atascos y material fantasma', () => {
  it('una partida en una unidad sin conversión nunca se da por disponible; al registrar la conversión se recalcula', async () => {
    const { profile } = seedItemStock(fake, { zohoItemId: 'item-1', quantity: 30 });
    seedSalesOrder(fake, { lines: [{ quantity: 10, unit: 'caja' }] });

    const result = await systemStart();

    expect(result.status).toBe('completed');
    const [demand] = fake.rows('caseDemand');
    expect(demand).toMatchObject({ unit: 'caja', baseUnit: 'caja' });
    const verify = stepOf('verificar_disponibilidad', demand.id)!;
    expect(verify.status).toBe('ready'); // 30 pz CONTROLLED never cover «10 caja»
    expect(fake.rows('demandAllocation')).toHaveLength(0);
    expect(fake.rows('stockReservation')).toHaveLength(0);
    expect(itemOf(verify)!.description).toContain(
      'no se convierte a la unidad base del artículo (pz)'
    );

    profile.conversions = [{ unit: 'caja', factor: '12' }];
    const advanced = await advanceCaseCommand(caseRow().id, { actor: team.manager, now: NOW });

    expect(advanced.status).toBe('completed');
    expect(demand).toMatchObject({ baseUnit: 'pz' });
    expect(String(demand.baseQuantity)).toBe('120');
    expect(eventTypes()).toContain('demand.changed');
    expect(stepOf('verificar_disponibilidad', demand.id)!.status).toBe('ready'); // 30 < 120
  });

  it('si Compras rechaza la compra, la asignación se cancela y Ventas vuelve a decidir el plan', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 6 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    const { data } = await systemStart();
    const [demand] = fake.rows('caseDemand');
    await completeWorkItem(
      team.byArea.inventario,
      itemOf(stepOf('verificar_disponibilidad', demand.id))!.id,
      { result: { availability_result: { counted: 6 } } },
      { now: NOW }
    );
    await completeWorkItem(
      team.byArea.ventas,
      itemOf(stepOf('plan_abastecimiento', demand.id))!.id,
      { result: { allocation_plan: { acceptProposal: true } } },
      { now: NOW }
    );
    const purchase = fake.rows('demandAllocation').find((a) => a.source === 'purchase')!;
    const rejected = await rejectAreaRequest(
      team.byArea.compras,
      purchase.linkedId as string,
      { reason: 'El proveedor ya no fabrica esta pieza' },
      { now: NOW }
    );
    expect(rejected.status).toBe('completed');
    // The rejection enqueued the advance in its own transaction.
    expect(
      fake
        .rows('backgroundJob')
        .filter((j) => j.type === 'ops.case.advance' && j.status === 'pending')
    ).toHaveLength(1);

    const advanced = await advanceCaseCommand(data!.caseId, { now: NOW });

    expect(advanced.status).toBe('completed');
    expect(purchase.status).toBe('cancelled');
    expect(stepOf('esperar_recepcion', purchase.id)!.status).toBe('cancelled');
    const plan = stepOf('plan_abastecimiento', demand.id)!;
    expect(plan.status).toBe('ready'); // reopened: 4 pz still uncovered
    const reopenedItem = fake
      .rows('workItem')
      .find((w) => w.stepId === plan.id && OPEN.includes(w.status as string));
    expect(reopenedItem).toMatchObject({ status: 'open', ownerUserId: 'u_ventas' });
    expect(demand.status).toBe('planned');
    const stock = fake.rows('demandAllocation').find((a) => a.source === 'stock')!;
    expect(stock.status).toBe('reserved'); // what was already committed is kept
    expect(eventTypes()).toEqual(expect.arrayContaining(['allocation.cancelled', 'step.reopened']));
  });

  it('preparar el pedido exige existencia reservada o material recibido', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    await systemStart();
    // The reservation was lost (e.g. released by hand) while the order was being prepared.
    const [reservation] = fake.rows('stockReservation');
    reservation.status = 'released';
    Object.assign(fake.rows('demandAllocation')[0], {
      status: 'planned',
      stockReservationId: null,
    });

    const prepared = await completeWorkItem(
      team.byArea.inventario,
      itemOf(stepOf('preparar_pedido'))!.id,
      { result: { issue_movements: { movementIds: ['movement_test'] } } },
      { now: NOW }
    );

    expect(prepared).toMatchObject({ status: 'rejected', errorCode: 'step_condition_pending' });
    expect(prepared.message).toContain('sin reservar');
    expect(fake.rows('demandAllocation')[0].status).toBe('planned');
    expect(fake.rows('deliveryOrder')).toHaveLength(0);
  });

  it('esperar_recepcion sólo se cierra con el movimiento de entrada y reserva ese material', async () => {
    const { stockItem } = seedItemStock(fake, { zohoItemId: 'item-1', quantity: 6 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    await systemStart();
    const [demand] = fake.rows('caseDemand');
    await completeWorkItem(
      team.byArea.inventario,
      itemOf(stepOf('verificar_disponibilidad', demand.id))!.id,
      { result: { availability_result: { counted: 6 } } },
      { now: NOW }
    );
    await completeWorkItem(
      team.byArea.ventas,
      itemOf(stepOf('plan_abastecimiento', demand.id))!.id,
      { result: { allocation_plan: { acceptProposal: true } } },
      { now: NOW }
    );
    const purchase = fake.rows('demandAllocation').find((a) => a.source === 'purchase')!;
    const waitItem = itemOf(stepOf('esperar_recepcion', purchase.id))!;

    const claimedOnly = await completeWorkItem(
      team.byArea.compras,
      waitItem.id,
      { result: { receipt_movement: 'ok' } },
      { now: NOW }
    );
    expect(claimedOnly).toMatchObject({ status: 'rejected', errorCode: 'evidence_invalid' });
    expect(purchase.status).toBe('requested');

    // Compras receives the 4 pz in the warehouse.
    const { Prisma } = await import('@prisma/client');
    stockItem.receipts = new Prisma.Decimal(4);
    stockItem.knownQty = new Prisma.Decimal(10);
    fake.seed('stockMovement', {
      id: 'mv-receipt-1',
      stockItemId: stockItem.id,
      zohoItemId: 'item-1',
      warehouseId: 'wh_principal',
      kind: 'receipt',
      quantity: new Prisma.Decimal(4),
      originalQuantity: new Prisma.Decimal(4),
      originalUnit: 'pz',
      actorId: 'u_compras',
      occurredAt: NOW,
    });
    const received = await completeWorkItem(
      team.byArea.compras,
      waitItem.id,
      { result: { receipt_movement: 'mv-receipt-1' } },
      { now: NOW }
    );

    expect(received.status).toBe('completed');
    const backing = fake
      .rows('stockReservation')
      .find((r) => r.allocationId === purchase.id && r.status === 'active');
    expect(backing).toBeDefined();
    expect(String(backing!.quantity)).toBe('4');
    expect(purchase).toMatchObject({ status: 'ready', stockReservationId: backing!.id });
    expect(String(stockItem.reserved)).toBe('10');
    expect(stepOf('preparar_pedido')!.status).toBe('ready');
  });

  it('asignar transporte espera sin escalar mientras Zoho no confirma y vuelve a abrirse después', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    const { data } = await systemStart();
    await completeWorkItem(
      team.byArea.inventario,
      itemOf(stepOf('preparar_pedido'))!.id,
      { result: { issue_movements: { movementIds: ['movement_test'] } } },
      { now: NOW }
    );
    const order = fake.rows('deliveryOrder')[0];
    Object.assign(order, { status: 'pending_external', zohoSyncState: 'pending_write' });

    await advanceCaseCommand(data!.caseId, { actor: team.manager, now: NOW });

    const transport = stepOf('asignar_transporte')!;
    expect(transport.status).toBe('waiting');
    const item = itemOf(transport)!;
    const until = new Date(NOW.getTime() + 15 * 60_000);
    expect(item).toMatchObject({
      status: 'waiting',
      waitReason: 'Esperando que Zoho confirme el embarque',
      waitUntil: until,
      dueAt: new Date(until.getTime() + 60 * 60_000),
    });

    // Zoho answered with other values: nothing is pending anymore, the work is open again.
    Object.assign(order, { status: 'conflict', zohoSyncState: 'readback_mismatch' });
    const later = new Date(NOW.getTime() + 20 * 60_000);
    await advanceCaseCommand(data!.caseId, { actor: team.manager, now: later });

    expect(stepOf('asignar_transporte')!.status).toBe('ready');
    expect(itemOf(transport)).toMatchObject({
      status: 'open',
      waitReason: null,
      waitUntil: null,
      dueAt: new Date(later.getTime() + 60 * 60_000),
    });
    expect(eventTypes()).toContain('workitem.resumed');
  });
});

describe('reglas puras del servicio', () => {
  it('deriveCasePhase toma la fase del paso abierto menos avanzado', () => {
    const bp = SALES_FULFILLMENT_BLUEPRINT;
    expect(
      deriveCasePhase(
        [
          { stepKey: 'plan_abastecimiento', status: 'done' },
          { stepKey: 'confirmar_entrega_directa', status: 'waiting' },
          { stepKey: 'esperar_recepcion', status: 'waiting' },
          { stepKey: 'preparar_pedido', status: 'pending' },
        ],
        bp
      )
    ).toBe('sourcing');
    expect(
      deriveCasePhase(
        [
          { stepKey: 'reservar_stock', status: 'done' },
          { stepKey: 'confirmar_entrega_directa', status: 'waiting' },
          { stepKey: 'preparar_pedido', status: 'ready' },
        ],
        bp
      )
    ).toBe('preparing');
    expect(
      deriveCasePhase(
        [
          { stepKey: 'entregar', status: 'done' },
          { stepKey: 'cierre_operativo', status: 'skipped' },
        ],
        bp
      )
    ).toBe('delivering');
    expect(deriveCasePhase([{ stepKey: 'verificar_disponibilidad', status: 'pending' }], bp)).toBe(
      'planning'
    );
  });

  it('preparationBlockers: sólo existencia reservada o material recibido', () => {
    const reserved = new Set(['a-stock-ok', 'a-reopened']);
    expect(
      preparationBlockers(
        [
          { id: 'a-stock-ok', source: 'stock', status: 'reserved' },
          { id: 'a-stock-lost', source: 'stock', status: 'reserved' },
          { id: 'a-stock-planned', source: 'stock', status: 'planned' },
          { id: 'a-purchase-requested', source: 'purchase', status: 'requested' },
          { id: 'a-production', source: 'manufacture', status: 'in_progress' },
          { id: 'a-purchase-ready', source: 'purchase', status: 'ready' },
          { id: 'a-reopened', source: 'purchase', status: 'reopened' },
          { id: 'a-direct', source: 'direct_supplier', status: 'requested' },
          { id: 'a-cancelled', source: 'stock', status: 'cancelled' },
        ],
        reserved
      )
    ).toEqual(['a-stock-lost', 'a-stock-planned', 'a-purchase-requested', 'a-production']);
  });

  it('computeStepDueAt usa el ancla y su respaldo', () => {
    const def = { slaMinutes: 1440, slaAnchor: 'expectedAt' as const, slaFallbackMinutes: 60 };
    expect(computeStepDueAt(def, new Date('2026-09-20T00:00:00.000Z'), NOW)).toEqual(
      new Date('2026-09-21T00:00:00.000Z')
    );
    expect(computeStepDueAt(def, null, NOW)).toEqual(new Date(NOW.getTime() + 60 * 60_000));
    expect(computeStepDueAt({ slaMinutes: 15 }, null, NOW)).toEqual(
      new Date(NOW.getTime() + 15 * 60_000)
    );
  });

  it('deriveCaseStatus', () => {
    const steps = [{ stepKey: 'preparar_pedido', status: 'ready' }];
    expect(
      deriveCaseStatus({
        current: 'open',
        steps,
        openWorkItemStatuses: ['open'],
        openRequestStatuses: [],
      })
    ).toBe('open');
    expect(
      deriveCaseStatus({
        current: 'open',
        steps,
        openWorkItemStatuses: ['waiting'],
        openRequestStatuses: [],
      })
    ).toBe('waiting');
    expect(
      deriveCaseStatus({
        current: 'open',
        steps,
        openWorkItemStatuses: ['open'],
        openRequestStatuses: ['blocked'],
      })
    ).toBe('blocked');
    expect(
      deriveCaseStatus({
        current: 'open',
        steps: [{ stepKey: 'cierre_operativo', status: 'done' }],
        openWorkItemStatuses: [],
        openRequestStatuses: [],
      })
    ).toBe('ready_to_close');
    expect(
      deriveCaseStatus({
        current: 'open',
        steps: [{ stepKey: 'cierre_financiero', status: 'done' }],
        openWorkItemStatuses: [],
        openRequestStatuses: [],
      })
    ).toBe('closed');
    expect(
      deriveCaseStatus({
        current: 'cancelled',
        steps,
        openWorkItemStatuses: ['open'],
        openRequestStatuses: [],
      })
    ).toBe('cancelled');
  });
});
