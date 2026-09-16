import { Prisma, type Expense, type ExpenseSplit } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { JOB_PRIORITY } from '@/modules/jobs/job-queue';
import {
  onApprovalDecided,
  parseApprovalDecisions,
  requestApproval,
} from '@/modules/operations/approvals-service';
import type { CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { toOperationalJson, userChannel } from '@/modules/operations/events-service';
import { nextNumber } from '@/modules/operations/sequence-service';
import { AREA_KEYS } from '@/modules/operations/types';
import { getFinanceSettings } from './finance-config';
import { financeError } from './finance-errors';
import { addDaysToKey, dateKeyOf, dateKeySchema, localDateKey, toDbDate } from './finance-dates';
import {
  actorUserIdOf,
  financeEventOptions,
  hasFinancePermission,
  loadCatalogRefs,
  publishBoard,
  runFinanceSystemCommand,
  todayKeyOf,
} from './finance-helpers';
import {
  buildDuplicateKey,
  duplicateIdentityChanged,
  duplicateSearchWindow,
  evaluateDuplicateStatus,
  findDuplicateMatches,
  supplierKeyOf,
  type DuplicateMatch,
  type DuplicateSubject,
} from './expense-duplicates';
import { buildExtractionMaterial, proposeExpenseWithAi } from './expense-extraction';
import {
  expenseCompletenessIssues,
  expenseLedgerAllocations,
  isExpenseCategory,
  mergeProposalIntoExpense,
  nextRecurrenceKey,
  parseRecurrence,
  recurrenceSchema,
  resolveExpenseProposal,
  splitIssues,
  suggestExpenseClassification,
  type ExpenseProposalRaw,
  type ResolvedExpenseProposal,
} from './expense-rules';
import { postLedgerEntry, reverseLedgerEntry } from './ledger-service';
import {
  D,
  currencySchema,
  nonNegativeMoneySchema,
  positiveMoneySchema,
  roundMoney,
  sumMoney,
  type Money,
} from './money';
import { cancelObligation, createObligationWithEntry } from './obligations-service';
import {
  EXPENSE_CAPTURE_MODES,
  FINANCE_AREA_KEY,
  FINANCE_COMMANDS,
  FINANCE_EVENTS,
  FINANCE_JOB_TYPES,
  FINANCE_OBJECT_TYPES,
  FINANCE_SEQUENCES,
  LEDGER_SOURCE_TYPES,
  PAYMENT_METHODS,
  type ExpenseCaptureMode,
} from './types';

/**
 * Expenses (plan 6.4): one-step capture → proposal (job
 * `finance.expense_propose`, AI + deterministic rules, never over what the
 * person typed) → duplicate resolution (mandatory before submitting) →
 * business approval (approvals-service, auto-approved under the threshold) →
 * posting (paid ⇒ `expense` entry against a cash account; unpaid ⇒
 * `Obligation payable`). Templates and daily recurring expenses create
 * drafts the person reviews. Corrections: reject a draft/approved expense or
 * reverse a posted one.
 */

type Db = Prisma.TransactionClient;
type ExpenseWithSplits = Expense & { splits: ExpenseSplit[] };

const idSchema = z.string().trim().min(1).max(120);
const optionalId = idSchema.nullish();

const splitSchema = z.object({
  amount: positiveMoneySchema,
  pct: z.union([z.number(), z.string()]).nullish(),
  costCenterId: optionalId,
  caseId: optionalId,
  projectRef: z.string().trim().max(120).nullish(),
});

type SplitOutput = z.output<typeof splitSchema>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ProposalState {
  userProvided: Set<string>;
  record: Record<string, unknown>;
}

function proposalStateOf(expense: Pick<Expense, 'aiProposal'>): ProposalState {
  const record =
    expense.aiProposal &&
    typeof expense.aiProposal === 'object' &&
    !Array.isArray(expense.aiProposal)
      ? (expense.aiProposal as Record<string, unknown>)
      : {};
  const provided = Array.isArray(record.userProvided) ? record.userProvided.map(String) : [];
  return { userProvided: new Set(provided), record };
}

function splitRows(
  expenseId: string,
  splits: readonly SplitOutput[]
): Prisma.ExpenseSplitCreateManyInput[] {
  return splits.map((split) => ({
    expenseId,
    amount: roundMoney(split.amount),
    pct:
      split.pct === null || split.pct === undefined || split.pct === ''
        ? null
        : new Prisma.Decimal(split.pct),
    costCenterId: split.costCenterId ?? null,
    caseId: split.caseId ?? null,
    projectRef: split.projectRef ?? null,
  }));
}

function assertCanEdit(
  ctx: CommandContext,
  expense: Pick<Expense, 'createdByUserId' | 'number'>,
  permissions: string[]
): void {
  if (ctx.actor.type === 'system') return;
  if (ctx.user && ctx.user.id === expense.createdByUserId) return;
  if (permissions.some((key) => hasFinancePermission(ctx.user, key))) return;
  throw new OperationsError(
    'forbidden',
    `Sólo quien capturó ${expense.number} o Contabilidad puede hacer esto`
  );
}

async function loadExpense(tx: Db, id: string): Promise<ExpenseWithSplits> {
  const expense = await tx.expense.findUnique({ where: { id }, include: { splits: true } });
  if (!expense) throw new OperationsError('not_found', 'No se encontró el gasto');
  return expense;
}

async function validateReferences(
  tx: Db,
  refs: {
    supplierId?: string | null;
    categoryId?: string | null;
    costCenterId?: string | null;
    cashAccountId?: string | null;
    caseId?: string | null;
    splits?: readonly SplitOutput[];
  }
): Promise<void> {
  if (refs.supplierId) {
    const supplier = await tx.supplier.findUnique({
      where: { id: refs.supplierId },
      select: { id: true },
    });
    if (!supplier) throw new OperationsError('not_found', 'El proveedor no existe');
  }
  if (refs.categoryId) {
    const category = await tx.financeCategory.findUnique({ where: { id: refs.categoryId } });
    if (!category) throw new OperationsError('not_found', 'La categoría no existe');
    if (!isExpenseCategory(category))
      throw financeError('invalid_payload', `La categoría ${category.name} no admite gastos`);
  }
  const centerIds = [refs.costCenterId, ...(refs.splits ?? []).map((s) => s.costCenterId)].filter(
    (id): id is string => Boolean(id)
  );
  if (centerIds.length > 0) {
    const centers = await tx.costCenter.findMany({
      where: { id: { in: [...new Set(centerIds)] }, status: 'active' },
      select: { id: true },
    });
    if (centers.length !== new Set(centerIds).size) {
      throw new OperationsError('not_found', 'Un centro de costo no existe o está archivado');
    }
  }
  if (refs.cashAccountId) {
    const account = await tx.cashAccount.findUnique({
      where: { id: refs.cashAccountId },
      select: { status: true },
    });
    if (!account) throw new OperationsError('not_found', 'La cuenta de pago no existe');
    if (account.status !== 'active')
      throw financeError('account_inactive', 'La cuenta de pago está cerrada');
  }
  const caseIds = [refs.caseId, ...(refs.splits ?? []).map((s) => s.caseId)].filter(
    (id): id is string => Boolean(id)
  );
  for (const caseId of new Set(caseIds)) {
    const found = await tx.operationalCase.findUnique({
      where: { id: caseId },
      select: { id: true },
    });
    if (!found) throw new OperationsError('not_found', 'No se encontró el expediente');
  }
}

type ReceiptRow = {
  id: string;
  originalName: string;
  declaredMimeType: string;
  detectedMimeType: string | null;
  sizeBytes: bigint;
  status: string;
  sha256: string | null;
  createdBy: string | null;
};

const RECEIPT_SELECT = {
  id: true,
  originalName: true,
  declaredMimeType: true,
  detectedMimeType: true,
  sizeBytes: true,
  status: true,
  sha256: true,
  createdBy: true,
} as const;

async function loadReceipts(
  tx: Db,
  ids: readonly string[],
  ctx: CommandContext
): Promise<ReceiptRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx.storageObject.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: RECEIPT_SELECT,
  });
  for (const id of new Set(ids)) {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new OperationsError('not_found', 'Un comprobante no existe');
    if (['rejected', 'aborted', 'deleted', 'missing'].includes(row.status)) {
      throw financeError('invalid_state', `El comprobante ${row.originalName} no está disponible`);
    }
    if (
      ctx.actor.type !== 'system' &&
      row.createdBy !== ctx.actor.id &&
      !hasFinancePermission(ctx.user, 'finance.post')
    ) {
      throw new OperationsError('forbidden', 'Sólo puedes adjuntar comprobantes que tú subiste');
    }
  }
  return rows;
}

/** Expenses that look like `subject` (receipt hash, exact key or ±1 % in ±3 days). */
export async function findExpenseDuplicates(
  db: Pick<Db, 'expense'>,
  subject: DuplicateSubject
): Promise<DuplicateMatch[]> {
  const or: Prisma.ExpenseWhereInput[] = [];
  const window = duplicateSearchWindow(subject);
  if (window && D(subject.amount).greaterThan(0)) {
    or.push({
      date: { gte: toDbDate(window.fromKey), lte: toDbDate(window.toKey) },
      amount: { gte: window.minAmount, lte: window.maxAmount },
    });
  }
  if (subject.receiptHash) or.push({ receiptHash: subject.receiptHash });
  if (or.length === 0) return [];
  const rows = await db.expense.findMany({
    where: {
      AND: [
        { status: { not: 'rejected' } },
        { OR: or },
        ...(subject.id ? [{ id: { not: subject.id } }] : []),
      ],
    },
    select: {
      id: true,
      number: true,
      amount: true,
      date: true,
      supplierId: true,
      supplierNameFree: true,
      receiptHash: true,
      status: true,
      duplicateStatus: true,
    },
    orderBy: { date: 'asc' },
    take: 100,
  });
  return findDuplicateMatches(
    subject,
    rows.map((row) => ({ ...row, dateKey: dateKeyOf(row.date) }))
  );
}

function duplicateSubjectOf(
  expense: Pick<
    Expense,
    'id' | 'amount' | 'date' | 'supplierId' | 'supplierNameFree' | 'receiptHash'
  >
): DuplicateSubject {
  return {
    id: expense.id,
    amount: expense.amount,
    dateKey: dateKeyOf(expense.date),
    supplierId: expense.supplierId,
    supplierNameFree: expense.supplierNameFree,
    receiptHash: expense.receiptHash,
  };
}

function emitDuplicate(
  ctx: CommandContext,
  expense: Expense,
  matches: readonly DuplicateMatch[]
): void {
  if (expense.duplicateStatus !== 'suspect' || matches.length === 0) return;
  ctx.emit(
    FINANCE_EVENTS.expense.duplicateSuspected,
    {
      expenseId: expense.id,
      number: expense.number,
      matches: matches
        .slice(0, 5)
        .map((m) => ({ expenseId: m.expenseId, number: m.number, kind: m.kind, reason: m.reason })),
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.expense, expense.id, expense.caseId)
  );
}

export interface ExpenseCommandData {
  expenseId: string;
  number: string;
  status: string;
  duplicateStatus: string;
  duplicateOfId: string | null;
  version: number;
  proposalQueued?: boolean;
  submitted?: boolean;
  approvalRequestId?: string | null;
  autoApproved?: boolean;
  requiredApprovals?: number;
  /** Persona cuya decisión sobre la propuesta de IA quedó como primera firma (plan 5.4). */
  firstSignatureByUserId?: string | null;
  ledgerEntryId?: string | null;
  obligationId?: string | null;
  matches?: Array<Pick<DuplicateMatch, 'expenseId' | 'number' | 'kind' | 'reason'>>;
}

export function toExpenseCommandData(
  expense: Expense,
  extra: Partial<ExpenseCommandData> = {}
): ExpenseCommandData {
  return {
    expenseId: expense.id,
    number: expense.number,
    status: expense.status,
    duplicateStatus: expense.duplicateStatus,
    duplicateOfId: expense.duplicateOfId,
    version: expense.version,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export const captureExpenseSchema = z
  .object({
    captureMode: z.enum(['form', 'text', 'voice', 'photo']).default('form'),
    rawInput: z.string().trim().max(4000).nullish(),
    amount: nonNegativeMoneySchema.nullish(),
    currency: currencySchema.default('MXN'),
    date: dateKeySchema.nullish(),
    supplierId: optionalId,
    supplierNameFree: z.string().trim().max(200).nullish(),
    categoryId: optionalId,
    costCenterId: optionalId,
    cashAccountId: optionalId,
    paymentMethod: z.enum(PAYMENT_METHODS).nullish(),
    isPaid: z.boolean().nullish(),
    description: z.string().trim().max(500).nullish(),
    receiptObjectIds: z.array(idSchema).max(10).default([]),
    caseId: optionalId,
    /** Area of the person (suggests the cost center). */
    areaKey: z.enum(AREA_KEYS).nullish(),
    splits: z.array(splitSchema).max(20).default([]),
  })
  .superRefine((value, issue) => {
    if (value.captureMode === 'text' && !value.rawInput) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rawInput'],
        message: 'Escribe el gasto',
      });
    }
    if (value.captureMode === 'voice' && !value.rawInput && value.receiptObjectIds.length === 0) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rawInput'],
        message: 'Falta la transcripción o la nota de voz',
      });
    }
  });

export type CaptureExpenseInput = z.input<typeof captureExpenseSchema>;

interface DraftInput {
  captureMode: ExpenseCaptureMode;
  rawInput: string | null;
  amount: Money;
  currency: string;
  dateKey: string;
  supplierId: string | null;
  supplierNameFree: string | null;
  categoryId: string | null;
  costCenterId: string | null;
  cashAccountId: string | null;
  paymentMethod: string | null;
  isPaid: boolean;
  description: string | null;
  receipts: readonly ReceiptRow[];
  caseId: string | null;
  splits: readonly SplitOutput[];
  templateId: string | null;
  createdByUserId: string;
  userProvided: readonly string[];
  needsProposal: boolean;
}

async function createExpenseDraftInTx(
  tx: Db,
  draft: DraftInput,
  ctx: CommandContext
): Promise<{ expense: ExpenseWithSplits; matches: DuplicateMatch[] }> {
  if (draft.splits.length > 0 && D(draft.amount).greaterThan(0)) {
    const issues = splitIssues(draft.amount, draft.splits);
    if (issues.length > 0) throw financeError('expense_incomplete', issues[0], { issues });
  }
  const number = await nextNumber(
    tx,
    FINANCE_SEQUENCES.expense.key,
    FINANCE_SEQUENCES.expense.prefix
  );
  const receiptHash = draft.receipts.find((r) => r.sha256)?.sha256 ?? null;
  const subject: DuplicateSubject = {
    amount: draft.amount,
    dateKey: draft.dateKey,
    supplierId: draft.supplierId,
    supplierNameFree: draft.supplierNameFree,
    receiptHash,
  };
  const matches = await findExpenseDuplicates(tx, subject);
  const duplicate = evaluateDuplicateStatus({
    matches,
    previousStatus: 'none',
    identityChanged: true,
  });
  const created = await tx.expense.create({
    data: {
      number,
      status: 'draft',
      captureMode: draft.captureMode,
      rawInput: draft.rawInput,
      aiProposal: toOperationalJson({
        status: draft.needsProposal ? 'pending' : 'not_needed',
        userProvided: [...new Set(draft.userProvided)],
      }),
      amount: roundMoney(draft.amount),
      currency: draft.currency,
      date: toDbDate(draft.dateKey),
      supplierId: draft.supplierId,
      supplierNameFree: draft.supplierNameFree,
      categoryId: draft.categoryId,
      costCenterId: draft.costCenterId,
      cashAccountId: draft.cashAccountId,
      paymentMethod: draft.paymentMethod,
      isPaid: draft.isPaid,
      description: draft.description,
      receiptObjectIds: draft.receipts.map((r) => r.id),
      receiptHash,
      duplicateKey: buildDuplicateKey(subject),
      duplicateOfId: duplicate.duplicateOfId,
      duplicateStatus: duplicate.status,
      templateId: draft.templateId,
      caseId: draft.caseId,
      createdByUserId: draft.createdByUserId,
    },
  });
  if (draft.splits.length > 0)
    await tx.expenseSplit.createMany({ data: splitRows(created.id, draft.splits) });
  const expense = await loadExpense(tx, created.id);
  ctx.emit(
    FINANCE_EVENTS.expense.captured,
    {
      expenseId: expense.id,
      number,
      captureMode: expense.captureMode,
      amount: D(expense.amount).toFixed(2),
      currency: expense.currency,
      date: draft.dateKey,
      createdByUserId: expense.createdByUserId,
      templateId: expense.templateId,
      proposalQueued: draft.needsProposal,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.expense, expense.id, expense.caseId)
  );
  emitDuplicate(ctx, expense, matches);
  if (draft.needsProposal) queueProposal(ctx, expense.id);
  publishBoard(ctx, 'finance.expense', { expenseId: expense.id, number, status: expense.status });
  return { expense, matches };
}

export function queueProposal(ctx: Pick<CommandContext, 'outbox'>, expenseId: string): void {
  ctx.outbox({
    type: FINANCE_JOB_TYPES.expensePropose,
    payload: { expenseId },
    dedupeKey: `${FINANCE_JOB_TYPES.expensePropose}:${expenseId}`,
    priority: JOB_PRIORITY.interactive,
    maxAttempts: 2,
  });
}

export async function captureExpenseInTx(
  tx: Db,
  input: z.output<typeof captureExpenseSchema>,
  ctx: CommandContext
): Promise<{ expense: ExpenseWithSplits; matches: DuplicateMatch[] }> {
  if (ctx.actor.type !== 'user' && ctx.actor.type !== 'ai') {
    throw new OperationsError(
      'forbidden',
      'Un gasto lo captura una persona o una identidad de IA registrada'
    );
  }
  await validateReferences(tx, input);
  const receipts = await loadReceipts(tx, input.receiptObjectIds, ctx);
  const amount = roundMoney(input.amount ?? 0);
  const userProvided: string[] = [];
  if (amount.greaterThan(0)) userProvided.push('amount');
  if (input.date) userProvided.push('date');
  if (input.supplierId || input.supplierNameFree) userProvided.push('supplier');
  if (input.categoryId) userProvided.push('categoryId');
  if (input.costCenterId) userProvided.push('costCenterId');
  if (input.description) userProvided.push('description');
  if (input.paymentMethod) userProvided.push('paymentMethod');
  if (input.isPaid !== null && input.isPaid !== undefined) userProvided.push('isPaid');
  if (input.splits.length > 0) userProvided.push('splits');
  let costCenterId = input.costCenterId ?? null;
  if (!costCenterId && input.areaKey) {
    const center = await tx.costCenter.findFirst({
      where: { areaKey: input.areaKey, status: 'active' },
      select: { id: true },
    });
    costCenterId = center?.id ?? null;
  }
  const hasMaterial = Boolean(input.rawInput) || receipts.length > 0;
  const needsProposal =
    (input.captureMode !== 'form' && hasMaterial) ||
    (!input.categoryId &&
      Boolean(input.description || input.supplierId || input.supplierNameFree || hasMaterial));
  return createExpenseDraftInTx(
    tx,
    {
      captureMode: input.captureMode,
      rawInput: input.rawInput ?? null,
      amount,
      currency: input.currency,
      dateKey: input.date ?? todayKeyOf(ctx),
      supplierId: input.supplierId ?? null,
      supplierNameFree: input.supplierId ? null : (input.supplierNameFree ?? null),
      categoryId: input.categoryId ?? null,
      costCenterId,
      cashAccountId: input.cashAccountId ?? null,
      paymentMethod: input.paymentMethod ?? null,
      isPaid: input.isPaid ?? true,
      description: input.description ?? null,
      receipts,
      caseId: input.caseId ?? null,
      splits: input.splits,
      templateId: null,
      createdByUserId: ctx.actor.id,
      userProvided,
      needsProposal,
    },
    ctx
  );
}

// ---------------------------------------------------------------------------
// Update / proposal / duplicates
// ---------------------------------------------------------------------------

export const updateExpenseSchema = z.object({
  expenseId: idSchema,
  amount: nonNegativeMoneySchema.optional(),
  date: dateKeySchema.optional(),
  supplierId: optionalId,
  supplierNameFree: z.string().trim().max(200).nullish(),
  categoryId: optionalId,
  costCenterId: optionalId,
  cashAccountId: optionalId,
  paymentMethod: z.enum(PAYMENT_METHODS).nullish(),
  isPaid: z.boolean().optional(),
  description: z.string().trim().max(500).nullish(),
  caseId: optionalId,
  splits: z.array(splitSchema).max(20).optional(),
  /** Attach already-uploaded receipts (replaces nothing). */
  addReceiptObjectIds: z.array(idSchema).max(10).optional(),
});

async function reevaluateDuplicates(
  tx: Db,
  before: Expense,
  after: Expense,
  ctx: CommandContext
): Promise<{ expense: Expense; matches: DuplicateMatch[] }> {
  const beforeIdentity = { ...duplicateSubjectOf(before) };
  const afterSubject = duplicateSubjectOf(after);
  const identityChanged = duplicateIdentityChanged(beforeIdentity, afterSubject);
  const matches = await findExpenseDuplicates(tx, afterSubject);
  const state = evaluateDuplicateStatus({
    matches,
    previousStatus: after.duplicateStatus,
    previousDuplicateOfId: after.duplicateOfId,
    identityChanged,
  });
  const key = buildDuplicateKey(afterSubject);
  if (
    state.status === after.duplicateStatus &&
    state.duplicateOfId === after.duplicateOfId &&
    key === after.duplicateKey
  ) {
    return { expense: after, matches };
  }
  const expense = await tx.expense.update({
    where: { id: after.id },
    data: { duplicateStatus: state.status, duplicateOfId: state.duplicateOfId, duplicateKey: key },
  });
  if (state.status === 'suspect' && after.duplicateStatus !== 'suspect')
    emitDuplicate(ctx, expense, matches);
  return { expense, matches };
}

export async function updateExpenseInTx(
  tx: Db,
  input: z.output<typeof updateExpenseSchema>,
  ctx: CommandContext
): Promise<{ expense: ExpenseWithSplits; matches: DuplicateMatch[] }> {
  const before = await loadExpense(tx, input.expenseId);
  if (before.status !== 'draft')
    throw financeError('invalid_state', `${before.number} ya no es un borrador`);
  assertCanEdit(ctx, before, ['finance.post']);
  await validateReferences(tx, {
    supplierId: input.supplierId,
    categoryId: input.categoryId,
    costCenterId: input.costCenterId,
    cashAccountId: input.cashAccountId,
    caseId: input.caseId,
    splits: input.splits,
  });
  const receipts = await loadReceipts(tx, input.addReceiptObjectIds ?? [], ctx);
  const state = proposalStateOf(before);
  const data: Prisma.ExpenseUpdateInput = {};
  const touch = (field: string) => state.userProvided.add(field);
  if (input.amount !== undefined) {
    data.amount = roundMoney(input.amount);
    touch('amount');
  }
  if (input.date !== undefined) {
    data.date = toDbDate(input.date);
    touch('date');
  }
  if (input.supplierId !== undefined || input.supplierNameFree !== undefined) {
    const supplierId = input.supplierId !== undefined ? input.supplierId : before.supplierId;
    data.supplierId = supplierId ?? null;
    data.supplierNameFree = supplierId
      ? null
      : input.supplierNameFree !== undefined
        ? input.supplierNameFree
        : before.supplierNameFree;
    touch('supplier');
  }
  if (input.categoryId !== undefined) {
    data.categoryId = input.categoryId;
    touch('categoryId');
  }
  if (input.costCenterId !== undefined) {
    data.costCenterId = input.costCenterId;
    touch('costCenterId');
  }
  if (input.cashAccountId !== undefined) data.cashAccountId = input.cashAccountId;
  if (input.paymentMethod !== undefined) {
    data.paymentMethod = input.paymentMethod;
    touch('paymentMethod');
  }
  if (input.isPaid !== undefined) {
    data.isPaid = input.isPaid;
    touch('isPaid');
  }
  if (input.description !== undefined) {
    data.description = input.description;
    touch('description');
  }
  if (input.caseId !== undefined) data.caseId = input.caseId;
  if (receipts.length > 0) {
    data.receiptObjectIds = [
      ...new Set([...before.receiptObjectIds, ...receipts.map((r) => r.id)]),
    ].slice(0, 10);
    if (!before.receiptHash) data.receiptHash = receipts.find((r) => r.sha256)?.sha256 ?? null;
  }
  const finalAmount = input.amount !== undefined ? roundMoney(input.amount) : D(before.amount);
  if (input.splits !== undefined) {
    if (input.splits.length > 0) {
      const issues = splitIssues(finalAmount, input.splits);
      if (issues.length > 0) throw financeError('expense_incomplete', issues[0], { issues });
    }
    touch('splits');
  }
  data.aiProposal = toOperationalJson({ ...state.record, userProvided: [...state.userProvided] });
  let after = await tx.expense.update({ where: { id: before.id }, data });
  if (input.splits !== undefined) {
    await tx.expenseSplit.deleteMany({ where: { expenseId: before.id } });
    if (input.splits.length > 0)
      await tx.expenseSplit.createMany({ data: splitRows(before.id, input.splits) });
  }
  const evaluated = await reevaluateDuplicates(tx, before, after, ctx);
  after = evaluated.expense;
  ctx.emit(
    FINANCE_EVENTS.expense.updated,
    {
      expenseId: after.id,
      number: after.number,
      fields: Object.keys(data).filter((key) => key !== 'aiProposal'),
      amount: D(after.amount).toFixed(2),
      duplicateStatus: after.duplicateStatus,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.expense, after.id, after.caseId)
  );
  if (receipts.length > 0) queueProposal(ctx, after.id);
  publishBoard(ctx, 'finance.expense', {
    expenseId: after.id,
    number: after.number,
    status: after.status,
  });
  return { expense: await loadExpense(tx, after.id), matches: evaluated.matches };
}

const proposalPayloadSchema = z.object({
  amount: z.string().nullable(),
  dateKey: z.string().nullable(),
  supplierId: z.string().nullable(),
  supplierNameFree: z.string().nullable(),
  categoryId: z.string().nullable(),
  costCenterId: z.string().nullable(),
  description: z.string().nullable(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  isPaid: z.boolean().nullable(),
  splits: z
    .array(z.object({ amount: z.string(), pct: z.string().nullable(), costCenterId: z.string() }))
    .max(20),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string().max(500)).max(30),
  reasons: z.array(z.string().max(500)).max(30),
});

export const applyProposalSchema = z.object({
  expenseId: idSchema,
  source: z.enum(['ai', 'rules']),
  model: z.string().max(120).nullish(),
  error: z.string().max(500).nullish(),
  receiptHash: z.string().max(128).nullish(),
  proposal: proposalPayloadSchema,
  notes: z.array(z.string().max(500)).max(20).default([]),
});

/** System command of the proposal job: fills only what the person did not provide. */
export async function applyProposalInTx(
  tx: Db,
  input: z.output<typeof applyProposalSchema>,
  ctx: CommandContext
): Promise<{ applied: boolean; expense: Expense; fields: string[] }> {
  const before = await loadExpense(tx, input.expenseId);
  if (before.status !== 'draft') return { applied: false, expense: before, fields: [] };
  const proposal: ResolvedExpenseProposal = { ...input.proposal };
  // The catalog may have changed since the job read it.
  if (proposal.categoryId) {
    const category = await tx.financeCategory.findUnique({ where: { id: proposal.categoryId } });
    if (!category || !isExpenseCategory(category)) proposal.categoryId = null;
  }
  if (proposal.costCenterId) {
    const center = await tx.costCenter.findUnique({
      where: { id: proposal.costCenterId },
      select: { status: true },
    });
    if (center?.status !== 'active') proposal.costCenterId = null;
  }
  if (proposal.supplierId) {
    const supplier = await tx.supplier.findUnique({
      where: { id: proposal.supplierId },
      select: { id: true },
    });
    if (!supplier) proposal.supplierId = null;
  }
  const state = proposalStateOf(before);
  const patch = mergeProposalIntoExpense(
    {
      amount: before.amount,
      dateKey: dateKeyOf(before.date),
      supplierId: before.supplierId,
      supplierNameFree: before.supplierNameFree,
      categoryId: before.categoryId,
      costCenterId: before.costCenterId,
      description: before.description,
      paymentMethod: before.paymentMethod,
      isPaid: before.isPaid,
      splitCount: before.splits.length,
    },
    proposal,
    state.userProvided
  );
  const { splits, ...fields } = patch;
  const data: Prisma.ExpenseUpdateInput = {
    ...fields,
    ...(input.receiptHash && !before.receiptHash ? { receiptHash: input.receiptHash } : {}),
    aiProposal: toOperationalJson({
      status: 'proposed',
      source: input.source,
      model: input.model ?? null,
      error: input.error ?? null,
      userProvided: [...state.userProvided],
      proposal,
      notes: input.notes,
      proposedAt: ctx.now.toISOString(),
    }),
  };
  let after = await tx.expense.update({ where: { id: before.id }, data });
  if (splits && splits.length > 0) {
    await tx.expenseSplit.createMany({
      data: splits.map((split) => ({
        expenseId: before.id,
        amount: roundMoney(split.amount),
        pct: split.pct === null ? null : new Prisma.Decimal(split.pct),
        costCenterId: split.costCenterId,
      })),
    });
  }
  after = (await reevaluateDuplicates(tx, before, after, ctx)).expense;
  const changed = [...Object.keys(fields), ...(splits ? ['splits'] : [])];
  ctx.emit(
    FINANCE_EVENTS.expense.proposed,
    {
      expenseId: after.id,
      number: after.number,
      source: input.source,
      fields: changed,
      confidence: proposal.confidence,
      warnings: proposal.warnings.slice(0, 10),
      duplicateStatus: after.duplicateStatus,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.expense, after.id, after.caseId)
  );
  ctx.realtime(userChannel(after.createdByUserId), 'finance.expense_proposed', {
    expenseId: after.id,
    number: after.number,
    duplicateStatus: after.duplicateStatus,
  });
  publishBoard(ctx, 'finance.expense', {
    expenseId: after.id,
    number: after.number,
    status: after.status,
  });
  return { applied: true, expense: after, fields: changed };
}

export const resolveDuplicateSchema = z.object({
  expenseId: idSchema,
  decision: z.enum(['unique', 'duplicate']),
  duplicateOfId: optionalId,
  note: z.string().trim().max(500).nullish(),
});

export async function resolveDuplicateInTx(
  tx: Db,
  input: z.output<typeof resolveDuplicateSchema>,
  ctx: CommandContext
): Promise<Expense> {
  const expense = await loadExpense(tx, input.expenseId);
  if (expense.status !== 'draft')
    throw financeError('invalid_state', `${expense.number} ya no es un borrador`);
  assertCanEdit(ctx, expense, ['finance.approve', 'finance.post']);
  let updated: Expense;
  if (input.decision === 'unique') {
    updated = await tx.expense.update({
      where: { id: expense.id },
      data: { duplicateStatus: 'confirmed_unique', duplicateOfId: null },
    });
  } else {
    const originalId = input.duplicateOfId ?? expense.duplicateOfId;
    if (!originalId) throw financeError('invalid_payload', 'Indica de qué gasto es duplicado');
    const original = await tx.expense.findUnique({
      where: { id: originalId },
      select: { id: true, number: true },
    });
    if (!original || original.id === expense.id)
      throw new OperationsError('not_found', 'No se encontró el gasto original');
    updated = await tx.expense.update({
      where: { id: expense.id },
      data: {
        duplicateStatus: 'confirmed_duplicate',
        duplicateOfId: original.id,
        status: 'rejected',
        rejectedReason:
          `Duplicado de ${original.number}${input.note ? `: ${input.note}` : ''}`.slice(0, 500),
      },
    });
  }
  ctx.emit(
    FINANCE_EVENTS.expense.duplicateResolved,
    {
      expenseId: updated.id,
      number: updated.number,
      decision: input.decision,
      duplicateOfId: updated.duplicateOfId,
      note: input.note ?? null,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.expense, updated.id, updated.caseId)
  );
  publishBoard(ctx, 'finance.expense', {
    expenseId: updated.id,
    number: updated.number,
    status: updated.status,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Submit / approval / post / reject / reverse
// ---------------------------------------------------------------------------

export const submitExpenseSchema = z.object({ expenseId: idSchema });

export async function submitExpenseInTx(
  tx: Db,
  input: z.output<typeof submitExpenseSchema>,
  ctx: CommandContext
): Promise<ExpenseCommandData> {
  const expense = await loadExpense(tx, input.expenseId);
  if (expense.status !== 'draft')
    throw financeError('invalid_state', `${expense.number} ya fue enviado`);
  assertCanEdit(ctx, expense, ['finance.post']);
  if (expense.duplicateStatus === 'suspect') {
    throw financeError(
      'duplicate_unresolved',
      `${expense.number} parece duplicado: confirma si es único o duplicado antes de enviarlo`
    );
  }
  if (expense.duplicateStatus === 'confirmed_duplicate') {
    throw financeError('invalid_state', `${expense.number} está marcado como duplicado`);
  }
  // A new expense may have appeared since capture: check again before asking for money.
  const reevaluated = await reevaluateDuplicates(tx, expense, expense, ctx);
  if (reevaluated.expense.duplicateStatus === 'suspect') {
    return toExpenseCommandData(reevaluated.expense, {
      submitted: false,
      matches: reevaluated.matches
        .slice(0, 5)
        .map(({ expenseId, number, kind, reason }) => ({ expenseId, number, kind, reason })),
    });
  }
  const refs = await loadCatalogRefs(tx);
  const issues = expenseCompletenessIssues(
    {
      amount: expense.amount,
      currency: expense.currency,
      dateKey: dateKeyOf(expense.date),
      categoryId: expense.categoryId,
      costCenterId: expense.costCenterId,
      isPaid: expense.isPaid,
      cashAccountId: expense.cashAccountId,
      splits: expense.splits.map((s) => ({ ...s, amount: s.amount })),
    },
    {
      categories: refs.categoriesById,
      costCenters: refs.costCentersById,
      cashAccounts: refs.cashAccountsById,
      todayKey: todayKeyOf(ctx),
      requireCashAccount: false,
    }
  );
  if (issues.length > 0) throw financeError('expense_incomplete', issues.join('; '), { issues });

  const creator = await tx.user.findUnique({
    where: { id: expense.createdByUserId },
    select: { isBot: true },
  });
  const requestedByUserId =
    creator && !creator.isBot ? expense.createdByUserId : actorUserIdOf(ctx);
  await tx.expense.update({ where: { id: expense.id }, data: { status: 'pending_approval' } });
  const supplier = expense.supplierId
    ? await tx.supplier.findUnique({ where: { id: expense.supplierId }, select: { name: true } })
    : null;
  const outcome = await requestApproval(tx, {
    scope: 'expense',
    targetType: FINANCE_OBJECT_TYPES.expense,
    targetId: expense.id,
    amount: expense.amount,
    currency: expense.currency,
    categoryId: expense.categoryId,
    caseId: expense.caseId,
    areaKey: FINANCE_AREA_KEY,
    requestedByUserId,
    title:
      `Gasto ${expense.number}${supplier?.name || expense.supplierNameFree ? ` · ${supplier?.name ?? expense.supplierNameFree}` : ''}`.slice(
        0,
        200
      ),
    description: expense.description,
  });
  const updated = await tx.expense.update({
    where: { id: expense.id },
    data: { approvalRequestId: outcome.approvalRequest.id },
  });
  ctx.emit(
    FINANCE_EVENTS.expense.submitted,
    {
      expenseId: updated.id,
      number: updated.number,
      amount: D(updated.amount).toFixed(2),
      currency: updated.currency,
      approvalRequestId: outcome.approvalRequest.id,
      autoApproved: outcome.autoApproved,
      requiredApprovals: outcome.approvalRequest.requiredApprovals,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.expense, updated.id, updated.caseId)
  );
  publishBoard(ctx, 'finance.expense', {
    expenseId: updated.id,
    number: updated.number,
    status: updated.status,
  });
  return toExpenseCommandData(updated, {
    submitted: true,
    approvalRequestId: outcome.approvalRequest.id,
    autoApproved: outcome.autoApproved,
    requiredApprovals: outcome.approvalRequest.requiredApprovals,
    firstSignatureByUserId: outcome.firstSignatureByUserId,
  });
}

type GlobalWithExpenseReactions = typeof globalThis & { __unikFinanceExpenseReactions?: boolean };

/** `expense` approvals: approved → `approved`; rejected → `rejected` with the reviewer's note. */
export function registerExpenseReactions(): void {
  const scope = globalThis as GlobalWithExpenseReactions;
  if (scope.__unikFinanceExpenseReactions) return;
  scope.__unikFinanceExpenseReactions = true;
  onApprovalDecided(FINANCE_OBJECT_TYPES.expense, async (tx, event) => {
    if (event.approvalRequest.scope !== 'expense') return;
    const expense = await tx.expense.findUnique({ where: { id: event.approvalRequest.targetId } });
    if (!expense || expense.status !== 'pending_approval') return;
    const approved = event.status === 'approved';
    const rejection = parseApprovalDecisions(event.approvalRequest.decisions)
      .filter((vote) => vote.decision === 'reject')
      .pop();
    // Auto-approval runs inside submit, whose aggregate (the expense) the engine already bumped.
    const version = event.auto ? {} : { version: { increment: 1 } };
    const updated = await tx.expense.update({
      where: { id: expense.id },
      data: approved
        ? {
            status: 'approved',
            approvedByUserId: event.decidedByUserId,
            approvalRequestId: event.approvalRequest.id,
            ...version,
          }
        : {
            status: 'rejected',
            rejectedReason: (rejection?.note ?? 'Rechazado en la aprobación').slice(0, 500),
            approvalRequestId: event.approvalRequest.id,
            ...version,
          },
    });
    event.ctx.emit(
      approved ? FINANCE_EVENTS.expense.approved : FINANCE_EVENTS.expense.rejected,
      {
        expenseId: updated.id,
        number: updated.number,
        approvalRequestId: event.approvalRequest.id,
        auto: event.auto,
        decidedByUserId: event.decidedByUserId,
        reason: approved ? null : updated.rejectedReason,
      },
      financeEventOptions(FINANCE_OBJECT_TYPES.expense, updated.id, updated.caseId)
    );
    publishBoard(event.ctx, 'finance.expense', {
      expenseId: updated.id,
      number: updated.number,
      status: updated.status,
    });
  });
}

registerExpenseReactions();

export const postExpenseSchema = z.object({
  expenseId: idSchema,
  cashAccountId: optionalId,
  /** Date of the entry (default: the expense date). */
  date: dateKeySchema.nullish(),
  /** Due date of the payable when the expense is not paid. */
  dueDate: dateKeySchema.nullish(),
});

export async function postExpenseInTx(
  tx: Db,
  input: z.output<typeof postExpenseSchema>,
  ctx: CommandContext
): Promise<ExpenseCommandData> {
  const expense = await loadExpense(tx, input.expenseId);
  if (expense.status !== 'approved') {
    throw financeError(
      'invalid_state',
      `${expense.number} debe estar aprobado para contabilizarse (está ${expense.status})`
    );
  }
  const cashAccountId = input.cashAccountId ?? expense.cashAccountId;
  const refs = await loadCatalogRefs(tx);
  const expenseDate = dateKeyOf(expense.date);
  const issues = expenseCompletenessIssues(
    {
      amount: expense.amount,
      currency: expense.currency,
      dateKey: expenseDate,
      categoryId: expense.categoryId,
      costCenterId: expense.costCenterId,
      isPaid: expense.isPaid,
      cashAccountId,
      splits: expense.splits,
    },
    {
      categories: refs.categoriesById,
      costCenters: refs.costCentersById,
      cashAccounts: refs.cashAccountsById,
      todayKey: todayKeyOf(ctx),
      requireCashAccount: true,
    }
  );
  if (issues.length > 0) throw financeError('expense_incomplete', issues.join('; '), { issues });
  const categoryId = expense.categoryId as string;
  const entryDate = input.date ?? expenseDate;
  const allocations = expenseLedgerAllocations({
    amount: expense.amount,
    costCenterId: expense.costCenterId,
    caseId: expense.caseId,
    splits: expense.splits,
  });
  const supplier = expense.supplierId
    ? await tx.supplier.findUnique({
        where: { id: expense.supplierId },
        select: { name: true, paymentTermsDays: true },
      })
    : null;
  const supplierName = supplier?.name ?? expense.supplierNameFree ?? null;
  const label = `${expense.number} · ${expense.description ?? supplierName ?? 'Gasto'}`.slice(
    0,
    500
  );

  let ledgerEntryId: string;
  let obligationId: string | null = null;
  if (expense.isPaid) {
    const total = roundMoney(sumMoney(allocations.map((a) => D(a.amount))));
    const entry = await postLedgerEntry(
      tx,
      {
        kind: 'expense',
        dateKey: entryDate,
        description: label,
        currency: expense.currency,
        sourceType: LEDGER_SOURCE_TYPES.expense,
        sourceId: expense.id,
        evidenceObjectIds: expense.receiptObjectIds,
        meta: {
          supplierId: expense.supplierId,
          supplierName,
          paymentMethod: expense.paymentMethod,
        },
        lines: [
          ...allocations.map((allocation) => ({
            accountType: 'category' as const,
            accountId: categoryId,
            debit: allocation.amount,
            costCenterId: allocation.costCenterId ?? null,
            caseId: allocation.caseId ?? null,
            projectRef: allocation.projectRef ?? null,
            memo: expense.description,
          })),
          {
            accountType: 'cash' as const,
            accountId: cashAccountId as string,
            credit: total,
            memo: supplierName,
          },
        ],
      },
      ctx
    );
    ledgerEntryId = entry.id;
  } else {
    const dueKey =
      input.dueDate ??
      (supplier?.paymentTermsDays
        ? addDaysToKey(expenseDate, supplier.paymentTermsDays)
        : expenseDate);
    const { obligation, ledgerEntry } = await createObligationWithEntry(
      tx,
      {
        kind: 'payable',
        counterpartyType: expense.supplierId ? 'supplier' : 'other',
        counterpartyName: supplierName,
        supplierId: expense.supplierId,
        expenseId: expense.id,
        caseId: expense.caseId,
        description: label,
        currency: expense.currency,
        expectedAmount: expense.amount,
        dueAt: dueKey,
        categoryId,
        costCenterId: expense.costCenterId,
        date: entryDate,
        allocations: allocations.map((a) => ({ ...a, amount: D(a.amount).toFixed(2) })),
        evidenceObjectIds: expense.receiptObjectIds,
      },
      ctx
    );
    obligationId = obligation.id;
    ledgerEntryId = ledgerEntry?.id ?? (obligation.ledgerEntryId as string);
  }
  const updated = await tx.expense.update({
    where: { id: expense.id },
    data: {
      status: 'posted',
      postedAt: ctx.now,
      ledgerEntryId,
      obligationId,
      cashAccountId: cashAccountId ?? null,
    },
  });
  ctx.emit(
    FINANCE_EVENTS.expense.posted,
    {
      expenseId: updated.id,
      number: updated.number,
      amount: D(updated.amount).toFixed(2),
      currency: updated.currency,
      isPaid: updated.isPaid,
      ledgerEntryId,
      obligationId,
      date: entryDate,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.expense, updated.id, updated.caseId)
  );
  publishBoard(ctx, 'finance.expense', {
    expenseId: updated.id,
    number: updated.number,
    status: updated.status,
  });
  return toExpenseCommandData(updated, { ledgerEntryId, obligationId });
}

export const rejectExpenseSchema = z.object({
  expenseId: idSchema,
  reason: z.string().trim().min(3).max(500),
});

export async function rejectExpenseInTx(
  tx: Db,
  input: z.output<typeof rejectExpenseSchema>,
  ctx: CommandContext
): Promise<Expense> {
  const expense = await loadExpense(tx, input.expenseId);
  if (expense.status === 'pending_approval') {
    throw financeError(
      'invalid_state',
      `${expense.number} espera su aprobación: recházalo desde la aprobación`
    );
  }
  if (expense.status === 'posted')
    throw financeError('invalid_state', `${expense.number} ya está contabilizado: revérsalo`);
  if (expense.status === 'rejected') return expense;
  if (expense.status === 'draft') assertCanEdit(ctx, expense, ['finance.approve', 'finance.post']);
  else if (!hasFinancePermission(ctx.user, 'finance.post') && ctx.actor.type !== 'system') {
    throw new OperationsError('forbidden', 'Sólo Contabilidad descarta un gasto aprobado');
  }
  const updated = await tx.expense.update({
    where: { id: expense.id },
    data: { status: 'rejected', rejectedReason: input.reason },
  });
  ctx.emit(
    FINANCE_EVENTS.expense.rejected,
    {
      expenseId: updated.id,
      number: updated.number,
      reason: input.reason,
      previousStatus: expense.status,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.expense, updated.id, updated.caseId)
  );
  publishBoard(ctx, 'finance.expense', {
    expenseId: updated.id,
    number: updated.number,
    status: updated.status,
  });
  return updated;
}

export const reverseExpenseSchema = z.object({
  expenseId: idSchema,
  reason: z.string().trim().min(3).max(500),
  date: dateKeySchema.nullish(),
});

/** A posted expense is corrected only by reversing its entry (or cancelling its unpaid payable). */
export async function reverseExpenseInTx(
  tx: Db,
  input: z.output<typeof reverseExpenseSchema>,
  ctx: CommandContext
): Promise<{ expense: Expense; reversalEntryId: string | null }> {
  const expense = await loadExpense(tx, input.expenseId);
  if (expense.status !== 'posted')
    throw financeError('invalid_state', `${expense.number} no está contabilizado`);
  let reversalEntryId: string | null = null;
  if (expense.obligationId) {
    const cancelled = await cancelObligation(
      tx,
      expense.obligationId,
      `Reverso de ${expense.number}: ${input.reason}`,
      ctx
    );
    const entry = cancelled.ledgerEntryId
      ? await tx.ledgerEntry.findUnique({
          where: { id: cancelled.ledgerEntryId },
          select: { reversedByEntryId: true },
        })
      : null;
    reversalEntryId = entry?.reversedByEntryId ?? null;
  } else if (expense.ledgerEntryId) {
    const { reversal } = await reverseLedgerEntry(
      tx,
      {
        entryId: expense.ledgerEntryId,
        reason: `Reverso de ${expense.number}: ${input.reason}`,
        dateKey: input.date ?? null,
      },
      ctx
    );
    reversalEntryId = reversal.id;
  }
  const updated = await tx.expense.update({
    where: { id: expense.id },
    data: { status: 'rejected', rejectedReason: `Reversado: ${input.reason}`.slice(0, 500) },
  });
  ctx.emit(
    FINANCE_EVENTS.expense.reversed,
    {
      expenseId: updated.id,
      number: updated.number,
      reason: input.reason,
      reversalEntryId,
      obligationId: expense.obligationId,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.expense, updated.id, updated.caseId)
  );
  publishBoard(ctx, 'finance.expense', {
    expenseId: updated.id,
    number: updated.number,
    status: updated.status,
  });
  return { expense: updated, reversalEntryId };
}

// ---------------------------------------------------------------------------
// Templates and recurring expenses
// ---------------------------------------------------------------------------

export const expenseTemplateCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    categoryId: idSchema,
    costCenterId: optionalId,
    supplierId: optionalId,
    defaultAmount: positiveMoneySchema.nullish(),
    currency: currencySchema.default('MXN'),
    recurrence: recurrenceSchema.nullish(),
    firstRunDate: dateKeySchema.nullish(),
  })
  .superRefine((value, issue) => {
    if (value.recurrence && !value.firstRunDate) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['firstRunDate'],
        message: 'Indica la primera fecha del gasto recurrente',
      });
    }
  });

export const expenseTemplateUpdateSchema = z.object({
  templateId: idSchema,
  name: z.string().trim().min(2).max(120).optional(),
  categoryId: idSchema.optional(),
  costCenterId: optionalId,
  supplierId: optionalId,
  defaultAmount: positiveMoneySchema.nullish(),
  recurrence: recurrenceSchema.nullish(),
  nextRunDate: dateKeySchema.nullish(),
  active: z.boolean().optional(),
});

export const captureFromTemplateSchema = z.object({
  templateId: idSchema,
  amount: positiveMoneySchema.nullish(),
  date: dateKeySchema.nullish(),
  description: z.string().trim().max(500).nullish(),
  cashAccountId: optionalId,
  isPaid: z.boolean().nullish(),
  caseId: optionalId,
});

export const runRecurringSchema = z.object({ templateId: idSchema, runDate: dateKeySchema });

export async function createExpenseTemplateInTx(
  tx: Db,
  input: z.output<typeof expenseTemplateCreateSchema>,
  ctx: CommandContext
): Promise<{ templateId: string; nextRunAt: string | null }> {
  await validateReferences(tx, {
    categoryId: input.categoryId,
    costCenterId: input.costCenterId,
    supplierId: input.supplierId,
  });
  const row = await tx.expenseTemplate.create({
    data: {
      name: input.name,
      categoryId: input.categoryId,
      costCenterId: input.costCenterId ?? null,
      supplierId: input.supplierId ?? null,
      defaultAmount: input.defaultAmount ? roundMoney(input.defaultAmount) : null,
      currency: input.currency,
      recurrence: input.recurrence ? toOperationalJson(input.recurrence) : Prisma.DbNull,
      nextRunAt: input.recurrence && input.firstRunDate ? toDbDate(input.firstRunDate) : null,
      createdByUserId: actorUserIdOf(ctx),
    },
  });
  ctx.emit(
    FINANCE_EVENTS.expense.templateChanged,
    { templateId: row.id, name: row.name, action: 'created', recurring: Boolean(input.recurrence) },
    financeEventOptions(FINANCE_OBJECT_TYPES.expenseTemplate, row.id)
  );
  return { templateId: row.id, nextRunAt: row.nextRunAt ? dateKeyOf(row.nextRunAt) : null };
}

export async function updateExpenseTemplateInTx(
  tx: Db,
  input: z.output<typeof expenseTemplateUpdateSchema>,
  ctx: CommandContext
): Promise<{ templateId: string; nextRunAt: string | null; active: boolean }> {
  const template = await tx.expenseTemplate.findUnique({ where: { id: input.templateId } });
  if (!template) throw new OperationsError('not_found', 'No se encontró la plantilla');
  if (
    ctx.user?.id !== template.createdByUserId &&
    !hasFinancePermission(ctx.user, 'finance.manage_catalog')
  ) {
    throw new OperationsError(
      'forbidden',
      'Sólo quien creó la plantilla o Contabilidad la modifica'
    );
  }
  await validateReferences(tx, {
    categoryId: input.categoryId,
    costCenterId: input.costCenterId,
    supplierId: input.supplierId,
  });
  const recurrence =
    input.recurrence !== undefined ? input.recurrence : parseRecurrence(template.recurrence);
  let nextRunAt: Date | null | undefined;
  if (input.nextRunDate !== undefined)
    nextRunAt = input.nextRunDate ? toDbDate(input.nextRunDate) : null;
  if (!recurrence) nextRunAt = null;
  if (recurrence && nextRunAt === undefined && !template.nextRunAt) {
    throw financeError('invalid_recurrence', 'Indica la próxima fecha del gasto recurrente');
  }
  const row = await tx.expenseTemplate.update({
    where: { id: template.id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.categoryId ? { categoryId: input.categoryId } : {}),
      ...(input.costCenterId !== undefined ? { costCenterId: input.costCenterId } : {}),
      ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
      ...(input.defaultAmount !== undefined
        ? { defaultAmount: input.defaultAmount ? roundMoney(input.defaultAmount) : null }
        : {}),
      ...(input.recurrence !== undefined
        ? { recurrence: input.recurrence ? toOperationalJson(input.recurrence) : Prisma.DbNull }
        : {}),
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
  ctx.emit(
    FINANCE_EVENTS.expense.templateChanged,
    { templateId: row.id, name: row.name, action: 'updated', active: row.active },
    financeEventOptions(FINANCE_OBJECT_TYPES.expenseTemplate, row.id)
  );
  return {
    templateId: row.id,
    nextRunAt: row.nextRunAt ? dateKeyOf(row.nextRunAt) : null,
    active: row.active,
  };
}

export async function captureFromTemplateInTx(
  tx: Db,
  input: z.output<typeof captureFromTemplateSchema>,
  ctx: CommandContext
): Promise<{ expense: ExpenseWithSplits; matches: DuplicateMatch[] }> {
  if (ctx.actor.type !== 'user' && ctx.actor.type !== 'ai') {
    throw new OperationsError(
      'forbidden',
      'Un gasto lo captura una persona o una identidad de IA registrada'
    );
  }
  const template = await tx.expenseTemplate.findUnique({ where: { id: input.templateId } });
  if (!template || !template.active)
    throw new OperationsError('not_found', 'La plantilla no existe o está inactiva');
  await validateReferences(tx, { cashAccountId: input.cashAccountId, caseId: input.caseId });
  const amount = roundMoney(input.amount ?? template.defaultAmount ?? 0);
  const userProvided = ['categoryId', 'date'];
  if (template.costCenterId) userProvided.push('costCenterId');
  if (template.supplierId) userProvided.push('supplier');
  if (amount.greaterThan(0)) userProvided.push('amount');
  if (input.description) userProvided.push('description');
  return createExpenseDraftInTx(
    tx,
    {
      captureMode: 'template',
      rawInput: null,
      amount,
      currency: template.currency,
      dateKey: input.date ?? todayKeyOf(ctx),
      supplierId: template.supplierId,
      supplierNameFree: null,
      categoryId: template.categoryId,
      costCenterId: template.costCenterId,
      cashAccountId: input.cashAccountId ?? null,
      paymentMethod: null,
      isPaid: input.isPaid ?? true,
      description: input.description ?? template.name,
      receipts: [],
      caseId: input.caseId ?? null,
      splits: [],
      templateId: template.id,
      createdByUserId: ctx.actor.id,
      userProvided,
      needsProposal: false,
    },
    ctx
  );
}

/** System command of the daily job: one draft per due run, then the template moves to its next date. */
export async function runRecurringExpenseInTx(
  tx: Db,
  input: z.output<typeof runRecurringSchema>,
  ctx: CommandContext
): Promise<{
  created: boolean;
  expenseId: string | null;
  nextRunAt: string | null;
  reason?: string;
}> {
  const template = await tx.expenseTemplate.findUnique({ where: { id: input.templateId } });
  if (!template || !template.active)
    return { created: false, expenseId: null, nextRunAt: null, reason: 'inactive' };
  const recurrence = parseRecurrence(template.recurrence);
  if (!recurrence || !template.nextRunAt)
    return { created: false, expenseId: null, nextRunAt: null, reason: 'not_recurring' };
  const due = dateKeyOf(template.nextRunAt);
  if (due !== input.runDate)
    return { created: false, expenseId: null, nextRunAt: due, reason: 'not_due' };
  const { expense } = await createExpenseDraftInTx(
    tx,
    {
      captureMode: 'recurring',
      rawInput: null,
      amount: roundMoney(template.defaultAmount ?? 0),
      currency: template.currency,
      dateKey: due,
      supplierId: template.supplierId,
      supplierNameFree: null,
      categoryId: template.categoryId,
      costCenterId: template.costCenterId,
      cashAccountId: null,
      paymentMethod: null,
      isPaid: true,
      description: template.name,
      receipts: [],
      caseId: null,
      splits: [],
      templateId: template.id,
      createdByUserId: template.createdByUserId,
      userProvided: ['categoryId', 'date', 'costCenterId', 'supplier', 'amount', 'description'],
      needsProposal: false,
    },
    ctx
  );
  const next = nextRecurrenceKey(recurrence, due);
  await tx.expenseTemplate.update({
    where: { id: template.id },
    data: { nextRunAt: toDbDate(next) },
  });
  ctx.realtime(userChannel(template.createdByUserId), 'finance.expense_recurring', {
    expenseId: expense.id,
    number: expense.number,
    templateId: template.id,
  });
  return { created: true, expenseId: expense.id, nextRunAt: next };
}

// ---------------------------------------------------------------------------
// Proposal job (outside any transaction)
// ---------------------------------------------------------------------------

export interface ProposeExpenseOutcome {
  status: 'applied' | 'skipped' | 'not_found' | 'rejected';
  source?: 'ai' | 'rules';
  error?: string | null;
  fields?: string[];
}

/**
 * `finance.expense_propose`: reads the receipts and the text, asks the model
 * once (never required: without AI the history rules still propose), resolves
 * the proposal against the catalog and applies it with a system command.
 */
export async function proposeExpense(
  expenseId: string,
  options: { now?: Date } = {}
): Promise<ProposeExpenseOutcome> {
  const now = options.now ?? new Date();
  const expense = await prisma.expense.findUnique({ where: { id: expenseId } });
  if (!expense) return { status: 'not_found' };
  if (expense.status !== 'draft') return { status: 'skipped' };
  const todayKey = localDateKey(now);
  const settings = await getFinanceSettings();
  const refs = await loadCatalogRefs(prisma);
  const receipts = expense.receiptObjectIds.length
    ? await prisma.storageObject.findMany({
        where: { id: { in: expense.receiptObjectIds } },
        select: RECEIPT_SELECT,
      })
    : [];
  const receiptHash = receipts.find((r) => r.sha256)?.sha256 ?? null;
  const since = addDaysToKey(todayKey, -30 * settings.expenseHistoryMonths);
  const [history, suppliers, employee] = await Promise.all([
    prisma.expense.findMany({
      where: {
        status: { in: ['approved', 'posted'] },
        date: { gte: toDbDate(since) },
        id: { not: expense.id },
      },
      select: {
        supplierId: true,
        supplierNameFree: true,
        categoryId: true,
        costCenterId: true,
        date: true,
      },
      orderBy: { date: 'desc' },
      take: 1000,
    }),
    prisma.supplier.findMany({
      where: { status: 'active' },
      select: { id: true, name: true, legalName: true, taxRegNo: true },
      orderBy: { name: 'asc' },
      take: 2000,
    }),
    prisma.employee.findUnique({
      where: { userId: expense.createdByUserId },
      select: { areaKey: true },
    }),
  ]);
  const historyRows = history.map((row) => ({
    supplierKey: supplierKeyOf(row),
    categoryId: row.categoryId,
    costCenterId: row.costCenterId,
    dateKey: dateKeyOf(row.date),
  }));
  const description = [expense.description, expense.rawInput, expense.supplierNameFree]
    .filter(Boolean)
    .join(' ');
  const suggest = (supplierKey: string) =>
    suggestExpenseClassification({
      supplierKey,
      areaKey: employee?.areaKey ?? null,
      description,
      history: historyRows,
      categories: refs.categories,
      costCenters: refs.costCenters,
    });

  let raw: ExpenseProposalRaw | null = null;
  let source: 'ai' | 'rules' = 'rules';
  let model: string | null = null;
  let error: string | null = null;
  const material = await buildExtractionMaterial({ rawInput: expense.rawInput, receipts });
  if (material.text || material.parts.length > 0) {
    try {
      const ai = await proposeExpenseWithAi({
        material,
        categories: refs.categories,
        costCenters: refs.costCenters,
        todayKey,
        currency: expense.currency,
      });
      raw = ai.raw;
      source = 'ai';
      model = ai.model;
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    }
  }
  const baseRefs = {
    categories: refs.categories,
    costCenters: refs.costCenters,
    suppliers,
    todayKey,
    expenseCurrency: expense.currency,
  };
  let resolved = resolveExpenseProposal(raw, {
    ...baseRefs,
    fallback: suggest(supplierKeyOf(expense)),
  });
  const proposedSupplierKey = supplierKeyOf({
    supplierId: expense.supplierId ?? resolved.supplierId,
    supplierNameFree: expense.supplierId
      ? null
      : (expense.supplierNameFree ?? resolved.supplierNameFree),
  });
  if (!raw?.categoryKey && proposedSupplierKey && proposedSupplierKey !== supplierKeyOf(expense)) {
    resolved = resolveExpenseProposal(raw, { ...baseRefs, fallback: suggest(proposedSupplierKey) });
  }
  const result = await runFinanceSystemCommand<{ applied: boolean; fields: string[] }>(
    {
      commandId: `finance:propose:${expense.id}:${expense.version}:${receipts.length}`,
      type: FINANCE_COMMANDS.expenseApplyProposal,
      aggregate: { type: FINANCE_OBJECT_TYPES.expense, id: expense.id },
      payload: {
        expenseId: expense.id,
        source,
        model,
        error,
        receiptHash,
        proposal: resolved,
        notes: material.notes,
      },
    },
    { now }
  );
  if (result.status === 'rejected')
    return { status: 'rejected', source, error: result.message ?? error };
  return {
    status: result.data?.applied ? 'applied' : 'skipped',
    source,
    error,
    fields: result.data?.fields ?? [],
  };
}

export const CAPTURE_MODES_WITH_PROPOSAL: readonly ExpenseCaptureMode[] =
  EXPENSE_CAPTURE_MODES.filter((mode) => mode === 'text' || mode === 'voice' || mode === 'photo');
