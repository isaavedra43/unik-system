import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Direct supplier delivery on FakePrisma with the real case engine and
 * logistics service: the supplier delivers to the customer, Compras confirms
 * with evidence, no stock moves, and the system job records the delivery order
 * as delivered through `recordDelivery`.
 */

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('./testing/purchases-fixtures');
  const inventory = await import('@/modules/inventory/testing/inventory-fixtures');
  const fake = fixtures.createPurchasesFake();
  return {
    fake,
    locks: inventory.createLockEmulation(fake),
    notifyUser: vi.fn(async () => ({ id: 'n1', inApp: true, push: false, suppressed: false })),
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
}));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/modules/auth/permissions')>();
  const { PURCHASES_PERMISSIONS } = await import('./permissions');
  const registry = [...original.PERMISSION_REGISTRY, ...PURCHASES_PERMISSIONS];
  const keys = new Set(registry.map((p) => p.key));
  return {
    ...original,
    PERMISSION_REGISTRY: registry,
    isKnownPermission: (key: string) => keys.has(key),
    assertKnownPermission: (key: string) => {
      if (!keys.has(key)) throw new Error(`Unknown permission "${key}"`);
    },
    filterKnownPermissions: (list: string[]) => list.filter((key) => keys.has(key)),
  };
});
vi.mock('./finance-bridge', () => ({
  createProcurementPayable: vi.fn(),
  cancelProcurementPayable: vi.fn(),
  registerProcurementSettlementHandler: vi.fn(() => () => undefined),
  registerProcurementSettlementReversedHandler: vi.fn(() => () => undefined),
  requestProcurementPaymentAuthorization: vi.fn(async (_tx: unknown, input: { obligationId: string }) => ({
    obligationId: input.obligationId,
    approvalRequestId: 'apr_payment',
    status: 'pending',
    autoApproved: false,
    reused: false,
    requiredApprovals: 1,
    approverCount: 1,
  })),
}));
vi.mock('@/modules/comms/comms-service', () => ({
  startConversation: vi.fn(),
  updateConversation: vi.fn(),
  sendOutboundMessage: vi.fn(),
}));
vi.mock('@/modules/ai/ai-client', () => ({ chatCompletion: vi.fn() }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({})) }));
vi.mock('./sourcing-providers', () => ({
  runBraveSearch: vi.fn(),
  runCatalogPages: vi.fn(),
  recordSourcingSpend: vi.fn(),
  sourcingUnitsUsedToday: vi.fn(async () => 0),
  cleanupSourcingThrottle: vi.fn(async () => 0),
}));

import { decideApproval } from '@/modules/operations/approvals-service';
import { advanceCaseCommand, startSalesFulfillment } from '@/modules/operations/case-service';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { clearProcessBlueprintCache } from '@/modules/operations/process-blueprints/registry';
import {
  CASE_TEST_NOW,
  seedCaseTeam,
  seedItemStock,
  seedOperationsConfig,
  seedSalesOrder,
  type CaseTeam,
} from '@/modules/operations/testing/case-fixtures';
import { completeWorkItem } from '@/modules/operations/work-items-service';
import * as purchases from './purchases-commands';
import { seedPurchasesTeam, seedStorageObject, seedSupplier, type PurchasesTeam } from './testing/purchases-fixtures';

const { fake } = mocks;
const NOW = CASE_TEST_NOW;
let team: CaseTeam;
let people: PurchasesTeam;

const rows = (model: string) => fake.rows(model);
const stepOf = (stepKey: string, scopeKey = '') => rows('caseStep').find((s) => s.stepKey === stepKey && s.scopeKey === scopeKey);
const itemOf = (step: Record<string, unknown> | undefined) => rows('workItem').find((w) => step && w.stepId === step.id);

beforeEach(() => {
  fake.tables.clear();
  mocks.locks.reset();
  invalidateOperationsConfigCache();
  clearProcessBlueprintCache();
  team = seedCaseTeam(fake);
  seedOperationsConfig(fake);
  people = seedPurchasesTeam(fake);
});

describe('entrega directa del proveedor', () => {
  it('confirmación con evidencia: sin movimiento de inventario, entrega registrada en logística y expediente avanzado', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 0 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    await startSalesFulfillment('zso-1', {
      commandId: 'ops:case.start:so:zso-1:job_1:1',
      actor: { type: 'system', id: 'job:ops.case.start' },
      now: NOW,
    });
    const [demand] = rows('caseDemand');
    const caseId = demand.caseId as string;
    await completeWorkItem(
      team.byArea.inventario,
      itemOf(stepOf('verificar_disponibilidad', demand.id as string))!.id as string,
      { result: { availability_result: { counted: 0 } } },
      { now: NOW }
    );
    expect(
      await completeWorkItem(
        team.byArea.ventas,
        itemOf(stepOf('plan_abastecimiento', demand.id as string))!.id as string,
        { result: { allocation_plan: { lines: [{ source: 'direct_supplier', quantity: 10 }] } } },
        { now: NOW }
      )
    ).toMatchObject({ status: 'completed' });
    const direct = rows('demandAllocation').find((a) => a.source === 'direct_supplier')!;
    const request = rows('areaRequest').find((r) => r.id === direct.linkedId)!;
    expect(request.toAreaKey).toBe('compras');

    await purchases.runShortfallSync(request.id as string, 'job_sync', 1, NOW);
    const [prLine] = rows('purchaseRequestLine');
    expect(prLine).toMatchObject({ allocationId: direct.id, demandId: demand.id });

    const supplier = seedSupplier(fake, { name: 'Fábrica Norte', paymentMode: 'credit' });
    const created = await purchases.createProcurementOrder(
      people.buyer,
      {
        supplierId: supplier.id as string,
        deliveryMode: 'direct_to_customer',
        directDeliveryCaseId: caseId,
        expectedAt: '2026-09-18',
        lines: [{ requestLineId: prLine.id as string, qty: 10, unitPrice: 80 }],
      },
      { now: NOW }
    );
    expect(created.status).toBe('completed');
    const order = rows('procurementOrder')[0];
    expect(order).toMatchObject({ deliveryMode: 'direct_to_customer', directDeliveryCaseId: caseId, warehouseId: null });
    await purchases.submitProcurementOrder(people.buyer, { orderId: order.id as string }, { now: NOW });
    const approval = rows('approvalRequest')[0];
    await decideApproval(people.approver, { approvalRequestId: approval.id as string, decision: 'approve' }, { now: NOW });
    expect(direct.status).toBe('in_progress');

    // A warehouse receipt is refused for a direct delivery order.
    const [orderLine] = rows('procurementOrderLine');
    expect(
      await purchases.recordGoodsReceipt(people.receiver, { orderId: order.id as string, lines: [{ orderLineId: orderLine.id as string, qtyReceived: 10 }] }, { now: NOW })
    ).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });

    // Evidence of someone else is refused; the receiver's own photo is accepted.
    seedStorageObject(fake, { id: 'obj_other', createdBy: 'u_outsider' });
    seedStorageObject(fake, { id: 'obj_photo', createdBy: 'u_receiver' });
    expect(
      await purchases.confirmDirectDelivery(
        people.receiver,
        { orderId: order.id as string, lines: [{ orderLineId: orderLine.id as string, qtyDelivered: 10 }], receivedBy: 'Residente de obra', evidenceObjectIds: ['obj_other'] },
        { now: NOW }
      )
    ).toMatchObject({ status: 'rejected', errorCode: 'evidence_invalid' });

    const confirmed = await purchases.confirmDirectDelivery(
      people.receiver,
      { orderId: order.id as string, lines: [{ orderLineId: orderLine.id as string, qtyDelivered: 10 }], receivedBy: 'Residente de obra', evidenceObjectIds: ['obj_photo'] },
      { now: NOW }
    );
    expect(confirmed).toMatchObject({
      status: 'completed',
      data: { orderStatus: 'received', syncQueued: true, plan: { deliveries: [{ caseId, allocationId: direct.id, deliveredQty: 10 }] } },
    });
    expect(rows('goodsReceipt')[0]).toMatchObject({ mode: 'direct_delivery', status: 'posted', directConfirmedByUserId: 'u_receiver' });
    expect(rows('stockMovement')).toHaveLength(0);
    const syncJob = rows('backgroundJob').find((job) => job.type === 'purchases.direct_delivery_sync')!;
    expect(syncJob.payload).toMatchObject({ receiptId: rows('goodsReceipt')[0].id });

    const { result, failure } = await purchases.runDirectDeliverySync(confirmed.data!.plan, 'job_direct', 1, NOW);
    expect(failure).toBeNull();
    expect(result).toMatchObject({ status: 'completed' });
    const deliveryOrder = rows('deliveryOrder')[0];
    expect(deliveryOrder).toMatchObject({ mode: 'direct_supplier', status: 'delivered', receivedBy: 'Residente de obra', allocationIds: [direct.id] });
    expect(rows('deliveryEvidence').find((e) => e.storageObjectId === 'obj_photo')).toMatchObject({ kind: 'photo', deliveryOrderId: deliveryOrder.id });
    expect(direct).toMatchObject({ status: 'delivered' });
    expect(demand).toMatchObject({ status: 'fulfilled' });
    expect(request.status).toBe('resolved');
    expect(rows('stockMovement')).toHaveLength(0);

    // Repeating the job never delivers twice.
    const again = await purchases.runDirectDeliverySync(confirmed.data!.plan, 'job_direct_again', 1, NOW);
    expect(again.result).toMatchObject({ status: 'completed', data: { deliveryOrderIds: [] } });

    await advanceCaseCommand(caseId, { commandId: 'case.advance:direct-test', now: NOW });
    expect(stepOf('confirmar_entrega_directa', direct.id as string)!.status).toBe('done');
  });
});
