import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Obligations and collections on FakePrisma (plan 9.1): the contracts
 * createObligation / settleObligation / onObligationSettled /
 * cancelObligation, payment authorization, expected receivables of cases,
 * reconciliation of Zoho payments with idempotency by
 * `externalRef = zoho_payment:{zohoPaymentId}:{obligationId}`, one payment
 * spread over two obligations, ambiguous payments, invoice links, voided
 * orders and the reversal of a settlement.
 */

const mocks = await vi.hoisted(async () => {
  const { createFinanceFake } = await import('./testing/finance-fixtures');
  return {
    fake: createFinanceFake(),
    notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({ id: '1', channel: '', type: '', payload: {}, createdAt: '' })),
    onCaseStarted: vi.fn<(listener: unknown) => () => void>(() => () => undefined),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/auth/permissions')>();
  const { withFinancePermissions } = await import('./testing/finance-permissions');
  return withFinancePermissions(actual);
});
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  wakeJobWorker: vi.fn(),
  registerJobHandler: vi.fn(),
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: vi.fn() }));
vi.mock('@/modules/operations/case-service', () => ({ onCaseStarted: mocks.onCaseStarted }));
vi.mock('@/modules/ai/ai-client', () => ({ chatCompletion: vi.fn() }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({})) }));
vi.mock('@/modules/ai/ai-attachments-service', () => ({ processAttachment: vi.fn() }));
vi.mock('@/modules/ai/json-utils', () => ({ parseJsonObject: vi.fn() }));

import { decideApproval } from '@/modules/operations/approvals-service';
import { executeCommand, registerCommand } from '@/modules/operations/commands';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { ensureFinanceSeed } from './catalog-service';
import { listUnmatchedPayments, reconcileCollections, registerCollectionsCaseListener } from './collections-service';
import {
  cancelObligationCommand,
  createManualObligation,
  matchPaymentToObligation,
  recordUnexpectedCollection,
  requestPaymentAuthorization,
  reverseSettlement,
  writeOffObligation,
} from './finance-commands';
import { invalidateFinanceSettingsCache } from './finance-config';
import { dateKeyOf } from './finance-dates';
import {
  createObligation,
  onObligationSettled,
  settleObligation,
  type CreateObligationInput,
} from './obligations-service';
import {
  byKey,
  D,
  dbDate,
  eventsOf,
  FINANCE_TEST_NOW,
  linesOf,
  resetFinanceFake,
  rowById,
  seedContact,
  seedCustomerPayment,
  seedFinanceTeam,
  seedOperationsConfig,
  seedSalesOrderCase,
  type FinanceTeam,
} from './testing/finance-fixtures';
import { FINANCE_COMMANDS } from './types';

const { fake } = mocks;
const NOW = FINANCE_TEST_NOW;
const tx = fake.client as unknown as Prisma.TransactionClient;
let team: FinanceTeam;
let seq = 0;
const opts = () => ({ commandId: `cmd-${++seq}`, now: NOW });
const cash = (key: string) => byKey(fake, 'cashAccount', key);
const obligationOfOrder = (zohoSalesOrderId: string) =>
  fake.rows('obligation').find((o) => o.zohoSalesOrderId === zohoSalesOrderId && o.kind === 'receivable')!;
const settlementsOf = (obligationId: string) => fake.rows('obligationSettlement').filter((s) => s.obligationId === obligationId);

registerCommand<Record<string, unknown>, unknown>('test.procurement_payable', {
  schema: z.record(z.unknown()),
  aggregate: 'none',
  actorTypes: ['system'],
  async handler(innerTx, cmd, ctx) {
    const obligation = await createObligation(innerTx, cmd.payload as CreateObligationInput, ctx);
    return { data: { obligationId: obligation.id, number: obligation.number } };
  },
});

async function expectCase(caseId: string) {
  return executeCommand<{ created: boolean; obligationId: string | null; reason: string }>(
    {
      commandId: `finance:expect_case:${caseId}`,
      type: FINANCE_COMMANDS.collectionExpectCase,
      actor: { type: 'system', id: 'finance' },
      aggregate: { type: 'operational_case', id: caseId },
      payload: { caseId },
    },
    null,
    { now: NOW }
  );
}

beforeEach(async () => {
  await resetFinanceFake(fake);
  invalidateOperationsConfigCache();
  invalidateFinanceSettingsCache();
  mocks.notifyUser.mockClear();
  seedOperationsConfig(fake);
  team = seedFinanceTeam(fake);
  await ensureFinanceSeed(tx);
});

describe('obligation contracts', () => {
  it('a purchase payable needs its payment authorization; settlements run onObligationSettled', async () => {
    const handler = vi.fn(async () => undefined);
    const unsubscribe = onObligationSettled('procurement_order', handler);
    const created = await executeCommand<{ obligationId: string; number: string }>(
      {
        commandId: 'po-1-payable',
        type: 'test.procurement_payable',
        actor: { type: 'system', id: 'purchases' },
        aggregate: { type: 'procurement_order', id: 'po-1' },
        payload: {
          kind: 'payable',
          counterpartyType: 'supplier',
          counterpartyName: 'Aceros del Norte',
          procurementOrderId: 'po-1',
          description: 'OC-000001 anticipo',
          expectedAmount: '12000',
          dueAt: '2026-09-20',
        },
      },
      null,
      { now: NOW }
    );
    expect(created.data?.number).toBe('OB-000001');
    const obligationId = created.data!.obligationId;
    const obligation = rowById(fake, 'obligation', obligationId);
    expect(obligation.categoryId).toBe(byKey(fake, 'financeCategory', 'compras_mercancia').id);
    expect(linesOf(fake, obligation.ledgerEntryId)).toEqual([
      ['category', obligation.categoryId, '12000.00', '0.00', null],
      ['payable', obligationId, '0.00', '12000.00', null],
    ]);
    const bank = cash('banco_zoho');

    const early = await settleObligation(team.admin, { obligationId, amount: '12000', cashAccountId: bank.id }, opts());
    expect(early).toMatchObject({ status: 'rejected', errorCode: 'payment_not_authorized' });

    const auth = await requestPaymentAuthorization(team.admin, { obligationId }, opts());
    expect(auth.data).toMatchObject({ status: 'pending', requiredApprovals: 1, reused: false });
    const pending = await settleObligation(team.admin, { obligationId, amount: '1', cashAccountId: bank.id }, opts());
    expect(pending).toMatchObject({ status: 'rejected', errorCode: 'payment_not_authorized' });

    await decideApproval(team.approver, { approvalRequestId: auth.data!.approvalRequestId, decision: 'approve' }, { commandId: 'vote', now: NOW });
    expect(eventsOf(fake, 'finance.payment.authorized')).toHaveLength(1);
    expect(fake.rows('workItem').find((w) => w.objectType === 'obligation' && w.objectId === obligationId)?.title).toBe(
      'Pagar OB-000001 a Aceros del Norte'
    );

    const partial = await settleObligation(team.admin, { obligationId, amount: '5000', cashAccountId: bank.id }, opts());
    expect(partial.data).toMatchObject({ status: 'partially_settled', remaining: '7000.00', settledAmount: '5000.00' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0] as unknown[])[1]).toMatchObject({ id: obligationId, status: 'partially_settled' });

    const over = await settleObligation(team.admin, { obligationId, amount: '7000.01', cashAccountId: bank.id }, opts());
    expect(over).toMatchObject({ status: 'rejected', errorCode: 'over_settlement' });
    const rest = await settleObligation(team.admin, { obligationId, amount: '7000', cashAccountId: bank.id }, opts());
    expect(rest.data).toMatchObject({ status: 'settled', remaining: '0.00' });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(D(cash('banco_zoho').currentBalance).toFixed(2)).toBe('-12000.00');
    expect(linesOf(fake, rest.data!.ledgerEntryId)).toEqual([
      ['payable', obligationId, '7000.00', '0.00', null],
      ['cash', bank.id, '0.00', '7000.00', null],
    ]);
    unsubscribe();
  });

  it('cancel refuses applied money; write-off clears the balance', async () => {
    const created = await createManualObligation(
      team.admin,
      { kind: 'receivable', counterpartyType: 'other', counterpartyName: 'Arrendatario', description: 'Renta de bodega', expectedAmount: '1000', dueAt: '2026-06-01' },
      opts()
    );
    const obligationId = created.data!.obligationId;
    expect(rowById(fake, 'obligation', obligationId).categoryId).toBe(byKey(fake, 'financeCategory', 'otros_ingresos').id);
    await settleObligation(team.admin, { obligationId, amount: '400', cashAccountId: cash('caja_general').id }, opts());
    const cancel = await cancelObligationCommand(team.admin, { obligationId, reason: 'Ya no aplica' }, opts());
    expect(cancel).toMatchObject({ status: 'rejected', errorCode: 'has_settlements' });
    const writeOff = await writeOffObligation(team.admin, { obligationId, reason: 'Incobrable tras 90 días' }, opts());
    expect(writeOff.data).toMatchObject({ status: 'written_off' });
    expect(linesOf(fake, writeOff.data!.ledgerEntryId)).toEqual([
      ['category', byKey(fake, 'financeCategory', 'cuentas_incobrables').id, '600.00', '0.00', null],
      ['receivable', obligationId, '0.00', '600.00', null],
    ]);

    const other = await createManualObligation(
      team.admin,
      { kind: 'payable', counterpartyType: 'tax', counterpartyName: 'SAT', description: 'Pago provisional', expectedAmount: '2500' },
      opts()
    );
    const cancelled = await cancelObligationCommand(team.admin, { obligationId: other.data!.obligationId, reason: 'Capturado por error' }, opts());
    expect(cancelled.data).toMatchObject({ status: 'cancelled' });
    const entry = rowById(fake, 'ledgerEntry', other.data!.ledgerEntryId!);
    expect(entry.reversedByEntryId).toBeTruthy();
    expect(rowById(fake, 'ledgerEntry', entry.reversedByEntryId)).toMatchObject({ kind: 'reversal', reversesEntryId: entry.id });
  });
});

describe('expected income vs collections', () => {
  it('spreads one payment over two expected receivables, idempotently', async () => {
    seedContact(fake, { zohoContactId: 'C1', paymentTerms: 15 });
    seedSalesOrderCase(fake, { caseId: 'case-1', zohoSalesOrderId: 'SO-1', total: '3000', zohoCustomerId: 'C1', orderDate: '2026-09-01', customerName: 'Constructora Río' });
    seedSalesOrderCase(fake, { caseId: 'case-2', zohoSalesOrderId: 'SO-2', total: '2000', zohoCustomerId: 'C1', orderDate: '2026-09-05', customerName: 'Constructora Río' });
    expect((await expectCase('case-1')).data).toMatchObject({ created: true, reason: 'created' });
    expect((await expectCase('case-2')).data).toMatchObject({ created: true });
    expect((await expectCase('case-1')).replayed).toBe(true);

    const ob1 = obligationOfOrder('SO-1');
    const ob2 = obligationOfOrder('SO-2');
    expect(ob1).toMatchObject({ caseId: 'case-1', counterpartyType: 'customer', zohoContactId: 'C1' });
    expect([dateKeyOf(ob1.dueAt), dateKeyOf(ob2.dueAt)]).toEqual(['2026-09-16', '2026-09-20']);
    expect(linesOf(fake, ob1.ledgerEntryId)).toEqual([
      ['receivable', ob1.id, '3000.00', '0.00', null],
      ['category', byKey(fake, 'financeCategory', 'ventas').id, '0.00', '3000.00', byKey(fake, 'costCenter', 'cc_ventas').id],
    ]);

    seedCustomerPayment(fake, { zohoPaymentId: 'P-1', amount: '5000', zohoCustomerId: 'C1', date: '2026-09-14', paymentNumber: 'PAGO-77' });
    const summary = await reconcileCollections({ now: NOW });
    expect(summary).toMatchObject({ payments: 1, matched: 1, settlements: 2, flagged: 0, errors: 0 });
    expect(settlementsOf(ob1.id).map((s) => [s.externalRef, D(s.amount).toFixed(2), s.zohoPaymentId])).toEqual([
      [`zoho_payment:P-1:${ob1.id}`, '3000.00', 'P-1'],
    ]);
    expect(settlementsOf(ob2.id).map((s) => [s.externalRef, D(s.amount).toFixed(2)])).toEqual([[`zoho_payment:P-1:${ob2.id}`, '2000.00']]);
    expect([rowById(fake, 'obligation', ob1.id).status, rowById(fake, 'obligation', ob2.id).status]).toEqual(['settled', 'settled']);
    expect(D(cash('banco_zoho').currentBalance).toFixed(2)).toBe('5000.00');
    expect(eventsOf(fake, 'finance.collection.matched')[0].payload).toMatchObject({ rule: 'fifo', zohoPaymentId: 'P-1' });

    const again = await reconcileCollections({ now: NOW });
    expect(again).toMatchObject({ payments: 0, settlements: 0 });
    expect(fake.rows('obligationSettlement')).toHaveLength(2);
  });

  it('a payment pair already applied is skipped by its externalRef', async () => {
    seedContact(fake, { zohoContactId: 'C9' });
    seedSalesOrderCase(fake, { caseId: 'case-9', zohoSalesOrderId: 'SO-9', total: '3000', zohoCustomerId: 'C9', orderDate: '2026-09-01' });
    await expectCase('case-9');
    const ob = obligationOfOrder('SO-9');
    seedCustomerPayment(fake, { zohoPaymentId: 'P-9', amount: '2000', zohoCustomerId: 'C9', date: '2026-09-10' });
    const first = await matchPaymentToObligation(team.admin, { zohoPaymentId: 'P-9', allocations: [{ obligationId: ob.id, amount: '1000' }] }, opts());
    expect(first.data?.applied).toHaveLength(1);
    const second = await matchPaymentToObligation(team.admin, { zohoPaymentId: 'P-9', allocations: [{ obligationId: ob.id, amount: '500' }] }, opts());
    expect(second.data).toMatchObject({ applied: [], skipped: [{ obligationId: ob.id, reason: 'already_applied' }], remaining: '1000.00' });
    expect(settlementsOf(ob.id)).toHaveLength(1);
  });

  it('flags the remainder of an overpayment and records it as unexpected income', async () => {
    seedSalesOrderCase(fake, { caseId: 'case-3', zohoSalesOrderId: 'SO-3', total: '1000', zohoCustomerId: 'C2', orderDate: '2026-09-01' });
    seedSalesOrderCase(fake, { caseId: 'case-4', zohoSalesOrderId: 'SO-4', total: '1000', zohoCustomerId: 'C2', orderDate: '2026-09-02' });
    await expectCase('case-3');
    await expectCase('case-4');
    seedCustomerPayment(fake, { zohoPaymentId: 'P-2', amount: '2500', zohoCustomerId: 'C2', date: '2026-09-12', paymentNumber: 'PAGO-2', customerName: 'Grupo Delta' });
    const summary = await reconcileCollections({ now: NOW });
    expect(summary).toMatchObject({ payments: 1, matched: 0, settlements: 2, flagged: 1 });
    const item = fake.rows('workItem').find((w) => w.objectType === 'customer_payment' && w.objectId === 'P-2')!;
    expect(item).toMatchObject({ title: 'Asignar cobro PAGO-2 de Grupo Delta', status: 'open', ownerUserId: 'u-conta', areaKey: 'contabilidad' });
    const pending = await listUnmatchedPayments(tx, { fromKey: '2026-08-01' });
    expect(pending).toEqual([expect.objectContaining({ zohoPaymentId: 'P-2', remaining: '500.00', applied: '2000.00', openWorkItemId: item.id })]);

    // a second run neither applies nor flags twice
    const rerun = await reconcileCollections({ now: NOW });
    expect(rerun).toMatchObject({ settlements: 0 });
    expect(fake.rows('workItem').filter((w) => w.objectId === 'P-2')).toHaveLength(1);

    const unexpected = await recordUnexpectedCollection(team.admin, { zohoPaymentId: 'P-2' }, opts());
    expect(unexpected.data).toMatchObject({ remaining: '0.00', completedWorkItemIds: [item.id] });
    expect(rowById(fake, 'obligation', unexpected.data!.obligationId)).toMatchObject({ status: 'settled', kind: 'receivable', counterpartyName: 'Grupo Delta' });
    expect(rowById(fake, 'workItem', item.id).status).toBe('done');
    expect(await listUnmatchedPayments(tx, { fromKey: '2026-08-01' })).toEqual([]);
  });

  it('equal balances are ambiguous until a person assigns the payment', async () => {
    seedSalesOrderCase(fake, { caseId: 'case-5', zohoSalesOrderId: 'SO-5', total: '1500', zohoCustomerId: 'C3', orderDate: '2026-09-01' });
    seedSalesOrderCase(fake, { caseId: 'case-6', zohoSalesOrderId: 'SO-6', total: '1500', zohoCustomerId: 'C3', orderDate: '2026-09-03' });
    await expectCase('case-5');
    await expectCase('case-6');
    seedCustomerPayment(fake, { zohoPaymentId: 'P-3', amount: '1500', zohoCustomerId: 'C3', date: '2026-09-13' });
    const summary = await reconcileCollections({ now: NOW });
    expect(summary).toMatchObject({ settlements: 0, flagged: 1 });
    const target = obligationOfOrder('SO-6');
    const viewer = { ...team.approver };
    const forbidden = await matchPaymentToObligation(viewer, { zohoPaymentId: 'P-3', allocations: [{ obligationId: target.id, amount: '1500' }] }, opts());
    expect(forbidden).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    const assigned = await matchPaymentToObligation(team.admin, { zohoPaymentId: 'P-3', allocations: [{ obligationId: target.id, amount: '1500' }] }, opts());
    expect(assigned.data).toMatchObject({ remaining: '0.00' });
    expect(assigned.data?.completedWorkItemIds).toHaveLength(1);
    expect(rowById(fake, 'obligation', target.id).status).toBe('settled');
    expect(obligationOfOrder('SO-5').status).toBe('expected');
  });

  it('follows the invoices of the payment to their sales order', async () => {
    seedSalesOrderCase(fake, { caseId: 'case-7', zohoSalesOrderId: 'SO-7', total: '1000', zohoCustomerId: 'C4', orderDate: '2026-08-20' });
    seedSalesOrderCase(fake, { caseId: 'case-8', zohoSalesOrderId: 'SO-8', total: '1000', zohoCustomerId: 'C4', orderDate: '2026-09-05' });
    await expectCase('case-7');
    await expectCase('case-8');
    const invoice = fake.seed('invoice', { zohoInvoiceId: 'INV-8', invoiceNumber: 'F-8', zohoCustomerId: 'C4' });
    fake.seed('invoiceItem', { invoiceId: invoice.id, zohoSalesOrderId: 'SO-8' });
    fake.seed('integrationSnapshot', {
      source: 'zoho',
      entityType: 'customerpayment',
      externalId: 'P-4',
      remoteModifiedAt: new Date('2026-09-14T10:00:00Z'),
      payload: { payment_id: 'P-4', invoices: [{ invoice_id: 'INV-8', invoice_number: 'F-8' }] },
    });
    seedCustomerPayment(fake, { zohoPaymentId: 'P-4', amount: '1000', zohoCustomerId: 'C4', date: '2026-09-14' });
    await reconcileCollections({ now: NOW });
    expect(obligationOfOrder('SO-8').status).toBe('settled');
    expect(obligationOfOrder('SO-7').status).toBe('expected');
    expect(eventsOf(fake, 'finance.collection.matched')[0].payload).toMatchObject({ rule: 'invoice' });
  });

  it('a voided order cancels its receivable by reversal, or asks a person when money was applied', async () => {
    const { order } = seedSalesOrderCase(fake, { caseId: 'case-10', zohoSalesOrderId: 'SO-10', total: '800', zohoCustomerId: 'C5', orderDate: '2026-09-01' });
    const paidOrder = seedSalesOrderCase(fake, { caseId: 'case-11', zohoSalesOrderId: 'SO-11', total: '900', zohoCustomerId: 'C6', orderDate: '2026-09-01' });
    await expectCase('case-10');
    await expectCase('case-11');
    seedCustomerPayment(fake, { zohoPaymentId: 'P-11', amount: '300', zohoCustomerId: 'C6', date: '2026-09-10' });
    await reconcileCollections({ now: NOW });
    expect(obligationOfOrder('SO-11').status).toBe('partially_settled');

    order.status = 'void';
    paidOrder.order.status = 'void';
    const summary = await reconcileCollections({ now: NOW });
    expect(summary.voidedOrders).toBe(2);
    const cancelled = obligationOfOrder('SO-10');
    expect(cancelled.status).toBe('cancelled');
    const entry = rowById(fake, 'ledgerEntry', cancelled.ledgerEntryId);
    expect(rowById(fake, 'ledgerEntry', entry.reversedByEntryId).kind).toBe('reversal');
    expect(obligationOfOrder('SO-11').status).toBe('partially_settled');
    expect(fake.rows('workItem').find((w) => w.objectType === 'obligation' && w.objectId === obligationOfOrder('SO-11').id)?.title).toContain(
      'Orden anulada con cobro'
    );
    // a voided order never gets a new expected receivable
    seedSalesOrderCase(fake, { caseId: 'case-12', zohoSalesOrderId: 'SO-12', total: '100', zohoCustomerId: 'C5', orderDate: '2026-09-01', status: 'void' });
    expect((await expectCase('case-12')).data).toMatchObject({ created: false, reason: 'voided' });
  });

  it('reversing a settlement frees the payment, which a person re-applies under a new reference', async () => {
    seedSalesOrderCase(fake, { caseId: 'case-20', zohoSalesOrderId: 'SO-20', total: '3000', zohoCustomerId: 'C7', orderDate: '2026-09-01' });
    await expectCase('case-20');
    const ob = obligationOfOrder('SO-20');
    seedCustomerPayment(fake, { zohoPaymentId: 'P-20', amount: '3000', zohoCustomerId: 'C7', date: '2026-09-11' });
    await reconcileCollections({ now: NOW });
    const [settlement] = settlementsOf(ob.id);
    expect(D(cash('banco_zoho').currentBalance).toFixed(2)).toBe('3000.00');

    const notReversal = await reverseSettlement(team.approver, { obligationId: ob.id, settlementId: settlement.id, reason: 'No' }, opts());
    expect(notReversal).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    const reversed = await reverseSettlement(team.admin, { obligationId: ob.id, settlementId: settlement.id, reason: 'Pago de otra orden' }, opts());
    expect(reversed.data).toMatchObject({ status: 'expected', remaining: '3000.00' });
    expect(settlementsOf(ob.id).map((s) => [s.externalRef, D(s.amount).toFixed(2)])).toEqual([
      [`zoho_payment:P-20:${ob.id}`, '3000.00'],
      [`zoho_payment:P-20:${ob.id}:reversal`, '-3000.00'],
    ]);
    expect(D(cash('banco_zoho').currentBalance).toFixed(2)).toBe('0.00');
    const twice = await reverseSettlement(team.admin, { obligationId: ob.id, settlementId: settlement.id, reason: 'Otra vez' }, opts());
    expect(twice).toMatchObject({ status: 'rejected', errorCode: 'already_reversed' });

    // The reconciler never re-applies it on its own: the payment waits in "Asignar cobro".
    expect(reversed.data?.paymentWorkItemId).toBeTruthy();
    expect(await reconcileCollections({ now: NOW })).toMatchObject({ held: 1, settlements: 0 });
    expect(settlementsOf(ob.id)).toHaveLength(2);
    const reassigned = await matchPaymentToObligation(team.admin, { zohoPaymentId: 'P-20', allocations: [{ obligationId: ob.id, amount: '3000' }] }, opts());
    expect(reassigned.data).toMatchObject({ remaining: '0.00', completedWorkItemIds: [reversed.data!.paymentWorkItemId] });
    expect(settlementsOf(ob.id).map((s) => s.externalRef)).toContain(`zoho_payment:P-20:${ob.id}#2`);
    expect(rowById(fake, 'obligation', ob.id).status).toBe('settled');
  });

  it('expects the receivable of a new case through the onCaseStarted listener and the reconciler', async () => {
    registerCollectionsCaseListener();
    const listener = mocks.onCaseStarted.mock.calls[0][0] as (event: Record<string, unknown>) => Promise<void>;
    seedSalesOrderCase(fake, { caseId: 'case-30', zohoSalesOrderId: 'SO-30', total: '1200', zohoCustomerId: 'C8', orderDate: '2026-09-14' });
    await listener({ caseId: 'case-30', zohoSalesOrderId: 'SO-30', caseNumber: 'EXP-1', manual: false });
    expect(obligationOfOrder('SO-30')).toMatchObject({ status: 'expected' });

    seedSalesOrderCase(fake, {
      caseId: 'case-31',
      zohoSalesOrderId: 'SO-31',
      total: '700',
      zohoCustomerId: 'C8',
      orderDate: '2026-09-14',
      openedAt: new Date(NOW.getTime() - 86_400_000),
    });
    const summary = await reconcileCollections({ now: NOW });
    expect(summary.expectedCases).toBe(1);
    expect(obligationOfOrder('SO-31')).toBeTruthy();
    // payments before the operations cutover are never reconciled
    seedCustomerPayment(fake, { zohoPaymentId: 'P-old', amount: '700', zohoCustomerId: 'C8', date: '2026-07-20' });
    expect((await reconcileCollections({ now: NOW })).payments).toBe(0);
    expect(fake.rows('customerPayment').find((p) => p.zohoPaymentId === 'P-old')).toBeTruthy();
    expect(dbDate('2026-07-20') < dbDate('2026-08-01')).toBe(true);
  });
});
