import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { yesterdayKeyOf } from '@/modules/finance/close-service';
import { cashBalanceAt, getBudgetVsActual, getCashBook } from '@/modules/finance/cashflow-service';
import type { BudgetVsActualResult, CashBookResult } from '@/modules/finance/cashflow-service';
import type { UnmatchedPayment } from '@/modules/finance/collections-service';
import { getFinanceSettings, type FinanceSettings } from '@/modules/finance/finance-config';
import { localDateKey, periodKeyOfKey } from '@/modules/finance/finance-dates';
import type {
  BudgetDTO,
  CashAccountDTO,
  CategoryDTO,
  CostCenterDTO,
  EmployeeDTO,
  ExpenseDTO,
  ExpenseTemplateDTO,
  ObligationDTO,
  PayrollRunDTO,
} from '@/modules/finance/finance-dto';
import { hasFinancePermission } from '@/modules/finance/finance-helpers';
import {
  getExpense,
  getFinanceCatalog,
  getPayrollRun,
  listBudgets,
  listEmployeeUserOptions,
  listEmployees,
  listExpenseTemplates,
  listExpenses,
  listObligations,
  listPayrollRuns,
  listPeriodCloses,
  listUnassignedCollections,
  type EmployeeUserOption,
  type ExpenseDetailDTO,
} from '@/modules/finance/finance-queries';
import { paymentAuthorizationState } from '@/modules/finance/obligation-rules';
import { FINANCE_OBJECT_TYPES } from '@/modules/finance/types';
import { needsCashCount, parseCloseChecks, type CloseCheckView } from './contabilidad-model';

/**
 * Reads of the Contabilidad surfaces (Libro de caja, obligaciones, nómina,
 * presupuestos, cierre, catálogos y captura de gastos). SERVER ONLY.
 *
 * Nothing is queried by hand that a finance service already answers: every
 * function goes through `finance-queries` / `cashflow-service`, which check the
 * permission of the person on the server and return JSON-safe DTOs. What is
 * added here is only what the UI needs on top: the state of the payment
 * authorization per obligation, the receipts that can travel as evidence of a
 * settlement, and the balance of each cash account at the cut-off date of the
 * close.
 */

const LEDGER_PAGE_SIZE = 25;
const OBLIGATIONS_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface FinanceCapabilities {
  view: boolean;
  capture: boolean;
  approve: boolean;
  post: boolean;
  manageObligations: boolean;
  payroll: boolean;
  close: boolean;
  manageCatalog: boolean;
  exportLedger: boolean;
}

/** What this person may do in Contabilidad (the commands check it again). */
export function financeCapabilities(actor: CurrentUser): FinanceCapabilities {
  return {
    view: hasFinancePermission(actor, 'finance.view'),
    capture: hasFinancePermission(actor, 'finance.capture_expense'),
    approve: hasFinancePermission(actor, 'finance.approve'),
    post: hasFinancePermission(actor, 'finance.post'),
    manageObligations: hasFinancePermission(actor, 'finance.manage_obligations'),
    payroll: hasFinancePermission(actor, 'finance.payroll'),
    close: hasFinancePermission(actor, 'finance.close'),
    manageCatalog: hasFinancePermission(actor, 'finance.manage_catalog'),
    exportLedger: hasFinancePermission(actor, 'finance.export'),
  };
}

// ---------------------------------------------------------------------------
// Libro de caja
// ---------------------------------------------------------------------------

export interface CashBookView {
  accounts: CashAccountDTO[];
  accountId: string | null;
  from: string | null;
  to: string | null;
  book: CashBookResult | null;
  capabilities: FinanceCapabilities;
  /** Spanish note when something could not be shown in full. */
  note: string | null;
}

export async function loadCashBookView(
  actor: CurrentUser,
  input: { accountId?: string; from?: string; to?: string; page?: number; now?: Date } = {}
): Promise<CashBookView> {
  const capabilities = financeCapabilities(actor);
  const catalog = await getFinanceCatalog(actor);
  const accounts = [...catalog.cashAccounts].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return a.name.localeCompare(b.name, 'es-MX');
  });
  const requested =
    input.accountId && accounts.some((account) => account.id === input.accountId)
      ? input.accountId
      : null;
  const accountId =
    requested ?? accounts.find((account) => account.status === 'active')?.id ?? null;

  if (!accountId) {
    return {
      accounts,
      accountId: null,
      from: input.from ?? null,
      to: input.to ?? null,
      book: null,
      capabilities,
      note: 'Todavía no hay cuentas de caja o banco: créalas en Catálogos para empezar a registrar movimientos.',
    };
  }

  const book = await getCashBook(
    actor,
    {
      cashAccountId: accountId,
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      page: input.page && input.page > 0 ? input.page : 1,
      pageSize: LEDGER_PAGE_SIZE,
    },
    input.now ? { now: input.now } : {}
  );

  return {
    accounts,
    accountId,
    from: book.from,
    to: book.to,
    book,
    capabilities,
    note: book.truncated
      ? 'El rango tiene más movimientos de los que podemos mostrar: acorta las fechas para verlos todos.'
      : null,
  };
}

// ---------------------------------------------------------------------------
// Cierre
// ---------------------------------------------------------------------------

export interface PeriodCloseSummary {
  id: string;
  periodKey: string;
  kind: string;
  status: string;
  checks: CloseCheckView[];
  closedAt: string | null;
  reopenReason: string | null;
  version: number;
  updatedAt: string;
}

export interface CloseAccountView {
  id: string;
  name: string;
  kind: string;
  currency: string;
  needsCount: boolean;
  /** Balance of the ledger at the end of the day being closed. */
  balanceAtCutoff: string;
  currentBalance: string;
}

export interface CloseView {
  todayKey: string;
  periodKey: string;
  dailyTargetKey: string;
  monthlyTargetKey: string;
  daily: PeriodCloseSummary | null;
  monthly: PeriodCloseSummary | null;
  history: PeriodCloseSummary[];
  accounts: CloseAccountView[];
  capabilities: FinanceCapabilities;
}

function toCloseSummary(row: {
  id: string;
  periodKey: string;
  kind: string;
  status: string;
  checks: unknown;
  closedAt: string | null;
  reopenReason: string | null;
  version: number;
  updatedAt: string;
}): PeriodCloseSummary {
  return {
    id: row.id,
    periodKey: row.periodKey,
    kind: row.kind,
    status: row.status,
    checks: parseCloseChecks(row.checks),
    closedAt: row.closedAt,
    reopenReason: row.reopenReason,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export async function loadCloseView(
  actor: CurrentUser,
  input: { now?: Date } = {}
): Promise<CloseView> {
  const capabilities = financeCapabilities(actor);
  const now = input.now ?? new Date();
  const todayKey = localDateKey(now);
  const periodKey = periodKeyOfKey(todayKey);
  const dailyTargetKey = yesterdayKeyOf(todayKey);
  const monthlyTargetKey = periodKeyOfKey(`${dailyTargetKey}`);

  const [dailyPage, monthlyPage, catalog] = await Promise.all([
    listPeriodCloses(actor, { kind: 'daily', pageSize: 20 }),
    listPeriodCloses(actor, { kind: 'monthly', pageSize: 12 }),
    getFinanceCatalog(actor),
  ]);

  const activeAccounts = catalog.cashAccounts.filter((account) => account.status === 'active');
  const accounts: CloseAccountView[] = await Promise.all(
    activeAccounts.map(async (account) => ({
      id: account.id,
      name: account.name,
      kind: account.kind,
      currency: account.currency,
      needsCount: needsCashCount(account.kind),
      balanceAtCutoff: (
        await cashBalanceAt(prisma, { asOfKey: dailyTargetKey, cashAccountId: account.id })
      ).toFixed(2),
      currentBalance: account.currentBalance,
    }))
  );

  const daily = dailyPage.rows.find((row) => row.periodKey === dailyTargetKey) ?? null;
  const monthly = monthlyPage.rows.find((row) => row.periodKey === monthlyTargetKey) ?? null;

  return {
    todayKey,
    periodKey,
    dailyTargetKey,
    monthlyTargetKey,
    daily: daily ? toCloseSummary(daily) : null,
    monthly: monthly ? toCloseSummary(monthly) : null,
    history: [...dailyPage.rows.slice(0, 8), ...monthlyPage.rows.slice(0, 6)].map(toCloseSummary),
    accounts,
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Resumen del libro (presupuesto + avance del cierre)
// ---------------------------------------------------------------------------

export interface FinanceSummaryView {
  periodKey: string;
  todayKey: string;
  budget: BudgetVsActualResult | null;
  monthly: PeriodCloseSummary | null;
  daily: PeriodCloseSummary | null;
  dailyTargetKey: string;
  capabilities: FinanceCapabilities;
}

export async function loadFinanceSummaryView(
  actor: CurrentUser,
  input: { periodKey?: string; now?: Date } = {}
): Promise<FinanceSummaryView> {
  const capabilities = financeCapabilities(actor);
  const now = input.now ?? new Date();
  const todayKey = localDateKey(now);
  const periodKey = input.periodKey ?? periodKeyOfKey(todayKey);
  const dailyTargetKey = yesterdayKeyOf(todayKey);

  const [budget, monthlyPage, dailyPage] = await Promise.all([
    getBudgetVsActual(actor, { periodKey }).catch(() => null),
    listPeriodCloses(actor, { kind: 'monthly', pageSize: 12 }),
    listPeriodCloses(actor, { kind: 'daily', pageSize: 20 }),
  ]);

  const monthly = monthlyPage.rows.find((row) => row.periodKey === periodKey) ?? null;
  const daily = dailyPage.rows.find((row) => row.periodKey === dailyTargetKey) ?? null;

  return {
    periodKey,
    todayKey,
    budget,
    monthly: monthly ? toCloseSummary(monthly) : null,
    daily: daily ? toCloseSummary(daily) : null,
    dailyTargetKey,
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Obligaciones
// ---------------------------------------------------------------------------

export interface ObligationRowView extends ObligationDTO {
  /** `not_required | approved | pending | rejected | missing`. */
  paymentAuthorization: string;
  expenseNumber: string | null;
  /** Receipts of the source expense, offered as evidence of the settlement. */
  suggestedEvidenceObjectIds: string[];
}

export interface ObligationsView {
  rows: ObligationRowView[];
  total: number;
  page: number;
  pageCount: number;
  aging: Awaited<ReturnType<typeof listObligations>>['aging'];
  accounts: CashAccountDTO[];
  capabilities: FinanceCapabilities;
  filters: {
    kind: string | null;
    status: string;
    agingBucket: string | null;
    overdueOnly: boolean;
    search: string | null;
  };
}

export async function loadObligationsView(
  actor: CurrentUser,
  input: {
    kind?: 'payable' | 'receivable';
    status?: string;
    agingBucket?: string;
    overdueOnly?: boolean;
    search?: string;
    page?: number;
    now?: Date;
  } = {}
): Promise<ObligationsView> {
  const capabilities = financeCapabilities(actor);
  const now = input.now ?? new Date();
  const page = await listObligations(
    actor,
    {
      ...(input.kind ? { kind: input.kind } : {}),
      status: (input.status ?? 'open') as 'open',
      ...(input.agingBucket ? { agingBucket: input.agingBucket as 'not_due' } : {}),
      ...(input.overdueOnly ? { overdueOnly: true } : {}),
      ...(input.search ? { search: input.search } : {}),
      page: input.page && input.page > 0 ? input.page : 1,
      pageSize: OBLIGATIONS_PAGE_SIZE,
    },
    { now }
  );

  const ids = page.rows.map((row) => row.id);
  const expenseIds = page.rows
    .map((row) => row.expenseId)
    .filter((value): value is string => Boolean(value));

  const [approvals, expenses, catalog] = await Promise.all([
    ids.length > 0
      ? prisma.approvalRequest.findMany({
          where: {
            scope: 'payment',
            targetType: FINANCE_OBJECT_TYPES.obligation,
            targetId: { in: ids },
          },
          select: { targetId: true, status: true, createdAt: true },
        })
      : Promise.resolve([]),
    expenseIds.length > 0
      ? prisma.expense.findMany({
          where: { id: { in: expenseIds } },
          select: { id: true, number: true, receiptObjectIds: true },
        })
      : Promise.resolve([]),
    getFinanceCatalog(actor),
  ]);

  const approvalsByTarget = new Map<string, Array<{ status: string; createdAt: Date }>>();
  for (const approval of approvals) {
    const list = approvalsByTarget.get(approval.targetId) ?? [];
    list.push({ status: approval.status, createdAt: approval.createdAt });
    approvalsByTarget.set(approval.targetId, list);
  }
  const expensesById = new Map(expenses.map((expense) => [expense.id, expense]));

  const rows: ObligationRowView[] = page.rows.map((row) => {
    const expense = row.expenseId ? expensesById.get(row.expenseId) : undefined;
    return {
      ...row,
      paymentAuthorization: paymentAuthorizationState(
        { kind: row.kind, expenseId: row.expenseId, payrollRunId: row.payrollRunId },
        approvalsByTarget.get(row.id) ?? []
      ),
      expenseNumber: expense?.number ?? null,
      suggestedEvidenceObjectIds: expense?.receiptObjectIds ?? [],
    };
  });

  return {
    rows,
    total: page.total,
    page: page.page,
    pageCount: page.pageCount,
    aging: page.aging,
    accounts: catalog.cashAccounts.filter((account) => account.status === 'active'),
    capabilities,
    filters: {
      kind: input.kind ?? null,
      status: input.status ?? 'open',
      agingBucket: input.agingBucket ?? null,
      overdueOnly: Boolean(input.overdueOnly),
      search: input.search ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Cobros sin asignar
// ---------------------------------------------------------------------------

export interface CollectionsView {
  payments: UnmatchedPayment[];
  receivables: ObligationDTO[];
  incomeCategories: CategoryDTO[];
  capabilities: FinanceCapabilities;
}

export async function loadCollectionsView(
  actor: CurrentUser,
  input: { now?: Date } = {}
): Promise<CollectionsView> {
  const capabilities = financeCapabilities(actor);
  const now = input.now ?? new Date();
  const [payments, receivables, catalog] = await Promise.all([
    listUnassignedCollections(actor, { limit: 50 }, { now }),
    listObligations(actor, { kind: 'receivable', status: 'open', pageSize: 100 }, { now }),
    getFinanceCatalog(actor),
  ]);
  return {
    payments,
    receivables: receivables.rows,
    incomeCategories: catalog.categories.filter(
      (category) => category.kind === 'income' && category.status === 'active'
    ),
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Nómina
// ---------------------------------------------------------------------------

export interface PayrollView {
  runs: PayrollRunDTO[];
  run: (PayrollRunDTO & { employees: EmployeeDTO[] }) | null;
  employees: EmployeeDTO[];
  accounts: CashAccountDTO[];
  costCenters: CostCenterDTO[];
  capabilities: FinanceCapabilities;
}

export async function loadPayrollView(
  actor: CurrentUser,
  input: { runId?: string } = {}
): Promise<PayrollView> {
  const capabilities = financeCapabilities(actor);
  const [runsPage, employeesPage, catalog] = await Promise.all([
    listPayrollRuns(actor, { pageSize: 20 }),
    listEmployees(actor, { active: true, pageSize: 200 }),
    getFinanceCatalog(actor),
  ]);
  const run = input.runId ? await getPayrollRun(actor, input.runId) : null;
  return {
    runs: runsPage.rows,
    run,
    employees: employeesPage.rows,
    accounts: catalog.cashAccounts.filter((account) => account.status === 'active'),
    costCenters: catalog.costCenters.filter((center) => center.status === 'active'),
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Presupuestos
// ---------------------------------------------------------------------------

export interface BudgetsView {
  periodKey: string;
  budgets: BudgetDTO[];
  comparison: BudgetVsActualResult | null;
  categories: CategoryDTO[];
  costCenters: CostCenterDTO[];
  capabilities: FinanceCapabilities;
}

export async function loadBudgetsView(
  actor: CurrentUser,
  input: { periodKey?: string; now?: Date } = {}
): Promise<BudgetsView> {
  const capabilities = financeCapabilities(actor);
  const periodKey = input.periodKey ?? periodKeyOfKey(localDateKey(input.now ?? new Date()));
  const [budgets, comparison, catalog] = await Promise.all([
    listBudgets(actor, { periodKey }),
    getBudgetVsActual(actor, { periodKey }).catch(() => null),
    getFinanceCatalog(actor),
  ]);
  return {
    periodKey,
    budgets,
    comparison,
    categories: catalog.categories.filter((category) => category.status === 'active'),
    costCenters: catalog.costCenters.filter((center) => center.status === 'active'),
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Catálogos
// ---------------------------------------------------------------------------

export interface CatalogView {
  accounts: CashAccountDTO[];
  categories: CategoryDTO[];
  costCenters: CostCenterDTO[];
  employees: EmployeeDTO[];
  /** Cuentas con las que se puede ligar un empleado (vacío sin `finance.payroll`). */
  employeeUsers: EmployeeUserOption[];
  /** Ajustes de la contabilidad interna (plan 6.4); sólo los edita `finance.manage_catalog`. */
  settings: FinanceSettings;
  capabilities: FinanceCapabilities;
}

export async function loadCatalogView(actor: CurrentUser): Promise<CatalogView> {
  const capabilities = financeCapabilities(actor);
  const [catalog, employees, employeeUsers, settings] = await Promise.all([
    getFinanceCatalog(actor),
    listEmployees(actor, { pageSize: 200 }).catch(() => ({ rows: [] as EmployeeDTO[] })),
    capabilities.payroll
      ? listEmployeeUserOptions(actor).catch(() => [] as EmployeeUserOption[])
      : Promise.resolve([] as EmployeeUserOption[]),
    getFinanceSettings(),
  ]);
  return {
    accounts: catalog.cashAccounts,
    categories: catalog.categories,
    costCenters: catalog.costCenters,
    employees: employees.rows,
    employeeUsers,
    settings,
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Captura de gastos
// ---------------------------------------------------------------------------

export interface ExpenseCaptureView {
  expense: ExpenseDetailDTO | null;
  categories: CategoryDTO[];
  costCenters: CostCenterDTO[];
  accounts: CashAccountDTO[];
  templates: ExpenseTemplateDTO[];
  recent: ExpenseDTO[];
  capabilities: FinanceCapabilities;
}

export async function loadExpenseCaptureView(
  actor: CurrentUser,
  input: { expenseId?: string } = {}
): Promise<ExpenseCaptureView> {
  const capabilities = financeCapabilities(actor);
  const [catalog, templates, recent] = await Promise.all([
    getFinanceCatalog(actor),
    listExpenseTemplates(actor, { activeOnly: true }).catch(() => [] as ExpenseTemplateDTO[]),
    listExpenses(actor, { mine: true, status: 'pending', pageSize: 8 }).catch(() => ({
      rows: [] as ExpenseDTO[],
    })),
  ]);
  const expense = input.expenseId ? await getExpense(actor, input.expenseId) : null;
  return {
    expense,
    categories: catalog.categories.filter((category) => category.status === 'active'),
    costCenters: catalog.costCenters.filter((center) => center.status === 'active'),
    accounts: catalog.cashAccounts.filter((account) => account.status === 'active'),
    templates,
    recent: recent.rows,
    capabilities,
  };
}
