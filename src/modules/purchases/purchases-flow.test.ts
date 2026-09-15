import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Compras on FakePrisma with the real case engine and inventory (plan 6.1,
 * flow "Compra por faltante"): shortfall request → purchase request → order →
 * simple/double approval → payment (finance bridge mocked) → partial receipt
 * with a difference → immediate reservation → case advance. Material that is
 * only expected never shows as available. Row locks of the inventory are
 * emulated; AI, messaging, storage and finance are mocked.
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
    saveGeneratedFile: vi.fn(async () => ({ id: 'pdf_1', sha256: 'hash' })),
    settled: { handler: null as null | ((...args: unknown[]) => Promise<void>) },
    cancelPayable: vi.fn(),
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
  createProcurementPayable: vi.fn(async (tx: { obligation: { create: (args: unknown) => Promise<unknown> } }, input: Record<string, unknown>) =>
    tx.obligation.create({
      data: {
        number: `OB-${String(input.orderNumber)}`,
        kind: 'payable',
        counterpartyType: 'supplier',
        counterpartyName: input.supplierName,
        supplierId: input.supplierId,
        caseId: input.caseId,
        procurementOrderId: input.orderId,
        description: `Orden ${String(input.orderNumber)}`,
        currency: input.currency,
        expectedAmount: input.amount,
        dueAt: input.dueAt,
        categoryId: 'cat_compras',
      },
    })
  ),
  cancelProcurementPayable: mocks.cancelPayable,
  registerProcurementSettlementHandler: vi.fn((handler: (...args: unknown[]) => Promise<void>) => {
    mocks.settled.handler = handler;
    return () => undefined;
  }),
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
vi.mock('@/modules/storage/storage-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/storage/storage-service')>()),
  saveGeneratedFile: mocks.saveGeneratedFile,
}));
vi.mock('@/modules/ai/generators/pdf-generator', () => ({
  generatePdfReport: vi.fn(async () => ({ sizeBytes: 10, pageCount: 1 })),
}));

import { verifyAvailability } from '@/modules/inventory/inventory-service';
import { decideApproval } from '@/modules/operations/approvals-service';
import { advanceCaseCommand, startSalesFulfillment } from '@/modules/operations/case-service';
import { executeCommand, registerCommand } from '@/modules/operations/commands';
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
import { listExpectedSupply } from './purchases-queries';
import { seedPurchasesTeam, seedSupplier, type PurchasesTeam } from './testing/purchases-fixtures';

const { fake } = mocks;
const NOW = CASE_TEST_NOW;
let team: CaseTeam;
let people: PurchasesTeam;

registerCommand<{ obligationId: string; amount: string }>('test.finance.settle', {
  schema: z.object({ obligationId: z.string(), amount: z.string() }),
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    const obligation = await tx.obligation.update({
      where: { id: cmd.payload.obligationId },
      data: { settledAmount: cmd.payload.amount as never, status: 'settled' },
    });
    await mocks.settled.handler!(tx, obligation, { id: 'settlement_1' }, ctx);
  },
});

const rows = (model: string) => fake.rows(model);
const stepOf = (stepKey: string, scopeKey = '') => rows('caseStep').find((s) => s.stepKey === stepKey && s.scopeKey === scopeKey);
const itemOf = (step: Record<string, unknown> | undefined) => rows('workItem').find((w) => step && w.stepId === step.id);
const jobsOf = (type: string) => rows('backgroundJob').filter((job) => job.type === type);
const eventTypes = () => rows('operationalEvent').map((event) => event.type as string);

async function available(zohoItemId: string): Promise<string> {
  const result = await verifyAvailability(fake.client as never, { zohoItemId, warehouseId: 'wh_principal' });
  return result.available.toString();
}

/** Case of 10 pz with 6 controlled in stock: the engine plans 6 from stock and 4 from a purchase. */
async function startCaseWithPurchase() {
  seedItemStock(fake, { zohoItemId: 'item-1', quantity: 6 });
  seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
  await startSalesFulfillment('zso-1', {
    commandId: 'ops:case.start:so:zso-1:job_1:1',
    actor: { type: 'system', id: 'job:ops.case.start' },
    now: NOW,
  });
  const [demand] = rows('caseDemand');
  await completeWorkItem(
    team.byArea.inventario,
    itemOf(stepOf('verificar_disponibilidad', demand.id as string))!.id as string,
    { result: { availability_result: { counted: 6 } } },
    { now: NOW }
  );
  await completeWorkItem(
    team.byArea.ventas,
    itemOf(stepOf('plan_abastecimiento', demand.id as string))!.id as string,
    { result: { allocation_plan: { acceptProposal: true } } },
    { now: NOW }
  );
  const purchase = rows('demandAllocation').find((a) => a.source === 'purchase')!;
  const request = rows('areaRequest').find((r) => r.id === purchase.linkedId)!;
  return { demand, purchase, request };
}

beforeEach(() => {
  fake.tables.clear();
  mocks.locks.reset();
  mocks.notifyUser.mockClear();
  mocks.cancelPayable.mockReset();
  mocks.cancelPayable.mockImplementation(async (tx: { obligation: { update: (args: unknown) => Promise<unknown> } }, id: string) => {
    await tx.obligation.update({ where: { id }, data: { status: 'cancelled' } });
  });
  invalidateOperationsConfigCache();
  clearProcessBlueprintCache();
  team = seedCaseTeam(fake);
  seedOperationsConfig(fake);
  people = seedPurchasesTeam(fake);
});

describe('compra por faltante', () => {
  it('faltante → solicitud → orden → aprobación → pago → recepción parcial con diferencia → reserva y avance', async () => {
    const { demand, purchase, request } = await startCaseWithPurchase();
    const caseId = demand.caseId as string;
    expect(request).toMatchObject({ kind: 'purchase_shortfall', toAreaKey: 'compras', status: 'sent' });

    // The purchase request is planned in the same transaction as the area request.
    const [syncJob] = jobsOf('purchases.shortfall_sync');
    expect(syncJob.payload).toEqual({ areaRequestId: request.id });
    expect(await purchases.runShortfallSync(request.id as string, 'job_sync', 1, NOW)).toMatchObject({
      status: 'completed',
      data: { action: 'created' },
    });
    const [pr] = rows('purchaseRequest');
    const [prLine] = rows('purchaseRequestLine');
    expect(pr).toMatchObject({ number: 'SC-000001', status: 'open', caseId, areaKey: 'inventario', priority: 'high' });
    expect(prLine).toMatchObject({ demandId: demand.id, allocationId: purchase.id, zohoItemId: 'item-1', unit: 'pz', status: 'open' });
    expect(String(prLine.qty)).toBe('4');
    expect(prLine.consolidationKey).toMatch(/^item-1\|\d{4}-W\d{2}$/);
    expect(await purchases.runShortfallSync(request.id as string, 'job_sync_2', 1, NOW)).toMatchObject({ data: { action: 'unchanged' } });
    expect(rows('purchaseRequest')).toHaveLength(1);

    // Draft order: nothing committed yet.
    const supplier = seedSupplier(fake, { name: 'Acme Materiales', paymentMode: 'prepaid' });
    const created = await purchases.createProcurementOrder(
      people.buyer,
      { supplierId: supplier.id as string, expectedAt: '2026-09-20', lines: [{ requestLineId: prLine.id as string, qty: 4, unitPrice: 100, taxRate: 0.16 }] },
      { now: NOW }
    );
    expect(created.status).toBe('completed');
    const order = rows('procurementOrder')[0];
    const [orderLine] = rows('procurementOrderLine');
    expect(order).toMatchObject({ number: 'OC-000001', status: 'draft', warehouseId: 'wh_principal' });
    expect(String(order.total)).toBe('464');
    expect(rows('procurementAllocation')[0]).toMatchObject({
      orderLineId: orderLine.id,
      demandId: demand.id,
      demandAllocationId: purchase.id,
      requestLineId: prLine.id,
    });
    expect(prLine.status).toBe('ordered');
    expect(pr.status).toBe('ordered');
    expect(purchase.status).toBe('requested');

    // Simple approval (464 MXN < 50,000).
    const submitted = await purchases.submitProcurementOrder(people.buyer, { orderId: order.id as string }, { now: NOW });
    expect(submitted).toMatchObject({ status: 'completed', data: { status: 'pending_approval', requiredApprovals: 1, autoApproved: false } });
    const approval = rows('approvalRequest')[0];
    expect(approval).toMatchObject({ scope: 'procurement', targetType: 'procurement_order', targetId: order.id, requestedByUserId: 'u_buyer', caseId });
    expect(rows('workItem').filter((w) => w.objectType === 'approval_request').map((w) => w.ownerUserId).sort()).toEqual(['u_approver', 'u_approver2']);
    expect(await decideApproval(people.approver, { approvalRequestId: approval.id as string, decision: 'approve' }, { now: NOW })).toMatchObject({
      status: 'completed',
      data: { status: 'approved' },
    });
    expect(order.status).toBe('approved');
    expect(purchase).toMatchObject({ status: 'in_progress', expectedAt: new Date('2026-09-20T12:00:00.000Z') });
    expect(request.status).toBe('accepted');
    expect(jobsOf('purchases.order_followup')).toHaveLength(1);

    // Expected is never available.
    expect(await available('item-1')).toBe('0');
    expect(await listExpectedSupply(people.buyer, { zohoItemId: 'item-1', now: NOW })).toEqual([
      expect.objectContaining({ orderNumber: 'OC-000001', expectedQty: '4', overdue: false }),
    ]);

    // Payment: payable + authorization request to Contabilidad; finance settles it.
    const followup = await purchases.runOrderPaymentFollowup(order.id as string, 'job_followup', 1, NOW);
    expect(followup.result).toMatchObject({ status: 'completed', data: { status: 'pending_payment' } });
    const obligation = rows('obligation')[0];
    expect(obligation).toMatchObject({ procurementOrderId: order.id, supplierId: supplier.id, caseId });
    expect(order).toMatchObject({ status: 'pending_payment', obligationId: obligation.id });
    const paymentRequest = rows('areaRequest').find((r) => r.kind === 'payment_authorization')!;
    expect(paymentRequest).toMatchObject({ fromAreaKey: 'compras', toAreaKey: 'contabilidad', objectType: 'obligation', objectId: obligation.id });
    expect(followup.result.data).toMatchObject({ approvalRequestId: 'apr_payment', authorizationStatus: 'pending' });
    expect(paymentRequest.payload).toMatchObject({ procurementOrderId: order.id, vendorId: supplier.id, amount: 464, currency: 'MXN' });
    await executeCommand(
      {
        commandId: 'settle-1',
        type: 'test.finance.settle',
        actor: { type: 'system', id: 'finance' },
        aggregate: { type: 'obligation', id: obligation.id as string },
        payload: { obligationId: obligation.id, amount: '464' },
      },
      null,
      { now: NOW }
    );
    expect(order).toMatchObject({ paymentStatus: 'paid', status: 'approved' });
    expect(paymentRequest.status).toBe('resolved');

    // Sent to the supplier as PDF.
    const sent = await purchases.sendOrderToSupplier(people.buyer, { orderId: order.id as string, via: 'pdf' }, { now: NOW });
    expect(sent.command).toMatchObject({ status: 'completed', data: { status: 'awaiting_receipt', sentVia: 'pdf' } });
    expect(order.evidenceObjectIds).toEqual(['pdf_1']);

    // First receipt: 3 arrive, 1 damaged → 2 enter stock and are reserved at once; still waiting.
    const first = await purchases.recordGoodsReceipt(
      people.receiver,
      { orderId: order.id as string, lines: [{ orderLineId: orderLine.id as string, qtyReceived: 3, qtyRejected: 1 }] },
      { now: NOW }
    );
    expect(first.status).toBe('completed');
    const firstPosted = first.data!.posted!;
    expect(firstPosted).toMatchObject({ status: 'disputed', orderStatus: 'disputed', readyAllocationIds: [], conflicts: [] });
    expect(firstPosted.reservations).toEqual([expect.objectContaining({ allocationId: purchase.id, quantity: '2' })]);
    expect(firstPosted.differences).toEqual([expect.objectContaining({ kind: 'damaged' })]);
    const receiptMovements = rows('stockMovement').filter((m) => m.kind === 'receipt');
    expect(receiptMovements.map((m) => String(m.quantity))).toEqual(['2']);
    expect(purchase.status).toBe('in_progress');
    expect(rows('incident').find((i) => i.kind === 'purchase_difference')).toMatchObject({ areaKey: 'compras', severity: 'high', status: 'open' });
    expect(rows('areaRequest').find((r) => r.kind === 'resolve_difference')).toMatchObject({ fromAreaKey: 'inventario', toAreaKey: 'compras' });
    expect(rows('areaRequest').find((r) => r.kind === 'customer_notice')).toMatchObject({ toAreaKey: 'ventas', caseId });
    expect(stepOf('esperar_recepcion', purchase.id as string)!.status).toBe('waiting');
    expect(await available('item-1')).toBe('0');

    const receiptLine = rows('goodsReceiptLine')[0];
    expect(
      await purchases.resolveReceiptDifference(
        people.buyer,
        { receiptLineId: receiptLine.id as string, resolution: 'replacement', note: 'El proveedor repone la pieza dañada' },
        { now: NOW }
      )
    ).toMatchObject({ status: 'completed', data: { orderStatus: 'partially_received', creditedQty: 0 } });
    expect(rows('incident').find((i) => i.kind === 'purchase_difference')!.status).toBe('resolved');
    expect(rows('areaRequest').find((r) => r.kind === 'resolve_difference')!.status).toBe('resolved');

    // Second receipt completes the allocation: ready, request resolved, order received.
    const second = await purchases.recordGoodsReceipt(
      people.receiver,
      { orderId: order.id as string, lines: [{ orderLineId: orderLine.id as string, qtyReceived: 2 }] },
      { now: NOW }
    );
    expect(second.data!.posted).toMatchObject({ status: 'posted', orderStatus: 'received', readyAllocationIds: [purchase.id] });
    expect(purchase).toMatchObject({ status: 'ready', warehouseId: 'wh_principal' });
    const reserved = rows('stockReservation').filter((r) => r.allocationId === purchase.id && r.status === 'active');
    expect(reserved.reduce((sum, r) => sum + Number(r.quantity), 0)).toBe(4);
    expect(request.status).toBe('resolved');
    expect(prLine.status).toBe('received');
    expect(pr.status).toBe('closed');
    expect(await available('item-1')).toBe('0');
    expect(eventTypes()).toEqual(
      expect.arrayContaining([
        'purchases.request.created',
        'purchases.order.created',
        'purchases.order.submitted',
        'purchases.order.approved',
        'allocation.in_progress',
        'purchases.order.payment_requested',
        'purchases.order.paid',
        'purchases.order.sent',
        'purchases.receipt.difference',
        'purchases.receipt.posted',
        'allocation.ready',
      ])
    );

    // The receipt woke the case: the awaited purchase closes and the order can be prepared.
    expect(jobsOf('ops.case.advance').length).toBeGreaterThan(0);
    const advanced = await advanceCaseCommand(caseId, { commandId: 'case.advance:purchases-test', now: NOW });
    expect(advanced.status).toBe('completed');
    expect(stepOf('esperar_recepcion', purchase.id as string)!.status).toBe('done');
    expect(stepOf('preparar_pedido')!.status).toBe('ready');
  });

  it('doble firma desde el umbral; rechazar regresa a borrador; nadie firma lo que pidió', async () => {
    const supplier = seedSupplier(fake, { paymentMode: 'credit', paymentTermsDays: 30 });
    expect(
      await purchases.createPurchaseRequest(
        people.buyer,
        { reason: 'Resurtido', lines: [{ zohoItemId: 'item-9', description: 'Placa de yeso', qty: 1000, unit: 'pz' }] },
        { now: NOW }
      )
    ).toMatchObject({ status: 'completed' });
    const [line] = rows('purchaseRequestLine');
    const created = await purchases.createProcurementOrder(
      people.buyer,
      { supplierId: supplier.id as string, lines: [{ requestLineId: line.id as string, qty: 1000, unitPrice: 60, taxRate: 0.16 }] },
      { now: NOW }
    );
    const orderId = created.data!.order.id;
    const order = rows('procurementOrder').find((o) => o.id === orderId)!;
    expect(created.data!.order.total).toBe('69600');

    const first = await purchases.submitProcurementOrder(people.buyer, { orderId }, { now: NOW });
    expect(first.data).toMatchObject({ requiredApprovals: 2 });
    const rejectedApproval = rows('approvalRequest')[0];
    await decideApproval(people.approver, { approvalRequestId: rejectedApproval.id as string, decision: 'reject', note: 'Pide otra cotización' }, { now: NOW });
    expect(order).toMatchObject({ status: 'draft', approvalRequestId: null });
    expect(mocks.notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u_buyer', type: 'purchase_order_rejected', body: 'Pide otra cotización' })
    );

    await purchases.submitProcurementOrder(people.buyer, { orderId }, { now: NOW });
    const approval = rows('approvalRequest').find((a) => a.status === 'pending')!;
    expect(await decideApproval(people.buyer, { approvalRequestId: approval.id as string, decision: 'approve' }, { now: NOW })).toMatchObject({
      status: 'rejected',
      errorCode: 'self_approval',
    });
    await decideApproval(people.approver, { approvalRequestId: approval.id as string, decision: 'approve' }, { now: NOW });
    expect(order.status).toBe('pending_approval');
    await decideApproval(people.secondApprover, { approvalRequestId: approval.id as string, decision: 'approve' }, { now: NOW });
    expect(order.status).toBe('approved');

    // Credit: the follow-up registers the payable, Contabilidad pays at the due date.
    const followup = await purchases.runOrderPaymentFollowup(orderId, 'job_f', 1, NOW);
    expect(followup.result.data).toMatchObject({ status: 'approved', areaRequestId: null, workItemId: null });
    expect(rows('obligation')).toHaveLength(1);
    expect(order.paymentStatus).toBe('unpaid');
  });

  it('cancelar compensa lo hecho: aprobación, cuenta por pagar, autorización y solicitudes', async () => {
    const supplier = seedSupplier(fake);
    await purchases.createPurchaseRequest(people.buyer, { lines: [{ description: 'Silicón transparente', qty: 10, unit: 'pz' }] }, { now: NOW });
    const [line] = rows('purchaseRequestLine');
    const draft = await purchases.createProcurementOrder(
      people.buyer,
      { supplierId: supplier.id as string, lines: [{ requestLineId: line.id as string, qty: 10, unitPrice: 50 }] },
      { now: NOW }
    );
    const orderId = draft.data!.order.id;
    await purchases.submitProcurementOrder(people.buyer, { orderId }, { now: NOW });
    expect(await purchases.cancelProcurementOrder(people.buyer, { orderId, reason: 'Ya no se necesita' }, { now: NOW })).toMatchObject({
      status: 'completed',
      data: { status: 'cancelled', compensations: ['approval_cancelled'] },
    });
    expect(rows('approvalRequest')[0].status).toBe('cancelled');
    expect(rows('workItem').filter((w) => w.objectType === 'approval_request').every((w) => w.status === 'cancelled')).toBe(true);
    expect(line.status).toBe('open');
    expect(String(line.qtyOrdered)).toBe('0');
    expect(rows('purchaseRequest')[0].status).toBe('open');

    // Approved prepaid order without case: payable + its payment authorization (finance), compensated.
    // The authorization itself is covered with the real finance module in purchases-finance.test.ts.
    const second = await purchases.createProcurementOrder(
      people.buyer,
      { supplierId: supplier.id as string, lines: [{ requestLineId: line.id as string, qty: 10, unitPrice: 50 }] },
      { now: NOW }
    );
    const secondId = second.data!.order.id;
    await purchases.submitProcurementOrder(people.buyer, { orderId: secondId }, { now: NOW });
    const pending = rows('approvalRequest').find((a) => a.status === 'pending')!;
    await decideApproval(people.approver, { approvalRequestId: pending.id as string, decision: 'approve' }, { now: NOW });
    const followup = await purchases.runOrderPaymentFollowup(secondId, 'job_c', 1, NOW);
    expect(followup.result.data).toMatchObject({ status: 'pending_payment', areaRequestId: null, approvalRequestId: 'apr_payment' });
    expect(rows('workItem').some((w) => w.areaKey === 'contabilidad' && w.objectType === 'obligation')).toBe(false);
    const cancelled = await purchases.cancelProcurementOrder(people.buyer, { orderId: secondId, reason: 'El proveedor no surte' }, { now: NOW });
    expect(cancelled.data!.compensations).toEqual(['payable_cancelled']);
    expect(mocks.cancelPayable).toHaveBeenCalledTimes(1);
    expect(rows('obligation')[0].status).toBe('cancelled');
    expect(line.status).toBe('open');
  });

  it('una solicitud rechazada por Compras regresa la asignación al plan del expediente', async () => {
    const { purchase, request } = await startCaseWithPurchase();
    await purchases.runShortfallSync(request.id as string, 'job_sync', 1, NOW);
    const [pr] = rows('purchaseRequest');
    expect(
      await purchases.cancelPurchaseRequest(people.buyer, { requestId: pr.id as string, reason: 'Descontinuado por el fabricante' }, { now: NOW })
    ).toMatchObject({ status: 'completed', data: { status: 'cancelled' } });
    expect(request.status).toBe('rejected');
    expect(rows('purchaseRequestLine')[0].status).toBe('cancelled');
    // The rejection plans a sync that finds nothing more to cancel.
    const syncs = jobsOf('purchases.shortfall_sync');
    expect(syncs.length).toBe(2);
    expect(await purchases.runShortfallSync(request.id as string, 'job_sync_rejected', 1, NOW)).toMatchObject({ data: { action: 'unchanged' } });
    expect(purchase.status).not.toBe('ready');
  });
});
