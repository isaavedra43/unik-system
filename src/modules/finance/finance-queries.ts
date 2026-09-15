import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { OperationsError } from '@/modules/operations/errors';
import { getOperationsConfig } from '@/modules/operations/operations-config';
import { listUnmatchedPayments, type UnmatchedPayment } from './collections-service';
import {
  addDaysToKey,
  compareKeys,
  dateKeyOf,
  dateKeySchema,
  localDateKey,
  periodKeySchema,
  toDbDate,
} from './finance-dates';
import {
  toBudgetDTO,
  toCashAccountDTO,
  toCategoryDTO,
  toCostCenterDTO,
  toEmployeeDTO,
  toExpenseDTO,
  toExpenseTemplateDTO,
  toLedgerEntryDTO,
  toObligationDTO,
  toPayrollRunDTO,
  toPeriodCloseDTO,
  type BudgetDTO,
  type CashAccountDTO,
  type CategoryDTO,
  type CostCenterDTO,
  type EmployeeDTO,
  type ExpenseDTO,
  type ExpenseTemplateDTO,
  type LedgerEntryDTO,
  type ObligationDTO,
  type PayrollRunDTO,
  type PeriodCloseDTO,
} from './finance-dto';
import { hasFinancePermission } from './finance-helpers';
import { D, moneyString, roundMoney } from './money';
import {
  AGING_BUCKETS,
  paymentAuthorizationState,
  remainingOf,
  summarizeAging,
  type AgingBucket,
  type AgingSummary,
  type PaymentAuthorizationState,
} from './obligation-rules';
import {
  COUNTERPARTY_TYPES,
  DUPLICATE_STATUSES,
  EXPENSE_CAPTURE_MODES,
  EXPENSE_PENDING_STATUSES,
  EXPENSE_STATUSES,
  FINANCE_OBJECT_TYPES,
  LEDGER_ENTRY_KINDS,
  OBLIGATION_KINDS,
  OBLIGATION_OPEN_STATUSES,
  OBLIGATION_STATUSES,
  PAYROLL_STATUSES,
  PERIOD_CLOSE_KINDS,
} from './types';

/**
 * Read side of the internal accounting for the UI (built in the next phase),
 * AI tools and routes. Every function takes the session user and checks the
 * finance permission on the server; lists are paginated (`page` from 1,
 * `pageSize` ≤ 200) and return JSON-safe DTOs. A person with only
 * `finance.capture_expense` sees their own expenses and the templates.
 */

export interface PageInput {
  page?: number;
  pageSize?: number;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function normalizePage(input: PageInput = {}): { page: number; pageSize: number; skip: number } {
  const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const page = Math.max(Math.trunc(input.page ?? 1), 1);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function pageOf<T>(rows: T[], total: number, page: { page: number; pageSize: number }): Page<T> {
  return { rows, total, page: page.page, pageSize: page.pageSize, pageCount: Math.max(1, Math.ceil(total / page.pageSize)) };
}

function requireAny(actor: CurrentUser, keys: readonly string[], message = 'No tienes permisos para ver la contabilidad'): void {
  if (!keys.some((key) => hasFinancePermission(actor, key))) throw new OperationsError('forbidden', message);
}

const VIEW = ['finance.view'] as const;
const pageFields = {
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
};

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new OperationsError(
      'invalid_payload',
      `Filtros inválidos: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface FinanceCatalogDTO {
  cashAccounts: CashAccountDTO[];
  categories: CategoryDTO[];
  costCenters: CostCenterDTO[];
}

export async function getFinanceCatalog(actor: CurrentUser): Promise<FinanceCatalogDTO> {
  requireAny(actor, ['finance.view', 'finance.capture_expense', 'finance.manage_catalog']);
  const [cashAccounts, categories, costCenters] = await Promise.all([
    prisma.cashAccount.findMany({ orderBy: [{ status: 'asc' }, { name: 'asc' }] }),
    prisma.financeCategory.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }] }),
    prisma.costCenter.findMany({ orderBy: [{ name: 'asc' }] }),
  ]);
  return {
    cashAccounts: cashAccounts.map(toCashAccountDTO),
    categories: categories.map(toCategoryDTO),
    costCenters: costCenters.map(toCostCenterDTO),
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export const ledgerFiltersSchema = z.object({
  ...pageFields,
  periodKey: periodKeySchema.optional(),
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
  kind: z.enum(LEDGER_ENTRY_KINDS).optional(),
  sourceType: z.string().trim().max(60).optional(),
  sourceId: z.string().trim().max(120).optional(),
  search: z.string().trim().max(120).optional(),
  cashAccountId: z.string().trim().max(120).optional(),
});

export type LedgerFilters = z.input<typeof ledgerFiltersSchema>;

export async function listLedgerEntries(actor: CurrentUser, filters: LedgerFilters = {}): Promise<Page<LedgerEntryDTO>> {
  requireAny(actor, VIEW);
  const f = parse(ledgerFiltersSchema, filters);
  const page = normalizePage(f);
  const where: Prisma.LedgerEntryWhereInput = {
    ...(f.periodKey ? { periodKey: f.periodKey } : {}),
    ...(f.from || f.to ? { date: { ...(f.from ? { gte: toDbDate(f.from) } : {}), ...(f.to ? { lte: toDbDate(f.to) } : {}) } } : {}),
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.sourceType ? { sourceType: f.sourceType } : {}),
    ...(f.sourceId ? { sourceId: f.sourceId } : {}),
    ...(f.cashAccountId ? { lines: { some: { accountType: 'cash', accountId: f.cashAccountId } } } : {}),
    ...(f.search
      ? { OR: [{ number: { contains: f.search, mode: 'insensitive' } }, { description: { contains: f.search, mode: 'insensitive' } }] }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.ledgerEntry.count({ where }),
    prisma.ledgerEntry.findMany({
      where,
      include: { lines: { orderBy: { seq: 'asc' } } },
      orderBy: [{ date: 'desc' }, { postedAt: 'desc' }],
      skip: page.skip,
      take: page.pageSize,
    }),
  ]);
  return pageOf(rows.map(toLedgerEntryDTO), total, page);
}

export async function getLedgerEntry(actor: CurrentUser, entryId: string): Promise<LedgerEntryDTO> {
  requireAny(actor, VIEW);
  const entry = await prisma.ledgerEntry.findUnique({ where: { id: entryId }, include: { lines: { orderBy: { seq: 'asc' } } } });
  if (!entry) throw new OperationsError('not_found', 'No se encontró el asiento');
  return toLedgerEntryDTO(entry);
}

// ---------------------------------------------------------------------------
// Obligations
// ---------------------------------------------------------------------------

export function agingRangeWhere(bucket: AgingBucket, todayKey: string): Prisma.ObligationWhereInput {
  const day = (offset: number) => toDbDate(addDaysToKey(todayKey, offset));
  switch (bucket) {
    case 'no_due_date':
      return { dueAt: null };
    case 'not_due':
      return { dueAt: { gte: day(0) } };
    case 'd1_30':
      return { dueAt: { gte: day(-30), lt: day(0) } };
    case 'd31_60':
      return { dueAt: { gte: day(-60), lt: day(-30) } };
    case 'd61_90':
      return { dueAt: { gte: day(-90), lt: day(-60) } };
    case 'd90_plus':
      return { dueAt: { lt: day(-90) } };
  }
}

export const obligationFiltersSchema = z.object({
  ...pageFields,
  kind: z.enum(OBLIGATION_KINDS).optional(),
  /** 'open' = expected + partially settled. */
  status: z.union([z.enum(OBLIGATION_STATUSES), z.literal('open'), z.literal('all')]).default('open'),
  counterpartyType: z.enum(COUNTERPARTY_TYPES).optional(),
  agingBucket: z.enum(AGING_BUCKETS).optional(),
  overdueOnly: z.boolean().optional(),
  caseId: z.string().trim().max(120).optional(),
  employeeId: z.string().trim().max(120).optional(),
  supplierId: z.string().trim().max(120).optional(),
  zohoContactId: z.string().trim().max(120).optional(),
  zohoSalesOrderId: z.string().trim().max(120).optional(),
  procurementOrderId: z.string().trim().max(120).optional(),
  dueFrom: dateKeySchema.optional(),
  dueTo: dateKeySchema.optional(),
  search: z.string().trim().max(120).optional(),
});

export type ObligationFilters = z.input<typeof obligationFiltersSchema>;

export async function listObligations(
  actor: CurrentUser,
  filters: ObligationFilters = {},
  options: { now?: Date } = {}
): Promise<Page<ObligationDTO> & { aging: AgingSummary }> {
  requireAny(actor, VIEW);
  const f = parse(obligationFiltersSchema, filters);
  const page = normalizePage(f);
  const todayKey = localDateKey(options.now ?? new Date());
  const and: Prisma.ObligationWhereInput[] = [];
  if (f.kind) and.push({ kind: f.kind });
  if (f.status === 'open') and.push({ status: { in: [...OBLIGATION_OPEN_STATUSES] } });
  else if (f.status !== 'all') and.push({ status: f.status });
  if (f.counterpartyType) and.push({ counterpartyType: f.counterpartyType });
  if (f.agingBucket) and.push(agingRangeWhere(f.agingBucket, todayKey));
  if (f.overdueOnly) and.push({ dueAt: { lt: toDbDate(todayKey) } });
  for (const key of ['caseId', 'employeeId', 'supplierId', 'zohoContactId', 'zohoSalesOrderId', 'procurementOrderId'] as const) {
    if (f[key]) and.push({ [key]: f[key] });
  }
  if (f.dueFrom) and.push({ dueAt: { gte: toDbDate(f.dueFrom) } });
  if (f.dueTo) and.push({ dueAt: { lte: toDbDate(f.dueTo) } });
  if (f.search) {
    and.push({
      OR: [
        { number: { contains: f.search, mode: 'insensitive' } },
        { description: { contains: f.search, mode: 'insensitive' } },
        { counterpartyName: { contains: f.search, mode: 'insensitive' } },
      ],
    });
  }
  const where: Prisma.ObligationWhereInput = and.length ? { AND: and } : {};
  const [total, rows, openRows] = await Promise.all([
    prisma.obligation.count({ where }),
    prisma.obligation.findMany({ where, orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }], skip: page.skip, take: page.pageSize }),
    prisma.obligation.findMany({
      where: { AND: [...and.filter((c) => !('status' in c)), { status: { in: [...OBLIGATION_OPEN_STATUSES] } }] },
      select: { kind: true, expectedAmount: true, settledAmount: true, dueAt: true },
      take: 20_000,
    }),
  ]);
  return {
    ...pageOf(rows.map((row) => toObligationDTO(row, todayKey)), total, page),
    aging: summarizeAging(
      openRows.map((row) => ({ kind: row.kind, remaining: remainingOf(row), dueAt: row.dueAt })),
      todayKey
    ),
  };
}

export interface ObligationDetailDTO extends ObligationDTO {
  paymentAuthorization: PaymentAuthorizationState;
  approvals: Array<{ id: string; status: string; amount: string; requiredApprovals: number; createdAt: string }>;
  ledgerEntry: LedgerEntryDTO | null;
}

export async function getObligation(actor: CurrentUser, obligationId: string, options: { now?: Date } = {}): Promise<ObligationDetailDTO> {
  requireAny(actor, VIEW);
  const obligation = await prisma.obligation.findUnique({
    where: { id: obligationId },
    include: { settlements: { orderBy: { settledAt: 'asc' } } },
  });
  if (!obligation) throw new OperationsError('not_found', 'No se encontró la obligación');
  const [approvals, entry] = await Promise.all([
    prisma.approvalRequest.findMany({
      where: { scope: 'payment', targetType: FINANCE_OBJECT_TYPES.obligation, targetId: obligation.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    obligation.ledgerEntryId
      ? prisma.ledgerEntry.findUnique({ where: { id: obligation.ledgerEntryId }, include: { lines: { orderBy: { seq: 'asc' } } } })
      : Promise.resolve(null),
  ]);
  return {
    ...toObligationDTO(obligation, localDateKey(options.now ?? new Date())),
    paymentAuthorization: paymentAuthorizationState(obligation, approvals),
    approvals: approvals.map((a) => ({
      id: a.id,
      status: a.status,
      amount: moneyString(a.amount),
      requiredApprovals: a.requiredApprovals,
      createdAt: a.createdAt.toISOString(),
    })),
    ledgerEntry: entry ? toLedgerEntryDTO(entry) : null,
  };
}

export async function getAgingSummary(actor: CurrentUser, input: { asOf?: string; currency?: string } = {}): Promise<AgingSummary & { asOf: string }> {
  requireAny(actor, VIEW);
  const asOf = input.asOf && dateKeySchema.safeParse(input.asOf).success ? input.asOf : localDateKey(new Date());
  const rows = await prisma.obligation.findMany({
    where: { status: { in: [...OBLIGATION_OPEN_STATUSES] }, currency: input.currency ?? 'MXN' },
    select: { kind: true, expectedAmount: true, settledAmount: true, dueAt: true },
    take: 20_000,
  });
  return { ...summarizeAging(rows.map((r) => ({ kind: r.kind, remaining: remainingOf(r), dueAt: r.dueAt })), asOf), asOf };
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export const expenseFiltersSchema = z.object({
  ...pageFields,
  status: z.union([z.enum(EXPENSE_STATUSES), z.literal('pending'), z.literal('all')]).default('all'),
  mine: z.boolean().optional(),
  duplicateStatus: z.enum(DUPLICATE_STATUSES).optional(),
  captureMode: z.enum(EXPENSE_CAPTURE_MODES).optional(),
  categoryId: z.string().trim().max(120).optional(),
  costCenterId: z.string().trim().max(120).optional(),
  supplierId: z.string().trim().max(120).optional(),
  caseId: z.string().trim().max(120).optional(),
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
  search: z.string().trim().max(120).optional(),
});

export type ExpenseFilters = z.input<typeof expenseFiltersSchema>;

export async function listExpenses(actor: CurrentUser, filters: ExpenseFilters = {}): Promise<Page<ExpenseDTO>> {
  requireAny(actor, ['finance.view', 'finance.capture_expense']);
  const f = parse(expenseFiltersSchema, filters);
  const page = normalizePage(f);
  const onlyMine = f.mine || !hasFinancePermission(actor, 'finance.view');
  const where: Prisma.ExpenseWhereInput = {
    ...(onlyMine ? { createdByUserId: actor.id } : {}),
    ...(f.status === 'pending'
      ? { status: { in: [...EXPENSE_PENDING_STATUSES] } }
      : f.status !== 'all'
        ? { status: f.status }
        : {}),
    ...(f.duplicateStatus ? { duplicateStatus: f.duplicateStatus } : {}),
    ...(f.captureMode ? { captureMode: f.captureMode } : {}),
    ...(f.categoryId ? { categoryId: f.categoryId } : {}),
    ...(f.costCenterId ? { costCenterId: f.costCenterId } : {}),
    ...(f.supplierId ? { supplierId: f.supplierId } : {}),
    ...(f.caseId ? { caseId: f.caseId } : {}),
    ...(f.from || f.to ? { date: { ...(f.from ? { gte: toDbDate(f.from) } : {}), ...(f.to ? { lte: toDbDate(f.to) } : {}) } } : {}),
    ...(f.search
      ? {
          OR: [
            { number: { contains: f.search, mode: 'insensitive' } },
            { description: { contains: f.search, mode: 'insensitive' } },
            { supplierNameFree: { contains: f.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.findMany({
      where,
      include: { splits: true },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      skip: page.skip,
      take: page.pageSize,
    }),
  ]);
  return pageOf(rows.map(toExpenseDTO), total, page);
}

export interface ExpenseDetailDTO extends ExpenseDTO {
  duplicateOfNumber: string | null;
  approval: { id: string; status: string; requiredApprovals: number; approvals: number } | null;
}

export async function getExpense(actor: CurrentUser, expenseId: string): Promise<ExpenseDetailDTO> {
  requireAny(actor, ['finance.view', 'finance.capture_expense']);
  const expense = await prisma.expense.findUnique({ where: { id: expenseId }, include: { splits: true } });
  if (!expense) throw new OperationsError('not_found', 'No se encontró el gasto');
  if (!hasFinancePermission(actor, 'finance.view') && expense.createdByUserId !== actor.id) {
    throw new OperationsError('forbidden', 'Sólo puedes ver los gastos que capturaste');
  }
  const [original, approval] = await Promise.all([
    expense.duplicateOfId ? prisma.expense.findUnique({ where: { id: expense.duplicateOfId }, select: { number: true } }) : null,
    expense.approvalRequestId ? prisma.approvalRequest.findUnique({ where: { id: expense.approvalRequestId } }) : null,
  ]);
  const votes = Array.isArray(approval?.decisions) ? (approval?.decisions as Array<{ decision?: string }>) : [];
  return {
    ...toExpenseDTO(expense),
    duplicateOfNumber: original?.number ?? null,
    approval: approval
      ? {
          id: approval.id,
          status: approval.status,
          requiredApprovals: approval.requiredApprovals,
          approvals: votes.filter((v) => v?.decision === 'approve').length,
        }
      : null,
  };
}

export async function listExpenseTemplates(actor: CurrentUser, input: { activeOnly?: boolean } = {}): Promise<ExpenseTemplateDTO[]> {
  requireAny(actor, ['finance.view', 'finance.capture_expense']);
  const rows = await prisma.expenseTemplate.findMany({
    where: input.activeOnly === false ? {} : { active: true },
    orderBy: { name: 'asc' },
    take: 500,
  });
  return rows.map(toExpenseTemplateDTO);
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

export const employeeFiltersSchema = z.object({
  ...pageFields,
  active: z.boolean().optional(),
  areaKey: z.string().trim().max(40).optional(),
  search: z.string().trim().max(120).optional(),
});

export async function listEmployees(actor: CurrentUser, filters: z.input<typeof employeeFiltersSchema> = {}): Promise<Page<EmployeeDTO>> {
  requireAny(actor, ['finance.payroll', 'finance.view']);
  const f = parse(employeeFiltersSchema, filters);
  const page = normalizePage(f);
  const where: Prisma.EmployeeWhereInput = {
    ...(f.active !== undefined ? { active: f.active } : {}),
    ...(f.areaKey ? { areaKey: f.areaKey } : {}),
    ...(f.search
      ? { OR: [{ name: { contains: f.search, mode: 'insensitive' } }, { number: { contains: f.search, mode: 'insensitive' } }] }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.findMany({ where, orderBy: { name: 'asc' }, skip: page.skip, take: page.pageSize }),
  ]);
  return pageOf(rows.map(toEmployeeDTO), total, page);
}

export const payrollFiltersSchema = z.object({
  ...pageFields,
  periodKey: periodKeySchema.optional(),
  status: z.enum(PAYROLL_STATUSES).optional(),
});

export async function listPayrollRuns(actor: CurrentUser, filters: z.input<typeof payrollFiltersSchema> = {}): Promise<Page<PayrollRunDTO>> {
  requireAny(actor, ['finance.payroll', 'finance.view']);
  const f = parse(payrollFiltersSchema, filters);
  const page = normalizePage(f);
  const where: Prisma.PayrollRunWhereInput = {
    ...(f.periodKey ? { periodKey: f.periodKey } : {}),
    ...(f.status ? { status: f.status } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.payrollRun.count({ where }),
    prisma.payrollRun.findMany({ where, orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }], skip: page.skip, take: page.pageSize }),
  ]);
  return pageOf(rows.map((row) => toPayrollRunDTO(row)), total, page);
}

export async function getPayrollRun(actor: CurrentUser, payrollRunId: string): Promise<PayrollRunDTO & { employees: EmployeeDTO[] }> {
  requireAny(actor, ['finance.payroll', 'finance.view']);
  const run = await prisma.payrollRun.findUnique({ where: { id: payrollRunId }, include: { lines: true } });
  if (!run) throw new OperationsError('not_found', 'No se encontró la nómina');
  const employees = await prisma.employee.findMany({ where: { id: { in: run.lines.map((l) => l.employeeId) } } });
  return { ...toPayrollRunDTO(run), employees: employees.map(toEmployeeDTO) };
}

// ---------------------------------------------------------------------------
// Budgets, closes, collections
// ---------------------------------------------------------------------------

export async function listBudgets(actor: CurrentUser, input: { periodKey: string }): Promise<BudgetDTO[]> {
  requireAny(actor, ['finance.view', 'finance.manage_catalog']);
  const periodKey = parse(z.object({ periodKey: periodKeySchema }), input).periodKey;
  const rows = await prisma.budget.findMany({ where: { periodKey }, orderBy: [{ costCenterId: 'asc' }, { categoryId: 'asc' }] });
  return rows.map(toBudgetDTO);
}

export const closeFiltersSchema = z.object({ ...pageFields, kind: z.enum(PERIOD_CLOSE_KINDS).optional(), status: z.string().trim().max(20).optional() });

export async function listPeriodCloses(actor: CurrentUser, filters: z.input<typeof closeFiltersSchema> = {}): Promise<Page<PeriodCloseDTO>> {
  requireAny(actor, ['finance.view', 'finance.close']);
  const f = parse(closeFiltersSchema, filters);
  const page = normalizePage(f);
  const where: Prisma.PeriodCloseWhereInput = { ...(f.kind ? { kind: f.kind } : {}), ...(f.status ? { status: f.status } : {}) };
  const [total, rows] = await Promise.all([
    prisma.periodClose.count({ where }),
    prisma.periodClose.findMany({ where, orderBy: [{ periodKey: 'desc' }, { kind: 'asc' }], skip: page.skip, take: page.pageSize }),
  ]);
  return pageOf(rows.map(toPeriodCloseDTO), total, page);
}

export async function listUnassignedCollections(
  actor: CurrentUser,
  input: { from?: string; to?: string; limit?: number } = {},
  options: { now?: Date } = {}
): Promise<UnmatchedPayment[]> {
  requireAny(actor, ['finance.view', 'finance.manage_obligations']);
  const todayKey = localDateKey(options.now ?? new Date());
  const config = await getOperationsConfig();
  const cutoverKey = localDateKey(new Date(config.cutoverDate));
  const requested = input.from && dateKeySchema.safeParse(input.from).success ? input.from : addDaysToKey(todayKey, -120);
  const fromKey = compareKeys(requested, cutoverKey) < 0 ? cutoverKey : requested;
  const toKey = input.to && dateKeySchema.safeParse(input.to).success ? input.to : null;
  return listUnmatchedPayments(prisma, { fromKey, toKey, limit: input.limit ?? 100 });
}

// ---------------------------------------------------------------------------
// Board and export
// ---------------------------------------------------------------------------

export interface FinanceBoardSummary {
  todayKey: string;
  cash: Array<{ currency: string; balance: string; accounts: number }>;
  receivables: { open: string; overdue: string; count: number };
  payables: { open: string; overdue: string; count: number };
  expenses: Record<'draft' | 'pending_approval' | 'approved' | 'suspectDuplicates', number>;
  unassignedCollections: { count: number; amount: string };
  payrollRunsOpen: number;
  lastDailyClose: string | null;
  lastMonthlyClose: string | null;
}

export async function getFinanceBoardSummary(actor: CurrentUser, options: { now?: Date } = {}): Promise<FinanceBoardSummary> {
  requireAny(actor, VIEW);
  const todayKey = localDateKey(options.now ?? new Date());
  const [accounts, open, draft, pending, approved, suspect, runs, lastDaily, lastMonthly, unassigned] = await Promise.all([
    prisma.cashAccount.findMany({ where: { status: 'active' }, select: { currency: true, currentBalance: true } }),
    prisma.obligation.findMany({
      where: { status: { in: [...OBLIGATION_OPEN_STATUSES] } },
      select: { kind: true, expectedAmount: true, settledAmount: true, dueAt: true },
      take: 20_000,
    }),
    prisma.expense.count({ where: { status: 'draft' } }),
    prisma.expense.count({ where: { status: 'pending_approval' } }),
    prisma.expense.count({ where: { status: 'approved' } }),
    prisma.expense.count({ where: { status: 'draft', duplicateStatus: 'suspect' } }),
    prisma.payrollRun.count({ where: { status: { in: ['draft', 'pending_approval', 'approved', 'obligations_created'] } } }),
    prisma.periodClose.findFirst({ where: { kind: 'daily', status: 'closed' }, orderBy: { periodKey: 'desc' }, select: { periodKey: true } }),
    prisma.periodClose.findFirst({ where: { kind: 'monthly', status: 'closed' }, orderBy: { periodKey: 'desc' }, select: { periodKey: true } }),
    listUnassignedCollections(actor, {}, options).catch(() => [] as UnmatchedPayment[]),
  ]);
  const cash = new Map<string, { balance: Prisma.Decimal; accounts: number }>();
  for (const account of accounts) {
    const current = cash.get(account.currency) ?? { balance: new Prisma.Decimal(0), accounts: 0 };
    cash.set(account.currency, { balance: current.balance.plus(D(account.currentBalance)), accounts: current.accounts + 1 });
  }
  const totals = (kind: string) => {
    let openAmount = new Prisma.Decimal(0);
    let overdue = new Prisma.Decimal(0);
    let count = 0;
    for (const row of open) {
      if (row.kind !== kind) continue;
      const remaining = remainingOf(row);
      openAmount = openAmount.plus(remaining);
      count += 1;
      if (row.dueAt && compareKeys(dateKeyOf(row.dueAt), todayKey) < 0) overdue = overdue.plus(remaining);
    }
    return { open: roundMoney(openAmount).toFixed(2), overdue: roundMoney(overdue).toFixed(2), count };
  };
  return {
    todayKey,
    cash: [...cash.entries()].map(([currency, value]) => ({ currency, balance: roundMoney(value.balance).toFixed(2), accounts: value.accounts })),
    receivables: totals('receivable'),
    payables: totals('payable'),
    expenses: { draft, pending_approval: pending, approved, suspectDuplicates: suspect },
    unassignedCollections: {
      count: unassigned.length,
      amount: roundMoney(unassigned.reduce((acc, p) => acc.plus(D(p.remaining)), new Prisma.Decimal(0))).toFixed(2),
    },
    payrollRunsOpen: runs,
    lastDailyClose: lastDaily?.periodKey ?? null,
    lastMonthlyClose: lastMonthly?.periodKey ?? null,
  };
}

export interface LedgerExportRow {
  entryNumber: string;
  date: string;
  periodKey: string;
  kind: string;
  description: string;
  seq: number;
  accountType: string;
  accountId: string;
  accountName: string;
  debit: string;
  credit: string;
  costCenter: string | null;
  caseId: string | null;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
}

export const MAX_EXPORT_LINES = 50_000;

/** Flat ledger lines of a date range for CSV/Excel (`finance.export`). */
export async function exportLedgerLines(actor: CurrentUser, input: { from: string; to: string }): Promise<{ rows: LedgerExportRow[]; truncated: boolean }> {
  requireAny(actor, ['finance.export'], 'No tienes permisos para exportar la contabilidad');
  const f = parse(z.object({ from: dateKeySchema, to: dateKeySchema }), input);
  if (compareKeys(f.from, f.to) > 0) throw new OperationsError('invalid_payload', 'El rango de exportación es inválido');
  const [lines, categories, accounts, centers] = await Promise.all([
    prisma.ledgerLine.findMany({
      where: { entry: { date: { gte: toDbDate(f.from), lte: toDbDate(f.to) } } },
      include: { entry: true },
      take: MAX_EXPORT_LINES + 1,
    }),
    prisma.financeCategory.findMany({ select: { id: true, name: true } }),
    prisma.cashAccount.findMany({ select: { id: true, name: true } }),
    prisma.costCenter.findMany({ select: { id: true, name: true } }),
  ]);
  const names = new Map<string, string>([...categories, ...accounts].map((row) => [row.id, row.name]));
  const obligationIds = [...new Set(lines.filter((l) => l.accountType === 'receivable' || l.accountType === 'payable').map((l) => l.accountId))];
  const obligations = obligationIds.length
    ? await prisma.obligation.findMany({ where: { id: { in: obligationIds } }, select: { id: true, number: true, counterpartyName: true } })
    : [];
  for (const o of obligations) names.set(o.id, `${o.number}${o.counterpartyName ? ` · ${o.counterpartyName}` : ''}`);
  const centerNames = new Map(centers.map((c) => [c.id, c.name]));
  const truncated = lines.length > MAX_EXPORT_LINES;
  const rows = lines
    .slice(0, MAX_EXPORT_LINES)
    .sort((a, b) => a.entry.date.getTime() - b.entry.date.getTime() || a.entry.number.localeCompare(b.entry.number) || a.seq - b.seq)
    .map((line) => ({
      entryNumber: line.entry.number,
      date: dateKeyOf(line.entry.date),
      periodKey: line.entry.periodKey,
      kind: line.entry.kind,
      description: line.entry.description,
      seq: line.seq,
      accountType: line.accountType,
      accountId: line.accountId,
      accountName: names.get(line.accountId) ?? line.accountId,
      debit: moneyString(line.debit),
      credit: moneyString(line.credit),
      costCenter: line.costCenterId ? (centerNames.get(line.costCenterId) ?? line.costCenterId) : null,
      caseId: line.caseId,
      memo: line.memo,
      sourceType: line.entry.sourceType,
      sourceId: line.entry.sourceId,
    }));
  return { rows, truncated };
}
