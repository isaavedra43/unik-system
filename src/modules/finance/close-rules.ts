import { Prisma } from '@prisma/client';
import { financeError } from './finance-errors';
import { isDateKey, isPeriodKey } from './finance-dates';
import { D, formatMxn, roundMoney, type Money } from './money';
import type { PeriodCloseKind } from './types';

/**
 * Pure rules of the daily and monthly closes (plan 6.4):
 *
 * Monthly (blocking): no draft / pending / approved-not-posted expenses of the
 * period, zero unassigned collections of the period, cash integrity per
 * account (ledger-derived balance = current balance), every provided cash
 * count equal to the balance and a balanced ledger. Warnings: previous month
 * not closed, payroll runs still open.
 *
 * Daily (blocking): cash integrity and a count for every cash / petty cash
 * account equal to its balance. Warnings: pending expenses and unassigned
 * collections of the day.
 *
 * A closed period rejects entries; reopening needs a reason (≥ 10 chars).
 */

export interface CloseCheck {
  key: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  data?: Record<string, unknown>;
}

export interface CashAccountCloseInput {
  cashAccountId: string;
  name: string;
  kind: string;
  currency: string;
  currentBalance: Prisma.Decimal.Value;
  ledgerBalance: Prisma.Decimal.Value;
  /**
   * Balance at the end of the closed day or month (ledger lines dated on or
   * before it). The physical count is compared with it, not with today's
   * balance, so a close run later is not affected by later movements.
   * Defaults to `currentBalance` when omitted.
   */
  balanceAtCutoff?: Prisma.Decimal.Value | null;
  counted?: Prisma.Decimal.Value | null;
}

export interface CloseRulesInput {
  kind: PeriodCloseKind;
  periodKey: string;
  pendingExpenses: { count: number; numbers: readonly string[] };
  unassignedCollections: { count: number; amount: Prisma.Decimal.Value };
  /**
   * Zoho payments whose active settlements exceed the payment (voided, no
   * longer synced or reduced in Zoho): money in the ledger that never arrived.
   */
  overappliedCollections?: { count: number; amount: Prisma.Decimal.Value; numbers: readonly string[] };
  cashAccounts: readonly CashAccountCloseInput[];
  ledgerTotals: { debit: Prisma.Decimal.Value; credit: Prisma.Decimal.Value; entries: number };
  previousPeriodClosed?: boolean | null;
  openPayrollRuns?: { count: number; numbers: readonly string[] };
}

/** Accounts whose physical count is required in a daily close. */
export const DAILY_COUNT_ACCOUNT_KINDS: readonly string[] = ['cash', 'petty_cash'];

function list(numbers: readonly string[], max = 5): string {
  const shown = numbers.slice(0, max).join(', ');
  return numbers.length > max ? `${shown} y ${numbers.length - max} más` : shown;
}

export function evaluateCloseChecks(input: CloseRulesInput): CloseCheck[] {
  const monthly = input.kind === 'monthly';
  const checks: CloseCheck[] = [];

  checks.push({
    key: 'pending_expenses',
    label: 'Gastos pendientes',
    ok: input.pendingExpenses.count === 0,
    blocking: monthly,
    detail:
      input.pendingExpenses.count === 0
        ? 'Sin gastos pendientes'
        : `${input.pendingExpenses.count} gasto(s) sin contabilizar: ${list(input.pendingExpenses.numbers)}`,
    data: { count: input.pendingExpenses.count },
  });

  const unassigned = roundMoney(D(input.unassignedCollections.amount));
  checks.push({
    key: 'unassigned_collections',
    label: 'Cobros sin asignar',
    ok: input.unassignedCollections.count === 0,
    blocking: monthly,
    detail:
      input.unassignedCollections.count === 0
        ? 'Todos los cobros están asignados'
        : `${input.unassignedCollections.count} cobro(s) sin asignar por ${formatMxn(unassigned)}`,
    data: { count: input.unassignedCollections.count, amount: unassigned.toFixed(2) },
  });

  if (input.overappliedCollections) {
    const over = input.overappliedCollections;
    const excess = roundMoney(D(over.amount));
    checks.push({
      key: 'overapplied_collections',
      label: 'Cobros anulados o reducidos en Zoho',
      ok: over.count === 0,
      blocking: monthly,
      detail:
        over.count === 0
          ? 'Ningún cobro aplicado fue anulado ni reducido en Zoho'
          : `${over.count} cobro(s) aplicados de más por ${formatMxn(excess)}: ${list(over.numbers)}`,
      data: { count: over.count, amount: excess.toFixed(2) },
    });
  }

  for (const account of input.cashAccounts) {
    const current = roundMoney(D(account.currentBalance));
    const cutoff =
      account.balanceAtCutoff === null || account.balanceAtCutoff === undefined
        ? current
        : roundMoney(D(account.balanceAtCutoff));
    const ledger = roundMoney(D(account.ledgerBalance));
    checks.push({
      key: `cash_integrity:${account.cashAccountId}`,
      label: `Integridad de ${account.name}`,
      ok: current.equals(ledger),
      blocking: true,
      detail: current.equals(ledger)
        ? `Saldo ${formatMxn(current, account.currency)} coincide con el libro`
        : `Saldo registrado ${formatMxn(current, account.currency)} y libro ${formatMxn(ledger, account.currency)}`,
      data: { currentBalance: current.toFixed(2), ledgerBalance: ledger.toFixed(2) },
    });
    const countRequired = !monthly && DAILY_COUNT_ACCOUNT_KINDS.includes(account.kind);
    const hasCount = account.counted !== null && account.counted !== undefined;
    if (hasCount || countRequired) {
      const counted = hasCount ? roundMoney(D(account.counted)) : null;
      const ok = counted !== null && counted.equals(cutoff);
      checks.push({
        key: `cash_count:${account.cashAccountId}`,
        label: `Arqueo de ${account.name}`,
        ok,
        blocking: true,
        detail:
          counted === null
            ? `Falta el arqueo de ${account.name}`
            : ok
              ? `Arqueo cuadra: ${formatMxn(counted, account.currency)}`
              : `Arqueo ${formatMxn(counted, account.currency)} y saldo al corte ${formatMxn(cutoff, account.currency)} (diferencia ${formatMxn(counted.minus(cutoff), account.currency)})`,
        data: {
          counted: counted?.toFixed(2) ?? null,
          currentBalance: current.toFixed(2),
          balanceAtCutoff: cutoff.toFixed(2),
          difference: counted ? counted.minus(cutoff).toFixed(2) : null,
        },
      });
    }
  }

  const debit = roundMoney(D(input.ledgerTotals.debit));
  const credit = roundMoney(D(input.ledgerTotals.credit));
  checks.push({
    key: 'ledger_balanced',
    label: 'Libro cuadrado',
    ok: debit.equals(credit),
    blocking: true,
    detail: debit.equals(credit)
      ? `${input.ledgerTotals.entries} asiento(s) cuadrados por ${formatMxn(debit)}`
      : `Cargos ${formatMxn(debit)} y abonos ${formatMxn(credit)}`,
    data: { debit: debit.toFixed(2), credit: credit.toFixed(2), entries: input.ledgerTotals.entries },
  });

  if (monthly && input.previousPeriodClosed !== undefined && input.previousPeriodClosed !== null) {
    checks.push({
      key: 'previous_period_closed',
      label: 'Mes anterior cerrado',
      ok: input.previousPeriodClosed,
      blocking: false,
      detail: input.previousPeriodClosed ? 'El mes anterior está cerrado' : 'El mes anterior sigue abierto',
    });
  }
  if (monthly && input.openPayrollRuns) {
    checks.push({
      key: 'open_payroll_runs',
      label: 'Nóminas abiertas',
      ok: input.openPayrollRuns.count === 0,
      blocking: false,
      detail:
        input.openPayrollRuns.count === 0
          ? 'Sin nóminas abiertas del periodo'
          : `${input.openPayrollRuns.count} nómina(s) sin pagar: ${list(input.openPayrollRuns.numbers)}`,
    });
  }
  return checks;
}

export function blockingFailures(checks: readonly CloseCheck[]): CloseCheck[] {
  return checks.filter((check) => check.blocking && !check.ok);
}

export function canClose(checks: readonly CloseCheck[]): boolean {
  return blockingFailures(checks).length === 0;
}

export function assertCloseKey(kind: PeriodCloseKind, periodKey: string): void {
  if (kind === 'monthly' && !isPeriodKey(periodKey)) {
    throw financeError('invalid_payload', 'Periodo del cierre mensual inválido (AAAA-MM)');
  }
  if (kind === 'daily' && !isDateKey(periodKey)) {
    throw financeError('invalid_payload', 'Día del cierre inválido (AAAA-MM-DD)');
  }
}

/** Close from nothing, open, closing or reopened; reopen only a closed period. */
export function assertCloseTransition(current: string | null, action: 'close' | 'reopen'): void {
  if (action === 'close') {
    if (current === 'closed') throw financeError('invalid_state', 'El periodo ya está cerrado');
    return;
  }
  if (current !== 'closed') throw financeError('invalid_state', 'Sólo se reabre un periodo cerrado');
}

export const REOPEN_REASON_MIN = 10;

export function assertReopenReason(reason: string | null | undefined): string {
  const text = (reason ?? '').trim();
  if (text.length < REOPEN_REASON_MIN) {
    throw financeError('invalid_payload', `Explica por qué se reabre el periodo (mínimo ${REOPEN_REASON_MIN} caracteres)`);
  }
  return text.slice(0, 1000);
}

export function closeSummary(checks: readonly CloseCheck[]): { ok: number; failed: number; warnings: number } {
  return {
    ok: checks.filter((c) => c.ok).length,
    failed: checks.filter((c) => !c.ok && c.blocking).length,
    warnings: checks.filter((c) => !c.ok && !c.blocking).length,
  };
}

export type { Money };
