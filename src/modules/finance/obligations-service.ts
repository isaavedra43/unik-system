import { Prisma, type Obligation, type ObligationSettlement } from '@prisma/client';
import { z } from 'zod';
import type { CurrentUser } from '@/modules/auth/authorization';
import { isKnownPermission } from '@/modules/auth/permissions';
import {
  approverPermissionsFor,
  onApprovalDecided,
  registerApprovalScopePermission,
  requestApproval,
  type RequestApprovalOutcome,
} from '@/modules/operations/approvals-service';
import {
  ConcurrencyConflict,
  type CommandContext,
  type CommandResult,
} from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { nextNumber } from '@/modules/operations/sequence-service';
import { FINANCE_CATEGORY_KEYS, categoryIdByKey } from './catalog-service';
import { financeError } from './finance-errors';
import { dateKeyOf, dateKeySchema, toDbDate } from './finance-dates';
import {
  actorUserIdOf,
  financeEventOptions,
  publishBoard,
  runFinanceCommand,
  todayKeyOf,
  type FinanceCommandOptions,
} from './finance-helpers';
import { postLedgerEntry, reverseLedgerEntry, type LedgerEntryWithLines } from './ledger-service';
import {
  D,
  MONEY_TOLERANCE,
  currencySchema,
  formatMxn,
  positiveMoneySchema,
  roundMoney,
} from './money';
import {
  assertPaymentAuthorized,
  assertSettleable,
  isOpenObligationStatus,
  isReversalExternalRef,
  nextObligationStatus,
  obligationEntryLines,
  obligationSourceOf,
  paymentAuthorizationState,
  remainingOf,
  reversalExternalRef,
  settlementEntryLines,
  writeOffEntryLines,
} from './obligation-rules';
import {
  COUNTERPARTY_TYPES,
  EXPENSE_CATEGORY_KINDS,
  FINANCE_AREA_KEY,
  FINANCE_COMMANDS,
  FINANCE_EVENTS,
  FINANCE_OBJECT_TYPES,
  FINANCE_SEQUENCES,
  LEDGER_SOURCE_TYPES,
  OBLIGATION_KINDS,
  type CounterpartyType,
  type ObligationKind,
} from './types';

/**
 * Payables and receivables (plan 6.4) — the contracts shared with the other
 * modules of the phase:
 *
 * - `createObligation(tx, input, ctx)` → Obligation (with its `obligation`
 *   entry unless `postLedger: false`), inside the caller's command;
 * - `settleObligation(actor, input, opts)` → `finance.obligation.settle`
 *   command: `settlement` entry (only settlements move cash), status update
 *   and the handlers registered with `onObligationSettled(sourceType, …)`
 *   (e.g. purchases registers `markOrderPaid` for `procurement_order`);
 * - `cancelObligation(tx, id, reason, ctx)`: reverses its entry and cancels
 *   it (never with money applied: reverse the settlements first).
 *
 * Payables of a supplier purchase are paid only after their `payment`
 * business approval (approvals-service); payables born from an approved
 * expense or payroll run need none.
 */

type Db = Prisma.TransactionClient;

/** Relation written by the agents layer from an AI-created request to the human who caused it. */
const CAUSED_BY_RELATION = 'caused_by';

const idSchema = z.string().trim().min(1).max(120);
const optionalId = idSchema.nullish();

export const obligationAllocationSchema = z.object({
  amount: positiveMoneySchema,
  costCenterId: optionalId,
  caseId: optionalId,
  projectRef: z.string().trim().max(120).nullish(),
  memo: z.string().trim().max(500).nullish(),
});

export const createObligationSchema = z.object({
  kind: z.enum(OBLIGATION_KINDS),
  counterpartyType: z.enum(COUNTERPARTY_TYPES),
  counterpartyName: z.string().trim().max(200).nullish(),
  supplierId: optionalId,
  zohoContactId: optionalId,
  employeeId: optionalId,
  caseId: optionalId,
  procurementOrderId: optionalId,
  payrollRunId: optionalId,
  expenseId: optionalId,
  zohoSalesOrderId: optionalId,
  zohoInvoiceId: optionalId,
  description: z.string().trim().min(3).max(500),
  currency: currencySchema.default('MXN'),
  expectedAmount: positiveMoneySchema,
  /** Due date (AAAA-MM-DD). */
  dueAt: dateKeySchema.nullish(),
  expectedCashAt: dateKeySchema.nullish(),
  categoryId: optionalId,
  /** Seeded category key when the id is not known (e.g. 'compras_mercancia'). */
  categoryKey: z.string().trim().max(60).nullish(),
  costCenterId: optionalId,
  /** Date of the obligation entry (default: today). */
  date: dateKeySchema.nullish(),
  postLedger: z.boolean().default(true),
  allocations: z.array(obligationAllocationSchema).max(50).optional(),
  offset: z
    .object({
      accountType: z.enum(['category', 'cash', 'clearing', 'equity']),
      accountId: idSchema,
    })
    .optional(),
  evidenceObjectIds: z.array(idSchema).max(20).default([]),
});

export type CreateObligationInput = z.input<typeof createObligationSchema>;

export function defaultCategoryKeyFor(
  kind: ObligationKind,
  counterpartyType: CounterpartyType
): string {
  if (kind === 'receivable') {
    if (counterpartyType === 'customer') return FINANCE_CATEGORY_KEYS.sales;
    if (counterpartyType === 'employee') return FINANCE_CATEGORY_KEYS.advances;
    return FINANCE_CATEGORY_KEYS.otherIncome;
  }
  switch (counterpartyType) {
    case 'supplier':
      return FINANCE_CATEGORY_KEYS.supplierPurchases;
    case 'employee':
      return FINANCE_CATEGORY_KEYS.payroll;
    case 'tax':
      return FINANCE_CATEGORY_KEYS.taxes;
    case 'lender':
      return FINANCE_CATEGORY_KEYS.loans;
    default:
      return FINANCE_CATEGORY_KEYS.general;
  }
}

function describeZod(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
    )
    .join('; ');
}

export interface CreateObligationResult {
  obligation: Obligation;
  ledgerEntry: LedgerEntryWithLines | null;
}

export async function createObligationWithEntry(
  tx: Db,
  rawInput: CreateObligationInput,
  ctx: CommandContext
): Promise<CreateObligationResult> {
  const parsed = createObligationSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new OperationsError(
      'invalid_payload',
      `Obligación inválida: ${describeZod(parsed.error)}`
    );
  }
  const input = parsed.data;
  const categoryId =
    input.categoryId ??
    (await categoryIdByKey(
      tx,
      input.categoryKey ?? defaultCategoryKeyFor(input.kind, input.counterpartyType)
    ));
  const category = await tx.financeCategory.findUnique({ where: { id: categoryId } });
  if (!category) throw new OperationsError('not_found', 'La categoría de la obligación no existe');
  if (category.status !== 'active') {
    throw financeError('account_inactive', `La categoría ${category.name} está archivada`);
  }
  const offsetIsCategory = !input.offset || input.offset.accountType === 'category';
  if (offsetIsCategory) {
    const allowed =
      input.kind === 'receivable' ? ['income'] : (EXPENSE_CATEGORY_KINDS as readonly string[]);
    if (!allowed.includes(category.kind)) {
      throw financeError(
        'invalid_line',
        `La categoría ${category.name} no corresponde a una cuenta ${input.kind === 'receivable' ? 'por cobrar' : 'por pagar'}`
      );
    }
  }
  if (input.costCenterId) {
    const center = await tx.costCenter.findUnique({
      where: { id: input.costCenterId },
      select: { id: true },
    });
    if (!center) throw new OperationsError('not_found', 'El centro de costo no existe');
  }
  if (input.employeeId) {
    const employee = await tx.employee.findUnique({
      where: { id: input.employeeId },
      select: { id: true },
    });
    if (!employee) throw new OperationsError('not_found', 'El empleado no existe');
  }
  if (input.caseId) {
    const found = await tx.operationalCase.findUnique({
      where: { id: input.caseId },
      select: { id: true },
    });
    if (!found) throw new OperationsError('not_found', 'No se encontró el expediente');
  }

  const number = await nextNumber(
    tx,
    FINANCE_SEQUENCES.obligation.key,
    FINANCE_SEQUENCES.obligation.prefix
  );
  const amount = roundMoney(input.expectedAmount);
  let obligation = await tx.obligation.create({
    data: {
      number,
      kind: input.kind,
      counterpartyType: input.counterpartyType,
      counterpartyName: input.counterpartyName ?? null,
      supplierId: input.supplierId ?? null,
      zohoContactId: input.zohoContactId ?? null,
      employeeId: input.employeeId ?? null,
      caseId: input.caseId ?? null,
      procurementOrderId: input.procurementOrderId ?? null,
      payrollRunId: input.payrollRunId ?? null,
      expenseId: input.expenseId ?? null,
      zohoSalesOrderId: input.zohoSalesOrderId ?? null,
      zohoInvoiceId: input.zohoInvoiceId ?? null,
      description: input.description,
      currency: input.currency,
      expectedAmount: amount,
      settledAmount: new Prisma.Decimal(0),
      dueAt: input.dueAt ? toDbDate(input.dueAt) : null,
      expectedCashAt: input.expectedCashAt
        ? toDbDate(input.expectedCashAt)
        : input.dueAt
          ? toDbDate(input.dueAt)
          : null,
      status: 'expected',
      categoryId,
      costCenterId: input.costCenterId ?? null,
    },
  });

  let ledgerEntry: LedgerEntryWithLines | null = null;
  if (input.postLedger) {
    ledgerEntry = await postLedgerEntry(
      tx,
      {
        kind: 'obligation',
        dateKey: input.date ?? todayKeyOf(ctx),
        description: `${number} · ${input.description}`,
        currency: input.currency,
        sourceType: LEDGER_SOURCE_TYPES.obligation,
        sourceId: obligation.id,
        evidenceObjectIds: input.evidenceObjectIds,
        meta: { source: obligationSourceOf(obligation), counterpartyType: input.counterpartyType },
        lines: obligationEntryLines({
          kind: input.kind,
          obligationId: obligation.id,
          amount,
          categoryId,
          costCenterId: input.costCenterId ?? null,
          caseId: input.caseId ?? null,
          procurementOrderId: input.procurementOrderId ?? null,
          allocations: input.allocations,
          offset: input.offset,
          memo: input.description,
        }),
      },
      ctx
    );
    obligation = await tx.obligation.update({
      where: { id: obligation.id },
      data: { ledgerEntryId: ledgerEntry.id },
    });
  }

  ctx.emit(
    FINANCE_EVENTS.obligation.created,
    {
      obligationId: obligation.id,
      number,
      kind: obligation.kind,
      source: obligationSourceOf(obligation),
      counterpartyType: obligation.counterpartyType,
      counterpartyName: obligation.counterpartyName,
      amount: amount.toFixed(2),
      currency: obligation.currency,
      dueAt: input.dueAt ?? null,
      ledgerEntryId: obligation.ledgerEntryId,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.obligation, obligation.id, obligation.caseId)
  );
  publishBoard(ctx, 'finance.obligation', {
    obligationId: obligation.id,
    number,
    status: obligation.status,
  });
  return { obligation, ledgerEntry };
}

/** Contract: creates the obligation (and its entry) inside the caller's command. */
export async function createObligation(
  tx: Db,
  input: CreateObligationInput,
  ctx: CommandContext
): Promise<Obligation> {
  return (await createObligationWithEntry(tx, input, ctx)).obligation;
}

// ---------------------------------------------------------------------------
// Settlement handlers
// ---------------------------------------------------------------------------

export type ObligationSettledHandler = (
  tx: Db,
  obligation: Obligation,
  settlement: ObligationSettlement,
  ctx: CommandContext
) => Promise<void>;

type GlobalWithObligationHandlers = typeof globalThis & {
  __unikObligationSettledHandlers?: Map<string, Set<ObligationSettledHandler>>;
  __unikFinanceObligationReactions?: boolean;
};

function settledHandlers(): Map<string, Set<ObligationSettledHandler>> {
  const scope = globalThis as GlobalWithObligationHandlers;
  if (!scope.__unikObligationSettledHandlers) scope.__unikObligationSettledHandlers = new Map();
  return scope.__unikObligationSettledHandlers;
}

/**
 * Registers a reaction to settlements of obligations of `sourceType`
 * (`procurement_order`, `payroll_run`, `expense`, `sales_order`,
 * `employee_advance`, `manual`). Runs inside the settling transaction.
 */
export function onObligationSettled(
  sourceType: string,
  handler: ObligationSettledHandler
): () => void {
  const map = settledHandlers();
  const set = map.get(sourceType) ?? new Set<ObligationSettledHandler>();
  set.add(handler);
  map.set(sourceType, set);
  return () => {
    set.delete(handler);
  };
}

export type ObligationSettlementReversedHandler = (
  tx: Db,
  obligation: Obligation,
  reversedSettlement: ObligationSettlement,
  ctx: CommandContext
) => Promise<void>;

type GlobalWithReversalHandlers = typeof globalThis & {
  __unikObligationSettlementReversedHandlers?: Map<
    string,
    Set<ObligationSettlementReversedHandler>
  >;
};

function reversedHandlers(): Map<string, Set<ObligationSettlementReversedHandler>> {
  const scope = globalThis as GlobalWithReversalHandlers;
  if (!scope.__unikObligationSettlementReversedHandlers)
    scope.__unikObligationSettlementReversedHandlers = new Map();
  return scope.__unikObligationSettlementReversedHandlers;
}

/**
 * Counterpart of `onObligationSettled`: runs inside the transaction that
 * reverses a settlement of an obligation of `sourceType`, with the obligation
 * already back to `expected` / `partially_settled`, so the owning module undoes
 * what the payment had done (payroll line and run back to unpaid, purchase
 * order payment status recomputed).
 */
export function onObligationSettlementReversed(
  sourceType: string,
  handler: ObligationSettlementReversedHandler
): () => void {
  const map = reversedHandlers();
  const set = map.get(sourceType) ?? new Set<ObligationSettlementReversedHandler>();
  set.add(handler);
  map.set(sourceType, set);
  return () => {
    set.delete(handler);
  };
}

async function runSettledHandlers(
  tx: Db,
  obligation: Obligation,
  settlement: ObligationSettlement,
  ctx: CommandContext
): Promise<void> {
  for (const handler of settledHandlers().get(obligationSourceOf(obligation)) ?? []) {
    await handler(tx, obligation, settlement, ctx);
  }
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

async function updateObligation(
  tx: Db,
  obligation: Obligation,
  data: Prisma.ObligationUpdateManyMutationInput,
  bumpVersion: boolean
): Promise<Obligation> {
  if (!bumpVersion) return tx.obligation.update({ where: { id: obligation.id }, data });
  const updated = await tx.obligation.updateMany({
    where: { id: obligation.id, version: obligation.version },
    data: { ...data, version: { increment: 1 } },
  });
  if (updated.count !== 1) throw new ConcurrencyConflict();
  return tx.obligation.findUniqueOrThrow({ where: { id: obligation.id } });
}

export interface SettleObligationInTxInput {
  obligationId: string;
  amount: Prisma.Decimal.Value;
  cashAccountId?: string | null;
  dateKey?: string | null;
  evidenceObjectIds?: readonly string[];
  memo?: string | null;
  zohoPaymentId?: string | null;
  externalRef?: string | null;
}

export interface SettleInTxOptions {
  /** False when the obligation is the command aggregate (the engine already bumped it). */
  bumpVersion?: boolean;
  /** Settlement recorded by an entry already posted (payroll advances); no cash movement here. */
  ledgerEntryId?: string | null;
  /** Payroll / internal flows that were approved upstream. */
  skipAuthorization?: boolean;
}

export interface SettleInTxResult {
  obligation: Obligation;
  settlement: ObligationSettlement;
  ledgerEntry: LedgerEntryWithLines | null;
}

export async function settleObligationInTx(
  tx: Db,
  input: SettleObligationInTxInput,
  ctx: CommandContext,
  options: SettleInTxOptions = {}
): Promise<SettleInTxResult> {
  const obligation = await tx.obligation.findUnique({ where: { id: input.obligationId } });
  if (!obligation) throw new OperationsError('not_found', 'No se encontró la obligación');
  const amount = roundMoney(D(input.amount));
  assertSettleable(obligation, amount);
  if (!options.skipAuthorization && obligation.kind === 'payable') {
    const approvals = await tx.approvalRequest.findMany({
      where: {
        scope: 'payment',
        targetType: FINANCE_OBJECT_TYPES.obligation,
        targetId: obligation.id,
      },
      select: { status: true, createdAt: true },
    });
    assertPaymentAuthorized(paymentAuthorizationState(obligation, approvals), obligation.number);
  }
  if (input.externalRef) {
    const existing = await tx.obligationSettlement.findUnique({
      where: { externalRef: input.externalRef },
      select: { id: true },
    });
    if (existing) throw financeError('duplicate', 'Este pago ya fue aplicado a la obligación');
  }

  const today = todayKeyOf(ctx);
  const dateKey = input.dateKey ?? today;
  let ledgerEntry: LedgerEntryWithLines | null = null;
  let ledgerEntryId = options.ledgerEntryId ?? null;
  if (!ledgerEntryId) {
    if (!input.cashAccountId) {
      throw financeError('invalid_payload', 'Indica la cuenta de caja o banco del pago');
    }
    const verb = obligation.kind === 'receivable' ? 'Cobro' : 'Pago';
    ledgerEntry = await postLedgerEntry(
      tx,
      {
        kind: 'settlement',
        dateKey,
        description: `${verb} ${obligation.number} · ${obligation.description}`.slice(0, 500),
        currency: obligation.currency,
        sourceType: LEDGER_SOURCE_TYPES.obligation,
        sourceId: obligation.id,
        evidenceObjectIds: input.evidenceObjectIds,
        meta: {
          zohoPaymentId: input.zohoPaymentId ?? null,
          externalRef: input.externalRef ?? null,
          memo: input.memo ?? null,
        },
        lines: settlementEntryLines({
          kind: obligation.kind as ObligationKind,
          obligationId: obligation.id,
          amount,
          cashAccountId: input.cashAccountId,
          caseId: obligation.caseId,
          procurementOrderId: obligation.procurementOrderId,
          memo: input.memo ?? null,
        }),
      },
      ctx
    );
    ledgerEntryId = ledgerEntry.id;
  }

  const settlement = await tx.obligationSettlement.create({
    data: {
      obligationId: obligation.id,
      ledgerEntryId,
      amount,
      settledAt: dateKey === today ? ctx.now : toDbDate(dateKey),
      cashAccountId: options.ledgerEntryId ? null : (input.cashAccountId ?? null),
      zohoPaymentId: input.zohoPaymentId ?? null,
      externalRef: input.externalRef ?? null,
      evidenceObjectIds: [...new Set(input.evidenceObjectIds ?? [])].slice(0, 20),
      createdByUserId: actorUserIdOf(ctx),
    },
  });
  const settledAmount = roundMoney(D(obligation.settledAmount).plus(amount));
  const updated = await updateObligation(
    tx,
    obligation,
    {
      settledAmount,
      status: nextObligationStatus(obligation.status, obligation.expectedAmount, settledAmount),
    },
    options.bumpVersion ?? true
  );

  ctx.emit(
    FINANCE_EVENTS.obligation.settled,
    {
      obligationId: updated.id,
      number: updated.number,
      kind: updated.kind,
      source: obligationSourceOf(updated),
      settlementId: settlement.id,
      amount: amount.toFixed(2),
      currency: updated.currency,
      settledAmount: settledAmount.toFixed(2),
      remaining: remainingOf(updated).toFixed(2),
      status: updated.status,
      cashAccountId: settlement.cashAccountId,
      ledgerEntryId,
      zohoPaymentId: settlement.zohoPaymentId,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.obligation, updated.id, updated.caseId)
  );
  publishBoard(ctx, 'finance.obligation', {
    obligationId: updated.id,
    number: updated.number,
    status: updated.status,
  });
  await runSettledHandlers(tx, updated, settlement, ctx);
  return { obligation: updated, settlement, ledgerEntry };
}

export const settleObligationSchema = z.object({
  obligationId: idSchema,
  amount: positiveMoneySchema,
  cashAccountId: idSchema,
  date: dateKeySchema.nullish(),
  evidenceObjectIds: z.array(idSchema).max(20).default([]),
  memo: z.string().trim().max(500).nullish(),
});

export type SettleObligationInput = z.input<typeof settleObligationSchema>;

export interface SettleObligationData {
  obligationId: string;
  number: string;
  settlementId: string;
  ledgerEntryId: string;
  ledgerEntryNumber: string | null;
  status: string;
  settledAmount: string;
  remaining: string;
}

export function toSettleData(result: SettleInTxResult): SettleObligationData {
  return {
    obligationId: result.obligation.id,
    number: result.obligation.number,
    settlementId: result.settlement.id,
    ledgerEntryId: result.settlement.ledgerEntryId,
    ledgerEntryNumber: result.ledgerEntry?.number ?? null,
    status: result.obligation.status,
    settledAmount: D(result.obligation.settledAmount).toFixed(2),
    remaining: remainingOf(result.obligation).toFixed(2),
  };
}

/** Contract: `finance.obligation.settle` as `actor` (aggregate = the obligation). */
export async function settleObligation(
  actor: CurrentUser,
  input: SettleObligationInput,
  opts: FinanceCommandOptions = {}
): Promise<CommandResult<SettleObligationData>> {
  return runFinanceCommand<SettleObligationData>(
    actor,
    {
      type: FINANCE_COMMANDS.obligationSettle,
      aggregate: { type: FINANCE_OBJECT_TYPES.obligation, id: String(input.obligationId ?? '') },
      payload: input,
    },
    opts
  );
}

// ---------------------------------------------------------------------------
// Cancel / write off / reverse a settlement
// ---------------------------------------------------------------------------

export interface CancelObligationOptions {
  bumpVersion?: boolean;
  /** The entry is shared (payroll) and is reversed by the owning flow. */
  skipLedger?: boolean;
}

/** Contract: reverses the obligation entry and cancels it. Idempotent on cancelled obligations. */
export async function cancelObligation(
  tx: Db,
  id: string,
  reason: string,
  ctx: CommandContext,
  options: CancelObligationOptions = {}
): Promise<Obligation> {
  const text = (reason ?? '').trim();
  if (text.length < 3) throw financeError('invalid_payload', 'Indica el motivo de la cancelación');
  const obligation = await tx.obligation.findUnique({ where: { id } });
  if (!obligation) throw new OperationsError('not_found', 'No se encontró la obligación');
  if (obligation.status === 'cancelled') return obligation;
  if (!isOpenObligationStatus(obligation.status)) {
    throw financeError(
      'invalid_state',
      `La obligación ${obligation.number} está ${obligation.status} y no se cancela`
    );
  }
  if (D(obligation.settledAmount).greaterThan(MONEY_TOLERANCE)) {
    throw financeError(
      'has_settlements',
      `La obligación ${obligation.number} ya tiene ${formatMxn(obligation.settledAmount, obligation.currency)} aplicados: reversa esos pagos antes de cancelarla`
    );
  }
  let reversalEntryId: string | null = null;
  if (obligation.ledgerEntryId && !options.skipLedger) {
    const entry = await tx.ledgerEntry.findUnique({
      where: { id: obligation.ledgerEntryId },
      select: { id: true, sourceType: true, sourceId: true, reversedByEntryId: true },
    });
    const owned =
      entry?.sourceType === LEDGER_SOURCE_TYPES.obligation && entry.sourceId === obligation.id;
    if (entry && owned && !entry.reversedByEntryId) {
      const { reversal } = await reverseLedgerEntry(
        tx,
        { entryId: entry.id, reason: `Cancelación de ${obligation.number}: ${text}` },
        ctx
      );
      reversalEntryId = reversal.id;
    } else if (entry && !owned && !entry.reversedByEntryId) {
      throw financeError(
        'domain_entry',
        `La obligación ${obligation.number} forma parte de otro asiento: cancélala desde su proceso`
      );
    }
  }
  const cancelled = await updateObligation(
    tx,
    obligation,
    { status: 'cancelled' },
    options.bumpVersion ?? true
  );
  ctx.emit(
    FINANCE_EVENTS.obligation.cancelled,
    {
      obligationId: cancelled.id,
      number: cancelled.number,
      kind: cancelled.kind,
      source: obligationSourceOf(cancelled),
      reason: text.slice(0, 500),
      reversalEntryId,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.obligation, cancelled.id, cancelled.caseId)
  );
  publishBoard(ctx, 'finance.obligation', {
    obligationId: cancelled.id,
    number: cancelled.number,
    status: 'cancelled',
  });
  return cancelled;
}

export const cancelObligationSchema = z.object({
  obligationId: idSchema,
  reason: z.string().trim().min(3).max(500),
});

export const writeOffObligationSchema = z.object({
  obligationId: idSchema,
  reason: z.string().trim().min(5).max(500),
  date: dateKeySchema.nullish(),
});

export const rescheduleObligationSchema = z.object({
  obligationId: idSchema,
  /** Nueva fecha de vencimiento (AAAA-MM-DD). */
  dueAt: dateKeySchema,
  /** Nueva fecha esperada de flujo; por omisión sigue al vencimiento. */
  expectedCashAt: dateKeySchema.nullish(),
  reason: z.string().trim().min(3).max(500),
});

export interface RescheduleObligationData {
  obligationId: string;
  number: string;
  dueAt: string;
  expectedCashAt: string | null;
  previousDueAt: string | null;
}

/**
 * Renegocia la fecha de una obligación abierta (plan 7.4, `obligation.reschedule`).
 *
 * NO es un hecho contable: el importe, la categoría y el asiento no se tocan,
 * así que no hay asiento nuevo ni reversa. Antes, una obligación con la fecha
 * equivocada o renegociada con el proveedor sólo se podía cancelar (lo que
 * reversa su asiento) y volver a crear, o quedarse vencida en falso — y
 * «obligaciones vencidas» es una tile en vivo de Contabilidad y una alerta del
 * Control Tower, así que el dato se ensuciaba.
 *
 * Una obligación liquidada, cancelada o castigada ya no se reprograma.
 */
export async function rescheduleObligationInTx(
  tx: Db,
  input: z.output<typeof rescheduleObligationSchema>,
  ctx: CommandContext,
  options: { bumpVersion?: boolean } = {}
): Promise<{ obligation: Obligation; data: RescheduleObligationData }> {
  const obligation = await tx.obligation.findUnique({ where: { id: input.obligationId } });
  if (!obligation) throw new OperationsError('not_found', 'No se encontró la obligación');
  if (!isOpenObligationStatus(obligation.status)) {
    throw financeError(
      'invalid_state',
      `La obligación ${obligation.number} está ${obligation.status} y ya no se reprograma`
    );
  }
  const previousDueAt = obligation.dueAt ? dateKeyOf(obligation.dueAt) : null;
  const expectedCashAt = input.expectedCashAt ?? input.dueAt;
  const updated = await updateObligation(
    tx,
    obligation,
    { dueAt: toDbDate(input.dueAt), expectedCashAt: toDbDate(expectedCashAt) },
    options.bumpVersion ?? true
  );
  const data: RescheduleObligationData = {
    obligationId: updated.id,
    number: updated.number,
    dueAt: input.dueAt,
    expectedCashAt,
    previousDueAt,
  };
  ctx.emit(
    FINANCE_EVENTS.obligation.rescheduled,
    {
      obligationId: updated.id,
      number: updated.number,
      kind: updated.kind,
      source: obligationSourceOf(updated),
      previousDueAt,
      dueAt: input.dueAt,
      expectedCashAt,
      reason: input.reason.slice(0, 500),
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.obligation, updated.id, updated.caseId)
  );
  publishBoard(ctx, 'finance.obligation', {
    obligationId: updated.id,
    number: updated.number,
    status: updated.status,
  });
  return { obligation: updated, data };
}

/**
 * Castiga el saldo pendiente: receivable → gasto "Cuentas incobrables";
 * payable → "Otros ingresos". The obligation ends `written_off`.
 */
export async function writeOffObligationInTx(
  tx: Db,
  input: z.output<typeof writeOffObligationSchema>,
  ctx: CommandContext,
  options: { bumpVersion?: boolean } = {}
): Promise<{ obligation: Obligation; ledgerEntry: LedgerEntryWithLines }> {
  const obligation = await tx.obligation.findUnique({ where: { id: input.obligationId } });
  if (!obligation) throw new OperationsError('not_found', 'No se encontró la obligación');
  if (!isOpenObligationStatus(obligation.status)) {
    throw financeError(
      'invalid_state',
      `La obligación ${obligation.number} ya no tiene saldo pendiente`
    );
  }
  const source = obligationSourceOf(obligation);
  if (source === 'payroll_run') {
    throw financeError(
      'domain_entry',
      `La obligación ${obligation.number} es el sueldo de una nómina: no se castiga, cancela la nómina o paga la línea`
    );
  }
  if (source === 'procurement_order') {
    throw financeError(
      'domain_entry',
      `La obligación ${obligation.number} es el pago de una orden de compra: no se castiga, cancela la orden de compra o registra su pago`
    );
  }
  const remaining = remainingOf(obligation);
  if (!remaining.greaterThan(0))
    throw financeError('invalid_state', 'La obligación no tiene saldo pendiente');
  const categoryId = await categoryIdByKey(
    tx,
    obligation.kind === 'receivable'
      ? FINANCE_CATEGORY_KEYS.badDebt
      : FINANCE_CATEGORY_KEYS.otherIncome
  );
  const ledgerEntry = await postLedgerEntry(
    tx,
    {
      kind: 'adjustment',
      dateKey: input.date ?? todayKeyOf(ctx),
      description: `Castigo de ${obligation.number}: ${input.reason}`.slice(0, 500),
      currency: obligation.currency,
      sourceType: LEDGER_SOURCE_TYPES.obligation,
      sourceId: obligation.id,
      meta: { reason: input.reason, action: 'write_off' },
      lines: writeOffEntryLines({
        kind: obligation.kind as ObligationKind,
        obligationId: obligation.id,
        amount: remaining,
        categoryId,
        costCenterId: obligation.costCenterId,
        caseId: obligation.caseId,
        memo: input.reason,
      }),
    },
    ctx
  );
  const updated = await updateObligation(
    tx,
    obligation,
    { status: 'written_off' },
    options.bumpVersion ?? true
  );
  ctx.emit(
    FINANCE_EVENTS.obligation.writtenOff,
    {
      obligationId: updated.id,
      number: updated.number,
      kind: updated.kind,
      amount: remaining.toFixed(2),
      currency: updated.currency,
      reason: input.reason,
      ledgerEntryId: ledgerEntry.id,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.obligation, updated.id, updated.caseId)
  );
  publishBoard(ctx, 'finance.obligation', {
    obligationId: updated.id,
    number: updated.number,
    status: 'written_off',
  });
  return { obligation: updated, ledgerEntry };
}

/**
 * Negative settlement rows that undo `settlements` under `reversalEntryId`
 * (the rows are insert-only) and the resulting obligation balances.
 */
export async function recordSettlementReversalRows(
  tx: Db,
  settlements: readonly ObligationSettlement[],
  reversalEntryId: string,
  ctx: CommandContext,
  options: { bumpVersion?: boolean } = {}
): Promise<Obligation[]> {
  const touched = new Map<string, Prisma.Decimal>();
  for (const settlement of settlements) {
    if (!D(settlement.amount).greaterThan(0)) continue;
    await tx.obligationSettlement.create({
      data: {
        obligationId: settlement.obligationId,
        ledgerEntryId: reversalEntryId,
        amount: D(settlement.amount).negated(),
        settledAt: ctx.now,
        cashAccountId: settlement.cashAccountId,
        zohoPaymentId: settlement.zohoPaymentId,
        externalRef: settlement.externalRef ? reversalExternalRef(settlement.externalRef) : null,
        evidenceObjectIds: [],
        createdByUserId: actorUserIdOf(ctx),
      },
    });
    touched.set(
      settlement.obligationId,
      (touched.get(settlement.obligationId) ?? new Prisma.Decimal(0)).plus(D(settlement.amount))
    );
  }
  const result: Obligation[] = [];
  for (const [obligationId, undone] of touched) {
    const obligation = await tx.obligation.findUniqueOrThrow({ where: { id: obligationId } });
    const settledAmount = roundMoney(D(obligation.settledAmount).minus(undone));
    result.push(
      await updateObligation(
        tx,
        obligation,
        {
          settledAmount,
          status: nextObligationStatus(
            obligation.status === 'settled' ? 'partially_settled' : obligation.status,
            obligation.expectedAmount,
            settledAmount
          ),
        },
        options.bumpVersion ?? true
      )
    );
  }
  return result;
}

export const reverseSettlementSchema = z.object({
  settlementId: idSchema,
  reason: z.string().trim().min(3).max(500),
  date: dateKeySchema.nullish(),
});

/** Undoes one settlement by reversing its own entry (payroll advances are undone by cancelling the run). */
export async function reverseSettlementInTx(
  tx: Db,
  input: z.output<typeof reverseSettlementSchema>,
  ctx: CommandContext,
  options: { bumpVersion?: boolean; expectedObligationId?: string } = {}
): Promise<{
  obligation: Obligation;
  settlement: ObligationSettlement;
  reversalEntryId: string;
  reversalNumber: string;
}> {
  const settlement = await tx.obligationSettlement.findUnique({
    where: { id: input.settlementId },
  });
  if (!settlement) throw new OperationsError('not_found', 'No se encontró la liquidación');
  if (options.expectedObligationId && settlement.obligationId !== options.expectedObligationId) {
    throw new OperationsError(
      'invalid_payload',
      'La liquidación no pertenece a la obligación del comando'
    );
  }
  if (!D(settlement.amount).greaterThan(0) || isReversalExternalRef(settlement.externalRef)) {
    throw financeError('not_reversible', 'Un reverso de liquidación no se revierte');
  }
  const entry = await tx.ledgerEntry.findUnique({ where: { id: settlement.ledgerEntryId } });
  if (!entry) throw new OperationsError('not_found', 'No se encontró el asiento de la liquidación');
  if (entry.reversedByEntryId)
    throw financeError('already_reversed', 'Esta liquidación ya fue reversada');
  const siblings = await tx.obligationSettlement.count({ where: { ledgerEntryId: entry.id } });
  if (entry.kind !== 'settlement' || siblings > 1) {
    throw financeError(
      'domain_entry',
      'Esta liquidación forma parte de una nómina: cancela la nómina para deshacerla'
    );
  }
  const obligation = await tx.obligation.findUniqueOrThrow({
    where: { id: settlement.obligationId },
  });
  if (obligation.status === 'cancelled' || obligation.status === 'written_off') {
    throw financeError(
      'invalid_state',
      `La obligación ${obligation.number} está ${obligation.status}`
    );
  }
  const { reversal } = await reverseLedgerEntry(
    tx,
    {
      entryId: entry.id,
      reason: `Reverso de liquidación de ${obligation.number}: ${input.reason}`,
      dateKey: input.date ?? null,
    },
    ctx
  );
  const [updated] = await recordSettlementReversalRows(tx, [settlement], reversal.id, ctx, options);
  ctx.emit(
    FINANCE_EVENTS.obligation.settlementReversed,
    {
      obligationId: updated.id,
      number: updated.number,
      settlementId: settlement.id,
      amount: D(settlement.amount).toFixed(2),
      zohoPaymentId: settlement.zohoPaymentId,
      reversalEntryId: reversal.id,
      status: updated.status,
      reason: input.reason,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.obligation, updated.id, updated.caseId)
  );
  publishBoard(ctx, 'finance.obligation', {
    obligationId: updated.id,
    number: updated.number,
    status: updated.status,
  });
  for (const handler of reversedHandlers().get(obligationSourceOf(updated)) ?? []) {
    await handler(tx, updated, settlement, ctx);
  }
  return {
    obligation: updated,
    settlement,
    reversalEntryId: reversal.id,
    reversalNumber: reversal.number,
  };
}

// ---------------------------------------------------------------------------
// Manual creation (finance.obligation.create)
// ---------------------------------------------------------------------------

export const manualObligationSchema = z.object({
  kind: z.enum(OBLIGATION_KINDS),
  counterpartyType: z.enum(COUNTERPARTY_TYPES),
  counterpartyName: z.string().trim().min(2).max(200),
  supplierId: optionalId,
  zohoContactId: optionalId,
  employeeId: optionalId,
  caseId: optionalId,
  description: z.string().trim().min(3).max(500),
  currency: currencySchema.default('MXN'),
  expectedAmount: positiveMoneySchema,
  dueAt: dateKeySchema.nullish(),
  expectedCashAt: dateKeySchema.nullish(),
  categoryId: optionalId,
  costCenterId: optionalId,
  date: dateKeySchema.nullish(),
  evidenceObjectIds: z.array(idSchema).max(20).default([]),
});

// ---------------------------------------------------------------------------
// Payment authorization (scope `payment`)
// ---------------------------------------------------------------------------

export const requestPaymentAuthorizationSchema = z.object({
  obligationId: idSchema,
  /** `payment_authorization` request received by Contabilidad (keeps who asked for the payment). */
  areaRequestId: optionalId,
  note: z.string().trim().max(1000).nullish(),
});

export interface PaymentRequester {
  requestedByUserId: string;
  minApprovals?: number;
}

/**
 * Who asked for a payment (no self-approval rule): the person who created the
 * area request, or the acting person; for an AI identity, the human that
 * caused the request (`caused_by`); an engine or AI request without an
 * identifiable human needs two distinct signatures.
 */
export async function resolvePaymentRequester(
  tx: Db,
  ctx: Pick<CommandContext, 'actor'>,
  areaRequest: { id: string; createdByType: string; createdById: string | null } | null
): Promise<PaymentRequester> {
  const type = areaRequest ? areaRequest.createdByType : ctx.actor.type;
  const id = areaRequest ? areaRequest.createdById : ctx.actor.id;
  if (type === 'user' && id) return { requestedByUserId: id };
  if (type === 'ai') {
    if (areaRequest) {
      const causer = await tx.objectRelation.findFirst({
        where: {
          fromType: 'area_request',
          fromId: areaRequest.id,
          toType: 'user',
          relation: CAUSED_BY_RELATION,
          validTo: null,
        },
        select: { toId: true },
      });
      if (causer?.toId) return { requestedByUserId: causer.toId };
    }
    return { requestedByUserId: `ai:${id ?? 'agent'}`.slice(0, 120), minApprovals: 2 };
  }
  return { requestedByUserId: `system:${id ?? 'finance'}`.slice(0, 120), minApprovals: 2 };
}

export interface PaymentAuthorizationData {
  obligationId: string;
  approvalRequestId: string;
  status: string;
  autoApproved: boolean;
  reused: boolean;
  requiredApprovals: number;
  approverCount: number;
}

export interface PaymentAuthorizationOptions {
  /**
   * Trusted internal callers only (never a command payload): the person who
   * asked for the payment when the command runs as the system (e.g. Compras'
   * follow-up job requests the payment of the order its buyer created).
   */
  requestedByUserId?: string | null;
}

export async function requestPaymentAuthorizationInTx(
  tx: Db,
  input: z.output<typeof requestPaymentAuthorizationSchema>,
  ctx: CommandContext,
  options: PaymentAuthorizationOptions = {}
): Promise<PaymentAuthorizationData> {
  const obligation = await tx.obligation.findUnique({ where: { id: input.obligationId } });
  if (!obligation) throw new OperationsError('not_found', 'No se encontró la obligación');
  if (obligation.kind !== 'payable')
    throw financeError('invalid_state', 'Sólo se autoriza el pago de una cuenta por pagar');
  if (!isOpenObligationStatus(obligation.status)) {
    throw financeError(
      'invalid_state',
      `La obligación ${obligation.number} ya no tiene saldo por pagar`
    );
  }
  if (obligation.expenseId || obligation.payrollRunId) {
    throw financeError(
      'invalid_state',
      'Este pago ya se aprobó con su gasto o su nómina; no requiere otra autorización'
    );
  }
  let areaRequest: {
    id: string;
    createdByType: string;
    createdById: string | null;
    kind: string;
    caseId: string;
  } | null = null;
  if (input.areaRequestId) {
    areaRequest = await tx.areaRequest.findUnique({
      where: { id: input.areaRequestId },
      select: { id: true, createdByType: true, createdById: true, kind: true, caseId: true },
    });
    if (!areaRequest) throw new OperationsError('not_found', 'No se encontró la solicitud de pago');
    if (areaRequest.kind !== 'payment_authorization') {
      throw new OperationsError('invalid_payload', 'La solicitud no es una autorización de pago');
    }
  }
  const requester: PaymentRequester = options.requestedByUserId
    ? { requestedByUserId: options.requestedByUserId }
    : await resolvePaymentRequester(tx, ctx, areaRequest);
  const remaining = remainingOf(obligation);
  // Other modules (Compras) may request a payment before finance-commands was imported.
  if (
    isKnownPermission('finance.approve') &&
    !approverPermissionsFor('payment').includes('finance.approve')
  ) {
    registerApprovalScopePermission('payment', 'finance.approve');
  }
  const outcome: RequestApprovalOutcome = await requestApproval(tx, {
    scope: 'payment',
    targetType: FINANCE_OBJECT_TYPES.obligation,
    targetId: obligation.id,
    amount: remaining,
    currency: obligation.currency,
    categoryId: obligation.categoryId,
    caseId: obligation.caseId ?? areaRequest?.caseId ?? null,
    areaKey: FINANCE_AREA_KEY,
    requestedByUserId: requester.requestedByUserId,
    ...(requester.minApprovals ? { minApprovals: requester.minApprovals } : {}),
    title:
      `Pago ${obligation.number}${obligation.counterpartyName ? ` a ${obligation.counterpartyName}` : ''}`.slice(
        0,
        200
      ),
    description: (input.note ?? obligation.description).slice(0, 1000),
  });
  if (areaRequest) {
    await ctx.relate(
      { type: 'area_request', id: areaRequest.id },
      { type: FINANCE_OBJECT_TYPES.obligation, id: obligation.id },
      'payment_for'
    );
  }
  if (!outcome.reused) {
    ctx.emit(
      FINANCE_EVENTS.payment.authorizationRequested,
      {
        obligationId: obligation.id,
        number: obligation.number,
        approvalRequestId: outcome.approvalRequest.id,
        amount: remaining.toFixed(2),
        currency: obligation.currency,
        status: outcome.status,
        requiredApprovals: outcome.approvalRequest.requiredApprovals,
        areaRequestId: areaRequest?.id ?? null,
      },
      financeEventOptions(FINANCE_OBJECT_TYPES.obligation, obligation.id, obligation.caseId)
    );
  }
  return {
    obligationId: obligation.id,
    approvalRequestId: outcome.approvalRequest.id,
    status: outcome.status,
    autoApproved: outcome.autoApproved,
    reused: outcome.reused,
    requiredApprovals: outcome.approvalRequest.requiredApprovals,
    approverCount: outcome.approverUserIds.length,
  };
}

/** Reaction to the `payment` approval of an obligation: announces it and hands the payment to Contabilidad. */
export function registerObligationReactions(): void {
  const scope = globalThis as GlobalWithObligationHandlers;
  if (scope.__unikFinanceObligationReactions) return;
  scope.__unikFinanceObligationReactions = true;
  onApprovalDecided(FINANCE_OBJECT_TYPES.obligation, async (tx, event) => {
    if (event.approvalRequest.scope !== 'payment') return;
    const obligation = await tx.obligation.findUnique({
      where: { id: event.approvalRequest.targetId },
    });
    if (!obligation || !isOpenObligationStatus(obligation.status)) return;
    const payload = {
      obligationId: obligation.id,
      number: obligation.number,
      approvalRequestId: event.approvalRequest.id,
      amount: D(event.approvalRequest.amount).toFixed(2),
      currency: event.approvalRequest.currency,
      auto: event.auto,
      decidedByUserId: event.decidedByUserId,
    };
    const options = financeEventOptions(
      FINANCE_OBJECT_TYPES.obligation,
      obligation.id,
      obligation.caseId
    );
    if (event.status === 'approved') {
      event.ctx.emit(FINANCE_EVENTS.payment.authorized, payload, options);
      await event.ctx.createWorkItem({
        areaKey: FINANCE_AREA_KEY,
        kind: 'action',
        title:
          `Pagar ${obligation.number}${obligation.counterpartyName ? ` a ${obligation.counterpartyName}` : ''}`.slice(
            0,
            200
          ),
        description:
          `${formatMxn(remainingOf(obligation), obligation.currency)} · ${obligation.description}`.slice(
            0,
            1000
          ),
        caseId: obligation.caseId,
        objectType: FINANCE_OBJECT_TYPES.obligation,
        objectId: obligation.id,
      });
    } else {
      event.ctx.emit(FINANCE_EVENTS.payment.rejected, payload, options);
    }
    publishBoard(event.ctx, 'finance.payment', {
      obligationId: obligation.id,
      status: event.status,
    });
  });
}

registerObligationReactions();
