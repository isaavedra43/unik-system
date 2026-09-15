import { Prisma } from '@prisma/client';
import { financeError } from './finance-errors';
import { compareKeys, daysBetweenKeys, isDateKey, periodKeyOfKey } from './finance-dates';
import type { LedgerLineInput } from './ledger-rules';
import { D, MONEY_TOLERANCE, formatMxn, minMoney, roundMoney, sumMoney, type Money } from './money';
import { PAYROLL_DEDUCTIONS_CLEARING_ID } from './types';

/**
 * Pure payroll rules: net of a line (gross − deductions − advances applied),
 * totals of the run, validation against the directory and the open advances,
 * FIFO application of advances and the lines of the payroll entry:
 *
 *   Dr payroll category (gross, per cost center)
 *     Cr clearing `payroll_deductions` (withholdings)
 *     Cr receivable (employee advances applied)
 *     Cr payable (one obligation per employee, net)
 */

export const MAX_PAYROLL_PERIOD_DAYS = 31;
export const MAX_PAYROLL_LINES = 500;

export interface PayrollDeductionInput {
  kind: string;
  label: string;
  amount: Prisma.Decimal.Value;
}

export interface PayrollLineComputation {
  gross: Money;
  deductionsTotal: Money;
  advancesApplied: Money;
  net: Money;
}

export function computePayrollLine(input: {
  gross: Prisma.Decimal.Value;
  deductions: readonly PayrollDeductionInput[];
  advancesApplied?: Prisma.Decimal.Value | null;
}): PayrollLineComputation {
  const gross = roundMoney(D(input.gross));
  const deductionsTotal = roundMoney(sumMoney(input.deductions.map((d) => D(d.amount))));
  const advancesApplied = roundMoney(D(input.advancesApplied));
  if (gross.isNegative() || deductionsTotal.isNegative() || advancesApplied.isNegative()) {
    throw financeError('invalid_quantity', 'Los importes de nómina no pueden ser negativos');
  }
  if (input.deductions.some((d) => D(d.amount).isNegative())) {
    throw financeError('invalid_quantity', 'Una deducción no puede ser negativa');
  }
  const net = gross.minus(deductionsTotal).minus(advancesApplied);
  if (net.isNegative()) {
    throw financeError(
      'invalid_quantity',
      `Las deducciones y anticipos (${formatMxn(deductionsTotal.plus(advancesApplied))}) superan el sueldo bruto (${formatMxn(gross)})`
    );
  }
  return { gross, deductionsTotal, advancesApplied, net: roundMoney(net) };
}

export interface PayrollTotals {
  totalGross: Money;
  /** Withholdings + advances applied (gross − totalDeductions = totalNet). */
  totalDeductions: Money;
  totalNet: Money;
}

export function computePayrollTotals(lines: readonly PayrollLineComputation[]): PayrollTotals {
  return {
    totalGross: roundMoney(sumMoney(lines.map((l) => l.gross))),
    totalDeductions: roundMoney(sumMoney(lines.map((l) => l.deductionsTotal.plus(l.advancesApplied)))),
    totalNet: roundMoney(sumMoney(lines.map((l) => l.net))),
  };
}

export interface PayrollPeriod {
  periodKey: string;
  startKey: string;
  endKey: string;
}

export function payrollPeriod(startKey: string, endKey: string): PayrollPeriod {
  if (!isDateKey(startKey) || !isDateKey(endKey)) {
    throw financeError('invalid_payload', 'Periodo de nómina inválido (usa AAAA-MM-DD)');
  }
  if (compareKeys(startKey, endKey) > 0) {
    throw financeError('invalid_payload', 'El periodo de nómina termina antes de empezar');
  }
  if (daysBetweenKeys(startKey, endKey) + 1 > MAX_PAYROLL_PERIOD_DAYS) {
    throw financeError('invalid_payload', `Un periodo de nómina abarca como máximo ${MAX_PAYROLL_PERIOD_DAYS} días`);
  }
  return { periodKey: periodKeyOfKey(endKey), startKey, endKey };
}

/** Duplicate / inactive employees and advances above the open balance. */
export function assertPayrollLines(
  lines: ReadonlyArray<{ employeeId: string; advancesApplied?: Prisma.Decimal.Value | null }>,
  refs: {
    employees: ReadonlyMap<string, { name: string; active: boolean }>;
    openAdvances: ReadonlyMap<string, Prisma.Decimal.Value>;
  }
): void {
  if (lines.length === 0) throw financeError('invalid_payload', 'La nómina necesita al menos un empleado');
  if (lines.length > MAX_PAYROLL_LINES) {
    throw financeError('invalid_payload', `Una nómina admite hasta ${MAX_PAYROLL_LINES} empleados`);
  }
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.employeeId)) {
      throw financeError('invalid_payload', 'Un empleado aparece dos veces en la nómina');
    }
    seen.add(line.employeeId);
    const employee = refs.employees.get(line.employeeId);
    if (!employee) throw financeError('not_found', 'Un empleado de la nómina no existe');
    if (!employee.active) {
      throw financeError('invalid_state', `${employee.name} está dado de baja`);
    }
    const applied = roundMoney(D(line.advancesApplied));
    const open = roundMoney(D(refs.openAdvances.get(line.employeeId)));
    if (applied.greaterThan(open.plus(MONEY_TOLERANCE))) {
      throw financeError(
        'over_settlement',
        `${employee.name} tiene ${formatMxn(open)} de anticipos pendientes y se aplican ${formatMxn(applied)}`
      );
    }
  }
}

export interface OpenAdvance {
  obligationId: string;
  remaining: Prisma.Decimal.Value;
  createdAt: Date;
}

/** FIFO application of `amount` over the employee's open advances (oldest first). */
export function allocateAdvances(
  amount: Prisma.Decimal.Value,
  advances: readonly OpenAdvance[]
): Array<{ obligationId: string; amount: Money }> {
  let left = roundMoney(D(amount));
  const result: Array<{ obligationId: string; amount: Money }> = [];
  const ordered = [...advances].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.obligationId.localeCompare(b.obligationId)
  );
  for (const advance of ordered) {
    if (!left.greaterThan(0)) break;
    const take = roundMoney(minMoney(left, D(advance.remaining)));
    if (!take.greaterThan(0)) continue;
    result.push({ obligationId: advance.obligationId, amount: take });
    left = left.minus(take);
  }
  if (left.greaterThan(MONEY_TOLERANCE)) {
    throw financeError('over_settlement', 'Los anticipos aplicados superan los anticipos pendientes');
  }
  return result;
}

export interface PayrollEntryLineInput {
  employeeId: string;
  employeeName: string;
  computation: PayrollLineComputation;
  costCenterId: string | null;
  /** Payable obligation of the net (null when the net is zero). */
  obligationId: string | null;
  advanceAllocations: ReadonlyArray<{ obligationId: string; amount: Prisma.Decimal.Value }>;
}

export function payrollEntryLines(input: {
  runNumber: string;
  categoryId: string;
  lines: readonly PayrollEntryLineInput[];
}): LedgerLineInput[] {
  const result: LedgerLineInput[] = [];
  for (const line of input.lines) {
    const memo = `${input.runNumber} · ${line.employeeName}`.slice(0, 500);
    result.push({
      accountType: 'category',
      accountId: input.categoryId,
      debit: line.computation.gross,
      costCenterId: line.costCenterId,
      memo,
    });
    if (line.computation.deductionsTotal.greaterThan(0)) {
      result.push({
        accountType: 'clearing',
        accountId: PAYROLL_DEDUCTIONS_CLEARING_ID,
        credit: line.computation.deductionsTotal,
        memo,
      });
    }
    for (const advance of line.advanceAllocations) {
      result.push({ accountType: 'receivable', accountId: advance.obligationId, credit: advance.amount, memo });
    }
    if (line.computation.net.greaterThan(0)) {
      if (!line.obligationId) throw new Error('payrollEntryLines: falta la obligación del neto');
      result.push({ accountType: 'payable', accountId: line.obligationId, credit: line.computation.net, memo });
    }
  }
  return result;
}

/** A run is paid when every line is paid. */
export function isPayrollFullyPaid(lines: ReadonlyArray<{ status: string }>): boolean {
  return lines.length > 0 && lines.every((line) => line.status === 'paid');
}
