import type { Obligation, ObligationSettlement, Prisma } from '@prisma/client';
import {
  cancelObligation,
  createObligation,
  onObligationSettled,
  onObligationSettlementReversed,
  requestPaymentAuthorizationInTx,
  type PaymentAuthorizationData,
} from '@/modules/finance/obligations-service';
import type { CommandContext } from '@/modules/operations/commands';

/**
 * The only door between Compras and the internal accounting (contract of
 * phase 4, `finance/obligations-service.ts`):
 *
 * - `createObligation(tx, input, ctx) → Obligation`: the payable of a
 *   procurement order (counterparty supplier, linked by `procurementOrderId`,
 *   so finance classifies its source as `procurement_order`; the category
 *   defaults to the supplier purchases category seeded by finance).
 * - `cancelObligation(tx, id, reason, ctx)`: reverse of an unpaid payable when
 *   the order is cancelled.
 * - `onObligationSettled('procurement_order', handler)`: finance calls
 *   `markOrderPaid` in the settlement transaction.
 * - `requestPaymentAuthorizationInTx(tx, {obligationId, areaRequestId}, ctx)`:
 *   the `payment` business approval (targetType `obligation`) that finance
 *   requires before it settles the payable of an order.
 * - `onObligationSettlementReversed('procurement_order', handler)`: a reversed
 *   payment recomputes the order's payment status.
 *
 * Kept in its own file so the purchases services and their tests do not load
 * the finance module (tests mock this bridge).
 */

export const PROCUREMENT_OBLIGATION_SOURCE = 'procurement_order';

export interface ProcurementPayableInput {
  orderId: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  zohoContactId: string | null;
  caseId: string | null;
  currency: string;
  /** Amount with two decimals. */
  amount: string;
  dueAt: Date;
}

/** `YYYY-MM-DD` of an instant in Mexico City (finance date keys). */
export function financeDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export async function createProcurementPayable(
  tx: Prisma.TransactionClient,
  input: ProcurementPayableInput,
  ctx: CommandContext
): Promise<Obligation> {
  return createObligation(
    tx,
    {
      kind: 'payable',
      counterpartyType: 'supplier',
      counterpartyName: input.supplierName.slice(0, 200),
      supplierId: input.supplierId,
      zohoContactId: input.zohoContactId,
      caseId: input.caseId,
      procurementOrderId: input.orderId,
      description: `Orden de compra ${input.orderNumber} · ${input.supplierName}`.slice(0, 500),
      currency: input.currency,
      expectedAmount: input.amount,
      dueAt: financeDateKey(input.dueAt),
      expectedCashAt: financeDateKey(input.dueAt),
    },
    ctx
  );
}

export async function cancelProcurementPayable(
  tx: Prisma.TransactionClient,
  obligationId: string,
  reason: string,
  ctx: CommandContext
): Promise<void> {
  await cancelObligation(tx, obligationId, reason, ctx);
}

export interface ProcurementPaymentAuthorizationInput {
  obligationId: string;
  /** `payment_authorization` request of the case (objectType `obligation`), when there is one. */
  areaRequestId: string | null;
  /** Human who asked for the payment when the command runs as the system (the order's buyer). */
  requestedByUserId: string | null;
  note: string | null;
}

export async function requestProcurementPaymentAuthorization(
  tx: Prisma.TransactionClient,
  input: ProcurementPaymentAuthorizationInput,
  ctx: CommandContext
): Promise<PaymentAuthorizationData> {
  return requestPaymentAuthorizationInTx(
    tx,
    { obligationId: input.obligationId, areaRequestId: input.areaRequestId ?? null, note: input.note ?? null },
    ctx,
    { requestedByUserId: input.requestedByUserId }
  );
}

export type ProcurementSettledHandler = (
  tx: Prisma.TransactionClient,
  obligation: Obligation,
  settlement: ObligationSettlement,
  ctx: CommandContext
) => Promise<void>;

export function registerProcurementSettlementHandler(handler: ProcurementSettledHandler): () => void {
  return onObligationSettled(PROCUREMENT_OBLIGATION_SOURCE, handler);
}

export function registerProcurementSettlementReversedHandler(handler: ProcurementSettledHandler): () => void {
  return onObligationSettlementReversed(PROCUREMENT_OBLIGATION_SOURCE, handler);
}
