import { Prisma } from '@prisma/client';
import type { DifferenceKind, PaymentMode, PaymentStatus } from './purchases-types';

/**
 * State rules of procurement orders and goods receipts (plan 6.1,
 * `orders-state.ts`).
 *
 * draft → pending_approval → approved ─┬─ (prepaid, unpaid, sent) → pending_payment → (paid) ─┐
 *        ↑ (rejected)                  └─ (sent) ──────────────────────────────────────────────┴→ awaiting_receipt
 * awaiting_receipt → partially_received → received → closed
 * any receipt with an open difference → disputed (until Compras resolves it)
 * cancel: before any receipt (compensations in the service); close: received, or
 * partially received accepting the shortage.
 *
 * Material that is only expected is never available: none of these states
 * touches the inventory; only a posted receipt does.
 *
 * Pure module.
 */

export const ORDER_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'pending_payment',
  'awaiting_receipt',
  'partially_received',
  'received',
  'closed',
  'cancelled',
  'disputed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: 'Borrador',
  pending_approval: 'Por aprobar',
  approved: 'Aprobada',
  pending_payment: 'Pendiente de pago',
  awaiting_receipt: 'Esperando material',
  partially_received: 'Recibida parcialmente',
  received: 'Recibida',
  closed: 'Cerrada',
  cancelled: 'Cancelada',
  disputed: 'Con diferencias',
};

export const ORDER_OPEN_STATUSES = ORDER_STATUSES.filter((s) => s !== 'closed' && s !== 'cancelled');
export const ORDER_CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  'draft',
  'pending_approval',
  'approved',
  'pending_payment',
  'awaiting_receipt',
];
export const ORDER_SENDABLE_STATUSES: readonly OrderStatus[] = [
  'approved',
  'pending_payment',
  'awaiting_receipt',
  'partially_received',
];
export const ORDER_RECEIVABLE_STATUSES: readonly OrderStatus[] = [
  'approved',
  'pending_payment',
  'awaiting_receipt',
  'partially_received',
  'disputed',
];
export const ORDER_PAYABLE_STATUSES: readonly OrderStatus[] = [
  'approved',
  'pending_payment',
  'awaiting_receipt',
  'partially_received',
  'received',
  'disputed',
];
export const ORDER_CLOSABLE_STATUSES: readonly OrderStatus[] = ['received', 'partially_received', 'disputed'];
/** Orders whose supplier is committed to deliver (the allocation shows the expected date, never stock). */
export const ORDER_COMMITTED_STATUSES: readonly OrderStatus[] = [
  'approved',
  'pending_payment',
  'awaiting_receipt',
  'partially_received',
  'disputed',
];

export const QTY_EPS = 0.00005;
const MONEY_EPS = 0.005;

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function orderStatusLabel(status: string): string {
  return isOrderStatus(status) ? ORDER_STATUS_LABELS[status] : status;
}

export type OrderCheck = { ok: true } | { ok: false; code: string; message: string };

const ok: OrderCheck = { ok: true };
const fail = (code: string, message: string): OrderCheck => ({ ok: false, code, message });

function inList(status: string, list: readonly string[]): boolean {
  return list.includes(status);
}

export function checkEditOrder(status: string): OrderCheck {
  return status === 'draft'
    ? ok
    : fail('invalid_state', `Sólo se edita una orden en borrador (está ${orderStatusLabel(status).toLowerCase()})`);
}

export function checkSubmitOrder(input: { status: string; lineCount: number; total: Prisma.Decimal.Value }): OrderCheck {
  if (input.status !== 'draft') {
    return fail('invalid_state', `La orden ya fue enviada a aprobación (${orderStatusLabel(input.status).toLowerCase()})`);
  }
  if (input.lineCount === 0) return fail('invalid_payload', 'La orden no tiene partidas');
  if (new Prisma.Decimal(input.total).lte(0)) return fail('invalid_payload', 'El total de la orden debe ser mayor que cero');
  return ok;
}

export function checkCancelOrder(input: { status: string; postedReceipts: number }): OrderCheck {
  if (input.status === 'cancelled') return fail('invalid_state', 'La orden ya está cancelada');
  if (input.postedReceipts > 0) {
    return fail('invalid_state', 'La orden ya tiene material recibido: ciérrala aceptando el faltante en lugar de cancelarla');
  }
  if (!inList(input.status, ORDER_CANCELLABLE_STATUSES)) {
    return fail('invalid_state', `No se puede cancelar una orden ${orderStatusLabel(input.status).toLowerCase()}`);
  }
  return ok;
}

export function checkRequestPayment(input: {
  status: string;
  paymentStatus: string;
  obligationId: string | null;
}): OrderCheck {
  if (!inList(input.status, ORDER_PAYABLE_STATUSES)) {
    return fail('invalid_state', `No se puede solicitar el pago de una orden ${orderStatusLabel(input.status).toLowerCase()}`);
  }
  if (input.paymentStatus === 'paid') return fail('invalid_state', 'La orden ya está pagada');
  if (input.obligationId) return fail('duplicate', 'El pago de esta orden ya fue solicitado');
  return ok;
}

export function checkSendOrder(status: string): OrderCheck {
  return inList(status, ORDER_SENDABLE_STATUSES)
    ? ok
    : fail('invalid_state', `Sólo se envía al proveedor una orden aprobada (está ${orderStatusLabel(status).toLowerCase()})`);
}

export function checkReceiveOrder(input: {
  status: string;
  deliveryMode: string;
  mode: 'warehouse' | 'direct_delivery';
}): OrderCheck {
  if (!inList(input.status, ORDER_RECEIVABLE_STATUSES)) {
    return fail('invalid_state', `No se puede recibir material de una orden ${orderStatusLabel(input.status).toLowerCase()}`);
  }
  if (input.mode === 'warehouse' && input.deliveryMode === 'direct_to_customer') {
    return fail('invalid_state', 'Esta orden la entrega el proveedor directo al cliente: confirma la entrega directa');
  }
  if (input.mode === 'direct_delivery' && input.deliveryMode !== 'direct_to_customer') {
    return fail('invalid_state', 'Esta orden se recibe en bodega, no es una entrega directa');
  }
  return ok;
}

export function checkCloseOrder(input: {
  status: string;
  openDifferences: number;
  pendingQty: number;
  acceptShortages: boolean;
  paymentStatus: string;
  obligationId: string | null;
}): OrderCheck {
  if (!inList(input.status, ORDER_CLOSABLE_STATUSES)) {
    return fail('invalid_state', `No se puede cerrar una orden ${orderStatusLabel(input.status).toLowerCase()}`);
  }
  if (input.openDifferences > 0) {
    return fail('invalid_state', 'Resuelve primero las diferencias de recepción de la orden');
  }
  if (input.pendingQty > QTY_EPS && !input.acceptShortages) {
    return fail('invalid_state', 'Aún falta material por recibir: confirma que aceptas el faltante para cerrarla');
  }
  if (input.paymentStatus !== 'paid' && !input.obligationId) {
    return fail('invalid_state', 'Solicita el pago de la orden (obligación por pagar) antes de cerrarla');
  }
  return ok;
}

/** Status after the business approval decision; null when the order no longer waits for it. */
export function statusAfterApprovalDecision(status: string, decision: 'approved' | 'rejected'): OrderStatus | null {
  if (status !== 'pending_approval') return null;
  return decision === 'approved' ? 'approved' : 'draft';
}

/** Prepaid orders wait for the payment; credit/cod orders keep their status (the payable is registered). */
export function statusAfterPaymentRequest(status: OrderStatus, paymentMode: PaymentMode | string): OrderStatus {
  return paymentMode === 'prepaid' && status === 'approved' ? 'pending_payment' : status;
}

export function statusAfterSend(
  status: OrderStatus,
  paymentMode: PaymentMode | string,
  paymentStatus: PaymentStatus | string
): OrderStatus {
  if (status !== 'approved') return status;
  return paymentMode === 'prepaid' && paymentStatus !== 'paid' ? 'pending_payment' : 'awaiting_receipt';
}

export function statusAfterPaid(status: OrderStatus, sentToSupplier: boolean): OrderStatus {
  if (status !== 'pending_payment') return status;
  return sentToSupplier ? 'awaiting_receipt' : 'approved';
}

/**
 * After a payment of the order is reversed in finance: a prepaid order that
 * was not sent yet waits for its payment again; otherwise the status stays
 * (an order already sent or received cannot be undone by a payment reversal).
 */
export function statusAfterPaymentReversed(
  status: OrderStatus,
  paymentMode: PaymentMode | string,
  sentToSupplier: boolean
): OrderStatus {
  if (paymentMode === 'prepaid' && status === 'approved' && !sentToSupplier) return 'pending_payment';
  return status;
}

export function paymentStatusFor(expected: Prisma.Decimal.Value, settled: Prisma.Decimal.Value): PaymentStatus {
  const exp = new Prisma.Decimal(expected);
  const set = new Prisma.Decimal(settled);
  if (exp.gt(0) && set.plus(MONEY_EPS).gte(exp)) return 'paid';
  if (set.gt(0)) return 'partial';
  return 'unpaid';
}

export interface OrderLineQuantities {
  qty: number;
  qtyReceived: number;
  status: string;
}

export function lineStatusAfterReceipt(qty: number, qtyReceived: number, current: string): string {
  if (current === 'cancelled' || current === 'closed') return current;
  if (qtyReceived + QTY_EPS >= qty) return 'received';
  if (qtyReceived > QTY_EPS) return 'partial';
  return 'open';
}

/** Order status after receipts: disputed with open differences, received when every live line is in. */
export function statusAfterReceipt(
  current: OrderStatus,
  lines: readonly OrderLineQuantities[],
  openDifferences: number
): OrderStatus {
  if (current === 'cancelled' || current === 'closed') return current;
  if (openDifferences > 0) return 'disputed';
  const live = lines.filter((line) => line.status !== 'cancelled');
  if (live.length === 0) return current;
  const done = live.every((line) => line.status === 'closed' || line.qtyReceived + QTY_EPS >= line.qty);
  if (done) return 'received';
  if (live.some((line) => line.qtyReceived > QTY_EPS)) return 'partially_received';
  return current === 'disputed' ? 'awaiting_receipt' : current;
}

export function pendingQuantity(lines: readonly OrderLineQuantities[]): number {
  return lines
    .filter((line) => line.status !== 'cancelled' && line.status !== 'closed')
    .reduce((sum, line) => sum + Math.max(0, line.qty - line.qtyReceived), 0);
}

export interface TotalsLineInput {
  qty: Prisma.Decimal.Value;
  unitPrice: Prisma.Decimal.Value;
  taxRate?: Prisma.Decimal.Value | null;
}

export interface OrderTotals {
  lineTotals: Prisma.Decimal[];
  subtotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  freight: Prisma.Decimal;
  total: Prisma.Decimal;
}

/** Line total = qty × price; tax per line; freight without tax (as quoted); 4 decimals. */
export function computeOrderTotals(lines: readonly TotalsLineInput[], freight: Prisma.Decimal.Value = 0): OrderTotals {
  let subtotal = new Prisma.Decimal(0);
  let taxTotal = new Prisma.Decimal(0);
  const lineTotals = lines.map((line) => {
    const total = new Prisma.Decimal(line.qty).times(line.unitPrice).toDecimalPlaces(4);
    subtotal = subtotal.plus(total);
    if (line.taxRate !== null && line.taxRate !== undefined) {
      taxTotal = taxTotal.plus(total.times(line.taxRate));
    }
    return total;
  });
  const freightValue = Prisma.Decimal.max(new Prisma.Decimal(freight), 0).toDecimalPlaces(4);
  subtotal = subtotal.toDecimalPlaces(4);
  taxTotal = taxTotal.toDecimalPlaces(4);
  return { lineTotals, subtotal, taxTotal, freight: freightValue, total: subtotal.plus(taxTotal).plus(freightValue) };
}

export interface ReceiptLineInput {
  ordered: number;
  receivedBefore: number;
  received: number;
  accepted?: number | null;
  rejected?: number | null;
  declared?: DifferenceKind | null;
}

export type ReceiptLineClassification =
  | { ok: true; accepted: number; rejected: number; differenceKind: DifferenceKind; overQty: number }
  | { ok: false; code: string; message: string };

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Accepted/rejected split and the difference of a received line:
 * wrong item (declared) > damaged (rejected quantity) > over (beyond the order) >
 * short (declared: the supplier will not send the rest). A partial receipt
 * without declaration is not a difference: the rest is still expected.
 */
export function classifyReceiptLine(input: ReceiptLineInput): ReceiptLineClassification {
  const received = Number(input.received);
  if (!Number.isFinite(received) || received < 0) {
    return { ok: false, code: 'invalid_quantity', message: 'La cantidad recibida no puede ser negativa' };
  }
  const rejected = input.rejected === null || input.rejected === undefined ? 0 : Number(input.rejected);
  if (!Number.isFinite(rejected) || rejected < 0) {
    return { ok: false, code: 'invalid_quantity', message: 'La cantidad rechazada no puede ser negativa' };
  }
  const accepted =
    input.accepted === null || input.accepted === undefined ? received - rejected : Number(input.accepted);
  if (!Number.isFinite(accepted) || accepted < -QTY_EPS) {
    return { ok: false, code: 'invalid_quantity', message: 'La cantidad aceptada no puede ser negativa ni mayor que la recibida' };
  }
  if (Math.abs(accepted + rejected - received) > QTY_EPS) {
    return {
      ok: false,
      code: 'invalid_quantity',
      message: 'Lo aceptado más lo rechazado debe sumar lo recibido',
    };
  }
  const declared = input.declared && input.declared !== 'none' ? input.declared : null;
  const overQty = Math.max(0, round4(input.receivedBefore + received - input.ordered));
  let differenceKind: DifferenceKind = 'none';
  if (declared === 'wrong_item') differenceKind = 'wrong_item';
  else if (declared === 'damaged' || rejected > QTY_EPS) differenceKind = 'damaged';
  else if (declared === 'over' || overQty > QTY_EPS) differenceKind = 'over';
  else if (declared === 'short') differenceKind = 'short';
  if (received <= QTY_EPS && differenceKind === 'none' && declared !== 'short') {
    return { ok: false, code: 'nothing_received', message: 'Indica una cantidad recibida o declara el faltante' };
  }
  return { ok: true, accepted: round4(Math.max(0, accepted)), rejected: round4(rejected), differenceKind, overQty };
}

/**
 * Base quantity a received order line may still reserve for one demand
 * allocation: its unmet need, bounded by what this line promised to that
 * allocation minus what earlier receipts of the same line already reserved
 * for it. Without the second bound, a second partial receipt would give an
 * allocation with several sources the share promised to another sale.
 */
export function receiptReservationCap(input: { need: number; promised: number; suppliedByLine: number }): number {
  const cap = Math.min(input.need, input.promised - Math.max(0, input.suppliedByLine));
  return cap > QTY_EPS ? round4(cap) : 0;
}

export interface FifoCap {
  id: string;
  cap: number;
}

/** Splits `total` over caps in order; returns only positive shares and the undistributed rest. */
export function distributeFifo(total: number, caps: readonly FifoCap[]): { shares: Array<{ id: string; qty: number }>; rest: number } {
  let remaining = Math.max(0, total);
  const shares: Array<{ id: string; qty: number }> = [];
  for (const entry of caps) {
    if (remaining <= QTY_EPS) break;
    const cap = Math.max(0, entry.cap);
    if (cap <= QTY_EPS) continue;
    const qty = round4(Math.min(cap, remaining));
    if (qty <= QTY_EPS) continue;
    shares.push({ id: entry.id, qty });
    remaining = round4(remaining - qty);
  }
  return { shares, rest: Math.max(0, round4(remaining)) };
}
