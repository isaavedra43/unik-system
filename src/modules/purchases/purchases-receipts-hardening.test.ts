import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Receipts hardening on FakePrisma with the real case engine and inventory:
 * the exact split of one order line among several sales survives partial
 * receipts, a line that supplies sales always carries a catalog item, only the
 * sales still waiting get a customer notice, a credit resolution is a
 * commercial decision, a direct delivery reports its differences and a
 * Manufactura shortfall is resolved (never compensated) when its purchase is
 * received. Finance, AI, messaging and storage are mocked.
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
  const registry = [...original.PERMISSION_REGISTRY, ...PURCHASES_PERMISSIONS.filter((p) => !original.isKnownPermission(p.key))];
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
  requestProcurementPaymentAuthorization: vi.fn(),
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
  saveGeneratedFile: vi.fn(async () => ({ id: 'pdf_1', sha256: 'hash' })),
}));
vi.mock('@/modules/ai/generators/pdf-generator', () => ({
  generatePdfReport: vi.fn(async () => ({ sizeBytes: 10, pageCount: 1 })),
}));

import { decideApproval } from '@/modules/operations/approvals-service';
import { startSalesFulfillment } from '@/modules/operations/case-service';
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
import { seedUser } from '@/modules/operations/testing/fixtures';
import { seedPurchasesTeam, seedStorageObject, seedSupplier, type PurchasesTeam } from './testing/purchases-fixtures';

const { fake } = mocks;
const NOW = CASE_TEST_NOW;
let team: CaseTeam;
let people: PurchasesTeam;
const rows = (model: string) => fake.rows(model);
const stepOf = (stepKey: string, scopeKey = '') => rows('caseStep').find((s) => s.stepKey === stepKey && s.scopeKey === scopeKey);
const itemOf = (step: Record<string, unknown> | undefined) => rows('workItem').find((w) => step && w.stepId === step.id);
const reservedFor = (allocationId: string) =>
  rows('stockReservation')
    .filter((r) => r.allocationId === allocationId && r.status === 'active')
    .reduce((sum, r) => sum + Number(r.quantity), 0);

registerCommand<{ caseId: string }, { requestId: string }>('test.mfg.material_shortfall', {
  schema: z.object({ caseId: z.string() }),
  aggregate: 'none',
  actorTypes: ['system'],
  async handler(_tx, cmd, ctx) {
    const { request } = await ctx.createAreaRequest({
      caseId: cmd.payload.caseId,
      fromAreaKey: 'manufactura',
      toAreaKey: 'compras',
      kind: 'material_shortfall',
      objectType: 'production_order',
      objectId: 'op_1',
      title: 'Faltan 8 pz de lámina para OP-000001',
      payload: { productionOrderId: 'op_1', sku: 'LAMINA', missingQty: 8, unit: 'pz', neededBy: '2026-09-20' },
    });
    return { data: { requestId: request.id } };
  },
});

/** A case of one sales order whose lines are planned (accepted proposal) with nothing in stock. */
async function startCase(zohoSalesOrderId: string, lines: Array<{ quantity: number; zohoItemId?: string }>, plan?: unknown) {
  seedSalesOrder(fake, { zohoSalesOrderId, salesOrderNumber: `SO-${zohoSalesOrderId}`, lines });
  await startSalesFulfillment(zohoSalesOrderId, {
    commandId: `ops:case.start:so:${zohoSalesOrderId}:job:1`,
    actor: { type: 'system', id: 'job:ops.case.start' },
    now: NOW,
  });
  const opCase = rows('operationalCase').find((c) => c.zohoSalesOrderId === zohoSalesOrderId)!;
  const demands = rows('caseDemand').filter((d) => d.caseId === opCase.id);
  for (const demand of demands) {
    await completeWorkItem(
      team.byArea.inventario,
      itemOf(stepOf('verificar_disponibilidad', demand.id as string))!.id as string,
      { result: { availability_result: { counted: 0 } } },
      { now: NOW }
    );
    const planned = await completeWorkItem(
      team.byArea.ventas,
      itemOf(stepOf('plan_abastecimiento', demand.id as string))!.id as string,
      { result: { allocation_plan: plan ?? { acceptProposal: true } } },
      { now: NOW }
    );
    expect(planned.status).toBe('completed');
  }
  return { caseId: opCase.id as string, demands };
}

async function approvedOrder(input: Record<string, unknown>, send = true) {
  const supplier = seedSupplier(fake, { name: `Proveedor ${rows('supplier').length + 1}`, paymentMode: 'credit' });
  const created = await purchases.createProcurementOrder(people.buyer, { supplierId: supplier.id as string, ...input } as never, { now: NOW });
  expect(created.status).toBe('completed');
  const orderId = created.data!.order.id;
  await purchases.submitProcurementOrder(people.buyer, { orderId }, { now: NOW });
  const approval = rows('approvalRequest').find((a) => a.targetId === orderId && a.status === 'pending')!;
  await decideApproval(people.approver, { approvalRequestId: approval.id as string, decision: 'approve' }, { now: NOW });
  if (send) {
    const sent = await purchases.sendOrderToSupplier(people.buyer, { orderId, via: 'pdf' }, { now: NOW });
    expect(sent.command.status).toBe('completed');
  }
  return { orderId, line: rows('procurementOrderLine').filter((l) => l.orderId === orderId)[0] };
}

const receive = (orderId: string, orderLineId: string, qtyReceived: number, extra: Record<string, unknown> = {}, actor = people.receiver) =>
  purchases.recordGoodsReceipt(actor, { orderId, lines: [{ orderLineId, qtyReceived, ...extra }] } as never, { now: NOW });

beforeEach(() => {
  fake.tables.clear();
  mocks.locks.reset();
  invalidateOperationsConfigCache();
  clearProcessBlueprintCache();
  team = seedCaseTeam(fake);
  seedOperationsConfig(fake);
  people = seedPurchasesTeam(fake);
  seedItemStock(fake, { zohoItemId: 'item-1', quantity: 0 });
});

describe('reparto exacto con recepciones parciales', () => {
  it('la segunda recepción surte a la otra venta: cada venta recibe lo que esta partida le prometió', async () => {
    const a = await startCase('zso-a', [{ quantity: 10, zohoItemId: 'item-1' }]);
    const b = await startCase('zso-b', [{ quantity: 5, zohoItemId: 'item-1' }]);
    const allocationA = rows('demandAllocation').find((x) => x.demandId === a.demands[0].id && x.source === 'purchase')!;
    const allocationB = rows('demandAllocation').find((x) => x.demandId === b.demands[0].id && x.source === 'purchase')!;
    expect([Number(allocationA.quantity), Number(allocationB.quantity)]).toEqual([10, 5]);

    const { orderId, line } = await approvedOrder({
      lines: [
        {
          zohoItemId: 'item-1',
          description: 'Lámina galvanizada',
          qty: 10,
          unit: 'pz',
          unitPrice: 10,
          allocations: [
            { demandId: a.demands[0].id, qty: 5 },
            { demandId: b.demands[0].id, qty: 5 },
          ],
        },
      ],
    });

    const first = await receive(orderId, line.id as string, 5);
    expect(first.data!.posted!.reservations).toEqual([expect.objectContaining({ allocationId: allocationA.id, quantity: '5' })]);
    const second = await receive(orderId, line.id as string, 5);
    expect(second.data!.posted!.reservations).toEqual([expect.objectContaining({ allocationId: allocationB.id, quantity: '5' })]);
    expect(second.data!.posted!.readyAllocationIds).toEqual([allocationB.id]);
    expect([reservedFor(allocationA.id as string), reservedFor(allocationB.id as string)]).toEqual([5, 5]);
    expect(allocationA.status).toBe('in_progress');
    expect(allocationB.status).toBe('ready');
  });

  it('una diferencia sólo avisa a las ventas que siguen esperando, y la nota de crédito la decide Compras', async () => {
    const a = await startCase('zso-a', [{ quantity: 10, zohoItemId: 'item-1' }]);
    const b = await startCase('zso-b', [{ quantity: 5, zohoItemId: 'item-1' }]);
    const { orderId, line } = await approvedOrder({
      lines: [
        {
          zohoItemId: 'item-1',
          description: 'Lámina galvanizada',
          qty: 10,
          unit: 'pz',
          unitPrice: 10,
          allocations: [
            { demandId: b.demands[0].id, qty: 5 },
            { demandId: a.demands[0].id, qty: 5 },
          ],
        },
      ],
    });
    const first = await receive(orderId, line.id as string, 5);
    expect(first.data!.posted!.readyAllocationIds).toHaveLength(1);

    const second = await receive(orderId, line.id as string, 5, { qtyRejected: 1 });
    expect(second.data!.posted!.differences).toEqual([expect.objectContaining({ kind: 'damaged' })]);
    const notices = rows('areaRequest').filter((r) => r.kind === 'customer_notice');
    expect(notices.map((n) => n.caseId)).toEqual([a.caseId]);

    const receiptLineId = second.data!.posted!.differences[0].receiptLineId;
    const byWarehouse = await purchases.resolveReceiptDifference(
      people.receiver,
      { receiptLineId, resolution: 'credit', note: 'El proveedor ya no tiene más' },
      { now: NOW }
    );
    expect(byWarehouse).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    const byBuyer = await purchases.resolveReceiptDifference(
      people.buyer,
      { receiptLineId, resolution: 'credit', note: 'El proveedor ya no tiene más' },
      { now: NOW }
    );
    expect(byBuyer).toMatchObject({ status: 'completed', data: { creditedQty: 1 } });
  });
});

describe('partidas sin artículo del catálogo', () => {
  it('hereda el artículo de las ventas que surte y rechaza un reparto entre artículos distintos', async () => {
    seedItemStock(fake, { zohoItemId: 'item-2', quantity: 0 });
    const a = await startCase('zso-a', [{ quantity: 4, zohoItemId: 'item-1' }]);
    const c = await startCase('zso-c', [{ quantity: 3, zohoItemId: 'item-2' }]);
    const supplier = seedSupplier(fake, { paymentMode: 'credit' });
    const inherited = await purchases.createProcurementOrder(
      people.buyer,
      { supplierId: supplier.id as string, lines: [{ description: 'Lámina', qty: 4, unit: 'pz', unitPrice: 10, allocations: [{ demandId: a.demands[0].id as string, qty: 4 }] }] },
      { now: NOW }
    );
    expect(inherited.status).toBe('completed');
    expect(rows('procurementOrderLine').find((l) => l.orderId === inherited.data!.order.id)).toMatchObject({ zohoItemId: 'item-1' });

    const mixed = await purchases.createProcurementOrder(
      people.buyer,
      {
        supplierId: supplier.id as string,
        lines: [
          {
            description: 'Material mixto',
            qty: 7,
            unit: 'pz',
            unitPrice: 10,
            allocations: [
              { demandId: a.demands[0].id as string, qty: 4 },
              { demandId: c.demands[0].id as string, qty: 3 },
            ],
          },
        ],
      },
      { now: NOW }
    );
    expect(mixed).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
  });
});

describe('faltante de Manufactura', () => {
  it('se resuelve al recibir su compra y nunca abre una compensación falsa', async () => {
    const a = await startCase('zso-a', [{ quantity: 1, zohoItemId: 'item-1' }]);
    const shortfall = await executeCommand<{ requestId: string }>(
      {
        commandId: 'mfg-shortfall-1',
        type: 'test.mfg.material_shortfall',
        actor: { type: 'system', id: 'manufacturing' },
        aggregate: { type: 'production_order', id: 'op_1' },
        payload: { caseId: a.caseId },
      },
      null,
      { now: NOW }
    );
    const requestId = shortfall.data!.requestId;
    expect(await purchases.runShortfallSync(requestId, 'job_mfg_sync', 1, NOW)).toMatchObject({ data: { action: 'created' } });
    const requestLine = rows('purchaseRequestLine').find((l) => l.demandId === null)!;
    const { orderId, line } = await approvedOrder({
      lines: [{ requestLineId: requestLine.id, zohoItemId: 'item-1', qty: 8, unitPrice: 20 }],
    });
    const received = await receive(orderId, line.id as string, 8);
    expect(received.data!.posted!.resolvedRequestIds).toContain(requestId);
    const request = rows('areaRequest').find((r) => r.id === requestId)!;
    expect(request.status).toBe('resolved');

    // Even if the request is later cancelled (old flows), a received line is not compensated.
    request.status = 'cancelled';
    await purchases.runShortfallSync(requestId, 'job_mfg_sync_2', 1, NOW);
    expect(rows('incident').filter((i) => i.kind === 'cancellation_compensation')).toHaveLength(0);
  });
});

describe('entrega directa con diferencias', () => {
  it('un faltante declarado abre la incidencia y la solicitud de Logística a Compras', async () => {
    const { caseId, demands } = await startCase('zso-d', [{ quantity: 10, zohoItemId: 'item-1' }], {
      lines: [{ source: 'direct_supplier', quantity: 10 }],
    });
    const direct = rows('demandAllocation').find((x) => x.demandId === demands[0].id && x.source === 'direct_supplier')!;
    await purchases.runShortfallSync(direct.linkedId as string, 'job_direct_sync', 1, NOW);
    const prLine = rows('purchaseRequestLine').find((l) => l.allocationId === direct.id)!;
    const { orderId, line } = await approvedOrder(
      { deliveryMode: 'direct_to_customer', directDeliveryCaseId: caseId, lines: [{ requestLineId: prLine.id, qty: 10, unitPrice: 80 }] },
      false
    );
    seedStorageObject(fake, { id: 'obj_photo', createdBy: 'u_receiver' });
    const confirmed = await purchases.confirmDirectDelivery(
      people.receiver,
      {
        orderId,
        lines: [{ orderLineId: line.id as string, qtyDelivered: 8, difference: 'short' }],
        receivedBy: 'Residente de obra',
        evidenceObjectIds: ['obj_photo'],
      },
      { now: NOW }
    );
    expect(confirmed).toMatchObject({ status: 'completed', data: { plan: { deliveries: [{ allocationId: direct.id, deliveredQty: 8 }] } } });
    expect(rows('goodsReceipt')[0]).toMatchObject({ mode: 'direct_delivery', status: 'disputed' });
    expect(rows('incident').find((i) => i.kind === 'purchase_difference')).toMatchObject({ status: 'open', caseId });
    expect(rows('areaRequest').find((r) => r.kind === 'resolve_difference')).toMatchObject({ fromAreaKey: 'logistica', toAreaKey: 'compras' });
    expect(rows('goodsReceiptLine')[0].incidentId).toBeTruthy();
  });
});

describe('entrega directa con su propio tipo de solicitud', () => {
  it('el motor pide direct_delivery y la orden sale directa al cliente sin indicarlo', async () => {
    const { caseId, demands } = await startCase('zso-e', [{ quantity: 6, zohoItemId: 'item-1' }], {
      lines: [{ source: 'direct_supplier', quantity: 6 }],
    });
    const direct = rows('demandAllocation').find((x) => x.demandId === demands[0].id && x.source === 'direct_supplier')!;
    const request = rows('areaRequest').find((r) => r.id === direct.linkedId)!;
    expect(request).toMatchObject({ kind: 'direct_delivery', fromAreaKey: 'inventario', toAreaKey: 'compras' });
    expect(await purchases.runShortfallSync(request.id as string, 'job_direct_kind', 1, NOW)).toMatchObject({ data: { action: 'created' } });
    const prLine = rows('purchaseRequestLine').find((l) => l.allocationId === direct.id)!;
    const supplier = seedSupplier(fake, { paymentMode: 'credit' });
    const created = await purchases.createProcurementOrder(
      people.buyer,
      { supplierId: supplier.id as string, lines: [{ requestLineId: prLine.id as string, qty: 6, unitPrice: 50 }] },
      { now: NOW }
    );
    expect(created.status).toBe('completed');
    expect(rows('procurementOrder').find((o) => o.id === created.data!.order.id)).toMatchObject({
      deliveryMode: 'direct_to_customer',
      directDeliveryCaseId: caseId,
      warehouseId: null,
    });
  });
});

describe('doble firma de una orden enviada por una IA', () => {
  it('la persona que causó el turno es la solicitante: no firma y siguen haciendo falta dos firmas', async () => {
    const bot = { ...seedUser(fake, { id: 'bot_compras', name: 'IA Compras', isBot: true, permissions: ['purchases.view', 'purchases.manage_orders'] }).currentUser, isBot: true };
    const supplier = seedSupplier(fake, { paymentMode: 'credit' });
    await purchases.createPurchaseRequest(people.buyer, { lines: [{ description: 'Silicón', qty: 10, unit: 'pz' }] }, { now: NOW });
    const line = rows('purchaseRequestLine').at(-1)!;
    const draft = await purchases.createProcurementOrder(
      people.buyer,
      { supplierId: supplier.id as string, lines: [{ requestLineId: line.id as string, qty: 10, unitPrice: 50 }] },
      { now: NOW }
    );
    const orderId = draft.data!.order.id;
    const submitted = await purchases.submitProcurementOrder(bot, { orderId, causedByUserId: 'u_buyer' }, { now: NOW });
    expect(submitted).toMatchObject({ status: 'completed', data: { requiredApprovals: 2 } });
    const approval = rows('approvalRequest').find((a) => a.targetId === orderId)!;
    expect(approval).toMatchObject({ requestedByUserId: 'u_buyer', requiredApprovals: 2 });
    const selfVote = await decideApproval(people.buyer, { approvalRequestId: approval.id as string, decision: 'approve' }, { now: NOW });
    expect(selfVote.status).toBe('rejected');
    // A person cannot pretend someone else caused the submission.
    const other = await purchases.createProcurementOrder(
      people.buyer,
      { supplierId: supplier.id as string, lines: [{ description: 'Cinta', qty: 1, unit: 'pz', unitPrice: 5 }] },
      { now: NOW }
    );
    await purchases.submitProcurementOrder(people.buyer, { orderId: other.data!.order.id, causedByUserId: 'u_approver' }, { now: NOW });
    expect(rows('approvalRequest').find((a) => a.targetId === other.data!.order.id)).toMatchObject({ requestedByUserId: 'u_buyer' });
  });
});
