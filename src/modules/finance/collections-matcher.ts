import { Prisma } from '@prisma/client';
import { compareKeys } from './finance-dates';
import { D, MONEY_TOLERANCE, formatMxn, minMoney, roundMoney, sumMoney, type Money } from './money';

/**
 * Pure matcher of synced Zoho customer payments against expected receivables
 * (plan 6.4 "ingreso esperado vs cobro real").
 *
 * Only the unapplied remainder of a payment is matched
 * (amount − Σ settlements already carrying that `zohoPaymentId`), so one
 * payment can be spread over several obligations and a re-run never applies
 * it twice. Rules, in order:
 *
 * 1. Invoice link: when the payment's invoices point to sales orders, the open
 *    receivables of those orders take it FIFO. An excess, or invoices whose
 *    orders have nothing pending, is ambiguous.
 * 2. Without a customer the payment cannot be matched.
 * 3. Exactly one open receivable of the customer with the same balance takes
 *    it; several with that balance are ambiguous.
 * 4. FIFO over the customer's open receivables (due date, then creation). An
 *    excess over everything pending is applied and the remainder is ambiguous.
 *
 * Ambiguous and unmatched remainders become the work item "Asignar cobro".
 */

export interface PaymentToMatch {
  zohoPaymentId: string;
  amount: Prisma.Decimal.Value;
  /** Σ of the settlements already carrying this payment (reversals included as negatives). */
  applied: Prisma.Decimal.Value;
  currency: string;
  zohoCustomerId: string | null;
  /** Sales orders of the invoices this payment was applied to in Zoho. */
  invoiceSalesOrderIds: readonly string[];
}

export interface ReceivableCandidate {
  obligationId: string;
  number: string;
  zohoContactId: string | null;
  zohoSalesOrderId: string | null;
  currency: string;
  remaining: Prisma.Decimal.Value;
  /** Due date key (expected cash date when present), null when undated. */
  dueKey: string | null;
  createdAt: Date;
}

export interface PaymentAllocation {
  obligationId: string;
  amount: Money;
}

export type MatchRule = 'invoice' | 'exact_amount' | 'fifo';

export type MatchOutcome =
  | { status: 'nothing_to_apply'; remaining: Money }
  | { status: 'matched'; rule: MatchRule; allocations: PaymentAllocation[]; remainder: Money }
  | { status: 'ambiguous'; reason: string; allocations: PaymentAllocation[]; remainder: Money }
  | { status: 'unmatched'; reason: string; remainder: Money };

export function remainingToApply(payment: Pick<PaymentToMatch, 'amount' | 'applied'>): Money {
  return roundMoney(D(payment.amount).minus(D(payment.applied)));
}

export function orderFifo<T extends Pick<ReceivableCandidate, 'dueKey' | 'createdAt' | 'number'>>(
  candidates: readonly T[]
): T[] {
  return [...candidates].sort((a, b) => {
    if (a.dueKey !== b.dueKey) {
      if (a.dueKey === null) return 1;
      if (b.dueKey === null) return -1;
      return compareKeys(a.dueKey, b.dueKey);
    }
    return a.createdAt.getTime() - b.createdAt.getTime() || a.number.localeCompare(b.number);
  });
}

function allocateFifo(
  amount: Money,
  candidates: readonly ReceivableCandidate[]
): { allocations: PaymentAllocation[]; remainder: Money } {
  let left = amount;
  const allocations: PaymentAllocation[] = [];
  for (const candidate of orderFifo(candidates)) {
    if (!left.greaterThan(MONEY_TOLERANCE)) break;
    const take = roundMoney(minMoney(left, D(candidate.remaining)));
    if (!take.greaterThan(0)) continue;
    allocations.push({ obligationId: candidate.obligationId, amount: take });
    left = roundMoney(left.minus(take));
  }
  return { allocations, remainder: left.greaterThan(MONEY_TOLERANCE) ? left : new Prisma.Decimal(0) };
}

export function matchPayment(
  payment: PaymentToMatch,
  candidates: readonly ReceivableCandidate[]
): MatchOutcome {
  const remaining = remainingToApply(payment);
  if (!remaining.greaterThan(MONEY_TOLERANCE)) return { status: 'nothing_to_apply', remaining };

  const open = candidates.filter(
    (c) => c.currency === payment.currency && D(c.remaining).greaterThan(MONEY_TOLERANCE)
  );
  const customerMatches = (c: ReceivableCandidate) =>
    !payment.zohoCustomerId || !c.zohoContactId || c.zohoContactId === payment.zohoCustomerId;

  // 1. Invoice link
  const linkedOrders = new Set(payment.invoiceSalesOrderIds.filter(Boolean));
  if (linkedOrders.size > 0) {
    const linked = open.filter(
      (c) => c.zohoSalesOrderId !== null && linkedOrders.has(c.zohoSalesOrderId) && customerMatches(c)
    );
    if (linked.length === 0) {
      return {
        status: 'ambiguous',
        reason: 'Las facturas del pago corresponden a órdenes sin cobro pendiente',
        allocations: [],
        remainder: remaining,
      };
    }
    const { allocations, remainder } = allocateFifo(remaining, linked);
    if (remainder.greaterThan(0)) {
      return {
        status: 'ambiguous',
        reason: `El pago excede en ${formatMxn(remainder, payment.currency)} lo pendiente de sus órdenes`,
        allocations,
        remainder,
      };
    }
    return { status: 'matched', rule: 'invoice', allocations, remainder };
  }

  // 2. Customer
  if (!payment.zohoCustomerId) {
    return { status: 'unmatched', reason: 'El pago no tiene cliente en Zoho', remainder: remaining };
  }
  const ofCustomer = open.filter((c) => c.zohoContactId === payment.zohoCustomerId);
  if (ofCustomer.length === 0) {
    return {
      status: 'unmatched',
      reason: 'El cliente no tiene cobros esperados pendientes',
      remainder: remaining,
    };
  }

  // 3. Exact balance
  const exact = ofCustomer.filter((c) => roundMoney(D(c.remaining)).minus(remaining).abs().lessThanOrEqualTo(MONEY_TOLERANCE));
  if (exact.length === 1) {
    return {
      status: 'matched',
      rule: 'exact_amount',
      allocations: [{ obligationId: exact[0].obligationId, amount: remaining }],
      remainder: new Prisma.Decimal(0),
    };
  }
  if (exact.length > 1) {
    return {
      status: 'ambiguous',
      reason: `${exact.length} órdenes del cliente tienen el mismo saldo que el pago`,
      allocations: [],
      remainder: remaining,
    };
  }

  // 4. FIFO
  const totalOpen = roundMoney(sumMoney(ofCustomer.map((c) => c.remaining)));
  const { allocations, remainder } = allocateFifo(remaining, ofCustomer);
  if (remainder.greaterThan(0)) {
    return {
      status: 'ambiguous',
      reason: `El pago excede en ${formatMxn(remainder, payment.currency)} el saldo pendiente del cliente (${formatMxn(totalOpen, payment.currency)})`,
      allocations,
      remainder,
    };
  }
  return { status: 'matched', rule: 'fifo', allocations, remainder };
}

/**
 * Invoice references of a Zoho customer-payment payload: the detail form has
 * `invoices: [{invoice_id, invoice_number}]`, the list form `invoice_numbers`
 * ("INV-1, INV-2").
 */
export function extractInvoiceRefs(payload: unknown): { invoiceIds: string[]; invoiceNumbers: string[] } {
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const ids = new Set<string>();
  const numbers = new Set<string>();
  if (Array.isArray(record.invoices)) {
    for (const entry of record.invoices) {
      if (!entry || typeof entry !== 'object') continue;
      const invoice = entry as Record<string, unknown>;
      if (invoice.invoice_id !== undefined && invoice.invoice_id !== null && String(invoice.invoice_id).trim()) {
        ids.add(String(invoice.invoice_id).trim());
      }
      if (typeof invoice.invoice_number === 'string' && invoice.invoice_number.trim()) {
        numbers.add(invoice.invoice_number.trim());
      }
    }
  }
  if (typeof record.invoice_numbers === 'string') {
    for (const part of record.invoice_numbers.split(/[,;]/)) {
      if (part.trim()) numbers.add(part.trim());
    }
  }
  return { invoiceIds: [...ids], invoiceNumbers: [...numbers] };
}

/** Spanish issues of a manual assignment; empty when valid. */
export function manualAllocationIssues(
  payment: Pick<PaymentToMatch, 'amount' | 'applied' | 'currency'>,
  allocations: ReadonlyArray<{ obligationId: string; amount: Prisma.Decimal.Value }>,
  candidates: ReadonlyMap<string, Pick<ReceivableCandidate, 'number' | 'currency' | 'remaining'> & { kind?: string; status?: string }>
): string[] {
  const issues: string[] = [];
  if (allocations.length === 0) issues.push('Indica al menos una obligación');
  const seen = new Set<string>();
  for (const allocation of allocations) {
    const candidate = candidates.get(allocation.obligationId);
    if (seen.has(allocation.obligationId)) {
      issues.push('Una obligación aparece dos veces');
      continue;
    }
    seen.add(allocation.obligationId);
    if (!candidate) {
      issues.push('Una obligación no existe');
      continue;
    }
    if (candidate.kind && candidate.kind !== 'receivable') issues.push(`${candidate.number} no es una cuenta por cobrar`);
    if (candidate.currency !== payment.currency) issues.push(`${candidate.number} está en otra moneda`);
    const amount = roundMoney(D(allocation.amount));
    if (!amount.greaterThan(0)) issues.push(`El importe para ${candidate.number} debe ser mayor que cero`);
    if (amount.greaterThan(roundMoney(D(candidate.remaining)).plus(MONEY_TOLERANCE))) {
      issues.push(`El importe para ${candidate.number} excede su saldo pendiente`);
    }
  }
  const total = roundMoney(sumMoney(allocations.map((a) => D(a.amount))));
  if (total.greaterThan(remainingToApply(payment).plus(MONEY_TOLERANCE))) {
    issues.push('La asignación excede lo que queda por aplicar del pago');
  }
  return issues;
}

export type OverapplicationIssue = 'void' | 'missing' | 'over_applied';

/**
 * What is wrong with a Zoho payment whose settlements are still active
 * (`applied` > 0): voided or draft in Zoho, no longer synced, or reduced below
 * what UNIK applied. Null when it is fine.
 */
export function overapplicationIssue(
  payment: { amount: Prisma.Decimal.Value | null; status: string | null } | null,
  applied: Prisma.Decimal.Value
): OverapplicationIssue | null {
  const used = D(applied);
  if (!used.greaterThan(MONEY_TOLERANCE)) return null;
  if (!payment) return 'missing';
  const status = (payment.status ?? '').trim().toLowerCase();
  if (status === 'void' || status === 'draft') return 'void';
  const amount = payment.amount === null ? new Prisma.Decimal(0) : D(payment.amount);
  if (used.greaterThan(amount.plus(MONEY_TOLERANCE))) return 'over_applied';
  return null;
}
