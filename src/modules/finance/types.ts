/**
 * Shared vocabulary of the internal cash-flow accounting (plan section 6.4):
 * states of every finance model (identical to the `///` comments in
 * prisma/schema.prisma, where every state is a String), command, event and
 * job names, folio sequences and error codes.
 *
 * Pure module (no Prisma, no server imports): safe for client components.
 * No SAT / CFDI: this is management accounting of cash, obligations and
 * budgets, with an immutable balanced ledger corrected only by reversals.
 */

export const FINANCE_AREA_KEY = 'contabilidad' as const;
/** Actor id of the finance jobs (`{type: 'system', id}`). */
export const FINANCE_SYSTEM_ACTOR_ID = 'finance';
/** Realtime channel of the finance board (authorized with `finance.view`). */
export const FINANCE_BOARD_CHANNEL = 'finance:board';
/** Notification category of finance alerts (catalog entry added by the notifications owner). */
export const FINANCE_ALERT_CATEGORY = 'finance_alert' as const;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const CASH_ACCOUNT_KINDS = ['cash', 'bank', 'card', 'petty_cash', 'digital'] as const;
export type CashAccountKind = (typeof CASH_ACCOUNT_KINDS)[number];

export const CASH_ACCOUNT_STATUSES = ['active', 'closed'] as const;
export type CashAccountStatus = (typeof CASH_ACCOUNT_STATUSES)[number];

export const CASH_ACCOUNT_KIND_LABELS: Record<CashAccountKind, string> = {
  cash: 'Caja',
  bank: 'Banco',
  card: 'Tarjeta',
  petty_cash: 'Caja chica',
  digital: 'Cartera digital',
};

export const CATEGORY_KINDS = ['income', 'expense', 'transfer', 'payroll', 'tax', 'debt'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = {
  income: 'Ingreso',
  expense: 'Gasto',
  transfer: 'Traspaso',
  payroll: 'Nómina',
  tax: 'Impuestos',
  debt: 'Deuda',
};

/** Category kinds an expense (or a payable) may be booked to. */
export const EXPENSE_CATEGORY_KINDS: readonly CategoryKind[] = [
  'expense',
  'payroll',
  'tax',
  'debt',
];

export const CATALOG_STATUSES = ['active', 'archived'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export const LEDGER_ENTRY_KINDS = [
  'income',
  'expense',
  'transfer',
  'obligation',
  'settlement',
  'payroll',
  'adjustment',
  'reversal',
  'close',
] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

/** Kinds a person may post by hand (`finance.ledger.post_manual`). */
export const MANUAL_ENTRY_KINDS = ['income', 'expense', 'transfer', 'adjustment'] as const;
export type ManualEntryKind = (typeof MANUAL_ENTRY_KINDS)[number];

export const LEDGER_ENTRY_KIND_LABELS: Record<LedgerEntryKind, string> = {
  income: 'Ingreso',
  expense: 'Gasto',
  transfer: 'Traspaso',
  obligation: 'Obligación',
  settlement: 'Liquidación',
  payroll: 'Nómina',
  adjustment: 'Ajuste',
  reversal: 'Reverso',
  close: 'Cierre',
};

export const LEDGER_ACCOUNT_TYPES = [
  'cash',
  'category',
  'receivable',
  'payable',
  'equity',
  'clearing',
] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

/** `sourceType` of entries owned by a domain flow: corrected only through that flow. */
export const LEDGER_SOURCE_TYPES = {
  manual: 'manual',
  obligation: 'obligation',
  expense: 'expense',
  payrollRun: 'payroll_run',
} as const;

/** Equity account that receives the opening balance of a new cash account. */
export const OPENING_BALANCE_EQUITY_ID = 'saldo_inicial';

/** Clearing account of payroll withholdings (retenciones por enterar). */
export const PAYROLL_DEDUCTIONS_CLEARING_ID = 'payroll_deductions';

// ---------------------------------------------------------------------------
// Obligations
// ---------------------------------------------------------------------------

export const OBLIGATION_KINDS = ['payable', 'receivable'] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export const COUNTERPARTY_TYPES = [
  'supplier',
  'customer',
  'employee',
  'tax',
  'lender',
  'other',
] as const;
export type CounterpartyType = (typeof COUNTERPARTY_TYPES)[number];

export const OBLIGATION_STATUSES = [
  'expected',
  'partially_settled',
  'settled',
  'written_off',
  'cancelled',
] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];
export const OBLIGATION_OPEN_STATUSES = ['expected', 'partially_settled'] as const;

export const OBLIGATION_STATUS_LABELS: Record<ObligationStatus, string> = {
  expected: 'Esperada',
  partially_settled: 'Liquidada parcialmente',
  settled: 'Liquidada',
  written_off: 'Castigada',
  cancelled: 'Cancelada',
};

/**
 * Origin of an obligation, derived from its links (the model has no source
 * column): handlers of `onObligationSettled(sourceType, …)` subscribe to it.
 */
export const OBLIGATION_SOURCE_TYPES = [
  'procurement_order',
  'payroll_run',
  'expense',
  'sales_order',
  'employee_advance',
  'manual',
] as const;
export type ObligationSourceType = (typeof OBLIGATION_SOURCE_TYPES)[number];

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export const EXPENSE_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'posted',
  'rejected',
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  draft: 'Borrador',
  pending_approval: 'Por aprobar',
  approved: 'Aprobado',
  posted: 'Contabilizado',
  rejected: 'Rechazado',
};

/** Expenses that still need somebody before the period can close. */
export const EXPENSE_PENDING_STATUSES = ['draft', 'pending_approval', 'approved'] as const;

export const EXPENSE_CAPTURE_MODES = [
  'form',
  'text',
  'voice',
  'photo',
  'template',
  'recurring',
] as const;
export type ExpenseCaptureMode = (typeof EXPENSE_CAPTURE_MODES)[number];

export const PAYMENT_METHODS = ['cash', 'transfer', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DUPLICATE_STATUSES = [
  'none',
  'suspect',
  'confirmed_unique',
  'confirmed_duplicate',
] as const;
export type DuplicateStatus = (typeof DUPLICATE_STATUSES)[number];

export const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

export const PAYROLL_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'obligations_created',
  'paid',
  'closed',
  'cancelled',
] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

export const PAYROLL_STATUS_LABELS: Record<PayrollStatus, string> = {
  draft: 'Borrador',
  pending_approval: 'Por aprobar',
  approved: 'Aprobada',
  obligations_created: 'Por pagar',
  paid: 'Pagada',
  closed: 'Cerrada',
  cancelled: 'Cancelada',
};

export const PAYROLL_LINE_STATUSES = ['pending', 'paid'] as const;
export type PayrollLineStatus = (typeof PAYROLL_LINE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Closes
// ---------------------------------------------------------------------------

export const PERIOD_CLOSE_KINDS = ['daily', 'monthly'] as const;
export type PeriodCloseKind = (typeof PERIOD_CLOSE_KINDS)[number];

export const PERIOD_CLOSE_STATUSES = ['open', 'closing', 'closed', 'reopened'] as const;
export type PeriodCloseStatus = (typeof PERIOD_CLOSE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Object types, sequences, commands, events, jobs
// ---------------------------------------------------------------------------

export const FINANCE_OBJECT_TYPES = {
  expense: 'expense',
  expenseTemplate: 'expense_template',
  obligation: 'obligation',
  settlement: 'obligation_settlement',
  ledgerEntry: 'ledger_entry',
  payrollRun: 'payroll_run',
  employee: 'employee',
  periodClose: 'period_close',
  cashAccount: 'cash_account',
  customerPayment: 'customer_payment',
  catalog: 'finance_catalog',
} as const;

export const FINANCE_SEQUENCES = {
  ledgerEntry: { key: 'finance.ledger_entry', prefix: 'AS' },
  obligation: { key: 'finance.obligation', prefix: 'OB' },
  expense: { key: 'finance.expense', prefix: 'GX' },
  payrollRun: { key: 'finance.payroll_run', prefix: 'NOM' },
  employee: { key: 'finance.employee', prefix: 'EMP' },
} as const;

export const FINANCE_COMMANDS = {
  catalogSeed: 'finance.catalog.seed',
  cashAccountCreate: 'finance.cash_account.create',
  cashAccountUpdate: 'finance.cash_account.update',
  categoryCreate: 'finance.category.create',
  categoryUpdate: 'finance.category.update',
  costCenterCreate: 'finance.cost_center.create',
  costCenterUpdate: 'finance.cost_center.update',
  budgetSet: 'finance.budget.set',
  ledgerPostManual: 'finance.ledger.post_manual',
  ledgerReverse: 'finance.ledger.reverse',
  obligationCreate: 'finance.obligation.create',
  obligationSettle: 'finance.obligation.settle',
  obligationCancel: 'finance.obligation.cancel',
  obligationReschedule: 'finance.obligation.reschedule',
  obligationWriteOff: 'finance.obligation.write_off',
  settlementReverse: 'finance.obligation.reverse_settlement',
  paymentAuthorizationRequest: 'finance.payment.request_authorization',
  expenseCapture: 'finance.expense.capture',
  expenseUpdate: 'finance.expense.update',
  expenseApplyProposal: 'finance.expense.apply_proposal',
  expenseResolveDuplicate: 'finance.expense.resolve_duplicate',
  expenseSubmit: 'finance.expense.submit',
  expensePost: 'finance.expense.post',
  expenseReject: 'finance.expense.reject',
  expenseReverse: 'finance.expense.reverse',
  expenseTemplateCreate: 'finance.expense_template.create',
  expenseTemplateUpdate: 'finance.expense_template.update',
  expenseCaptureFromTemplate: 'finance.expense.capture_from_template',
  expenseRunRecurring: 'finance.expense.run_recurring',
  employeeCreate: 'finance.employee.create',
  employeeUpdate: 'finance.employee.update',
  employeeAdvance: 'finance.employee.advance',
  payrollCreate: 'finance.payroll.create',
  payrollUpdate: 'finance.payroll.update',
  payrollSubmit: 'finance.payroll.submit',
  payrollCreateObligations: 'finance.payroll.create_obligations',
  payrollPayLine: 'finance.payroll.pay_line',
  payrollClose: 'finance.payroll.close',
  payrollCancel: 'finance.payroll.cancel',
  collectionExpectCase: 'finance.collections.expect_case',
  collectionApplyPayment: 'finance.collections.apply_payment',
  collectionMatchPayment: 'finance.collections.match_payment',
  collectionFlagPayment: 'finance.collections.flag_payment',
  collectionRecordUnexpected: 'finance.collections.record_unexpected',
  collectionCancelVoided: 'finance.collections.cancel_voided',
  collectionFlagOverapplied: 'finance.collections.flag_overapplied',
  closeDaily: 'finance.close.daily',
  closeMonthly: 'finance.close.monthly',
  closeReopen: 'finance.close.reopen',
} as const;

export const FINANCE_EVENTS = {
  catalog: { changed: 'finance.catalog.changed', seeded: 'finance.catalog.seeded' },
  ledger: { posted: 'finance.ledger.posted', reversed: 'finance.ledger.reversed' },
  obligation: {
    created: 'finance.obligation.created',
    settled: 'finance.obligation.settled',
    cancelled: 'finance.obligation.cancelled',
    rescheduled: 'finance.obligation.rescheduled',
    writtenOff: 'finance.obligation.written_off',
    settlementReversed: 'finance.obligation.settlement_reversed',
  },
  payment: {
    authorizationRequested: 'finance.payment.authorization_requested',
    authorized: 'finance.payment.authorized',
    rejected: 'finance.payment.rejected',
  },
  expense: {
    captured: 'finance.expense.captured',
    updated: 'finance.expense.updated',
    proposed: 'finance.expense.proposed',
    duplicateSuspected: 'finance.expense.duplicate_suspected',
    duplicateResolved: 'finance.expense.duplicate_resolved',
    submitted: 'finance.expense.submitted',
    approved: 'finance.expense.approved',
    rejected: 'finance.expense.rejected',
    posted: 'finance.expense.posted',
    reversed: 'finance.expense.reversed',
    templateChanged: 'finance.expense.template_changed',
  },
  payroll: {
    created: 'finance.payroll.created',
    updated: 'finance.payroll.updated',
    submitted: 'finance.payroll.submitted',
    approved: 'finance.payroll.approved',
    rejected: 'finance.payroll.rejected',
    obligationsCreated: 'finance.payroll.obligations_created',
    linePaid: 'finance.payroll.line_paid',
    lineUnpaid: 'finance.payroll.line_unpaid',
    reopened: 'finance.payroll.reopened',
    paid: 'finance.payroll.paid',
    closed: 'finance.payroll.closed',
    cancelled: 'finance.payroll.cancelled',
  },
  employee: {
    created: 'finance.employee.created',
    updated: 'finance.employee.updated',
    advanceGranted: 'finance.employee.advance_granted',
  },
  collection: {
    expected: 'finance.collection.expected',
    matched: 'finance.collection.matched',
    unassigned: 'finance.collection.unassigned',
    unexpected: 'finance.collection.unexpected',
    held: 'finance.collection.held',
    overapplied: 'finance.collection.overapplied',
  },
  period: {
    closed: 'finance.period.closed',
    closeBlocked: 'finance.period.close_blocked',
    reopened: 'finance.period.reopened',
  },
} as const;

export const FINANCE_JOB_TYPES = {
  expensePropose: 'finance.expense_propose',
  recurringExpenses: 'finance.recurring_expenses',
  reconcileCollections: 'finance.reconcile_collections',
  obligationsDue: 'finance.obligations_due',
  dailyCloseReminder: 'finance.daily_close_reminder',
} as const;

export const FINANCE_RECURRING_EVERY_MS = {
  recurringExpenses: 24 * 60 * 60_000,
  reconcileCollections: 30 * 60_000,
  obligationsDue: 60 * 60_000,
  dailyCloseReminder: 24 * 60 * 60_000,
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Finance rejection codes (thrown as `OperationsError`) and their HTTP status. */
export const FINANCE_ERROR_HTTP_STATUS = {
  unbalanced_entry: 422,
  invalid_line: 422,
  period_closed: 409,
  already_reversed: 409,
  not_reversible: 409,
  domain_entry: 409,
  over_settlement: 409,
  payment_not_authorized: 409,
  duplicate_unresolved: 409,
  expense_incomplete: 422,
  currency_mismatch: 422,
  account_inactive: 409,
  has_settlements: 409,
  payment_exhausted: 409,
  close_blocked: 409,
  invalid_recurrence: 422,
  approval_required: 409,
  payment_overapplied: 409,
} as const;
export type FinanceErrorCode = keyof typeof FINANCE_ERROR_HTTP_STATUS;
