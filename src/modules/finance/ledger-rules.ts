import { Prisma } from '@prisma/client';
import { financeError } from './finance-errors';
import { compareKeys, isDateKey, periodKeyOfKey } from './finance-dates';
import { D, formatMxn, parseMoney, roundMoney, sumMoney, type Money } from './money';
import {
  LEDGER_ACCOUNT_TYPES,
  LEDGER_ENTRY_KINDS,
  type LedgerAccountType,
  type LedgerEntryKind,
} from './types';

/**
 * Pure rules of the double-entry ledger (plan 6.4):
 *
 * - every line carries either a debit or a credit (> 0, rounded to cents);
 * - an entry needs at least two lines and `Σdebit = Σcredit` exactly;
 * - entries dated in a closed day or month are rejected;
 * - the only correction is a reversal whose lines mirror the original
 *   (debit ↔ credit, same dimensions), dated in an open period and never
 *   before the original; a reversal is never reversed and an entry is
 *   reversed at most once;
 * - balances are `Σ(debit − credit)` per account (cash is debit-normal).
 */

export const MAX_LEDGER_LINES = 200;

export interface LedgerLineInput {
  accountType: LedgerAccountType | (string & {});
  accountId: string;
  debit?: Prisma.Decimal.Value | null;
  credit?: Prisma.Decimal.Value | null;
  costCenterId?: string | null;
  caseId?: string | null;
  procurementOrderId?: string | null;
  projectRef?: string | null;
  memo?: string | null;
}

export interface NormalizedLedgerLine {
  seq: number;
  accountType: LedgerAccountType;
  accountId: string;
  debit: Money;
  credit: Money;
  costCenterId: string | null;
  caseId: string | null;
  procurementOrderId: string | null;
  projectRef: string | null;
  memo: string | null;
}

export function isLedgerAccountType(value: unknown): value is LedgerAccountType {
  return typeof value === 'string' && (LEDGER_ACCOUNT_TYPES as readonly string[]).includes(value);
}

export function isLedgerEntryKind(value: unknown): value is LedgerEntryKind {
  return typeof value === 'string' && (LEDGER_ENTRY_KINDS as readonly string[]).includes(value);
}

function optionalText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function lineAmount(value: Prisma.Decimal.Value | null | undefined, n: number, side: string): Money {
  if (value === null || value === undefined || value === '') return new Prisma.Decimal(0);
  const parsed = parseMoney(value);
  if (!parsed) throw financeError('invalid_line', `Renglón ${n}: ${side} inválido`);
  if (parsed.isNegative()) {
    throw financeError('invalid_line', `Renglón ${n}: el ${side} no puede ser negativo`);
  }
  return roundMoney(parsed);
}

/** Validates and normalizes lines (sequence from 1, cents). Throws `invalid_line` / `unbalanced_entry`. */
export function normalizeLedgerLines(lines: readonly LedgerLineInput[]): NormalizedLedgerLine[] {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw financeError('unbalanced_entry', 'Un asiento necesita al menos dos renglones');
  }
  if (lines.length > MAX_LEDGER_LINES) {
    throw financeError('invalid_line', `Un asiento admite hasta ${MAX_LEDGER_LINES} renglones`);
  }
  return lines.map((line, index) => {
    const n = index + 1;
    if (!isLedgerAccountType(line.accountType)) {
      throw financeError('invalid_line', `Renglón ${n}: tipo de cuenta inválido`);
    }
    const accountId = typeof line.accountId === 'string' ? line.accountId.trim() : '';
    if (!accountId || accountId.length > 120) {
      throw financeError('invalid_line', `Renglón ${n}: falta la cuenta`);
    }
    const debit = lineAmount(line.debit, n, 'cargo');
    const credit = lineAmount(line.credit, n, 'abono');
    if (debit.greaterThan(0) && credit.greaterThan(0)) {
      throw financeError('invalid_line', `Renglón ${n}: lleva cargo o abono, no ambos`);
    }
    if (debit.isZero() && credit.isZero()) {
      throw financeError('invalid_line', `Renglón ${n}: no tiene importe`);
    }
    return {
      seq: n,
      accountType: line.accountType,
      accountId,
      debit,
      credit,
      costCenterId: optionalText(line.costCenterId, 120),
      caseId: optionalText(line.caseId, 120),
      procurementOrderId: optionalText(line.procurementOrderId, 120),
      projectRef: optionalText(line.projectRef, 120),
      memo: optionalText(line.memo, 500),
    };
  });
}

export interface LedgerTotals {
  totalDebit: Money;
  totalCredit: Money;
}

export function ledgerTotals(
  lines: ReadonlyArray<{ debit: Prisma.Decimal.Value; credit: Prisma.Decimal.Value }>
): LedgerTotals {
  return {
    totalDebit: roundMoney(sumMoney(lines.map((l) => l.debit))),
    totalCredit: roundMoney(sumMoney(lines.map((l) => l.credit))),
  };
}

/** `Σdebit = Σcredit` (exact, in cents) and non-zero. Returns the totals. */
export function assertBalanced(
  lines: ReadonlyArray<{ debit: Prisma.Decimal.Value; credit: Prisma.Decimal.Value }>
): LedgerTotals {
  if (lines.length < 2) {
    throw financeError('unbalanced_entry', 'Un asiento necesita al menos dos renglones');
  }
  const totals = ledgerTotals(lines);
  if (!totals.totalDebit.equals(totals.totalCredit)) {
    throw financeError(
      'unbalanced_entry',
      `El asiento no cuadra: cargos ${formatMxn(totals.totalDebit)} y abonos ${formatMxn(totals.totalCredit)}`,
      { totalDebit: totals.totalDebit.toFixed(2), totalCredit: totals.totalCredit.toFixed(2) }
    );
  }
  if (totals.totalDebit.isZero()) {
    throw financeError('unbalanced_entry', 'El asiento no tiene importe');
  }
  return totals;
}

/** 'YYYY-MM' of a business date (date key or UTC-midnight `@db.Date`). */
export function periodKeyOf(date: Date | string): string {
  return periodKeyOfKey(date);
}

/** Lines of the reversal: same accounts and dimensions, debit ↔ credit. */
export function mirrorForReversal(
  lines: ReadonlyArray<{
    accountType: string;
    accountId: string;
    debit: Prisma.Decimal.Value;
    credit: Prisma.Decimal.Value;
    costCenterId?: string | null;
    caseId?: string | null;
    procurementOrderId?: string | null;
    projectRef?: string | null;
    memo?: string | null;
  }>
): LedgerLineInput[] {
  return lines.map((line) => ({
    accountType: line.accountType,
    accountId: line.accountId,
    debit: D(line.credit),
    credit: D(line.debit),
    costCenterId: line.costCenterId ?? null,
    caseId: line.caseId ?? null,
    procurementOrderId: line.procurementOrderId ?? null,
    projectRef: line.projectRef ?? null,
    memo: line.memo ? `Reverso: ${line.memo}`.slice(0, 500) : 'Reverso',
  }));
}

export function accountKey(accountType: string, accountId: string): string {
  return `${accountType}:${accountId}`;
}

/** `Σ(debit − credit)` per `accountType:accountId`. */
export function computeAccountBalances(
  lines: ReadonlyArray<{
    accountType: string;
    accountId: string;
    debit: Prisma.Decimal.Value;
    credit: Prisma.Decimal.Value;
  }>
): Map<string, Money> {
  const balances = new Map<string, Money>();
  for (const line of lines) {
    const key = accountKey(line.accountType, line.accountId);
    const current = balances.get(key) ?? new Prisma.Decimal(0);
    balances.set(key, current.plus(D(line.debit)).minus(D(line.credit)));
  }
  return balances;
}

/** Net change per cash account (debit − credit), zero deltas omitted. */
export function cashDeltas(
  lines: ReadonlyArray<{
    accountType: string;
    accountId: string;
    debit: Prisma.Decimal.Value;
    credit: Prisma.Decimal.Value;
  }>
): Map<string, Money> {
  const deltas = new Map<string, Money>();
  for (const line of lines) {
    if (line.accountType !== 'cash') continue;
    const current = deltas.get(line.accountId) ?? new Prisma.Decimal(0);
    deltas.set(line.accountId, current.plus(D(line.debit)).minus(D(line.credit)));
  }
  for (const [id, delta] of deltas) if (delta.isZero()) deltas.delete(id);
  return deltas;
}

export function balanceFor(
  lines: ReadonlyArray<{
    accountType: string;
    accountId: string;
    debit: Prisma.Decimal.Value;
    credit: Prisma.Decimal.Value;
  }>,
  accountType: string,
  accountId: string
): Money {
  return computeAccountBalances(lines).get(accountKey(accountType, accountId)) ?? new Prisma.Decimal(0);
}

export interface PeriodCloseState {
  periodKey: string;
  kind: string;
  status: string;
}

/** The closed day or month that contains `dateKey`, or null when the date is open. */
export function closedPeriodFor(
  closes: readonly PeriodCloseState[],
  dateKey: string
): PeriodCloseState | null {
  const month = periodKeyOf(dateKey);
  return (
    closes.find(
      (c) =>
        c.status === 'closed' &&
        ((c.kind === 'monthly' && c.periodKey === month) || (c.kind === 'daily' && c.periodKey === dateKey))
    ) ?? null
  );
}

export function assertDateOpen(closes: readonly PeriodCloseState[], dateKey: string): void {
  if (!isDateKey(dateKey)) throw financeError('invalid_payload', 'Fecha del asiento inválida');
  const closed = closedPeriodFor(closes, dateKey);
  if (closed) {
    throw financeError(
      'period_closed',
      closed.kind === 'monthly'
        ? `El periodo ${closed.periodKey} está cerrado: registra el movimiento en un periodo abierto`
        : `El día ${closed.periodKey} está cerrado: registra el movimiento en una fecha abierta`,
      { periodKey: closed.periodKey, kind: closed.kind }
    );
  }
}

/** Whether an entry can be reversed; throws the Spanish reason otherwise. */
export function assertReversible(entry: {
  number?: string;
  kind: string;
  reversedByEntryId: string | null;
}): void {
  if (entry.kind === 'reversal') {
    throw financeError(
      'not_reversible',
      'Un asiento de reverso no se revierte: registra un asiento nuevo con el movimiento correcto'
    );
  }
  if (entry.reversedByEntryId) {
    throw financeError(
      'already_reversed',
      `El asiento${entry.number ? ` ${entry.number}` : ''} ya fue reversado`
    );
  }
}

/**
 * Date of a reversal: the requested day, or today — never before the original
 * entry (a reversal of an entry dated in the future waits for that date).
 */
export function reversalDateKey(originalKey: string, todayKey: string, requestedKey?: string | null): string {
  const date = requestedKey ?? (compareKeys(todayKey, originalKey) >= 0 ? todayKey : originalKey);
  if (!isDateKey(date)) throw financeError('invalid_payload', 'Fecha del reverso inválida');
  if (compareKeys(date, originalKey) < 0) {
    throw financeError('invalid_payload', 'El reverso no puede fecharse antes que el asiento original');
  }
  return date;
}

// ---------------------------------------------------------------------------
// Serialization against closes (advisory lock keys)
// ---------------------------------------------------------------------------

/** Advisory lock key of a close: `finance:period:YYYY-MM` (monthly) or `finance:day:YYYY-MM-DD` (daily). */
export function closeLockKey(kind: string, periodKey: string): string {
  return kind === 'monthly' ? `finance:period:${periodKey}` : `finance:day:${periodKey}`;
}

/**
 * Keys a posting dated `dateKey` holds in shared mode: its month and its day.
 * A close takes the exclusive lock of its own key, so a posting and the close
 * of its period never interleave (the close sees the committed entry, or the
 * posting sees the close and is rejected).
 */
export function postingLockKeys(dateKey: string): string[] {
  return [closeLockKey('monthly', periodKeyOf(dateKey)), closeLockKey('daily', dateKey)];
}

/**
 * Net money a manual entry takes out of cash (Σ cash credits − Σ cash debits),
 * never negative. Zero for income and for transfers between cash accounts.
 */
export function manualCashOutflow(
  lines: ReadonlyArray<{ accountType: string; debit?: Prisma.Decimal.Value | null; credit?: Prisma.Decimal.Value | null }>
): Money {
  let net = new Prisma.Decimal(0);
  for (const line of lines) {
    if (line.accountType !== 'cash') continue;
    net = net.plus(D(line.credit ?? 0)).minus(D(line.debit ?? 0));
  }
  return net.greaterThan(0) ? roundMoney(net) : new Prisma.Decimal(0);
}
