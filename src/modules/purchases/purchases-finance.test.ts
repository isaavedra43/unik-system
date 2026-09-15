import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Compras → Contabilidad with the REAL finance module (no mocked bridge): the
 * payable of a procurement order is paid only after its `payment` business
 * approval, the settlement marks the order paid through
 * `onObligationSettled('procurement_order')`, a reversed payment puts the order
 * back to waiting for it, and cancelling an order cancels its pending payment
 * approval. Inventory locks are emulated; AI, messaging and storage are mocked.
 */

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('./testing/purchases-fixtures');
  const finance = await import('@/modules/finance/testing/finance-fixtures');
  const inventory = await import('@/modules/inventory/testing/inventory-fixtures');
  const fake = finance.extendFakeWithFinance(fixtures.createPurchasesFake());
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
  registerJobHandler: vi.fn(),
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: vi.fn() }));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/modules/auth/permissions')>();
  const { PURCHASES_PERMISSIONS } = await import('./permissions');
  const { FINANCE_PERMISSIONS } = await import('@/modules/finance/permissions');
  const registry = [
    ...original.PERMISSION_REGISTRY,
    ...[...PURCHASES_PERMISSIONS, ...FINANCE_PERMISSIONS].filter((p) => !original.isKnownPermission(p.key)),
  ];
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
vi.mock('@/modules/comms/comms-service', () => ({
  startConversation: vi.fn(),
  updateConversation: vi.fn(),
  sendOutboundMessage: vi.fn(),
}));
vi.mock('@/modules/ai/ai-client', () => ({ chatCompletion: vi.fn() }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({})) }));
vi.mock('@/modules/ai/ai-attachments-service', () => ({ processAttachment: vi.fn() }));
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

import type { Prisma } from '@prisma/client';
import type { CurrentUser } from '@/modules/auth/authorization';
import { ensureFinanceSeed } from '@/modules/finance/catalog-service';
import { reverseSettlement } from '@/modules/finance/finance-commands';
import { invalidateFinanceSettingsCache } from '@/modules/finance/finance-config';
import { settleObligation } from '@/modules/finance/obligations-service';
import { decideApproval } from '@/modules/operations/approvals-service';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { CASE_TEST_NOW, seedCaseTeam, seedOperationsConfig } from '@/modules/operations/testing/case-fixtures';
import { seedUser } from '@/modules/operations/testing/fixtures';
import * as purchases from './purchases-commands';
import { seedPurchasesTeam, seedSupplier, type PurchasesTeam } from './testing/purchases-fixtures';

const { fake } = mocks;
const NOW = CASE_TEST_NOW;
const rows = (model: string) => fake.rows(model);
let people: PurchasesTeam;
let accountant: CurrentUser;
let paymentsApprover: CurrentUser;
let seq = 0;
const opts = () => ({ commandId: `pf-${++seq}`, now: NOW });

async function approvedOrder(paymentMode: 'prepaid' | 'credit') {
  const supplier = seedSupplier(fake, { name: `Acme ${paymentMode}`, paymentMode });
  await purchases.createPurchaseRequest(people.buyer, { lines: [{ description: 'Silicón transparente', qty: 10, unit: 'pz' }] }, { now: NOW });
  const line = rows('purchaseRequestLine').at(-1)!;
  const draft = await purchases.createProcurementOrder(
    people.buyer,
    { supplierId: supplier.id as string, lines: [{ requestLineId: line.id as string, qty: 10, unitPrice: 50 }] },
    { now: NOW }
  );
  const orderId = draft.data!.order.id;
  await purchases.submitProcurementOrder(people.buyer, { orderId }, { now: NOW });
  const approval = rows('approvalRequest').find((a) => a.scope === 'procurement' && a.targetId === orderId)!;
  await decideApproval(people.approver, { approvalRequestId: approval.id as string, decision: 'approve' }, { now: NOW });
  const order = rows('procurementOrder').find((o) => o.id === orderId)!;
  expect(order.status).toBe('approved');
  return { order, supplier };
}

beforeEach(async () => {
  fake.tables.clear();
  mocks.locks.reset();
  invalidateOperationsConfigCache();
  invalidateFinanceSettingsCache();
  seedCaseTeam(fake);
  seedOperationsConfig(fake);
  people = seedPurchasesTeam(fake);
  accountant = seedUser(fake, { id: 'u_conta', name: 'Contadora', permissions: ['finance.view', 'finance.manage_obligations', 'finance.post'] }).currentUser;
  paymentsApprover = seedUser(fake, { id: 'u_pagos', name: 'Tesorería', permissions: ['finance.view', 'finance.approve'] }).currentUser;
  await ensureFinanceSeed(fake.client as unknown as Prisma.TransactionClient);
});

describe('pago de una orden de compra con el módulo de finanzas real', () => {
  it('pide la autorización, no paga sin ella, marca la orden pagada y la regresa al revertir el pago', async () => {
    const { order } = await approvedOrder('prepaid');
    const followup = await purchases.runOrderPaymentFollowup(order.id as string, 'job_pay', 1, NOW);
    expect(followup.result).toMatchObject({ status: 'completed', data: { status: 'pending_payment', authorizationStatus: 'pending' } });
    const obligation = rows('obligation').find((o) => o.procurementOrderId === order.id)!;
    expect(obligation).toMatchObject({ kind: 'payable', counterpartyType: 'supplier', status: 'expected' });
    const paymentApproval = rows('approvalRequest').find((a) => a.scope === 'payment')!;
    expect(paymentApproval).toMatchObject({
      targetType: 'obligation',
      targetId: obligation.id,
      status: 'pending',
      requiredApprovals: 1,
      // The follow-up job runs as the system: the requester is the buyer, so she cannot sign it.
      requestedByUserId: 'u_buyer',
    });
    expect(followup.result.data?.approvalRequestId).toBe(paymentApproval.id);

    const bank = rows('cashAccount').find((a) => a.key === 'banco_zoho')!;
    const amount = String(obligation.expectedAmount);
    const early = await settleObligation(accountant, { obligationId: obligation.id as string, amount, cashAccountId: bank.id as string }, opts());
    expect(early).toMatchObject({ status: 'rejected', errorCode: 'payment_not_authorized' });
    expect(order.paymentStatus).not.toBe('paid');

    const selfSigned = await decideApproval(people.buyer, { approvalRequestId: paymentApproval.id as string, decision: 'approve' }, opts());
    expect(selfSigned.status).toBe('rejected');
    const signed = await decideApproval(paymentsApprover, { approvalRequestId: paymentApproval.id as string, decision: 'approve' }, opts());
    expect(signed).toMatchObject({ status: 'completed', data: { status: 'approved' } });
    const payItem = rows('workItem').find((w) => w.objectType === 'obligation' && w.objectId === obligation.id && String(w.title).startsWith('Pagar'))!;
    expect(payItem.status).toBe('open');

    const paid = await settleObligation(accountant, { obligationId: obligation.id as string, amount, cashAccountId: bank.id as string }, opts());
    expect(paid).toMatchObject({ status: 'completed', data: { status: 'settled' } });
    expect(order).toMatchObject({ paymentStatus: 'paid', status: 'approved' });
    expect(payItem.status).toBe('done');

    const settlement = rows('obligationSettlement').find((s) => s.obligationId === obligation.id)!;
    const reversed = await reverseSettlement(
      accountant,
      { obligationId: obligation.id as string, settlementId: settlement.id as string, reason: 'Se registró en la cuenta equivocada' },
      opts()
    );
    expect(reversed).toMatchObject({ status: 'completed', data: { status: 'expected' } });
    expect(order).toMatchObject({ paymentStatus: 'unpaid', status: 'pending_payment' });
    expect(rows('workItem').find((w) => w.objectType === 'obligation' && String(w.title).startsWith('Volver a pagar'))).toMatchObject({
      status: 'open',
      areaKey: 'contabilidad',
    });
  });

  it('una orden a crédito también pide autorización, y cancelar la orden cancela esa autorización pendiente', async () => {
    const { order } = await approvedOrder('credit');
    const requested = await purchases.requestProcurementPayment(people.buyer, { orderId: order.id as string }, { now: NOW });
    expect(requested).toMatchObject({ status: 'completed', data: { areaRequestId: null, authorizationStatus: 'pending' } });
    const approval = rows('approvalRequest').find((a) => a.scope === 'payment')!;
    expect(approval).toMatchObject({ status: 'pending', requestedByUserId: 'u_buyer' });

    const cancelled = await purchases.cancelProcurementOrder(people.buyer, { orderId: order.id as string, reason: 'El proveedor no surte' }, { now: NOW });
    expect(cancelled.status).toBe('completed');
    expect(cancelled.data!.compensations).toEqual(expect.arrayContaining(['payment_approval_cancelled', 'payable_cancelled']));
    expect(approval.status).toBe('cancelled');
    expect(rows('obligation').find((o) => o.procurementOrderId === order.id)!.status).toBe('cancelled');
    expect(rows('workItem').filter((w) => w.objectType === 'approval_request' && w.objectId === approval.id).every((w) => w.status === 'cancelled')).toBe(true);
  });
});
