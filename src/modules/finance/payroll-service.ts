import { Prisma, type PayrollLine, type PayrollRun } from '@prisma/client';
import { z } from 'zod';
import { onApprovalDecided, requestApproval } from '@/modules/operations/approvals-service';
import type { CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { toOperationalJson } from '@/modules/operations/events-service';
import { nextNumber } from '@/modules/operations/sequence-service';
import { AREA_KEYS } from '@/modules/operations/types';
import { FINANCE_CATEGORY_KEYS, categoryIdByKey } from './catalog-service';
import { financeError } from './finance-errors';
import { dateKeyOf, dateKeySchema, toDbDate } from './finance-dates';
import { actorUserIdOf, financeEventOptions, publishBoard, todayKeyOf } from './finance-helpers';
import { postLedgerEntry, reverseLedgerEntry } from './ledger-service';
import { D, currencySchema, nonNegativeMoneySchema, positiveMoneySchema, roundMoney } from './money';
import {
  cancelObligation,
  createObligationWithEntry,
  onObligationSettled,
  onObligationSettlementReversed,
  recordSettlementReversalRows,
  settleObligationInTx,
} from './obligations-service';
import { remainingOf } from './obligation-rules';
import {
  allocateAdvances,
  assertPayrollLines,
  computePayrollLine,
  computePayrollTotals,
  isPayrollFullyPaid,
  payrollEntryLines,
  payrollPeriod,
  type OpenAdvance,
  type PayrollLineComputation,
} from './payroll-rules';
import {
  FINANCE_AREA_KEY,
  FINANCE_COMMANDS,
  FINANCE_EVENTS,
  FINANCE_OBJECT_TYPES,
  FINANCE_SEQUENCES,
  LEDGER_SOURCE_TYPES,
  OBLIGATION_OPEN_STATUSES,
} from './types';

/**
 * Payroll (plan 6.4): employee directory (not every employee has a login),
 * payroll runs → `payroll` business approval (two signatures by default) →
 * one `Obligation payable employee` per line with a single `payroll` entry
 * (gross against withholdings, applied advances and the net payables) →
 * payments line by line → `paid` → `closed`. Advances are
 * `Obligation receivable employee` paid from a cash account and recovered
 * FIFO from the next payroll.
 */

type Db = Prisma.TransactionClient;

const idSchema = z.string().trim().min(1).max(120);
const optionalId = idSchema.nullish();

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export const employeeCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  position: z.string().trim().max(120).nullish(),
  userId: optionalId,
  areaKey: z.enum(AREA_KEYS).nullish(),
  costCenterId: optionalId,
});

export const employeeUpdateSchema = z.object({
  employeeId: idSchema,
  name: z.string().trim().min(2).max(120).optional(),
  position: z.string().trim().max(120).nullish(),
  userId: optionalId,
  areaKey: z.enum(AREA_KEYS).nullish(),
  costCenterId: optionalId,
  active: z.boolean().optional(),
});

async function assertEmployeeRefs(tx: Db, refs: { userId?: string | null; costCenterId?: string | null; employeeId?: string }): Promise<void> {
  if (refs.userId) {
    const user = await tx.user.findUnique({ where: { id: refs.userId }, select: { id: true, isBot: true } });
    if (!user || user.isBot) throw new OperationsError('not_found', 'El usuario no existe o es una identidad de IA');
    const taken = await tx.employee.findUnique({ where: { userId: refs.userId }, select: { id: true } });
    if (taken && taken.id !== refs.employeeId) throw financeError('duplicate', 'Ese usuario ya está ligado a otro empleado');
  }
  if (refs.costCenterId) {
    const center = await tx.costCenter.findUnique({ where: { id: refs.costCenterId }, select: { id: true } });
    if (!center) throw new OperationsError('not_found', 'El centro de costo no existe');
  }
}

export async function createEmployeeInTx(
  tx: Db,
  input: z.output<typeof employeeCreateSchema>,
  ctx: CommandContext
): Promise<{ employeeId: string; number: string }> {
  await assertEmployeeRefs(tx, input);
  const number = await nextNumber(tx, FINANCE_SEQUENCES.employee.key, FINANCE_SEQUENCES.employee.prefix);
  const row = await tx.employee.create({
    data: {
      number,
      name: input.name,
      position: input.position ?? null,
      userId: input.userId ?? null,
      areaKey: input.areaKey ?? null,
      costCenterId: input.costCenterId ?? null,
    },
  });
  ctx.emit(
    FINANCE_EVENTS.employee.created,
    { employeeId: row.id, number, name: row.name, areaKey: row.areaKey },
    financeEventOptions(FINANCE_OBJECT_TYPES.employee, row.id)
  );
  return { employeeId: row.id, number };
}

export async function updateEmployeeInTx(
  tx: Db,
  input: z.output<typeof employeeUpdateSchema>,
  ctx: CommandContext
): Promise<{ employeeId: string; active: boolean }> {
  const employee = await tx.employee.findUnique({ where: { id: input.employeeId } });
  if (!employee) throw new OperationsError('not_found', 'No se encontró el empleado');
  await assertEmployeeRefs(tx, { userId: input.userId, costCenterId: input.costCenterId, employeeId: employee.id });
  const row = await tx.employee.update({
    where: { id: employee.id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.areaKey !== undefined ? { areaKey: input.areaKey } : {}),
      ...(input.costCenterId !== undefined ? { costCenterId: input.costCenterId } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
  ctx.emit(
    FINANCE_EVENTS.employee.updated,
    { employeeId: row.id, number: row.number, active: row.active },
    financeEventOptions(FINANCE_OBJECT_TYPES.employee, row.id)
  );
  return { employeeId: row.id, active: row.active };
}

/** Open advances (receivable employee obligations) per employee, oldest first. */
export async function openAdvancesByEmployee(tx: Db, employeeIds: readonly string[]): Promise<Map<string, OpenAdvance[]>> {
  const map = new Map<string, OpenAdvance[]>();
  if (employeeIds.length === 0) return map;
  const rows = await tx.obligation.findMany({
    where: {
      kind: 'receivable',
      counterpartyType: 'employee',
      employeeId: { in: [...new Set(employeeIds)] },
      status: { in: [...OBLIGATION_OPEN_STATUSES] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const row of rows) {
    if (!row.employeeId) continue;
    const list = map.get(row.employeeId) ?? [];
    list.push({ obligationId: row.id, remaining: remainingOf(row), createdAt: row.createdAt });
    map.set(row.employeeId, list);
  }
  return map;
}

export const employeeAdvanceSchema = z.object({
  employeeId: idSchema,
  amount: positiveMoneySchema,
  cashAccountId: idSchema,
  date: dateKeySchema.nullish(),
  dueDate: dateKeySchema.nullish(),
  description: z.string().trim().max(500).nullish(),
});

/** Advance paid now from a cash account: Dr receivable(employee) / Cr cash. */
export async function grantEmployeeAdvanceInTx(
  tx: Db,
  input: z.output<typeof employeeAdvanceSchema>,
  ctx: CommandContext
): Promise<{ obligationId: string; number: string; ledgerEntryId: string | null }> {
  const employee = await tx.employee.findUnique({ where: { id: input.employeeId } });
  if (!employee) throw new OperationsError('not_found', 'No se encontró el empleado');
  if (!employee.active) throw financeError('invalid_state', `${employee.name} está dado de baja`);
  const { obligation, ledgerEntry } = await createObligationWithEntry(
    tx,
    {
      kind: 'receivable',
      counterpartyType: 'employee',
      counterpartyName: employee.name,
      employeeId: employee.id,
      description: (input.description ?? `Anticipo a ${employee.name}`).slice(0, 500),
      expectedAmount: input.amount,
      categoryKey: FINANCE_CATEGORY_KEYS.advances,
      costCenterId: employee.costCenterId,
      dueAt: input.dueDate ?? null,
      date: input.date ?? null,
      offset: { accountType: 'cash', accountId: input.cashAccountId },
    },
    ctx
  );
  ctx.emit(
    FINANCE_EVENTS.employee.advanceGranted,
    {
      employeeId: employee.id,
      obligationId: obligation.id,
      number: obligation.number,
      amount: roundMoney(input.amount).toFixed(2),
      cashAccountId: input.cashAccountId,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.employee, employee.id)
  );
  return { obligationId: obligation.id, number: obligation.number, ledgerEntryId: ledgerEntry?.id ?? null };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const deductionSchema = z.object({
  kind: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  amount: nonNegativeMoneySchema,
});

const payrollLineSchema = z.object({
  employeeId: idSchema,
  gross: nonNegativeMoneySchema,
  deductions: z.array(deductionSchema).max(20).default([]),
  advancesApplied: nonNegativeMoneySchema.default('0'),
  costCenterId: optionalId,
});

export const payrollCreateSchema = z.object({
  periodStart: dateKeySchema,
  periodEnd: dateKeySchema,
  currency: currencySchema.default('MXN'),
  lines: z.array(payrollLineSchema).min(1).max(500),
});

export const payrollUpdateSchema = z.object({
  payrollRunId: idSchema,
  periodStart: dateKeySchema.optional(),
  periodEnd: dateKeySchema.optional(),
  lines: z.array(payrollLineSchema).min(1).max(500).optional(),
});

export const payrollRunOnlySchema = z.object({ payrollRunId: idSchema });

export const payrollCreateObligationsSchema = z.object({
  payrollRunId: idSchema,
  /** Date of the payroll entry (default: today). */
  date: dateKeySchema.nullish(),
  /** Due date of the net payables (default: the end of the period). */
  dueDate: dateKeySchema.nullish(),
});

export const payrollPayLineSchema = z.object({
  payrollRunId: idSchema,
  employeeId: idSchema,
  cashAccountId: idSchema,
  date: dateKeySchema.nullish(),
  evidenceObjectIds: z.array(idSchema).max(20).default([]),
});

export const payrollCancelSchema = z.object({
  payrollRunId: idSchema,
  reason: z.string().trim().min(3).max(500),
});

type LineInput = z.output<typeof payrollLineSchema>;

interface BuiltLine {
  input: LineInput;
  computation: PayrollLineComputation;
}

async function buildLines(tx: Db, lines: readonly LineInput[]): Promise<BuiltLine[]> {
  const employeeIds = lines.map((l) => l.employeeId);
  const employees = await tx.employee.findMany({ where: { id: { in: [...new Set(employeeIds)] } } });
  const advances = await openAdvancesByEmployee(tx, employeeIds);
  const openTotals = new Map<string, Prisma.Decimal>();
  for (const [employeeId, list] of advances) {
    openTotals.set(employeeId, list.reduce((acc, a) => acc.plus(D(a.remaining)), new Prisma.Decimal(0)));
  }
  assertPayrollLines(lines, {
    employees: new Map(employees.map((e) => [e.id, { name: e.name, active: e.active }])),
    openAdvances: openTotals,
  });
  const centerIds = [...new Set(lines.map((l) => l.costCenterId).filter((id): id is string => Boolean(id)))];
  if (centerIds.length > 0) {
    const centers = await tx.costCenter.findMany({ where: { id: { in: centerIds } }, select: { id: true } });
    if (centers.length !== centerIds.length) throw new OperationsError('not_found', 'Un centro de costo de la nómina no existe');
  }
  return lines.map((input) => ({
    input,
    computation: computePayrollLine({ gross: input.gross, deductions: input.deductions, advancesApplied: input.advancesApplied }),
  }));
}

function lineData(payrollRunId: string, line: BuiltLine): Prisma.PayrollLineCreateManyInput {
  return {
    payrollRunId,
    employeeId: line.input.employeeId,
    gross: line.computation.gross,
    deductions: toOperationalJson(
      line.input.deductions.map((d) => ({ kind: d.kind, label: d.label, amount: roundMoney(d.amount).toFixed(2) }))
    ),
    advancesApplied: line.computation.advancesApplied,
    net: line.computation.net,
    costCenterId: line.input.costCenterId ?? null,
  };
}

async function loadRun(tx: Db, id: string): Promise<PayrollRun & { lines: PayrollLine[] }> {
  const run = await tx.payrollRun.findUnique({ where: { id }, include: { lines: true } });
  if (!run) throw new OperationsError('not_found', 'No se encontró la nómina');
  return run;
}

function emitRun(ctx: CommandContext, type: string, run: PayrollRun, extra: Record<string, unknown> = {}): void {
  ctx.emit(
    type,
    {
      payrollRunId: run.id,
      number: run.number,
      periodKey: run.periodKey,
      status: run.status,
      totalNet: D(run.totalNet).toFixed(2),
      currency: run.currency,
      ...extra,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.payrollRun, run.id)
  );
  publishBoard(ctx, 'finance.payroll', { payrollRunId: run.id, number: run.number, status: run.status });
}

export async function createPayrollRunInTx(
  tx: Db,
  input: z.output<typeof payrollCreateSchema>,
  ctx: CommandContext
): Promise<{ payrollRunId: string; number: string; totalNet: string; version: number }> {
  const period = payrollPeriod(input.periodStart, input.periodEnd);
  const lines = await buildLines(tx, input.lines);
  const totals = computePayrollTotals(lines.map((l) => l.computation));
  const number = await nextNumber(tx, FINANCE_SEQUENCES.payrollRun.key, FINANCE_SEQUENCES.payrollRun.prefix);
  const run = await tx.payrollRun.create({
    data: {
      number,
      periodKey: period.periodKey,
      periodStart: toDbDate(period.startKey),
      periodEnd: toDbDate(period.endKey),
      currency: input.currency,
      totalGross: totals.totalGross,
      totalDeductions: totals.totalDeductions,
      totalNet: totals.totalNet,
      createdByUserId: actorUserIdOf(ctx),
    },
  });
  await tx.payrollLine.createMany({ data: lines.map((line) => lineData(run.id, line)) });
  emitRun(ctx, FINANCE_EVENTS.payroll.created, run, { lines: lines.length });
  return { payrollRunId: run.id, number, totalNet: totals.totalNet.toFixed(2), version: run.version };
}

export async function updatePayrollRunInTx(
  tx: Db,
  input: z.output<typeof payrollUpdateSchema>,
  ctx: CommandContext
): Promise<{ payrollRunId: string; totalNet: string }> {
  const run = await loadRun(tx, input.payrollRunId);
  if (run.status !== 'draft') throw financeError('invalid_state', `La nómina ${run.number} ya no es un borrador`);
  const period = payrollPeriod(input.periodStart ?? dateKeyOf(run.periodStart), input.periodEnd ?? dateKeyOf(run.periodEnd));
  const data: Prisma.PayrollRunUpdateInput = {
    periodKey: period.periodKey,
    periodStart: toDbDate(period.startKey),
    periodEnd: toDbDate(period.endKey),
  };
  if (input.lines) {
    const lines = await buildLines(tx, input.lines);
    const totals = computePayrollTotals(lines.map((l) => l.computation));
    await tx.payrollLine.deleteMany({ where: { payrollRunId: run.id } });
    await tx.payrollLine.createMany({ data: lines.map((line) => lineData(run.id, line)) });
    Object.assign(data, { totalGross: totals.totalGross, totalDeductions: totals.totalDeductions, totalNet: totals.totalNet });
  }
  const updated = await tx.payrollRun.update({ where: { id: run.id }, data });
  emitRun(ctx, FINANCE_EVENTS.payroll.updated, updated);
  return { payrollRunId: updated.id, totalNet: D(updated.totalNet).toFixed(2) };
}

export async function submitPayrollRunInTx(
  tx: Db,
  input: z.output<typeof payrollRunOnlySchema>,
  ctx: CommandContext
): Promise<{ payrollRunId: string; status: string; approvalRequestId: string; requiredApprovals: number }> {
  const run = await loadRun(tx, input.payrollRunId);
  if (run.status !== 'draft') throw financeError('invalid_state', `La nómina ${run.number} ya fue enviada`);
  if (run.lines.length === 0 || !D(run.totalGross).greaterThan(0)) {
    throw financeError('invalid_state', 'La nómina no tiene importes');
  }
  // Advances may have changed since the draft: re-validate against the directory.
  await buildLines(
    tx,
    run.lines.map((line) => ({
      employeeId: line.employeeId,
      gross: D(line.gross),
      deductions: [],
      advancesApplied: D(line.advancesApplied),
      costCenterId: line.costCenterId,
    }))
  );
  await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'pending_approval' } });
  const outcome = await requestApproval(tx, {
    scope: 'payroll',
    targetType: FINANCE_OBJECT_TYPES.payrollRun,
    targetId: run.id,
    amount: run.totalGross,
    currency: run.currency,
    areaKey: FINANCE_AREA_KEY,
    requestedByUserId: actorUserIdOf(ctx),
    title: `Nómina ${run.number} (${dateKeyOf(run.periodStart)} a ${dateKeyOf(run.periodEnd)})`,
    description: `${run.lines.length} empleado(s) · neto ${D(run.totalNet).toFixed(2)} ${run.currency}`,
  });
  const updated = await tx.payrollRun.update({ where: { id: run.id }, data: { approvalRequestId: outcome.approvalRequest.id } });
  emitRun(ctx, FINANCE_EVENTS.payroll.submitted, updated, {
    approvalRequestId: outcome.approvalRequest.id,
    requiredApprovals: outcome.approvalRequest.requiredApprovals,
  });
  return {
    payrollRunId: updated.id,
    status: updated.status,
    approvalRequestId: outcome.approvalRequest.id,
    requiredApprovals: outcome.approvalRequest.requiredApprovals,
  };
}

export async function createPayrollObligationsInTx(
  tx: Db,
  input: z.output<typeof payrollCreateObligationsSchema>,
  ctx: CommandContext
): Promise<{ payrollRunId: string; status: string; ledgerEntryId: string; obligationIds: string[] }> {
  const run = await loadRun(tx, input.payrollRunId);
  if (run.status !== 'approved') {
    throw financeError('invalid_state', `La nómina ${run.number} debe estar aprobada (está ${run.status})`);
  }
  const employees = await tx.employee.findMany({ where: { id: { in: run.lines.map((l) => l.employeeId) } } });
  const employeesById = new Map(employees.map((e) => [e.id, e]));
  const advances = await openAdvancesByEmployee(tx, run.lines.map((l) => l.employeeId));
  const categoryId = await categoryIdByKey(tx, FINANCE_CATEGORY_KEYS.payroll);
  const dateKey = input.date ?? todayKeyOf(ctx);
  const dueKey = input.dueDate ?? dateKeyOf(run.periodEnd);

  const prepared = [];
  for (const line of [...run.lines].sort((a, b) => a.employeeId.localeCompare(b.employeeId))) {
    const employee = employeesById.get(line.employeeId);
    if (!employee) throw new OperationsError('not_found', 'Un empleado de la nómina ya no existe');
    const deductions = Array.isArray(line.deductions)
      ? (line.deductions as Array<Record<string, unknown>>).map((d) => ({
          kind: String(d?.kind ?? 'other'),
          label: String(d?.label ?? ''),
          amount: String(d?.amount ?? '0'),
        }))
      : [];
    const computation = computePayrollLine({ gross: line.gross, deductions, advancesApplied: line.advancesApplied });
    const advanceAllocations = allocateAdvances(computation.advancesApplied, advances.get(line.employeeId) ?? []);
    const costCenterId = line.costCenterId ?? employee.costCenterId;
    let obligationId: string | null = null;
    if (computation.net.greaterThan(0)) {
      const { obligation } = await createObligationWithEntry(
        tx,
        {
          kind: 'payable',
          counterpartyType: 'employee',
          counterpartyName: employee.name,
          employeeId: employee.id,
          payrollRunId: run.id,
          description: `${run.number} · ${employee.name}`,
          currency: run.currency,
          expectedAmount: computation.net,
          dueAt: dueKey,
          categoryId,
          costCenterId,
          postLedger: false,
        },
        ctx
      );
      obligationId = obligation.id;
    }
    prepared.push({ line, employee, computation, advanceAllocations, costCenterId, obligationId });
  }

  const entry = await postLedgerEntry(
    tx,
    {
      kind: 'payroll',
      dateKey,
      description: `Nómina ${run.number} (${dateKeyOf(run.periodStart)} a ${dateKeyOf(run.periodEnd)})`,
      currency: run.currency,
      sourceType: LEDGER_SOURCE_TYPES.payrollRun,
      sourceId: run.id,
      meta: { periodKey: run.periodKey, lines: run.lines.length },
      lines: payrollEntryLines({
        runNumber: run.number,
        categoryId,
        lines: prepared.map((p) => ({
          employeeId: p.employee.id,
          employeeName: p.employee.name,
          computation: p.computation,
          costCenterId: p.costCenterId,
          obligationId: p.obligationId,
          advanceAllocations: p.advanceAllocations,
        })),
      }),
    },
    ctx
  );
  const obligationIds = prepared.map((p) => p.obligationId).filter((id): id is string => Boolean(id));
  if (obligationIds.length > 0) {
    await tx.obligation.updateMany({ where: { id: { in: obligationIds } }, data: { ledgerEntryId: entry.id } });
  }
  for (const p of prepared) {
    for (const advance of p.advanceAllocations) {
      await settleObligationInTx(
        tx,
        { obligationId: advance.obligationId, amount: advance.amount, dateKey, memo: `Descontado en ${run.number}` },
        ctx,
        { ledgerEntryId: entry.id, skipAuthorization: true }
      );
    }
    await tx.payrollLine.update({
      where: { id: p.line.id },
      data: { obligationId: p.obligationId, status: p.obligationId ? 'pending' : 'paid' },
    });
  }
  const allPaid = prepared.every((p) => !p.obligationId);
  const updated = await tx.payrollRun.update({
    where: { id: run.id },
    data: { status: allPaid ? 'paid' : 'obligations_created' },
  });
  emitRun(ctx, FINANCE_EVENTS.payroll.obligationsCreated, updated, { ledgerEntryId: entry.id, obligations: obligationIds.length });
  return { payrollRunId: updated.id, status: updated.status, ledgerEntryId: entry.id, obligationIds };
}

export async function payPayrollLineInTx(
  tx: Db,
  input: z.output<typeof payrollPayLineSchema>,
  ctx: CommandContext
): Promise<{ payrollRunId: string; runStatus: string; obligationId: string; settlementId: string; ledgerEntryId: string }> {
  const run = await loadRun(tx, input.payrollRunId);
  if (run.status !== 'obligations_created') {
    throw financeError('invalid_state', `La nómina ${run.number} no está por pagar (está ${run.status})`);
  }
  const line = run.lines.find((l) => l.employeeId === input.employeeId);
  if (!line) throw new OperationsError('not_found', 'El empleado no está en esta nómina');
  if (line.status === 'paid' || !line.obligationId) throw financeError('invalid_state', 'Esta línea de nómina ya está pagada');
  const obligation = await tx.obligation.findUniqueOrThrow({ where: { id: line.obligationId } });
  const result = await settleObligationInTx(
    tx,
    {
      obligationId: obligation.id,
      amount: remainingOf(obligation),
      cashAccountId: input.cashAccountId,
      dateKey: input.date ?? null,
      evidenceObjectIds: input.evidenceObjectIds,
      memo: `Pago de ${run.number}`,
    },
    ctx,
    { skipAuthorization: true }
  );
  const refreshed = await tx.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
  return {
    payrollRunId: run.id,
    runStatus: refreshed.status,
    obligationId: obligation.id,
    settlementId: result.settlement.id,
    ledgerEntryId: result.settlement.ledgerEntryId,
  };
}

export async function closePayrollRunInTx(
  tx: Db,
  input: z.output<typeof payrollRunOnlySchema>,
  ctx: CommandContext
): Promise<{ payrollRunId: string; status: string }> {
  const run = await loadRun(tx, input.payrollRunId);
  if (run.status !== 'paid') throw financeError('invalid_state', `La nómina ${run.number} debe estar pagada para cerrarse`);
  const updated = await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'closed' } });
  emitRun(ctx, FINANCE_EVENTS.payroll.closed, updated);
  return { payrollRunId: updated.id, status: updated.status };
}

/**
 * Cancels a run before any payment: drafts and pending/approved runs just end;
 * a run with obligations reverses its payroll entry once, cancels the net
 * payables and gives back the advances it had applied.
 */
export async function cancelPayrollRunInTx(
  tx: Db,
  input: z.output<typeof payrollCancelSchema>,
  ctx: CommandContext
): Promise<{ payrollRunId: string; status: string; reversalEntryId: string | null }> {
  const run = await loadRun(tx, input.payrollRunId);
  if (run.status === 'cancelled') return { payrollRunId: run.id, status: run.status, reversalEntryId: null };
  if (run.status === 'paid' || run.status === 'closed') {
    throw financeError('invalid_state', `La nómina ${run.number} ya se pagó: registra la corrección con un asiento nuevo`);
  }
  let reversalEntryId: string | null = null;
  if (run.status === 'obligations_created') {
    const obligationIds = run.lines.map((l) => l.obligationId).filter((id): id is string => Boolean(id));
    const obligations = await tx.obligation.findMany({ where: { id: { in: obligationIds } } });
    if (obligations.some((o) => D(o.settledAmount).greaterThan(0))) {
      throw financeError('has_settlements', `La nómina ${run.number} ya tiene pagos: reversa esos pagos antes de cancelarla`);
    }
    const entry = await tx.ledgerEntry.findFirst({
      where: { sourceType: LEDGER_SOURCE_TYPES.payrollRun, sourceId: run.id, kind: 'payroll', reversedByEntryId: null },
    });
    if (entry) {
      const { reversal } = await reverseLedgerEntry(tx, { entryId: entry.id, reason: `Cancelación de ${run.number}: ${input.reason}` }, ctx);
      reversalEntryId = reversal.id;
      const advanceSettlements = await tx.obligationSettlement.findMany({ where: { ledgerEntryId: entry.id } });
      await recordSettlementReversalRows(tx, advanceSettlements, reversal.id, ctx);
    }
    for (const obligation of obligations) {
      await cancelObligation(tx, obligation.id, `Cancelación de ${run.number}: ${input.reason}`, ctx, { skipLedger: true });
    }
  }
  const updated = await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'cancelled' } });
  emitRun(ctx, FINANCE_EVENTS.payroll.cancelled, updated, { reason: input.reason, reversalEntryId });
  return { payrollRunId: updated.id, status: updated.status, reversalEntryId };
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

type GlobalWithPayrollReactions = typeof globalThis & { __unikFinancePayrollReactions?: boolean };

export function registerPayrollReactions(): void {
  const scope = globalThis as GlobalWithPayrollReactions;
  if (scope.__unikFinancePayrollReactions) return;
  scope.__unikFinancePayrollReactions = true;

  onApprovalDecided(FINANCE_OBJECT_TYPES.payrollRun, async (tx, event) => {
    if (event.approvalRequest.scope !== 'payroll') return;
    const run = await tx.payrollRun.findUnique({ where: { id: event.approvalRequest.targetId } });
    if (!run || run.status !== 'pending_approval') return;
    const approved = event.status === 'approved';
    const updated = await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        status: approved ? 'approved' : 'draft',
        approvalRequestId: event.approvalRequest.id,
        ...(event.auto ? {} : { version: { increment: 1 } }),
      },
    });
    emitRun(event.ctx, approved ? FINANCE_EVENTS.payroll.approved : FINANCE_EVENTS.payroll.rejected, updated, {
      approvalRequestId: event.approvalRequest.id,
      decidedByUserId: event.decidedByUserId,
    });
  });

  onObligationSettled('payroll_run', async (tx, obligation, _settlement, ctx) => {
    if (obligation.status !== 'settled') return;
    const line = await tx.payrollLine.findFirst({ where: { obligationId: obligation.id } });
    if (!line || line.status === 'paid') return;
    await tx.payrollLine.update({ where: { id: line.id }, data: { status: 'paid' } });
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: line.payrollRunId }, include: { lines: true } });
    ctx.emit(
      FINANCE_EVENTS.payroll.linePaid,
      { payrollRunId: run.id, number: run.number, employeeId: line.employeeId, obligationId: obligation.id },
      financeEventOptions(FINANCE_OBJECT_TYPES.payrollRun, run.id)
    );
    if (run.status === 'obligations_created' && isPayrollFullyPaid(run.lines)) {
      // Inside pay_line the run is the command aggregate (the engine bumped it).
      const bump = ctx.commandType === FINANCE_COMMANDS.payrollPayLine ? {} : { version: { increment: 1 } };
      const paid = await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'paid', ...bump } });
      emitRun(ctx, FINANCE_EVENTS.payroll.paid, paid);
    }
  });

  // A reversed payment of a payroll line: the line owes again and the run goes back to
  // `obligations_created`, so the line is paid again through payroll (pay_line).
  onObligationSettlementReversed('payroll_run', async (tx, obligation, _settlement, ctx) => {
    if (obligation.status === 'settled') return;
    const line = await tx.payrollLine.findFirst({ where: { obligationId: obligation.id } });
    if (!line) return;
    if (line.status === 'paid') {
      await tx.payrollLine.update({ where: { id: line.id }, data: { status: 'pending' } });
    }
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: line.payrollRunId } });
    ctx.emit(
      FINANCE_EVENTS.payroll.lineUnpaid,
      { payrollRunId: run.id, number: run.number, employeeId: line.employeeId, obligationId: obligation.id, previousRunStatus: run.status },
      financeEventOptions(FINANCE_OBJECT_TYPES.payrollRun, run.id)
    );
    if (run.status === 'paid' || run.status === 'closed') {
      const reopened = await tx.payrollRun.update({
        where: { id: run.id },
        data: { status: 'obligations_created', version: { increment: 1 } },
      });
      emitRun(ctx, FINANCE_EVENTS.payroll.reopened, reopened, { previousStatus: run.status, obligationId: obligation.id });
    }
  });
}

registerPayrollReactions();
