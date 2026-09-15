import type {
  Budget,
  CashAccount,
  CostCenter,
  Employee,
  Expense,
  ExpenseSplit,
  ExpenseTemplate,
  FinanceCategory,
  LedgerEntry,
  LedgerLine,
  Obligation,
  ObligationSettlement,
  PayrollLine,
  PayrollRun,
  PeriodClose,
  Prisma,
} from '@prisma/client';
import { dateKeyOf } from './finance-dates';
import { moneyString } from './money';
import {
  agingBucket,
  daysOverdue,
  obligationSourceOf,
  remainingOf,
  type AgingBucket,
} from './obligation-rules';
import {
  CASH_ACCOUNT_KIND_LABELS,
  CATEGORY_KIND_LABELS,
  EXPENSE_STATUS_LABELS,
  LEDGER_ENTRY_KIND_LABELS,
  OBLIGATION_STATUS_LABELS,
  PAYROLL_STATUS_LABELS,
  type CashAccountKind,
  type CategoryKind,
  type ExpenseStatus,
  type LedgerEntryKind,
  type ObligationSourceType,
  type ObligationStatus,
  type PayrollStatus,
} from './types';

/**
 * JSON-safe DTOs of the finance models (money as '1234.50', business dates as
 * 'YYYY-MM-DD', instants as ISO). Pure mappers used by commands, queries and
 * tools.
 */

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);
const dateKey = (value: Date | null | undefined): string | null => (value ? dateKeyOf(value) : null);

function jsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export interface CashAccountDTO {
  id: string;
  key: string;
  name: string;
  kind: string;
  kindLabel: string;
  currency: string;
  openingBalance: string;
  currentBalance: string;
  status: string;
  version: number;
}

export function toCashAccountDTO(row: CashAccount): CashAccountDTO {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    kindLabel: CASH_ACCOUNT_KIND_LABELS[row.kind as CashAccountKind] ?? row.kind,
    currency: row.currency,
    openingBalance: moneyString(row.openingBalance),
    currentBalance: moneyString(row.currentBalance),
    status: row.status,
    version: row.version,
  };
}

export interface CategoryDTO {
  id: string;
  key: string;
  name: string;
  kind: string;
  kindLabel: string;
  isDirect: boolean;
  parentId: string | null;
  defaultCostCenterId: string | null;
  status: string;
}

export function toCategoryDTO(row: FinanceCategory): CategoryDTO {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    kindLabel: CATEGORY_KIND_LABELS[row.kind as CategoryKind] ?? row.kind,
    isDirect: row.isDirect,
    parentId: row.parentId,
    defaultCostCenterId: row.defaultCostCenterId,
    status: row.status,
  };
}

export interface CostCenterDTO {
  id: string;
  key: string;
  name: string;
  areaKey: string | null;
  parentId: string | null;
  status: string;
}

export function toCostCenterDTO(row: CostCenter): CostCenterDTO {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    areaKey: row.areaKey,
    parentId: row.parentId,
    status: row.status,
  };
}

export interface LedgerLineDTO {
  id: string;
  seq: number;
  accountType: string;
  accountId: string;
  debit: string;
  credit: string;
  costCenterId: string | null;
  caseId: string | null;
  procurementOrderId: string | null;
  projectRef: string | null;
  memo: string | null;
}

export function toLedgerLineDTO(row: LedgerLine): LedgerLineDTO {
  return {
    id: row.id,
    seq: row.seq,
    accountType: row.accountType,
    accountId: row.accountId,
    debit: moneyString(row.debit),
    credit: moneyString(row.credit),
    costCenterId: row.costCenterId,
    caseId: row.caseId,
    procurementOrderId: row.procurementOrderId,
    projectRef: row.projectRef,
    memo: row.memo,
  };
}

export interface LedgerEntryDTO {
  id: string;
  number: string;
  kind: string;
  kindLabel: string;
  date: string;
  periodKey: string;
  description: string;
  currency: string;
  sourceType: string | null;
  sourceId: string | null;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  postedByUserId: string;
  postedAt: string;
  evidenceObjectIds: string[];
  totalDebit: string;
  totalCredit: string;
  lines: LedgerLineDTO[];
}

export function toLedgerEntryDTO(row: LedgerEntry & { lines?: LedgerLine[] }): LedgerEntryDTO {
  const lines = [...(row.lines ?? [])].sort((a, b) => a.seq - b.seq);
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    debit += Number(line.debit);
    credit += Number(line.credit);
  }
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    kindLabel: LEDGER_ENTRY_KIND_LABELS[row.kind as LedgerEntryKind] ?? row.kind,
    date: dateKeyOf(row.date),
    periodKey: row.periodKey,
    description: row.description,
    currency: row.currency,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    reversesEntryId: row.reversesEntryId,
    reversedByEntryId: row.reversedByEntryId,
    postedByUserId: row.postedByUserId,
    postedAt: row.postedAt.toISOString(),
    evidenceObjectIds: row.evidenceObjectIds,
    totalDebit: moneyString(debit),
    totalCredit: moneyString(credit),
    lines: lines.map(toLedgerLineDTO),
  };
}

export interface SettlementDTO {
  id: string;
  obligationId: string;
  ledgerEntryId: string;
  amount: string;
  settledAt: string;
  cashAccountId: string | null;
  zohoPaymentId: string | null;
  externalRef: string | null;
  isReversal: boolean;
  evidenceObjectIds: string[];
  createdByUserId: string;
}

export function toSettlementDTO(row: ObligationSettlement): SettlementDTO {
  return {
    id: row.id,
    obligationId: row.obligationId,
    ledgerEntryId: row.ledgerEntryId,
    amount: moneyString(row.amount),
    settledAt: row.settledAt.toISOString(),
    cashAccountId: row.cashAccountId,
    zohoPaymentId: row.zohoPaymentId,
    externalRef: row.externalRef,
    isReversal: Number(row.amount) < 0,
    evidenceObjectIds: row.evidenceObjectIds,
    createdByUserId: row.createdByUserId,
  };
}

export interface ObligationDTO {
  id: string;
  number: string;
  kind: string;
  counterpartyType: string;
  counterpartyName: string | null;
  supplierId: string | null;
  zohoContactId: string | null;
  employeeId: string | null;
  caseId: string | null;
  procurementOrderId: string | null;
  payrollRunId: string | null;
  expenseId: string | null;
  zohoSalesOrderId: string | null;
  zohoInvoiceId: string | null;
  source: ObligationSourceType;
  description: string;
  currency: string;
  expectedAmount: string;
  settledAmount: string;
  remaining: string;
  dueAt: string | null;
  expectedCashAt: string | null;
  status: string;
  statusLabel: string;
  categoryId: string;
  costCenterId: string | null;
  ledgerEntryId: string | null;
  agingBucket: AgingBucket;
  daysOverdue: number | null;
  version: number;
  createdAt: string;
  settlements?: SettlementDTO[];
}

export function toObligationDTO(
  row: Obligation & { settlements?: ObligationSettlement[] },
  asOfKey: string
): ObligationDTO {
  const open = row.status === 'expected' || row.status === 'partially_settled';
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    counterpartyType: row.counterpartyType,
    counterpartyName: row.counterpartyName,
    supplierId: row.supplierId,
    zohoContactId: row.zohoContactId,
    employeeId: row.employeeId,
    caseId: row.caseId,
    procurementOrderId: row.procurementOrderId,
    payrollRunId: row.payrollRunId,
    expenseId: row.expenseId,
    zohoSalesOrderId: row.zohoSalesOrderId,
    zohoInvoiceId: row.zohoInvoiceId,
    source: obligationSourceOf(row),
    description: row.description,
    currency: row.currency,
    expectedAmount: moneyString(row.expectedAmount),
    settledAmount: moneyString(row.settledAmount),
    remaining: open ? remainingOf(row).toFixed(2) : '0.00',
    dueAt: dateKey(row.dueAt),
    expectedCashAt: dateKey(row.expectedCashAt),
    status: row.status,
    statusLabel: OBLIGATION_STATUS_LABELS[row.status as ObligationStatus] ?? row.status,
    categoryId: row.categoryId,
    costCenterId: row.costCenterId,
    ledgerEntryId: row.ledgerEntryId,
    agingBucket: open ? agingBucket(row.dueAt, asOfKey) : 'not_due',
    daysOverdue: open ? daysOverdue(row.dueAt, asOfKey) : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    ...(row.settlements ? { settlements: row.settlements.map(toSettlementDTO) } : {}),
  };
}

export interface ExpenseSplitDTO {
  id: string;
  costCenterId: string | null;
  caseId: string | null;
  projectRef: string | null;
  amount: string;
  pct: string | null;
}

export interface ExpenseDTO {
  id: string;
  number: string;
  status: string;
  statusLabel: string;
  captureMode: string;
  rawInput: string | null;
  aiProposal: Record<string, unknown> | null;
  amount: string;
  currency: string;
  date: string;
  supplierId: string | null;
  supplierNameFree: string | null;
  categoryId: string | null;
  costCenterId: string | null;
  cashAccountId: string | null;
  paymentMethod: string | null;
  isPaid: boolean;
  description: string | null;
  receiptObjectIds: string[];
  receiptHash: string | null;
  duplicateStatus: string;
  duplicateOfId: string | null;
  approvalRequestId: string | null;
  ledgerEntryId: string | null;
  obligationId: string | null;
  templateId: string | null;
  caseId: string | null;
  createdByUserId: string;
  approvedByUserId: string | null;
  postedAt: string | null;
  rejectedReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  splits: ExpenseSplitDTO[];
}

export function toExpenseDTO(row: Expense & { splits?: ExpenseSplit[] }): ExpenseDTO {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    statusLabel: EXPENSE_STATUS_LABELS[row.status as ExpenseStatus] ?? row.status,
    captureMode: row.captureMode,
    rawInput: row.rawInput,
    aiProposal: jsonRecord(row.aiProposal),
    amount: moneyString(row.amount),
    currency: row.currency,
    date: dateKeyOf(row.date),
    supplierId: row.supplierId,
    supplierNameFree: row.supplierNameFree,
    categoryId: row.categoryId,
    costCenterId: row.costCenterId,
    cashAccountId: row.cashAccountId,
    paymentMethod: row.paymentMethod,
    isPaid: row.isPaid,
    description: row.description,
    receiptObjectIds: row.receiptObjectIds,
    receiptHash: row.receiptHash,
    duplicateStatus: row.duplicateStatus,
    duplicateOfId: row.duplicateOfId,
    approvalRequestId: row.approvalRequestId,
    ledgerEntryId: row.ledgerEntryId,
    obligationId: row.obligationId,
    templateId: row.templateId,
    caseId: row.caseId,
    createdByUserId: row.createdByUserId,
    approvedByUserId: row.approvedByUserId,
    postedAt: iso(row.postedAt),
    rejectedReason: row.rejectedReason,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    splits: (row.splits ?? []).map((split) => ({
      id: split.id,
      costCenterId: split.costCenterId,
      caseId: split.caseId,
      projectRef: split.projectRef,
      amount: moneyString(split.amount),
      pct: split.pct === null ? null : String(split.pct),
    })),
  };
}

export interface ExpenseTemplateDTO {
  id: string;
  name: string;
  categoryId: string;
  costCenterId: string | null;
  supplierId: string | null;
  defaultAmount: string | null;
  currency: string;
  recurrence: Record<string, unknown> | null;
  nextRunAt: string | null;
  active: boolean;
  createdByUserId: string;
}

export function toExpenseTemplateDTO(row: ExpenseTemplate): ExpenseTemplateDTO {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.categoryId,
    costCenterId: row.costCenterId,
    supplierId: row.supplierId,
    defaultAmount: row.defaultAmount === null ? null : moneyString(row.defaultAmount),
    currency: row.currency,
    recurrence: jsonRecord(row.recurrence),
    nextRunAt: dateKey(row.nextRunAt),
    active: row.active,
    createdByUserId: row.createdByUserId,
  };
}

export interface BudgetDTO {
  id: string;
  periodKey: string;
  costCenterId: string;
  categoryId: string;
  amount: string;
  currency: string;
}

export function toBudgetDTO(row: Budget): BudgetDTO {
  return {
    id: row.id,
    periodKey: row.periodKey,
    costCenterId: row.costCenterId,
    categoryId: row.categoryId,
    amount: moneyString(row.amount),
    currency: row.currency,
  };
}

export interface EmployeeDTO {
  id: string;
  number: string;
  name: string;
  position: string | null;
  userId: string | null;
  areaKey: string | null;
  costCenterId: string | null;
  active: boolean;
}

export function toEmployeeDTO(row: Employee): EmployeeDTO {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    position: row.position,
    userId: row.userId,
    areaKey: row.areaKey,
    costCenterId: row.costCenterId,
    active: row.active,
  };
}

export interface PayrollLineDTO {
  id: string;
  employeeId: string;
  gross: string;
  deductions: Array<{ kind: string; label: string; amount: string }>;
  advancesApplied: string;
  net: string;
  costCenterId: string | null;
  obligationId: string | null;
  status: string;
}

export interface PayrollRunDTO {
  id: string;
  number: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  statusLabel: string;
  currency: string;
  totalGross: string;
  totalDeductions: string;
  totalNet: string;
  approvalRequestId: string | null;
  createdByUserId: string;
  version: number;
  createdAt: string;
  lines?: PayrollLineDTO[];
}

export function toPayrollLineDTO(row: PayrollLine): PayrollLineDTO {
  const deductions = Array.isArray(row.deductions)
    ? (row.deductions as Array<Record<string, unknown>>).map((d) => ({
        kind: String(d?.kind ?? 'other'),
        label: String(d?.label ?? ''),
        amount: moneyString(String(d?.amount ?? '0')),
      }))
    : [];
  return {
    id: row.id,
    employeeId: row.employeeId,
    gross: moneyString(row.gross),
    deductions,
    advancesApplied: moneyString(row.advancesApplied),
    net: moneyString(row.net),
    costCenterId: row.costCenterId,
    obligationId: row.obligationId,
    status: row.status,
  };
}

export function toPayrollRunDTO(row: PayrollRun & { lines?: PayrollLine[] }): PayrollRunDTO {
  return {
    id: row.id,
    number: row.number,
    periodKey: row.periodKey,
    periodStart: dateKeyOf(row.periodStart),
    periodEnd: dateKeyOf(row.periodEnd),
    status: row.status,
    statusLabel: PAYROLL_STATUS_LABELS[row.status as PayrollStatus] ?? row.status,
    currency: row.currency,
    totalGross: moneyString(row.totalGross),
    totalDeductions: moneyString(row.totalDeductions),
    totalNet: moneyString(row.totalNet),
    approvalRequestId: row.approvalRequestId,
    createdByUserId: row.createdByUserId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    ...(row.lines ? { lines: row.lines.map(toPayrollLineDTO) } : {}),
  };
}

export interface PeriodCloseDTO {
  id: string;
  periodKey: string;
  kind: string;
  status: string;
  closedByUserId: string | null;
  closedAt: string | null;
  snapshot: Record<string, unknown> | null;
  checks: unknown[];
  reopenReason: string | null;
  version: number;
  updatedAt: string;
}

export function toPeriodCloseDTO(row: PeriodClose): PeriodCloseDTO {
  return {
    id: row.id,
    periodKey: row.periodKey,
    kind: row.kind,
    status: row.status,
    closedByUserId: row.closedByUserId,
    closedAt: iso(row.closedAt),
    snapshot: jsonRecord(row.snapshot),
    checks: Array.isArray(row.checks) ? (row.checks as unknown[]) : [],
    reopenReason: row.reopenReason,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}
