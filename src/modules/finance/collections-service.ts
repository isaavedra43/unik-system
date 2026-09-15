import { createHash } from 'crypto';
import { Prisma, type CustomerPayment } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { lockAdvisoryKeys } from '@/modules/operations/advisory-locks';
import { onCaseStarted } from '@/modules/operations/case-service';
import type { CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { toOperationalJson } from '@/modules/operations/events-service';
import { getOperationsConfig } from '@/modules/operations/operations-config';
import { OPS_EVENTS, WORK_ITEM_OPEN_STATUSES } from '@/modules/operations/types';
import { FINANCE_CATEGORY_KEYS, cashAccountByKey, costCenterIdForArea } from './catalog-service';
import {
  extractInvoiceRefs,
  manualAllocationIssues,
  matchPayment,
  overapplicationIssue,
  remainingToApply,
  type MatchOutcome,
  type OverapplicationIssue,
  type ReceivableCandidate,
} from './collections-matcher';
import { getFinanceSettings, readFinanceSettings } from './finance-config';
import { financeError } from './finance-errors';
import { addDaysToKey, compareKeys, dateKeyOf, localDateKey, toDbDate } from './finance-dates';
import {
  actorUserIdOf,
  financeEventOptions,
  publishBoard,
  runFinanceSystemCommand,
  todayKeyOf,
} from './finance-helpers';
import { closedPeriodOf } from './ledger-service';
import { D, MONEY_TOLERANCE, formatMxn, positiveMoneySchema, roundMoney, sumMoney } from './money';
import {
  cancelObligation,
  createObligationWithEntry,
  settleObligationInTx,
} from './obligations-service';
import {
  nextSettlementExternalRef,
  remainingOf,
  reversedObligationIdsOf,
  ZOHO_PAYMENT_REF_PREFIX,
} from './obligation-rules';
import {
  FINANCE_AREA_KEY,
  FINANCE_COMMANDS,
  FINANCE_EVENTS,
  FINANCE_OBJECT_TYPES,
  OBLIGATION_OPEN_STATUSES,
} from './types';

/**
 * Expected income against real collections (plan 6.4).
 *
 * - When a case starts (`onCaseStarted`) a `receivable` obligation is expected
 *   from its sales order: total, customer terms (`Contact.paymentTerms` days
 *   after the order date) and an `obligation` entry.
 * - `finance.reconcile_collections` (every 30 min) matches each synced Zoho
 *   customer payment with an unapplied remainder (amount − Σ settlements that
 *   carry its id) using `collections-matcher.ts`; one payment may settle
 *   several obligations and each settlement is idempotent by
 *   `externalRef = zoho_payment:{zohoPaymentId}:{obligationId}`. Ambiguous or
 *   unmatched remainders open the work item "Asignar cobro"; a voided sales
 *   order cancels its receivable by reversal. Only settlements move cash (the
 *   configurable "Banco (Zoho)" account).
 */

type Db = Prisma.TransactionClient;

/** IntegrationSnapshot of a Zoho customer payment (payments-sync.ts constants). */
const PAYMENT_SNAPSHOT_SOURCE = 'zoho';
const PAYMENT_SNAPSHOT_ENTITY = 'customerpayment';
const VOID_PAYMENT_STATUSES = ['void', 'draft'];
const VOID_ORDER_STATUSES = ['void', 'cancelled'];

const idSchema = z.string().trim().min(1).max(120);

/** Title prefix of the work item that asks Contabilidad to review a payment voided or reduced in Zoho. */
export const OVERAPPLIED_WORK_ITEM_PREFIX = 'Revisar cobro';

/**
 * Advisory lock of one Zoho payment. Every command that reads its unapplied
 * remainder and settles against it (reconciler, a person's assignment, an
 * unexpected collection, a review) takes it first, so two of them never apply
 * the same money twice to different obligations.
 */
export function paymentLockKey(zohoPaymentId: string): string {
  return `finance:zoho_payment:${zohoPaymentId}`;
}

function isVoidStatus(status: string | null | undefined, list: readonly string[]): boolean {
  return Boolean(status && list.includes(status.trim().toLowerCase()));
}

function currencyOf(code: string | null | undefined): string {
  const value = (code ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : 'MXN';
}

// ---------------------------------------------------------------------------
// Expected receivable of a case
// ---------------------------------------------------------------------------

export const expectCaseSchema = z.object({ caseId: idSchema });

export interface ExpectCaseResult {
  created: boolean;
  obligationId: string | null;
  reason: 'created' | 'exists' | 'no_sales_order' | 'sales_order_missing' | 'no_total' | 'voided';
}

export async function expectReceivableForCaseInTx(
  tx: Db,
  input: z.output<typeof expectCaseSchema>,
  ctx: CommandContext
): Promise<ExpectCaseResult> {
  const operationalCase = await tx.operationalCase.findUnique({ where: { id: input.caseId } });
  if (!operationalCase) throw new OperationsError('not_found', 'No se encontró el expediente');
  const zohoSalesOrderId = operationalCase.zohoSalesOrderId;
  if (!zohoSalesOrderId) return { created: false, obligationId: null, reason: 'no_sales_order' };
  const existing = await tx.obligation.findFirst({
    where: { kind: 'receivable', zohoSalesOrderId, status: { not: 'cancelled' } },
    select: { id: true },
  });
  if (existing) return { created: false, obligationId: existing.id, reason: 'exists' };
  const order = await tx.salesOrder.findUnique({ where: { zohoSalesOrderId } });
  if (!order) return { created: false, obligationId: null, reason: 'sales_order_missing' };
  if (isVoidStatus(order.status, VOID_ORDER_STATUSES)) return { created: false, obligationId: null, reason: 'voided' };
  const total = roundMoney(D(order.total));
  if (!total.greaterThan(0)) return { created: false, obligationId: null, reason: 'no_total' };

  const contact = order.zohoCustomerId
    ? await tx.contact.findUnique({ where: { zohoContactId: order.zohoCustomerId }, select: { paymentTerms: true } })
    : null;
  const today = todayKeyOf(ctx);
  const orderKey = order.orderDate ? dateKeyOf(order.orderDate) : today;
  const terms = Math.max(0, Math.min(contact?.paymentTerms ?? 0, 365));
  const dueKey = addDaysToKey(orderKey, terms);
  const { obligation } = await createObligationWithEntry(
    tx,
    {
      kind: 'receivable',
      counterpartyType: 'customer',
      counterpartyName: order.customerName ?? operationalCase.customerName,
      zohoContactId: order.zohoCustomerId,
      caseId: operationalCase.id,
      zohoSalesOrderId,
      description: `Cobro esperado de ${order.salesOrderNumber ?? zohoSalesOrderId}${order.customerName ? ` · ${order.customerName}` : ''}`.slice(0, 500),
      currency: currencyOf(order.currencyCode),
      expectedAmount: total,
      dueAt: dueKey,
      expectedCashAt: dueKey,
      categoryKey: FINANCE_CATEGORY_KEYS.sales,
      costCenterId: await costCenterIdForArea(tx, 'ventas'),
      date: today,
    },
    ctx
  );
  ctx.emit(
    FINANCE_EVENTS.collection.expected,
    {
      obligationId: obligation.id,
      number: obligation.number,
      zohoSalesOrderId,
      salesOrderNumber: order.salesOrderNumber,
      amount: total.toFixed(2),
      currency: obligation.currency,
      dueAt: dueKey,
      paymentTermsDays: terms,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.obligation, obligation.id, operationalCase.id)
  );
  return { created: true, obligationId: obligation.id, reason: 'created' };
}

type GlobalWithCollections = typeof globalThis & { __unikFinanceCaseListener?: () => void };

/** After each new case: expect its receivable (idempotent command; the reconciler catches misses). */
export function registerCollectionsCaseListener(): void {
  const scope = globalThis as GlobalWithCollections;
  if (scope.__unikFinanceCaseListener) return;
  scope.__unikFinanceCaseListener = onCaseStarted(async (event) => {
    if (!event.zohoSalesOrderId) return;
    await runFinanceSystemCommand({
      commandId: `finance:expect_case:${event.caseId}`,
      type: FINANCE_COMMANDS.collectionExpectCase,
      aggregate: { type: 'operational_case', id: event.caseId },
      payload: { caseId: event.caseId },
    });
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

type PaymentsDb = Pick<Db, 'customerPayment' | 'obligationSettlement' | 'workItem'>;

/**
 * Σ settlement amounts per Zoho payment (reversals are negative rows). When
 * `rowCounts` is given it receives how many settlement rows carry each payment:
 * that count only grows (a reversal adds a row), so it versions the
 * reconciler's command ids and a re-application after a reversal is never
 * mistaken for a replay.
 */
export async function appliedByPayment(
  db: Pick<Db, 'obligationSettlement'>,
  zohoPaymentIds: readonly string[],
  rowCounts?: Map<string, number>,
  refs?: Map<string, string[]>
): Promise<Map<string, Prisma.Decimal>> {
  const map = new Map<string, Prisma.Decimal>();
  if (zohoPaymentIds.length === 0) return map;
  const rows = await db.obligationSettlement.findMany({
    where: { zohoPaymentId: { in: [...new Set(zohoPaymentIds)] } },
    select: { zohoPaymentId: true, amount: true, externalRef: true },
  });
  for (const row of rows) {
    if (!row.zohoPaymentId) continue;
    map.set(row.zohoPaymentId, (map.get(row.zohoPaymentId) ?? new Prisma.Decimal(0)).plus(D(row.amount)));
    rowCounts?.set(row.zohoPaymentId, (rowCounts.get(row.zohoPaymentId) ?? 0) + 1);
    if (refs && row.externalRef) refs.set(row.zohoPaymentId, [...(refs.get(row.zohoPaymentId) ?? []), row.externalRef]);
  }
  return map;
}

export interface UnmatchedPayment {
  zohoPaymentId: string;
  paymentNumber: string | null;
  date: string | null;
  customerName: string | null;
  zohoCustomerId: string | null;
  currency: string;
  amount: string;
  applied: string;
  remaining: string;
  referenceNumber: string | null;
  openWorkItemId: string | null;
  /** Settlement rows already carrying this payment (reversals included). */
  settlementRows: number;
  /**
   * Obligations from which a person reversed an application of this payment:
   * the reconciler never re-applies the payment to them automatically.
   */
  reversedObligationIds: string[];
}

/** Synced payments of `[fromKey, toKey]` with an unapplied remainder (oldest first). */
export async function listUnmatchedPayments(
  db: PaymentsDb,
  options: { fromKey: string; toKey?: string | null; limit?: number }
): Promise<UnmatchedPayment[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 2000);
  const payments = await db.customerPayment.findMany({
    where: {
      date: { gte: toDbDate(options.fromKey), ...(options.toKey ? { lte: toDbDate(options.toKey) } : {}) },
      amount: { gt: 0 },
    },
    orderBy: [{ date: 'asc' }, { zohoPaymentId: 'asc' }],
    take: Math.min(limit * 4, 5000),
  });
  const live = payments.filter((p) => !isVoidStatus(p.status, VOID_PAYMENT_STATUSES));
  const rowCounts = new Map<string, number>();
  const refs = new Map<string, string[]>();
  const applied = await appliedByPayment(db, live.map((p) => p.zohoPaymentId), rowCounts, refs);
  const pending = live
    .map((payment) => {
      const used = applied.get(payment.zohoPaymentId) ?? new Prisma.Decimal(0);
      return { payment, used, remaining: remainingToApply({ amount: D(payment.amount), applied: used }) };
    })
    .filter((row) => row.remaining.greaterThan(MONEY_TOLERANCE))
    .slice(0, limit);
  const items = pending.length
    ? await db.workItem.findMany({
        where: {
          objectType: FINANCE_OBJECT_TYPES.customerPayment,
          objectId: { in: pending.map((row) => row.payment.zohoPaymentId) },
          status: { in: [...WORK_ITEM_OPEN_STATUSES] },
        },
        select: { id: true, objectId: true },
      })
    : [];
  return pending.map(({ payment, used, remaining }) => ({
    zohoPaymentId: payment.zohoPaymentId,
    paymentNumber: payment.paymentNumber,
    date: payment.date ? dateKeyOf(payment.date) : null,
    customerName: payment.customerName,
    zohoCustomerId: payment.zohoCustomerId,
    currency: currencyOf(payment.currencyCode),
    amount: roundMoney(D(payment.amount)).toFixed(2),
    applied: roundMoney(used).toFixed(2),
    remaining: remaining.toFixed(2),
    referenceNumber: payment.referenceNumber,
    openWorkItemId: items.find((item) => item.objectId === payment.zohoPaymentId)?.id ?? null,
    settlementRows: rowCounts.get(payment.zohoPaymentId) ?? 0,
    reversedObligationIds: reversedObligationIdsOf(refs.get(payment.zohoPaymentId) ?? [], payment.zohoPaymentId),
  }));
}

export interface OverappliedPayment {
  zohoPaymentId: string;
  paymentNumber: string | null;
  customerName: string | null;
  currency: string;
  /** Payment amount in Zoho; null when it is no longer synced. */
  amount: string | null;
  applied: string;
  /** Money the ledger has from this payment beyond what Zoho still holds. */
  excess: string;
  issue: OverapplicationIssue;
  settlementRows: number;
  openWorkItemId: string | null;
}

/**
 * Zoho payments whose active settlements exceed what the payment still is:
 * voided or draft in Zoho (a bounced check), no longer synced, or reduced
 * below what UNIK applied. The other direction of the reconciliation.
 */
export async function listOverappliedPayments(
  db: PaymentsDb,
  options: { limit?: number } = {}
): Promise<OverappliedPayment[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 2000);
  const settlements = await db.obligationSettlement.findMany({
    where: { zohoPaymentId: { not: null } },
    select: { zohoPaymentId: true, amount: true },
    take: 100_000,
  });
  const sums = new Map<string, { applied: Prisma.Decimal; rows: number }>();
  for (const row of settlements) {
    if (!row.zohoPaymentId) continue;
    const current = sums.get(row.zohoPaymentId) ?? { applied: new Prisma.Decimal(0), rows: 0 };
    current.applied = current.applied.plus(D(row.amount));
    current.rows += 1;
    sums.set(row.zohoPaymentId, current);
  }
  const active = [...sums.entries()].filter(([, sum]) => sum.applied.greaterThan(MONEY_TOLERANCE));
  if (active.length === 0) return [];
  const payments = await db.customerPayment.findMany({
    where: { zohoPaymentId: { in: active.map(([id]) => id) } },
  });
  const byId = new Map(payments.map((payment) => [payment.zohoPaymentId, payment]));
  const flagged: Array<Omit<OverappliedPayment, 'openWorkItemId'>> = [];
  for (const [zohoPaymentId, sum] of active.sort(([a], [b]) => a.localeCompare(b))) {
    const payment = byId.get(zohoPaymentId) ?? null;
    const issue = overapplicationIssue(payment ? { amount: payment.amount, status: payment.status } : null, sum.applied);
    if (!issue) continue;
    const held = issue === 'over_applied' && payment?.amount ? D(payment.amount) : new Prisma.Decimal(0);
    flagged.push({
      zohoPaymentId,
      paymentNumber: payment?.paymentNumber ?? null,
      customerName: payment?.customerName ?? null,
      currency: currencyOf(payment?.currencyCode),
      amount: payment?.amount === null || payment?.amount === undefined ? null : roundMoney(D(payment.amount)).toFixed(2),
      applied: roundMoney(sum.applied).toFixed(2),
      excess: roundMoney(sum.applied.minus(held)).toFixed(2),
      issue,
      settlementRows: sum.rows,
    });
    if (flagged.length >= limit) break;
  }
  const items = flagged.length
    ? await db.workItem.findMany({
        where: {
          objectType: FINANCE_OBJECT_TYPES.customerPayment,
          objectId: { in: flagged.map((row) => row.zohoPaymentId) },
          status: { in: [...WORK_ITEM_OPEN_STATUSES] },
          title: { startsWith: OVERAPPLIED_WORK_ITEM_PREFIX },
        },
        select: { id: true, objectId: true },
      })
    : [];
  return flagged.map((row) => ({
    ...row,
    openWorkItemId: items.find((item) => item.objectId === row.zohoPaymentId)?.id ?? null,
  }));
}

/** Sales orders of the invoices the payment was applied to in Zoho (latest snapshot). */
export async function invoiceSalesOrderIdsForPayment(
  db: Pick<Db, 'integrationSnapshot' | 'invoice' | 'invoiceItem'>,
  zohoPaymentId: string
): Promise<string[]> {
  const snapshot = await db.integrationSnapshot.findFirst({
    where: { source: PAYMENT_SNAPSHOT_SOURCE, entityType: PAYMENT_SNAPSHOT_ENTITY, externalId: zohoPaymentId },
    orderBy: { remoteModifiedAt: 'desc' },
    select: { payload: true },
  });
  if (!snapshot) return [];
  const refs = extractInvoiceRefs(snapshot.payload);
  if (refs.invoiceIds.length === 0 && refs.invoiceNumbers.length === 0) return [];
  const or: Prisma.InvoiceWhereInput[] = [];
  if (refs.invoiceIds.length) or.push({ zohoInvoiceId: { in: refs.invoiceIds } });
  if (refs.invoiceNumbers.length) or.push({ invoiceNumber: { in: refs.invoiceNumbers } });
  const invoices = await db.invoice.findMany({ where: { OR: or }, select: { id: true } });
  if (invoices.length === 0) return [];
  const items = await db.invoiceItem.findMany({
    where: { invoiceId: { in: invoices.map((i) => i.id) }, zohoSalesOrderId: { not: null } },
    select: { zohoSalesOrderId: true },
  });
  return [...new Set(items.map((i) => i.zohoSalesOrderId).filter((id): id is string => Boolean(id)))];
}

export async function receivableCandidates(
  db: Pick<Db, 'obligation'>,
  input: { zohoCustomerId: string | null; salesOrderIds: readonly string[]; currency: string }
): Promise<ReceivableCandidate[]> {
  const or: Prisma.ObligationWhereInput[] = [];
  if (input.zohoCustomerId) or.push({ zohoContactId: input.zohoCustomerId });
  if (input.salesOrderIds.length) or.push({ zohoSalesOrderId: { in: [...input.salesOrderIds] } });
  if (or.length === 0) return [];
  const rows = await db.obligation.findMany({
    where: { kind: 'receivable', status: { in: [...OBLIGATION_OPEN_STATUSES] }, currency: input.currency, OR: or },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
    take: 200,
  });
  return rows.map((row) => ({
    obligationId: row.id,
    number: row.number,
    zohoContactId: row.zohoContactId,
    zohoSalesOrderId: row.zohoSalesOrderId,
    currency: row.currency,
    remaining: remainingOf(row),
    dueKey: row.expectedCashAt ? dateKeyOf(row.expectedCashAt) : row.dueAt ? dateKeyOf(row.dueAt) : null,
    createdAt: row.createdAt,
  }));
}

async function loadPayment(tx: Db, zohoPaymentId: string): Promise<CustomerPayment> {
  const payment = await tx.customerPayment.findUnique({ where: { zohoPaymentId } });
  if (!payment) throw new OperationsError('not_found', 'No se encontró el pago sincronizado de Zoho');
  if (isVoidStatus(payment.status, VOID_PAYMENT_STATUSES)) {
    throw financeError('invalid_state', `El pago ${payment.paymentNumber ?? zohoPaymentId} está anulado en Zoho`);
  }
  return payment;
}

async function completePaymentWorkItems(
  tx: Db,
  zohoPaymentId: string,
  ctx: CommandContext,
  result: Record<string, unknown>
): Promise<string[]> {
  const items = await tx.workItem.findMany({
    where: {
      objectType: FINANCE_OBJECT_TYPES.customerPayment,
      objectId: zohoPaymentId,
      status: { in: [...WORK_ITEM_OPEN_STATUSES] },
    },
  });
  for (const item of items) {
    await tx.workItem.update({
      where: { id: item.id },
      data: {
        status: 'done',
        completedAt: ctx.now,
        completedBy: actorUserIdOf(ctx),
        result: toOperationalJson(result),
        version: { increment: 1 },
      },
    });
    ctx.emit(
      OPS_EVENTS.workitem.completed,
      { workItemId: item.id, reason: 'payment_assigned' },
      { caseId: item.caseId, areaKey: item.areaKey, objectType: 'work_item', objectId: item.id }
    );
  }
  return items.map((item) => item.id);
}

export const applyPaymentSchema = z.object({
  zohoPaymentId: idSchema,
  allocations: z.array(z.object({ obligationId: idSchema, amount: positiveMoneySchema })).min(1).max(50),
  rule: z.string().trim().max(40).nullish(),
});

export interface ApplyPaymentResult {
  zohoPaymentId: string;
  applied: Array<{ obligationId: string; number: string; settlementId: string; amount: string; externalRef: string }>;
  skipped: Array<{ obligationId: string; reason: string }>;
  remaining: string;
  completedWorkItemIds: string[];
}

/**
 * Applies a Zoho payment to receivables (system reconciler or a person's
 * assignment). Idempotent per payment and obligation; re-verifies the
 * remainder inside the transaction.
 */
export async function applyPaymentInTx(
  tx: Db,
  input: z.output<typeof applyPaymentSchema>,
  ctx: CommandContext,
  options: { manual: boolean }
): Promise<ApplyPaymentResult> {
  // Serialize on the payment BEFORE reading what is already applied (READ COMMITTED).
  await lockAdvisoryKeys(tx, [paymentLockKey(input.zohoPaymentId)]);
  const payment = await loadPayment(tx, input.zohoPaymentId);
  const currency = currencyOf(payment.currencyCode);
  const applied = (await appliedByPayment(tx, [payment.zohoPaymentId])).get(payment.zohoPaymentId) ?? new Prisma.Decimal(0);
  const paymentState = { amount: D(payment.amount), applied, currency };
  const obligations = await tx.obligation.findMany({
    where: { id: { in: input.allocations.map((a) => a.obligationId) } },
  });
  const byId = new Map(
    obligations.map((o) => [
      o.id,
      { number: o.number, currency: o.currency, remaining: isOpenStatus(o.status) ? remainingOf(o) : new Prisma.Decimal(0), kind: o.kind },
    ])
  );
  const issues = manualAllocationIssues(paymentState, input.allocations, byId);
  if (issues.length > 0) {
    throw financeError(options.manual ? 'invalid_payload' : 'payment_exhausted', issues.join('; '), { issues });
  }
  const settings = await readFinanceSettings(tx);
  const cashAccount = await cashAccountByKey(tx, settings.collectionsCashAccountKey);
  const today = todayKeyOf(ctx);
  let dateKey = payment.date ? dateKeyOf(payment.date) : today;
  if (compareKeys(dateKey, today) > 0 || (await closedPeriodOf(tx, dateKey))) dateKey = today;

  const result: ApplyPaymentResult = {
    zohoPaymentId: payment.zohoPaymentId,
    applied: [],
    skipped: [],
    remaining: '0.00',
    completedWorkItemIds: [],
  };
  for (const allocation of input.allocations) {
    const prefix = `${ZOHO_PAYMENT_REF_PREFIX}:${payment.zohoPaymentId}:${allocation.obligationId}`;
    const existing = await tx.obligationSettlement.findMany({
      where: { externalRef: { startsWith: prefix } },
      select: { externalRef: true },
    });
    const externalRef = nextSettlementExternalRef(
      existing.map((row) => row.externalRef).filter((ref): ref is string => Boolean(ref)),
      payment.zohoPaymentId,
      allocation.obligationId
    );
    if (!externalRef) {
      result.skipped.push({ obligationId: allocation.obligationId, reason: 'already_applied' });
      continue;
    }
    const settled = await settleObligationInTx(
      tx,
      {
        obligationId: allocation.obligationId,
        amount: allocation.amount,
        cashAccountId: cashAccount.id,
        dateKey,
        zohoPaymentId: payment.zohoPaymentId,
        externalRef,
        memo: `Pago Zoho ${payment.paymentNumber ?? payment.zohoPaymentId}`,
      },
      ctx
    );
    result.applied.push({
      obligationId: settled.obligation.id,
      number: settled.obligation.number,
      settlementId: settled.settlement.id,
      amount: roundMoney(allocation.amount).toFixed(2),
      externalRef,
    });
  }
  const appliedNow = sumMoney(result.applied.map((a) => a.amount));
  // Defense in depth: the total applied to the payment, re-read after writing, never exceeds it.
  const appliedTotal =
    (await appliedByPayment(tx, [payment.zohoPaymentId])).get(payment.zohoPaymentId) ?? new Prisma.Decimal(0);
  if (appliedTotal.greaterThan(D(payment.amount).plus(MONEY_TOLERANCE))) {
    throw financeError(
      'payment_overapplied',
      `El pago ${payment.paymentNumber ?? payment.zohoPaymentId} quedaría aplicado por ${formatMxn(appliedTotal, currency)} y es de ${formatMxn(payment.amount ?? 0, currency)}`,
      { applied: roundMoney(appliedTotal).toFixed(2), amount: roundMoney(D(payment.amount)).toFixed(2) }
    );
  }
  const remaining = remainingToApply({ amount: D(payment.amount), applied: applied.plus(appliedNow) });
  result.remaining = remaining.greaterThan(0) ? remaining.toFixed(2) : '0.00';
  if (!remaining.greaterThan(MONEY_TOLERANCE)) {
    result.completedWorkItemIds = await completePaymentWorkItems(tx, payment.zohoPaymentId, ctx, {
      assigned: result.applied.map((a) => ({ obligationId: a.obligationId, amount: a.amount })),
      manual: options.manual,
    });
  }
  if (result.applied.length > 0) {
    ctx.emit(
      FINANCE_EVENTS.collection.matched,
      {
        zohoPaymentId: payment.zohoPaymentId,
        paymentNumber: payment.paymentNumber,
        customerName: payment.customerName,
        manual: options.manual,
        rule: input.rule ?? null,
        allocations: result.applied.map((a) => ({ obligationId: a.obligationId, number: a.number, amount: a.amount })),
        remaining: result.remaining,
      },
      financeEventOptions(FINANCE_OBJECT_TYPES.customerPayment, payment.zohoPaymentId)
    );
    publishBoard(ctx, 'finance.collection', { zohoPaymentId: payment.zohoPaymentId, remaining: result.remaining });
  }
  return result;
}

function isOpenStatus(status: string): boolean {
  return (OBLIGATION_OPEN_STATUSES as readonly string[]).includes(status);
}

export const flagPaymentSchema = z.object({
  zohoPaymentId: idSchema,
  reason: z.string().trim().min(3).max(500),
});

/** Opens (once) the work item "Asignar cobro" for a payment the matcher could not place. */
export async function flagPaymentInTx(
  tx: Db,
  input: z.output<typeof flagPaymentSchema>,
  ctx: CommandContext
): Promise<{ workItemId: string; created: boolean }> {
  const payment = await loadPayment(tx, input.zohoPaymentId);
  const existing = await tx.workItem.findFirst({
    where: {
      objectType: FINANCE_OBJECT_TYPES.customerPayment,
      objectId: payment.zohoPaymentId,
      status: { in: [...WORK_ITEM_OPEN_STATUSES] },
    },
    select: { id: true },
  });
  if (existing) return { workItemId: existing.id, created: false };
  const applied = (await appliedByPayment(tx, [payment.zohoPaymentId])).get(payment.zohoPaymentId) ?? new Prisma.Decimal(0);
  const remaining = remainingToApply({ amount: D(payment.amount), applied });
  const currency = currencyOf(payment.currencyCode);
  const item = await ctx.createWorkItem({
    areaKey: FINANCE_AREA_KEY,
    kind: 'action',
    title: `Asignar cobro ${payment.paymentNumber ?? payment.zohoPaymentId}${payment.customerName ? ` de ${payment.customerName}` : ''}`.slice(0, 200),
    description: `${formatMxn(remaining, currency)} sin asignar. ${input.reason}`.slice(0, 1000),
    objectType: FINANCE_OBJECT_TYPES.customerPayment,
    objectId: payment.zohoPaymentId,
  });
  ctx.emit(
    FINANCE_EVENTS.collection.unassigned,
    {
      zohoPaymentId: payment.zohoPaymentId,
      paymentNumber: payment.paymentNumber,
      customerName: payment.customerName,
      remaining: remaining.toFixed(2),
      currency,
      reason: input.reason,
      workItemId: item.id,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.customerPayment, payment.zohoPaymentId)
  );
  publishBoard(ctx, 'finance.collection', { zohoPaymentId: payment.zohoPaymentId, workItemId: item.id });
  return { workItemId: item.id, created: true };
}

export const recordUnexpectedCollectionSchema = z.object({
  zohoPaymentId: idSchema,
  amount: positiveMoneySchema.nullish(),
  categoryId: idSchema.nullish(),
  caseId: idSchema.nullish(),
  description: z.string().trim().max(500).nullish(),
});

/** A payment without an expected receivable: recognizes the income and applies the payment to it. */
export async function recordUnexpectedCollectionInTx(
  tx: Db,
  input: z.output<typeof recordUnexpectedCollectionSchema>,
  ctx: CommandContext
): Promise<ApplyPaymentResult & { obligationId: string }> {
  await lockAdvisoryKeys(tx, [paymentLockKey(input.zohoPaymentId)]);
  const payment = await loadPayment(tx, input.zohoPaymentId);
  const applied = (await appliedByPayment(tx, [payment.zohoPaymentId])).get(payment.zohoPaymentId) ?? new Prisma.Decimal(0);
  const remaining = remainingToApply({ amount: D(payment.amount), applied });
  const amount = input.amount ? roundMoney(input.amount) : remaining;
  if (!amount.greaterThan(0) || amount.greaterThan(remaining.plus(MONEY_TOLERANCE))) {
    throw financeError('payment_exhausted', `Al pago le quedan ${formatMxn(remaining, currencyOf(payment.currencyCode))} por aplicar`);
  }
  const today = todayKeyOf(ctx);
  let dateKey = payment.date ? dateKeyOf(payment.date) : today;
  if (compareKeys(dateKey, today) > 0 || (await closedPeriodOf(tx, dateKey))) dateKey = today;
  const { obligation } = await createObligationWithEntry(
    tx,
    {
      kind: 'receivable',
      counterpartyType: 'customer',
      counterpartyName: payment.customerName,
      zohoContactId: payment.zohoCustomerId,
      caseId: input.caseId ?? null,
      description: (input.description ?? `Cobro sin orden esperada ${payment.paymentNumber ?? payment.zohoPaymentId}`).slice(0, 500),
      currency: currencyOf(payment.currencyCode),
      expectedAmount: amount,
      dueAt: dateKey,
      categoryId: input.categoryId ?? null,
      categoryKey: input.categoryId ? null : FINANCE_CATEGORY_KEYS.sales,
      date: dateKey,
    },
    ctx
  );
  const result = await applyPaymentInTx(
    tx,
    { zohoPaymentId: payment.zohoPaymentId, allocations: [{ obligationId: obligation.id, amount }], rule: 'unexpected' },
    ctx,
    { manual: true }
  );
  ctx.emit(
    FINANCE_EVENTS.collection.unexpected,
    { zohoPaymentId: payment.zohoPaymentId, obligationId: obligation.id, number: obligation.number, amount: amount.toFixed(2) },
    financeEventOptions(FINANCE_OBJECT_TYPES.customerPayment, payment.zohoPaymentId)
  );
  return { ...result, obligationId: obligation.id };
}

export interface HoldPaymentResult {
  workItemId: string | null;
  created: boolean;
}

/**
 * After a person reverses a settlement of a Zoho payment: the freed remainder
 * waits for a person ("Asignar cobro") instead of being re-applied by the
 * reconciler with the same deterministic rule it had just been undone from.
 */
export async function holdReversedPaymentInTx(
  tx: Db,
  input: { zohoPaymentId: string; obligationNumber: string; reason: string },
  ctx: CommandContext
): Promise<HoldPaymentResult> {
  await lockAdvisoryKeys(tx, [paymentLockKey(input.zohoPaymentId)]);
  const payment = await tx.customerPayment.findUnique({ where: { zohoPaymentId: input.zohoPaymentId } });
  // A voided payment is reviewed by the over-application check; nothing is left to assign.
  if (!payment || isVoidStatus(payment.status, VOID_PAYMENT_STATUSES)) return { workItemId: null, created: false };
  const applied = (await appliedByPayment(tx, [payment.zohoPaymentId])).get(payment.zohoPaymentId) ?? new Prisma.Decimal(0);
  const remaining = remainingToApply({ amount: D(payment.amount), applied });
  if (!remaining.greaterThan(MONEY_TOLERANCE)) return { workItemId: null, created: false };
  const currency = currencyOf(payment.currencyCode);
  const existing = await tx.workItem.findFirst({
    where: {
      objectType: FINANCE_OBJECT_TYPES.customerPayment,
      objectId: payment.zohoPaymentId,
      status: { in: [...WORK_ITEM_OPEN_STATUSES] },
      NOT: { title: { startsWith: OVERAPPLIED_WORK_ITEM_PREFIX } },
    },
    select: { id: true },
  });
  const workItemId = existing
    ? existing.id
    : (
        await ctx.createWorkItem({
          areaKey: FINANCE_AREA_KEY,
          kind: 'action',
          title: `Asignar cobro ${payment.paymentNumber ?? payment.zohoPaymentId}${payment.customerName ? ` de ${payment.customerName}` : ''}`.slice(0, 200),
          description: `${formatMxn(remaining, currency)} sin asignar: se revirtió su aplicación a ${input.obligationNumber} (${input.reason}). El conciliador no lo vuelve a aplicar mientras esta tarea siga abierta.`.slice(0, 1000),
          objectType: FINANCE_OBJECT_TYPES.customerPayment,
          objectId: payment.zohoPaymentId,
        })
      ).id;
  ctx.emit(
    FINANCE_EVENTS.collection.held,
    {
      zohoPaymentId: payment.zohoPaymentId,
      paymentNumber: payment.paymentNumber,
      remaining: remaining.toFixed(2),
      currency,
      obligationNumber: input.obligationNumber,
      reason: input.reason.slice(0, 500),
      workItemId,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.customerPayment, payment.zohoPaymentId)
  );
  publishBoard(ctx, 'finance.collection', { zohoPaymentId: payment.zohoPaymentId, workItemId });
  return { workItemId, created: !existing };
}

export const flagOverappliedSchema = z.object({ zohoPaymentId: idSchema });

export interface FlagOverappliedResult {
  workItemId: string | null;
  created: boolean;
  issue: OverapplicationIssue | null;
}

const OVERAPPLIED_LABELS: Record<OverapplicationIssue, string> = {
  void: 'anulado en Zoho',
  missing: 'que ya no aparece en Zoho',
  over_applied: 'reducido en Zoho',
};

/** Opens (once) "Revisar cobro …" for a payment whose active settlements exceed what Zoho still holds. */
export async function flagOverappliedPaymentInTx(
  tx: Db,
  input: z.output<typeof flagOverappliedSchema>,
  ctx: CommandContext
): Promise<FlagOverappliedResult> {
  await lockAdvisoryKeys(tx, [paymentLockKey(input.zohoPaymentId)]);
  const applied = (await appliedByPayment(tx, [input.zohoPaymentId])).get(input.zohoPaymentId) ?? new Prisma.Decimal(0);
  const payment = await tx.customerPayment.findUnique({ where: { zohoPaymentId: input.zohoPaymentId } });
  const issue = overapplicationIssue(payment ? { amount: payment.amount, status: payment.status } : null, applied);
  if (!issue) return { workItemId: null, created: false, issue: null };
  const existing = await tx.workItem.findFirst({
    where: {
      objectType: FINANCE_OBJECT_TYPES.customerPayment,
      objectId: input.zohoPaymentId,
      status: { in: [...WORK_ITEM_OPEN_STATUSES] },
      title: { startsWith: OVERAPPLIED_WORK_ITEM_PREFIX },
    },
    select: { id: true },
  });
  if (existing) return { workItemId: existing.id, created: false, issue };
  const currency = currencyOf(payment?.currencyCode);
  const label = payment?.paymentNumber ?? input.zohoPaymentId;
  const amountText = payment?.amount === null || payment?.amount === undefined ? null : formatMxn(payment.amount, currency);
  const state =
    issue === 'void'
      ? 'el pago está anulado en Zoho'
      : issue === 'missing'
        ? 'el pago ya no aparece en la sincronización de Zoho'
        : `el pago ahora es de ${amountText}`;
  const item = await ctx.createWorkItem({
    areaKey: FINANCE_AREA_KEY,
    kind: 'action',
    title: `${OVERAPPLIED_WORK_ITEM_PREFIX} ${OVERAPPLIED_LABELS[issue]}: ${label}${payment?.customerName ? ` de ${payment.customerName}` : ''}`.slice(0, 200),
    description: `UNIK aplicó ${formatMxn(applied, currency)} y ${state}. Reversa las liquidaciones que sobran (el banco quedó inflado) o confirma el cobro con el cliente.`.slice(0, 1000),
    objectType: FINANCE_OBJECT_TYPES.customerPayment,
    objectId: input.zohoPaymentId,
  });
  ctx.emit(
    FINANCE_EVENTS.collection.overapplied,
    {
      zohoPaymentId: input.zohoPaymentId,
      paymentNumber: payment?.paymentNumber ?? null,
      issue,
      applied: roundMoney(applied).toFixed(2),
      amount: payment?.amount === null || payment?.amount === undefined ? null : roundMoney(D(payment.amount)).toFixed(2),
      workItemId: item.id,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.customerPayment, input.zohoPaymentId)
  );
  publishBoard(ctx, 'finance.collection', { zohoPaymentId: input.zohoPaymentId, workItemId: item.id, issue });
  return { workItemId: item.id, created: true, issue };
}

export const cancelVoidedSchema = z.object({ zohoSalesOrderId: idSchema });

/** A sales order voided in Zoho: its open receivables are cancelled by reversal (or flagged when money was applied). */
export async function cancelVoidedReceivablesInTx(
  tx: Db,
  input: z.output<typeof cancelVoidedSchema>,
  ctx: CommandContext
): Promise<{ cancelled: string[]; flagged: string[] }> {
  const order = await tx.salesOrder.findUnique({
    where: { zohoSalesOrderId: input.zohoSalesOrderId },
    select: { status: true, salesOrderNumber: true },
  });
  if (!order || !isVoidStatus(order.status, VOID_ORDER_STATUSES)) return { cancelled: [], flagged: [] };
  const obligations = await tx.obligation.findMany({
    where: { kind: 'receivable', zohoSalesOrderId: input.zohoSalesOrderId, status: { in: [...OBLIGATION_OPEN_STATUSES] } },
  });
  const cancelled: string[] = [];
  const flagged: string[] = [];
  for (const obligation of obligations) {
    if (D(obligation.settledAmount).greaterThan(MONEY_TOLERANCE)) {
      const open = await tx.workItem.findFirst({
        where: { objectType: FINANCE_OBJECT_TYPES.obligation, objectId: obligation.id, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
        select: { id: true },
      });
      if (!open) {
        await ctx.createWorkItem({
          areaKey: FINANCE_AREA_KEY,
          kind: 'action',
          title: `Orden anulada con cobro: ${obligation.number}`,
          description: `La orden ${order.salesOrderNumber ?? input.zohoSalesOrderId} se anuló en Zoho y ya tiene ${formatMxn(obligation.settledAmount, obligation.currency)} cobrados. Decide la devolución o reasigna el pago.`,
          caseId: obligation.caseId,
          objectType: FINANCE_OBJECT_TYPES.obligation,
          objectId: obligation.id,
        });
      }
      flagged.push(obligation.id);
      continue;
    }
    await cancelObligation(tx, obligation.id, `Orden ${order.salesOrderNumber ?? input.zohoSalesOrderId} anulada en Zoho`, ctx);
    cancelled.push(obligation.id);
  }
  return { cancelled, flagged };
}

// ---------------------------------------------------------------------------
// Reconciler (job finance.reconcile_collections)
// ---------------------------------------------------------------------------

function allocationDigest(outcome: Extract<MatchOutcome, { allocations: unknown }>): string {
  const material = outcome.allocations.map((a) => `${a.obligationId}=${a.amount.toFixed(2)}`).join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 24);
}

export interface ReconcileSummary {
  payments: number;
  matched: number;
  flagged: number;
  settlements: number;
  voidedOrders: number;
  expectedCases: number;
  /** Payments skipped because a person reversed an application and has not reassigned them yet. */
  held: number;
  /** Payments voided, missing or reduced in Zoho with active settlements (review work item opened). */
  overapplied: number;
  errors: number;
}

export async function reconcileCollections(options: { now?: Date; limit?: number } = {}): Promise<ReconcileSummary> {
  const now = options.now ?? new Date();
  const todayKey = localDateKey(now);
  const settings = await getFinanceSettings();
  const config = await getOperationsConfig();
  const cutoverKey = localDateKey(new Date(config.cutoverDate));
  const lookbackKey = addDaysToKey(todayKey, -settings.reconcileLookbackDays);
  const fromKey = compareKeys(cutoverKey, lookbackKey) > 0 ? cutoverKey : lookbackKey;
  const summary: ReconcileSummary = {
    payments: 0,
    matched: 0,
    flagged: 0,
    settlements: 0,
    voidedOrders: 0,
    expectedCases: 0,
    held: 0,
    overapplied: 0,
    errors: 0,
  };
  const log = (event: string, extra: Record<string, unknown>) =>
    console.info(JSON.stringify({ component: 'finance-collections', event, ...extra }));

  // 1. Cases that started without their expected receivable (listener missed).
  const recentCases = await prisma.operationalCase.findMany({
    where: { openedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) }, zohoSalesOrderId: { not: null } },
    select: { id: true, zohoSalesOrderId: true },
    take: 500,
  });
  const expectedOrders = new Set(
    (
      await prisma.obligation.findMany({
        where: { kind: 'receivable', zohoSalesOrderId: { in: recentCases.map((c) => c.zohoSalesOrderId as string) } },
        select: { zohoSalesOrderId: true },
      })
    ).map((o) => o.zohoSalesOrderId)
  );
  for (const operationalCase of recentCases) {
    if (expectedOrders.has(operationalCase.zohoSalesOrderId)) continue;
    const result = await runFinanceSystemCommand<ExpectCaseResult>(
      {
        commandId: `finance:expect_case:${operationalCase.id}`,
        type: FINANCE_COMMANDS.collectionExpectCase,
        aggregate: { type: 'operational_case', id: operationalCase.id },
        payload: { caseId: operationalCase.id },
      },
      { now }
    ).catch((err) => {
      summary.errors += 1;
      log('expect_case_failed', { caseId: operationalCase.id, message: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (result?.data?.created) summary.expectedCases += 1;
  }

  // 2. Receivables of orders voided in Zoho.
  const openWithOrder = await prisma.obligation.findMany({
    where: { kind: 'receivable', status: { in: [...OBLIGATION_OPEN_STATUSES] }, zohoSalesOrderId: { not: null } },
    select: { zohoSalesOrderId: true },
    take: 2000,
  });
  const orderIds = [...new Set(openWithOrder.map((o) => o.zohoSalesOrderId as string))];
  if (orderIds.length > 0) {
    const voided = await prisma.salesOrder.findMany({
      where: { zohoSalesOrderId: { in: orderIds }, status: { in: VOID_ORDER_STATUSES } },
      select: { zohoSalesOrderId: true },
    });
    for (const order of voided) {
      const result = await runFinanceSystemCommand(
        {
          commandId: `finance:voided:${order.zohoSalesOrderId}:${todayKey}`,
          type: FINANCE_COMMANDS.collectionCancelVoided,
          aggregate: { type: 'sales_order', id: order.zohoSalesOrderId },
          payload: { zohoSalesOrderId: order.zohoSalesOrderId },
        },
        { now }
      ).catch((err) => {
        summary.errors += 1;
        log('voided_failed', { zohoSalesOrderId: order.zohoSalesOrderId, message: err instanceof Error ? err.message : String(err) });
        return null;
      });
      if (result && result.status !== 'rejected') summary.voidedOrders += 1;
    }
  }

  // 3. Payments with an unapplied remainder.
  const pending = await listUnmatchedPayments(prisma, { fromKey, limit: options.limit ?? 200 });
  for (const row of pending) {
    // A person reversed an application of this payment and has not reassigned it yet.
    if (row.openWorkItemId && row.reversedObligationIds.length > 0) {
      summary.held += 1;
      continue;
    }
    summary.payments += 1;
    try {
      const salesOrderIds = await invoiceSalesOrderIdsForPayment(prisma, row.zohoPaymentId);
      const candidates = (
        await receivableCandidates(prisma, {
          zohoCustomerId: row.zohoCustomerId,
          salesOrderIds,
          currency: row.currency,
        })
      ).filter((candidate) => !row.reversedObligationIds.includes(candidate.obligationId));
      const outcome = matchPayment(
        {
          zohoPaymentId: row.zohoPaymentId,
          amount: row.amount,
          applied: row.applied,
          currency: row.currency,
          zohoCustomerId: row.zohoCustomerId,
          invoiceSalesOrderIds: salesOrderIds,
        },
        candidates
      );
      if (outcome.status === 'nothing_to_apply') continue;
      if ((outcome.status === 'matched' || outcome.status === 'ambiguous') && outcome.allocations.length > 0) {
        const applied = await runFinanceSystemCommand<ApplyPaymentResult>(
          {
            commandId: `finance:collect:${row.zohoPaymentId}:${row.settlementRows}:${allocationDigest(outcome)}`,
            type: FINANCE_COMMANDS.collectionApplyPayment,
            aggregate: { type: FINANCE_OBJECT_TYPES.customerPayment, id: row.zohoPaymentId },
            payload: {
              zohoPaymentId: row.zohoPaymentId,
              allocations: outcome.allocations.map((a) => ({ obligationId: a.obligationId, amount: a.amount.toFixed(2) })),
              rule: outcome.status === 'matched' ? outcome.rule : 'partial',
            },
          },
          { now }
        );
        if (applied.status === 'rejected') {
          log('apply_rejected', { zohoPaymentId: row.zohoPaymentId, errorCode: applied.errorCode, message: applied.message });
        } else {
          summary.settlements += applied.data?.applied.length ?? 0;
          if (outcome.status === 'matched') summary.matched += 1;
        }
      }
      if (outcome.status === 'ambiguous' || outcome.status === 'unmatched') {
        const flagged = await runFinanceSystemCommand(
          {
            commandId: `finance:flag:${row.zohoPaymentId}:${row.settlementRows}:${outcome.remainder.toFixed(2)}`,
            type: FINANCE_COMMANDS.collectionFlagPayment,
            aggregate: { type: FINANCE_OBJECT_TYPES.customerPayment, id: row.zohoPaymentId },
            payload: { zohoPaymentId: row.zohoPaymentId, reason: outcome.reason },
          },
          { now }
        );
        if (flagged.status !== 'rejected') summary.flagged += 1;
      }
    } catch (err) {
      summary.errors += 1;
      log('payment_failed', { zohoPaymentId: row.zohoPaymentId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  // 4. The other direction: payments voided, missing or reduced in Zoho after being applied.
  const overapplied = await listOverappliedPayments(prisma, { limit: options.limit ?? 200 });
  for (const row of overapplied) {
    if (row.openWorkItemId) continue;
    const flagged = await runFinanceSystemCommand<FlagOverappliedResult>(
      {
        commandId: `finance:overapplied:${row.zohoPaymentId}:${row.settlementRows}:${row.issue}`,
        type: FINANCE_COMMANDS.collectionFlagOverapplied,
        aggregate: { type: FINANCE_OBJECT_TYPES.customerPayment, id: row.zohoPaymentId },
        payload: { zohoPaymentId: row.zohoPaymentId },
      },
      { now }
    ).catch((err) => {
      summary.errors += 1;
      log('overapplied_failed', { zohoPaymentId: row.zohoPaymentId, message: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (flagged && flagged.status !== 'rejected' && flagged.data?.created) summary.overapplied += 1;
  }

  log('reconciled', { ...summary, fromKey });
  return summary;
}
