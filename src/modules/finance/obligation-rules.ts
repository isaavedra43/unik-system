import { Prisma } from '@prisma/client';
import { financeError } from './finance-errors';
import { daysBetweenKeys, dateKeyOf } from './finance-dates';
import type { LedgerLineInput } from './ledger-rules';
import {
  D,
  MONEY_TOLERANCE,
  formatMxn,
  maxMoney,
  roundMoney,
  sumMoney,
  type Money,
} from './money';
import {
  OBLIGATION_OPEN_STATUSES,
  type ObligationKind,
  type ObligationSourceType,
  type ObligationStatus,
} from './types';

/**
 * Pure rules of payables and receivables: remaining balance and status after
 * settlements, the lines of the obligation / settlement / write-off entries,
 * aging buckets, payment authorization and the idempotency references of the
 * collections reconciler.
 */

export interface ObligationAmounts {
  expectedAmount: Prisma.Decimal.Value;
  settledAmount: Prisma.Decimal.Value;
}

export function remainingOf(obligation: ObligationAmounts): Money {
  return roundMoney(maxMoney(D(obligation.expectedAmount).minus(D(obligation.settledAmount)), 0));
}

export function isOpenObligationStatus(status: string): boolean {
  return (OBLIGATION_OPEN_STATUSES as readonly string[]).includes(status);
}

/** Status after a settlement change; cancelled and written-off obligations keep their status. */
export function nextObligationStatus(
  current: string,
  expectedAmount: Prisma.Decimal.Value,
  settledAmount: Prisma.Decimal.Value
): ObligationStatus {
  if (current === 'cancelled' || current === 'written_off') return current;
  const settled = D(settledAmount);
  if (settled.greaterThanOrEqualTo(D(expectedAmount).minus(MONEY_TOLERANCE))) return 'settled';
  if (settled.greaterThan(MONEY_TOLERANCE)) return 'partially_settled';
  return 'expected';
}

export function assertSettleable(
  obligation: ObligationAmounts & { status: string; currency: string; number?: string },
  amount: Money,
  currency?: string | null
): void {
  if (!isOpenObligationStatus(obligation.status)) {
    throw financeError(
      'invalid_state',
      `La obligación${obligation.number ? ` ${obligation.number}` : ''} ya no admite pagos (${obligation.status})`
    );
  }
  if (!amount.greaterThan(0)) {
    throw financeError('invalid_quantity', 'El importe de la liquidación debe ser mayor que cero');
  }
  if (currency && currency !== obligation.currency) {
    throw financeError(
      'currency_mismatch',
      `La obligación está en ${obligation.currency} y el pago en ${currency}`
    );
  }
  const remaining = remainingOf(obligation);
  if (amount.greaterThan(remaining.plus(MONEY_TOLERANCE))) {
    throw financeError(
      'over_settlement',
      `El importe ${formatMxn(amount, obligation.currency)} excede el saldo pendiente ${formatMxn(remaining, obligation.currency)}`,
      { remaining: remaining.toFixed(2), amount: amount.toFixed(2) }
    );
  }
}

export interface ObligationLinks {
  kind: string;
  procurementOrderId?: string | null;
  payrollRunId?: string | null;
  expenseId?: string | null;
  zohoSalesOrderId?: string | null;
  employeeId?: string | null;
  counterpartyType?: string | null;
}

/** Origin of an obligation from its links (the handlers of `onObligationSettled` subscribe to it). */
export function obligationSourceOf(obligation: ObligationLinks): ObligationSourceType {
  if (obligation.procurementOrderId) return 'procurement_order';
  if (obligation.payrollRunId) return 'payroll_run';
  if (obligation.expenseId) return 'expense';
  if (obligation.zohoSalesOrderId) return 'sales_order';
  if (obligation.kind === 'receivable' && obligation.employeeId) return 'employee_advance';
  return 'manual';
}

export type ObligationOffsetType = 'category' | 'cash' | 'clearing' | 'equity';

export interface ObligationOffset {
  accountType: ObligationOffsetType;
  accountId: string;
}

export interface ObligationAllocation {
  amount: Prisma.Decimal.Value;
  costCenterId?: string | null;
  caseId?: string | null;
  projectRef?: string | null;
  memo?: string | null;
}

export interface ObligationEntryInput {
  kind: ObligationKind;
  obligationId: string;
  amount: Prisma.Decimal.Value;
  categoryId: string;
  costCenterId?: string | null;
  caseId?: string | null;
  procurementOrderId?: string | null;
  /** Category side split (cost centers / cases). Must add up to `amount`. */
  allocations?: readonly ObligationAllocation[];
  /** Counter account; default the category. An employee advance uses the cash account. */
  offset?: ObligationOffset;
  memo?: string | null;
}

/**
 * Lines of the entry that recognizes an obligation:
 * - receivable: Dr receivable(obligation) / Cr offset (income category by default);
 * - payable: Dr offset (expense category by default) / Cr payable(obligation).
 */
export function obligationEntryLines(input: ObligationEntryInput): LedgerLineInput[] {
  const amount = roundMoney(input.amount);
  if (!amount.greaterThan(0)) {
    throw financeError('invalid_quantity', 'El importe de la obligación debe ser mayor que cero');
  }
  const offset: ObligationOffset = input.offset ?? {
    accountType: 'category',
    accountId: input.categoryId,
  };
  const splits =
    offset.accountType === 'category' && input.allocations && input.allocations.length > 0
      ? input.allocations.map((a) => ({ ...a, amount: roundMoney(a.amount) }))
      : [
          {
            amount,
            costCenterId: input.costCenterId ?? null,
            caseId: input.caseId ?? null,
            projectRef: null,
            memo: input.memo ?? null,
          },
        ];
  if (!roundMoney(sumMoney(splits.map((s) => s.amount))).equals(amount)) {
    throw financeError('unbalanced_entry', 'El reparto por centro de costo no suma el importe');
  }
  if (splits.some((s) => !D(s.amount).greaterThan(0))) {
    throw financeError('invalid_line', 'Cada parte del reparto debe tener importe');
  }
  const offsetLines: LedgerLineInput[] = splits.map((split) => ({
    accountType: offset.accountType,
    accountId: offset.accountId,
    costCenterId: offset.accountType === 'category' ? (split.costCenterId ?? null) : null,
    caseId: split.caseId ?? input.caseId ?? null,
    procurementOrderId: input.procurementOrderId ?? null,
    projectRef: split.projectRef ?? null,
    memo: split.memo ?? input.memo ?? null,
    ...(input.kind === 'receivable' ? { credit: split.amount } : { debit: split.amount }),
  }));
  const obligationLine: LedgerLineInput = {
    accountType: input.kind,
    accountId: input.obligationId,
    caseId: input.caseId ?? null,
    procurementOrderId: input.procurementOrderId ?? null,
    memo: input.memo ?? null,
    ...(input.kind === 'receivable' ? { debit: amount } : { credit: amount }),
  };
  return input.kind === 'receivable' ? [obligationLine, ...offsetLines] : [...offsetLines, obligationLine];
}

/** Receivable: Dr cash / Cr receivable. Payable: Dr payable / Cr cash. */
export function settlementEntryLines(input: {
  kind: ObligationKind;
  obligationId: string;
  amount: Prisma.Decimal.Value;
  cashAccountId: string;
  caseId?: string | null;
  procurementOrderId?: string | null;
  memo?: string | null;
}): LedgerLineInput[] {
  const amount = roundMoney(input.amount);
  const common = {
    caseId: input.caseId ?? null,
    procurementOrderId: input.procurementOrderId ?? null,
    memo: input.memo ?? null,
  };
  const cash: LedgerLineInput = { accountType: 'cash', accountId: input.cashAccountId, ...common };
  const obligation: LedgerLineInput = {
    accountType: input.kind,
    accountId: input.obligationId,
    ...common,
  };
  return input.kind === 'receivable'
    ? [
        { ...cash, debit: amount },
        { ...obligation, credit: amount },
      ]
    : [
        { ...obligation, debit: amount },
        { ...cash, credit: amount },
      ];
}

/** Receivable: Dr bad-debt category / Cr receivable. Payable: Dr payable / Cr other-income category. */
export function writeOffEntryLines(input: {
  kind: ObligationKind;
  obligationId: string;
  amount: Prisma.Decimal.Value;
  categoryId: string;
  costCenterId?: string | null;
  caseId?: string | null;
  memo?: string | null;
}): LedgerLineInput[] {
  const amount = roundMoney(input.amount);
  const category: LedgerLineInput = {
    accountType: 'category',
    accountId: input.categoryId,
    costCenterId: input.costCenterId ?? null,
    caseId: input.caseId ?? null,
    memo: input.memo ?? null,
  };
  const obligation: LedgerLineInput = {
    accountType: input.kind,
    accountId: input.obligationId,
    caseId: input.caseId ?? null,
    memo: input.memo ?? null,
  };
  return input.kind === 'receivable'
    ? [
        { ...category, debit: amount },
        { ...obligation, credit: amount },
      ]
    : [
        { ...obligation, debit: amount },
        { ...category, credit: amount },
      ];
}

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

export const AGING_BUCKETS = ['not_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'no_due_date'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  not_due: 'Por vencer',
  d1_30: '1 a 30 días',
  d31_60: '31 a 60 días',
  d61_90: '61 a 90 días',
  d90_plus: 'Más de 90 días',
  no_due_date: 'Sin vencimiento',
};

/** Days past due on `asOfKey` (0 when not due yet), null without a due date. */
export function daysOverdue(dueAt: Date | null | undefined, asOfKey: string): number | null {
  if (!dueAt) return null;
  return Math.max(0, daysBetweenKeys(dateKeyOf(dueAt), asOfKey));
}

export function agingBucket(dueAt: Date | null | undefined, asOfKey: string): AgingBucket {
  const days = daysOverdue(dueAt, asOfKey);
  if (days === null) return 'no_due_date';
  if (days <= 0) return 'not_due';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}

export interface AgingInputRow {
  kind: string;
  remaining: Prisma.Decimal.Value;
  dueAt: Date | null;
}

export type AgingSummary = Record<ObligationKind, Record<AgingBucket | 'total', string>>;

export function summarizeAging(rows: readonly AgingInputRow[], asOfKey: string): AgingSummary {
  const empty = (): Record<AgingBucket | 'total', Money> =>
    Object.fromEntries([...AGING_BUCKETS, 'total'].map((b) => [b, new Prisma.Decimal(0)])) as Record<
      AgingBucket | 'total',
      Money
    >;
  const totals: Record<ObligationKind, Record<AgingBucket | 'total', Money>> = {
    payable: empty(),
    receivable: empty(),
  };
  for (const row of rows) {
    if (row.kind !== 'payable' && row.kind !== 'receivable') continue;
    const amount = D(row.remaining);
    if (!amount.greaterThan(0)) continue;
    const bucket = agingBucket(row.dueAt, asOfKey);
    totals[row.kind][bucket] = totals[row.kind][bucket].plus(amount);
    totals[row.kind].total = totals[row.kind].total.plus(amount);
  }
  const serialize = (record: Record<AgingBucket | 'total', Money>) =>
    Object.fromEntries(Object.entries(record).map(([k, v]) => [k, roundMoney(v).toFixed(2)])) as Record<
      AgingBucket | 'total',
      string
    >;
  return { payable: serialize(totals.payable), receivable: serialize(totals.receivable) };
}

// ---------------------------------------------------------------------------
// Payment authorization (scope `payment` of approvals-service)
// ---------------------------------------------------------------------------

export type PaymentAuthorizationState = 'not_required' | 'approved' | 'pending' | 'rejected' | 'missing';

/**
 * Whether a payable may be paid:
 * - receivables, and payables born from an approved expense or payroll run,
 *   need no payment authorization (their approval already happened upstream);
 * - every other payable (supplier purchases AND manual payables) needs the
 *   latest `payment` approval of the obligation to be approved; the policy of
 *   that approval sets the signatures by amount (one below the double-approval
 *   threshold, two from it), so the person who records a payable can never
 *   pay it alone;
 * - without any approval the state is `missing`.
 */
export function paymentAuthorizationState(
  obligation: ObligationLinks,
  approvals: ReadonlyArray<{ status: string; createdAt: Date }>
): PaymentAuthorizationState {
  if (obligation.kind !== 'payable') return 'not_required';
  if (obligation.expenseId || obligation.payrollRunId) return 'not_required';
  const latest = [...approvals].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (latest) {
    if (latest.status === 'approved') return 'approved';
    if (latest.status === 'pending') return 'pending';
    return 'rejected';
  }
  return 'missing';
}

export function assertPaymentAuthorized(state: PaymentAuthorizationState, number?: string): void {
  const label = number ? ` ${number}` : '';
  switch (state) {
    case 'not_required':
    case 'approved':
      return;
    case 'pending':
      throw financeError(
        'payment_not_authorized',
        `El pago de la obligación${label} espera su autorización`
      );
    case 'rejected':
      throw financeError(
        'payment_not_authorized',
        `La autorización del pago de la obligación${label} fue rechazada o venció; solicítala de nuevo`
      );
    case 'missing':
      throw financeError(
        'payment_not_authorized',
        `El pago de la obligación${label} necesita autorización antes de registrarse`
      );
  }
}

// ---------------------------------------------------------------------------
// Idempotency references of Zoho payments
// ---------------------------------------------------------------------------

export const ZOHO_PAYMENT_REF_PREFIX = 'zoho_payment';
const REVERSAL_SUFFIX = ':reversal';

/** `zoho_payment:{zohoPaymentId}:{obligationId}`; later attempts (after a reversal) add `#n`. */
export function settlementExternalRef(zohoPaymentId: string, obligationId: string, attempt = 1): string {
  const base = `${ZOHO_PAYMENT_REF_PREFIX}:${zohoPaymentId}:${obligationId}`;
  return attempt <= 1 ? base : `${base}#${attempt}`;
}

export function reversalExternalRef(externalRef: string): string {
  return `${externalRef}${REVERSAL_SUFFIX}`;
}

export function isReversalExternalRef(externalRef: string | null | undefined): boolean {
  return Boolean(externalRef && externalRef.endsWith(REVERSAL_SUFFIX));
}

/**
 * Reference for applying `zohoPaymentId` to `obligationId`: the base key the
 * first time, the next free attempt when every previous application was
 * reversed, or null when an application is still active (already applied).
 */
export function nextSettlementExternalRef(
  existingRefs: readonly string[],
  zohoPaymentId: string,
  obligationId: string
): string | null {
  const refs = new Set(existingRefs);
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const ref = settlementExternalRef(zohoPaymentId, obligationId, attempt);
    if (!refs.has(ref)) return ref;
    if (!refs.has(reversalExternalRef(ref))) return null;
  }
  return null;
}

/**
 * Obligation id of a Zoho payment settlement reference
 * (`zoho_payment:{pid}:{obligationId}[#n][:reversal]`), or null when the
 * reference belongs to another payment.
 */
export function obligationIdOfSettlementRef(externalRef: string | null | undefined, zohoPaymentId: string): string | null {
  const prefix = `${ZOHO_PAYMENT_REF_PREFIX}:${zohoPaymentId}:`;
  if (!externalRef || !externalRef.startsWith(prefix)) return null;
  let rest = externalRef.slice(prefix.length);
  if (rest.endsWith(REVERSAL_SUFFIX)) rest = rest.slice(0, -REVERSAL_SUFFIX.length);
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  return rest.length > 0 ? rest : null;
}

/** Obligations from which an application of `zohoPaymentId` was reversed (a person undid that match). */
export function reversedObligationIdsOf(externalRefs: readonly (string | null | undefined)[], zohoPaymentId: string): string[] {
  const ids = new Set<string>();
  for (const ref of externalRefs) {
    if (!isReversalExternalRef(ref)) continue;
    const id = obligationIdOfSettlementRef(ref, zohoPaymentId);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Outstanding balance of an obligation from its ledger lines: receivable
 * Σdebit − Σcredit, payable Σcredit − Σdebit (never negative). Used to read
 * AR/AP as of a past date (lines of entries dated on or before it).
 */
export function obligationLedgerBalance(
  kind: string,
  debit: Prisma.Decimal.Value,
  credit: Prisma.Decimal.Value
): Money {
  const net = kind === 'receivable' ? D(debit).minus(D(credit)) : D(credit).minus(D(debit));
  return net.greaterThan(0) ? roundMoney(net) : new Prisma.Decimal(0);
}
