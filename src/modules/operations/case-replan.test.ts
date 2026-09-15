import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * case.replan and case.cancel on FakePrisma (plan 2.5): quantity down/up,
 * new and removed lines, address changes with and without assigned transport,
 * cancellation with compensations (from Zoho and manual).
 */

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('./testing/case-fixtures');
  const inventory = await import('@/modules/inventory/testing/inventory-fixtures');
  const fake = fixtures.createCaseFake();
  return {
    fake,
    locks: inventory.createLockEmulation(fake),
    notifyUser: vi.fn(async () => ({ id: 'n1', inApp: true, push: false, suppressed: false })),
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

import type { Row } from '@/modules/comms/testing/fake-prisma';
import { acceptAreaRequest } from './area-requests-service';
import { startSalesFulfillment } from './case-service';
import { invalidateOperationsConfigCache } from './operations-config';
import { clearProcessBlueprintCache } from './process-blueprints/registry';
import { cancelCase, replanCase } from './replan';
import {
  CASE_TEST_NOW,
  seedCaseTeam,
  seedItemStock,
  seedOperationsConfig,
  seedOrderItems,
  seedSalesOrder,
  type CaseTeam,
  type SeedOrderLine,
} from './testing/case-fixtures';
import { completeWorkItem, startWorkItem } from './work-items-service';

const { fake } = mocks;
const NOW = CASE_TEST_NOW;
const OPEN = ['open', 'in_progress', 'waiting', 'escalated'];
let team: CaseTeam;
let counter = 0;

const stepOf = (stepKey: string, scopeKey = '') =>
  fake.rows('caseStep').find((s) => s.stepKey === stepKey && s.scopeKey === scopeKey);
const itemOf = (step: Row | undefined) =>
  fake.rows('workItem').find((w) => step && w.stepId === step.id);
const openItems = () => fake.rows('workItem').filter((w) => OPEN.includes(w.status as string));
const eventsOf = (type: string) => fake.rows('operationalEvent').filter((e) => e.type === type);
const demandOf = (zohoItemId: string) =>
  fake.rows('caseDemand').find((d) => d.zohoItemId === zohoItemId)!;
const allocationsOf = (demandId: string) =>
  fake.rows('demandAllocation').filter((a) => a.demandId === demandId);
const stockOf = (zohoItemId: string) =>
  fake.rows('stockItem').find((s) => s.zohoItemId === zohoItemId)!;
const caseRow = () => fake.rows('operationalCase')[0];
const salesOrder = () => fake.rows('salesOrder')[0];

async function startCase(
  lines: SeedOrderLine[] = [{ quantity: 10 }],
  extra: Record<string, unknown> = {}
) {
  seedSalesOrder(fake, { lines, ...extra });
  const result = await startSalesFulfillment('zso-1', {
    commandId: 'ops:case.start:so:zso-1:job_1:1',
    actor: { type: 'system', id: 'job:ops.case.start' },
    now: NOW,
  });
  expect(result.status).toBe('completed');
  return result.data!.caseId;
}

function changeOrder(lines: SeedOrderLine[]) {
  seedOrderItems(fake, salesOrder().id as string, lines);
}

function changeEvent(fields: Record<string, { before: unknown; after: unknown }>): string {
  counter += 1;
  return fake.seed('entityChangeEvent', {
    id: `chg-${counter}`,
    entityType: 'sales_order',
    entityId: salesOrder().id,
    sourceSnapshotId: `snap-${counter}`,
    changes: { fields },
  }).id as string;
}

function replan(caseId: string, changeEventId?: string) {
  counter += 1;
  return replanCase(caseId, {
    commandId: `ops:case.replan:${caseId}:${changeEventId ?? `manual-${counter}`}:1`,
    systemActorId: 'job:ops.case.replan',
    changeEventId,
    now: NOW,
  });
}

async function prepareOrder() {
  const result = await completeWorkItem(
    team.byArea.inventario,
    itemOf(stepOf('preparar_pedido'))!.id,
    { result: { issue_movements: 'Surtido' } },
    { now: NOW }
  );
  expect(result.status).toBe('completed');
}

/** Line 2 (item-2, UNCOUNTED) goes through verification and a human plan → purchase requested. */
async function planPurchaseForItem2() {
  const demand = demandOf('item-2');
  const verified = await completeWorkItem(
    team.byArea.inventario,
    itemOf(stepOf('verificar_disponibilidad', demand.id as string))!.id,
    { result: { availability_result: { counted: 0 } } },
    { now: NOW }
  );
  expect(verified.status).toBe('completed');
  const planned = await completeWorkItem(
    team.byArea.ventas,
    itemOf(stepOf('plan_abastecimiento', demand.id as string))!.id,
    { result: { allocation_plan: true } },
    { now: NOW }
  );
  expect(planned.status).toBe('completed');
  const purchase = allocationsOf(demand.id as string).find((a) => a.source === 'purchase')!;
  expect(purchase.status).toBe('requested');
  return {
    demand,
    purchase,
    request: fake.rows('areaRequest').find((r) => r.id === purchase.linkedId)!,
  };
}

beforeEach(() => {
  fake.tables.clear();
  mocks.locks.reset();
  invalidateOperationsConfigCache();
  clearProcessBlueprintCache();
  team = seedCaseTeam(fake);
  seedOperationsConfig(fake);
});

describe('case.replan', () => {
  it('cantidad a la baja: libera la reserva y vuelve a reservar sólo lo nuevo', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 20 });
    const caseId = await startCase();
    const prepareItem = itemOf(stepOf('preparar_pedido'))!;
    const oldReservation = fake.rows('stockReservation')[0];

    changeOrder([{ quantity: 6 }]);
    const result = await replan(caseId);

    expect(result).toMatchObject({
      status: 'completed',
      data: { changed: true, summary: { quantityDown: 1 } },
    });
    const demand = demandOf('item-1');
    expect(String(demand.quantity)).toBe('6');
    expect(String(demand.baseQuantity)).toBe('6');
    const [allocation] = allocationsOf(demand.id as string);
    expect(String(allocation.quantity)).toBe('6');
    expect(allocation.status).toBe('reserved');
    expect(oldReservation.status).toBe('released');
    const active = fake.rows('stockReservation').filter((r) => r.status === 'active');
    expect(active).toHaveLength(1);
    expect(String(active[0].quantity)).toBe('6');
    expect(String(stockOf('item-1').reserved)).toBe('6');
    expect(itemOf(stepOf('preparar_pedido'))!.id).toBe(prepareItem.id);
    expect(prepareItem.status).toBe('open');
    expect(eventsOf('demand.changed')).toHaveLength(1);
    expect(eventsOf('allocation.reopened')).toHaveLength(1);
    expect(eventsOf('case.replanned')).toHaveLength(1);
    expect(eventsOf('step.reopened')).toHaveLength(1);
  });

  it('cantidad a la alza: reabre el plan y reserva el aumento con existencia controlada', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 20 });
    const caseId = await startCase();
    const prepareItem = itemOf(stepOf('preparar_pedido'))!;

    changeOrder([{ quantity: 14 }]);
    const result = await replan(caseId);

    expect(result).toMatchObject({
      status: 'completed',
      data: { summary: { quantityUp: 1, conflicts: 0 } },
    });
    const demand = demandOf('item-1');
    const allocations = allocationsOf(demand.id as string);
    expect(allocations.map((a) => [String(a.quantity), a.status])).toEqual([
      ['10', 'reserved'],
      ['4', 'reserved'],
    ]);
    expect(String(stockOf('item-1').reserved)).toBe('14');
    expect(stepOf('plan_abastecimiento', demand.id as string)!.status).toBe('done');
    expect(demand.status).toBe('allocated');
    const prepare = stepOf('preparar_pedido')!;
    expect(prepare.status).toBe('ready');
    expect(prepare.dependsOn).toEqual(
      expect.arrayContaining(allocations.map((a) => `reservar_stock:${a.id}`))
    );
    expect(itemOf(prepare)!.id).toBe(prepareItem.id);
    expect(fake.rows('incident')).toHaveLength(0);
  });

  it('cantidad a la alza con la preparación en curso: el paso vuelve a esperar y nada sin reservar se da por listo', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 10 });
    const caseId = await startCase();
    const prepareItem = itemOf(stepOf('preparar_pedido'))!;
    expect((await startWorkItem(team.byArea.inventario, prepareItem.id, { now: NOW })).status).toBe(
      'completed'
    );
    expect(stepOf('preparar_pedido')!.status).toBe('active');

    changeOrder([{ quantity: 14 }]); // no free stock for the 4 extra pieces
    const result = await replan(caseId);

    expect(result.status).toBe('completed');
    const prepare = stepOf('preparar_pedido')!;
    expect(prepare.status).toBe('pending');
    expect(prepareItem.status).toBe('cancelled');
    const late = await completeWorkItem(
      team.byArea.inventario,
      prepareItem.id,
      { result: { issue_movements: 'Surtido' } },
      { now: NOW }
    );
    expect(late.status).toBe('rejected');
    const allocations = allocationsOf(demandOf('item-1').id as string);
    expect(allocations.filter((a) => a.status === 'ready')).toHaveLength(0);
    expect(fake.rows('deliveryOrder')).toHaveLength(0);
  });

  it('cantidad a la alza con el pedido ya preparado: incidencia order_change_conflict', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 20 });
    const caseId = await startCase();
    await prepareOrder();

    changeOrder([{ quantity: 12 }]);
    const result = await replan(caseId);

    expect(result.status).toBe('completed');
    const [incident] = fake.rows('incident');
    expect(incident).toMatchObject({
      kind: 'order_change_conflict',
      severity: 'medium',
      status: 'open',
      caseId,
    });
    expect(incident.detail).toMatchObject({ reason: 'prepared', quantity: 2 });
    expect(stepOf('preparar_pedido')!.status).toBe('done');
    expect(allocationsOf(demandOf('item-1').id as string)).toHaveLength(2);
  });

  it('línea nueva: crea la necesidad con sus pasos y la surte sin tocar la preparación', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 20 });
    seedItemStock(fake, { zohoItemId: 'item-2', quantity: 5 });
    const caseId = await startCase();
    const prepareItem = itemOf(stepOf('preparar_pedido'))!;

    changeOrder([{ quantity: 10 }, { quantity: 3 }]);
    const result = await replan(caseId);

    expect(result).toMatchObject({ status: 'completed', data: { summary: { added: 1 } } });
    const second = demandOf('item-2');
    expect(second).toMatchObject({ lineRef: 'li-2', status: 'allocated' });
    expect(allocationsOf(second.id as string)).toEqual([
      expect.objectContaining({ status: 'reserved' }),
    ]);
    expect(String(stockOf('item-2').reserved)).toBe('3');
    expect(stepOf('verificar_disponibilidad', second.id as string)!.status).toBe('done');
    expect(stepOf('preparar_pedido')!.status).toBe('ready');
    expect(itemOf(stepOf('preparar_pedido'))!.id).toBe(prepareItem.id);
    expect(eventsOf('demand.created').map((e) => (e.payload as Row).reason)).toEqual([
      'case_start',
      'replan',
    ]);
  });

  it('línea eliminada: cancela la compra solicitada, la necesidad y sus pasos', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 20 });
    seedItemStock(fake, { zohoItemId: 'item-2', quantity: 0, confidence: 'UNCOUNTED' });
    const caseId = await startCase([{ quantity: 10 }, { quantity: 3 }]);
    const { demand, purchase, request } = await planPurchaseForItem2();
    const waitStep = stepOf('esperar_recepcion', purchase.id as string)!;
    expect(waitStep.status).toBe('waiting');

    changeOrder([{ quantity: 10 }]);
    const result = await replan(caseId);

    expect(result).toMatchObject({ status: 'completed', data: { summary: { removed: 1 } } });
    expect(request.status).toBe('cancelled');
    expect(purchase.status).toBe('cancelled');
    expect(demand.status).toBe('cancelled');
    expect(waitStep.status).toBe('cancelled');
    expect(itemOf(waitStep)!.status).toBe('cancelled');
    expect(eventsOf('allocation.cancelled')).toHaveLength(1);
    expect(eventsOf('demand.cancelled')).toHaveLength(1);
    const prepare = stepOf('preparar_pedido')!;
    expect(prepare.status).toBe('ready');
    expect(prepare.dependsOn.some((ref: string) => ref.includes(purchase.id as string))).toBe(
      false
    );
    expect(itemOf(prepare)!.status).toBe('open');
  });

  it('dirección: parchea la entrega pendiente; con transporte asignado abre incidencia y trabajo a logística', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 20 });
    const caseId = await startCase();
    await prepareOrder();
    const deliveryOrder = fake.rows('deliveryOrder')[0];
    expect(deliveryOrder).toMatchObject({ status: 'pending', city: 'Monterrey' });

    salesOrder().shippingCity = 'Saltillo';
    const patched = await replan(
      caseId,
      changeEvent({ shippingCity: { before: 'Monterrey', after: 'Saltillo' } })
    );
    expect(patched).toMatchObject({
      status: 'completed',
      data: { summary: { deliveryPatches: 1 } },
    });
    expect(deliveryOrder.city).toBe('Saltillo');
    expect(eventsOf('delivery.address_updated')).toHaveLength(1);
    expect(fake.rows('incident')).toHaveLength(0);

    deliveryOrder.status = 'assigned';
    deliveryOrder.zohoSyncState = 'readback_ok';
    salesOrder().shippingAddressLine1 = 'Calle Nueva 5';
    const conflicted = await replan(
      caseId,
      changeEvent({ shippingAddressLine1: { before: 'Av. Reforma 100', after: 'Calle Nueva 5' } })
    );
    expect(conflicted).toMatchObject({
      status: 'completed',
      data: { summary: { deliveryIncidents: 1 } },
    });
    expect(deliveryOrder.addressLine).toBe('Av. Reforma 100');
    const [incident] = fake.rows('incident');
    expect(incident).toMatchObject({
      kind: 'order_change_conflict',
      areaKey: 'logistica',
      dedupeKey: `order_change:${caseId}:delivery:${deliveryOrder.id}:address`,
    });
    expect(openItems().find((w) => w.objectType === 'incident')).toMatchObject({
      areaKey: 'logistica',
      kind: 'incident_followup',
      objectId: incident.id,
    });
  });
});

describe('case.cancel', () => {
  it('orden anulada en Zoho: libera, vence solicitudes y compensa lo que está en vuelo', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 20 });
    seedItemStock(fake, { zohoItemId: 'item-2', quantity: 0, confidence: 'UNCOUNTED' });
    const caseId = await startCase([{ quantity: 10 }, { quantity: 3 }]);
    const { purchase, request } = await planPurchaseForItem2();
    const accepted = await acceptAreaRequest(
      team.byArea.compras,
      request.id as string,
      {},
      { now: NOW }
    );
    expect(accepted.status).toBe('completed');
    expect(request.status).toBe('accepted');

    salesOrder().status = 'void';
    const result = await replan(caseId);

    expect(result).toMatchObject({ status: 'completed', data: { cancelled: true } });
    expect(caseRow()).toMatchObject({ status: 'cancelled', cancelledAt: NOW });
    expect(caseRow().closeReason).toContain('se anuló en Zoho');
    expect(String(stockOf('item-1').reserved)).toBe('0');
    expect(fake.rows('stockReservation').every((r) => r.status === 'released')).toBe(true);
    expect(request.status).toBe('expired');
    const cancelRequest = fake.rows('areaRequest').find((r) => r.kind === 'cancel')!;
    expect(cancelRequest).toMatchObject({
      toAreaKey: 'compras',
      fromAreaKey: 'ventas',
      objectId: purchase.id,
    });
    expect(fake.rows('incident')).toEqual([
      expect.objectContaining({
        kind: 'cancellation_compensation',
        severity: 'medium',
        areaKey: 'compras',
      }),
    ]);
    expect(fake.rows('demandAllocation').every((a) => a.status === 'cancelled')).toBe(true);
    expect(fake.rows('caseDemand').every((d) => d.status === 'cancelled')).toBe(true);
    expect(
      fake
        .rows('caseStep')
        .some((s) => ['pending', 'ready', 'active', 'waiting'].includes(s.status as string))
    ).toBe(false);
    expect(openItems().map((w) => w.objectId)).toEqual([cancelRequest.id]);
    expect(eventsOf('case.cancelled')).toHaveLength(1);
  });

  it('cancelación manual con embarque escrito: cancela la entrega y encola la cancelación en Zoho', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 20 });
    const caseId = await startCase();
    await prepareOrder();
    const deliveryOrder = fake.rows('deliveryOrder')[0];
    Object.assign(deliveryOrder, {
      status: 'assigned',
      packageId: 'pkg_1',
      zohoSyncState: 'readback_ok',
    });

    expect(
      await cancelCase(team.stranger, caseId, { reason: 'El cliente desistió' }, { now: NOW })
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });
    const result = await cancelCase(
      team.manager,
      caseId,
      { reason: 'El cliente desistió' },
      { now: NOW }
    );

    expect(result).toMatchObject({
      status: 'completed',
      data: { alreadyCancelled: false, cancelledDeliveryOrders: 1, zohoCancellationsQueued: 1 },
    });
    expect(deliveryOrder.status).toBe('cancelled');
    expect(fake.rows('backgroundJob').map((j) => j.type)).toContain('ops.zoho.cancel_shipment');
    expect(fake.rows('incident')).toEqual([
      expect.objectContaining({
        kind: 'cancellation_compensation',
        areaKey: 'inventario',
        severity: 'medium',
      }),
    ]);
    expect(caseRow()).toMatchObject({ status: 'cancelled', closeReason: 'El cliente desistió' });
    expect(openItems()).toHaveLength(0);

    const again = await cancelCase(team.manager, caseId, { reason: 'Otra vez' }, { now: NOW });
    expect(again).toMatchObject({ status: 'completed', data: { alreadyCancelled: true } });
    expect(await replan(caseId)).toMatchObject({
      status: 'completed',
      data: { skipped: 'cancelled' },
    });
  });
});
