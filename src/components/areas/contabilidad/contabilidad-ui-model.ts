import type { OfflineCommandInput } from '@/lib/offline-commands';
import { FINANCE_COMMANDS, FINANCE_OBJECT_TYPES } from '@/modules/finance/types';
import {
  addDaysToDateKey,
  countDifference,
  formatMoney,
  type ContabilidadTone,
} from '@/modules/areas/contabilidad/contabilidad-model';

/**
 * Pure view model of the Contabilidad surfaces (plan 7.6 y 7.10): the commands
 * each action sends and the checks the UI makes before sending them. No React,
 * no I/O: the panels stay declarative and this is what the unit test covers.
 *
 * Every mutation is a real finance command executed through
 * `POST /app/operations/api/commands` (the offline queue), so the engine
 * validates permission, schema, state and optimistic version again. Building
 * the command here means a screen can never invent a payload shape.
 */

type Command = OfflineCommandInput<Record<string, unknown>>;

const NEW = 'new';

function command(
  type: string,
  aggregate: { type: string; id: string },
  payload: Record<string, unknown>,
  expectedVersion?: number
): Command {
  return {
    type,
    aggregate,
    payload,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

/** Drops keys the person left empty so a Zod `nullish()` field is simply absent. */
export function definedFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gastos
// ---------------------------------------------------------------------------

export type ExpenseCaptureMode = 'form' | 'text' | 'voice' | 'photo';

export interface CaptureExpenseInput {
  captureMode: ExpenseCaptureMode;
  rawInput?: string | null;
  amount?: string | null;
  date?: string | null;
  currency?: string;
  supplierNameFree?: string | null;
  categoryId?: string | null;
  costCenterId?: string | null;
  cashAccountId?: string | null;
  paymentMethod?: string | null;
  isPaid?: boolean;
  description?: string | null;
  areaKey?: string | null;
}

export function captureExpenseCommand(input: CaptureExpenseInput): Command {
  return command(
    FINANCE_COMMANDS.expenseCapture,
    { type: FINANCE_OBJECT_TYPES.expense, id: NEW },
    {
      captureMode: input.captureMode,
      ...definedFields({
        rawInput: input.rawInput,
        amount: input.amount,
        date: input.date,
        currency: input.currency,
        supplierNameFree: input.supplierNameFree,
        categoryId: input.categoryId,
        costCenterId: input.costCenterId,
        cashAccountId: input.cashAccountId,
        paymentMethod: input.paymentMethod,
        description: input.description,
        areaKey: input.areaKey,
      }),
      ...(input.isPaid === undefined ? {} : { isPaid: input.isPaid }),
    }
  );
}

export interface UpdateExpenseInput {
  amount?: string | null;
  date?: string | null;
  supplierNameFree?: string | null;
  categoryId?: string | null;
  costCenterId?: string | null;
  cashAccountId?: string | null;
  paymentMethod?: string | null;
  isPaid?: boolean;
  description?: string | null;
}

export function updateExpenseCommand(
  expenseId: string,
  version: number,
  patch: UpdateExpenseInput
): Command {
  return command(
    FINANCE_COMMANDS.expenseUpdate,
    { type: FINANCE_OBJECT_TYPES.expense, id: expenseId },
    {
      expenseId,
      ...definedFields({
        amount: patch.amount,
        date: patch.date,
        supplierNameFree: patch.supplierNameFree,
        categoryId: patch.categoryId,
        costCenterId: patch.costCenterId,
        cashAccountId: patch.cashAccountId,
        paymentMethod: patch.paymentMethod,
        description: patch.description,
      }),
      ...(patch.isPaid === undefined ? {} : { isPaid: patch.isPaid }),
    },
    version
  );
}

export function resolveExpenseDuplicateCommand(
  expenseId: string,
  version: number,
  decision: 'unique' | 'duplicate',
  duplicateOfId?: string | null
): Command {
  return command(
    FINANCE_COMMANDS.expenseResolveDuplicate,
    { type: FINANCE_OBJECT_TYPES.expense, id: expenseId },
    { expenseId, decision, ...definedFields({ duplicateOfId }) },
    version
  );
}

export function submitExpenseCommand(expenseId: string, version: number): Command {
  return command(
    FINANCE_COMMANDS.expenseSubmit,
    { type: FINANCE_OBJECT_TYPES.expense, id: expenseId },
    { expenseId },
    version
  );
}

export function postExpenseCommand(
  expenseId: string,
  version: number,
  input: { cashAccountId?: string | null; date?: string | null; dueDate?: string | null } = {}
): Command {
  return command(
    FINANCE_COMMANDS.expensePost,
    { type: FINANCE_OBJECT_TYPES.expense, id: expenseId },
    { expenseId, ...definedFields(input as Record<string, unknown>) },
    version
  );
}

export function captureFromTemplateCommand(
  templateId: string,
  input: { amount?: string | null; date?: string | null; description?: string | null } = {}
): Command {
  return command(
    FINANCE_COMMANDS.expenseCaptureFromTemplate,
    { type: FINANCE_OBJECT_TYPES.expenseTemplate, id: templateId },
    { templateId, ...definedFields(input as Record<string, unknown>) }
  );
}

/** The next thing this draft needs, in the order a person would do it. */
export type ExpenseStepKey =
  | 'resolve_duplicate'
  | 'amount'
  | 'category'
  | 'cash_account'
  | 'receipt'
  | 'submit'
  | 'waiting_approval'
  | 'post'
  | 'done';

export interface ExpenseStep {
  key: ExpenseStepKey;
  label: string;
  detail: string;
}

export interface ExpenseDraftSubject {
  status: string;
  duplicateStatus: string;
  amount: string;
  categoryId: string | null;
  isPaid: boolean;
  cashAccountId: string | null;
  receiptObjectIds: readonly string[];
}

/** "Siguiente acción" of a captured expense (drives the primary button). */
export function nextExpenseStep(expense: ExpenseDraftSubject): ExpenseStep {
  if (expense.status === 'pending_approval') {
    return {
      key: 'waiting_approval',
      label: 'Esperando aprobación',
      detail: 'Quien aprueba lo firma desde Mi trabajo; te avisamos cuando haya respuesta.',
    };
  }
  if (expense.status === 'approved') {
    return {
      key: 'post',
      label: 'Contabilizar',
      detail: 'Aprobado: Contabilidad genera el asiento o la cuenta por pagar.',
    };
  }
  if (expense.status === 'posted' || expense.status === 'rejected') {
    return { key: 'done', label: 'Sin pendientes', detail: 'Este gasto ya se cerró.' };
  }
  if (expense.duplicateStatus === 'suspect') {
    return {
      key: 'resolve_duplicate',
      label: 'Resolver el posible duplicado',
      detail: 'Confirma si es un gasto único o si ya se había capturado.',
    };
  }
  if (!(Number(expense.amount) > 0)) {
    return { key: 'amount', label: 'Falta el importe', detail: 'Escribe cuánto se pagó.' };
  }
  if (!expense.categoryId) {
    return {
      key: 'category',
      label: 'Falta la categoría',
      detail: 'Elige a qué categoría se carga.',
    };
  }
  if (expense.isPaid && !expense.cashAccountId) {
    return {
      key: 'cash_account',
      label: 'Falta la cuenta de pago',
      detail: 'Indica de qué cuenta salió el dinero.',
    };
  }
  if (expense.receiptObjectIds.length === 0) {
    return {
      key: 'receipt',
      label: 'Adjunta el comprobante',
      detail:
        'Toma la foto del ticket o sube el PDF; puedes enviarlo sin él, pero quedará marcado.',
    };
  }
  return {
    key: 'submit',
    label: 'Enviar a aprobación',
    detail: 'Está completo: se aplica la política de aprobación del monto.',
  };
}

/** Blocking issues before submitting (the engine applies the same rules). */
export function expenseSubmitIssues(
  expense: ExpenseDraftSubject,
  todayKey: string,
  dateKey: string
): string[] {
  const issues: string[] = [];
  if (!(Number(expense.amount) > 0)) issues.push('Falta el importe del gasto');
  if (!dateKey) issues.push('Falta la fecha del gasto');
  else if (dateKey > addDaysToDateKey(todayKey, 1))
    issues.push('La fecha del gasto no puede ser futura');
  if (!expense.categoryId) issues.push('Falta la categoría');
  if (expense.duplicateStatus === 'suspect') {
    issues.push('Resuelve primero si es un duplicado');
  }
  return issues;
}

/** Fields the AI proposed that the person did not write (shown as an editable card). */
export interface ProposedField {
  key: string;
  label: string;
  value: string;
}

const PROPOSAL_LABELS: Readonly<Record<string, string>> = {
  amount: 'Importe',
  date: 'Fecha',
  supplierName: 'Proveedor',
  supplierNameFree: 'Proveedor',
  categoryId: 'Categoría',
  categoryName: 'Categoría',
  costCenterId: 'Centro de costo',
  costCenterName: 'Centro de costo',
  description: 'Descripción',
  paymentMethod: 'Forma de pago',
  isPaid: 'Pagado',
  confidence: 'Confianza',
  reason: 'Por qué',
};

/** Reads `Expense.aiProposal` defensively: it is model output, never a command. */
export function proposalFields(proposal: Record<string, unknown> | null): ProposedField[] {
  if (!proposal) return [];
  const source =
    proposal.fields && typeof proposal.fields === 'object' && !Array.isArray(proposal.fields)
      ? (proposal.fields as Record<string, unknown>)
      : proposal;
  const out: ProposedField[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (out.length >= 8) break;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue;
    if (key === 'status' || key === 'appliedAt' || key === 'model') continue;
    out.push({
      key,
      label: PROPOSAL_LABELS[key] ?? key,
      value: typeof value === 'boolean' ? (value ? 'Sí' : 'No') : String(value).slice(0, 120),
    });
  }
  return out;
}

export function proposalStatus(
  proposal: Record<string, unknown> | null
): 'pending' | 'ready' | 'none' {
  if (!proposal) return 'none';
  if (proposal.status === 'pending') return 'pending';
  return proposalFields(proposal).length > 0 ? 'ready' : 'none';
}

// ---------------------------------------------------------------------------
// Obligaciones
// ---------------------------------------------------------------------------

export interface SettleObligationInput {
  obligationId: string;
  version: number;
  amount: string;
  cashAccountId: string;
  date?: string | null;
  memo?: string | null;
  evidenceObjectIds?: readonly string[];
}

export function settleObligationCommand(input: SettleObligationInput): Command {
  return command(
    FINANCE_COMMANDS.obligationSettle,
    { type: FINANCE_OBJECT_TYPES.obligation, id: input.obligationId },
    {
      obligationId: input.obligationId,
      amount: input.amount,
      cashAccountId: input.cashAccountId,
      ...definedFields({ date: input.date, memo: input.memo }),
      ...(input.evidenceObjectIds && input.evidenceObjectIds.length > 0
        ? { evidenceObjectIds: [...input.evidenceObjectIds] }
        : {}),
    },
    input.version
  );
}

export function writeOffObligationCommand(
  obligationId: string,
  version: number,
  reason: string,
  date?: string | null
): Command {
  return command(
    FINANCE_COMMANDS.obligationWriteOff,
    { type: FINANCE_OBJECT_TYPES.obligation, id: obligationId },
    { obligationId, reason: reason.trim(), ...definedFields({ date }) },
    version
  );
}

export function rescheduleObligationCommand(input: {
  obligationId: string;
  version: number;
  dueAt: string;
  expectedCashAt?: string | null;
  reason: string;
}): Command {
  return command(
    FINANCE_COMMANDS.obligationReschedule,
    { type: FINANCE_OBJECT_TYPES.obligation, id: input.obligationId },
    {
      obligationId: input.obligationId,
      dueAt: input.dueAt,
      reason: input.reason.trim(),
      ...definedFields({ expectedCashAt: input.expectedCashAt }),
    },
    input.version
  );
}

/**
 * Comprobaciones antes de renegociar la fecha de una obligación. Reprogramar no
 * es un hecho contable (no toca el asiento ni el importe), pero sí ensucia el
 * dato si se guarda una fecha imposible o la misma que ya tenía.
 */
export function rescheduleIssues(input: {
  dueAt: string;
  currentDueAt: string | null;
  reason: string;
}): string[] {
  const issues: string[] = [];
  const dueAt = input.dueAt.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) issues.push('Elige la nueva fecha de vencimiento');
  else if (Number.isNaN(new Date(`${dueAt}T00:00:00Z`).getTime())) {
    issues.push('La nueva fecha de vencimiento no es válida');
  } else if (input.currentDueAt === dueAt) {
    issues.push('La nueva fecha es la misma que ya tenía');
  }
  if (input.reason.trim().length < 3) issues.push('Escribe el motivo (mínimo 3 caracteres)');
  return issues;
}

export function requestPaymentAuthorizationCommand(
  obligationId: string,
  note?: string | null
): Command {
  return command(
    FINANCE_COMMANDS.paymentAuthorizationRequest,
    { type: FINANCE_OBJECT_TYPES.obligation, id: obligationId },
    { obligationId, ...definedFields({ note }) }
  );
}

export function createObligationCommand(input: {
  kind: 'payable' | 'receivable';
  counterpartyType: string;
  counterpartyName: string;
  description: string;
  expectedAmount: string;
  categoryId?: string | null;
  costCenterId?: string | null;
  dueAt?: string | null;
  currency?: string;
}): Command {
  return command(
    FINANCE_COMMANDS.obligationCreate,
    { type: FINANCE_OBJECT_TYPES.obligation, id: NEW },
    {
      kind: input.kind,
      counterpartyType: input.counterpartyType,
      counterpartyName: input.counterpartyName.trim(),
      description: input.description.trim(),
      expectedAmount: input.expectedAmount,
      ...definedFields({
        categoryId: input.categoryId,
        costCenterId: input.costCenterId,
        dueAt: input.dueAt,
        currency: input.currency,
      }),
    }
  );
}

/** Checks before registering a payment or a collection. */
export function settlementIssues(input: {
  amount: string;
  remaining: string;
  cashAccountId: string | null;
  currency: string;
  accountCurrency: string | null;
  canSettle: boolean;
}): string[] {
  const issues: string[] = [];
  const amount = Number(input.amount);
  const remaining = Number(input.remaining);
  if (!Number.isFinite(amount) || amount <= 0) issues.push('Escribe un importe mayor a cero');
  else if (Number.isFinite(remaining) && amount - remaining > 0.005) {
    issues.push(`El importe no puede pasar de ${formatMoney(input.remaining, input.currency)}`);
  }
  if (!input.cashAccountId) issues.push('Elige la cuenta de donde sale o entra el dinero');
  else if (input.accountCurrency && input.accountCurrency !== input.currency) {
    issues.push(`La cuenta es en ${input.accountCurrency} y la obligación en ${input.currency}`);
  }
  if (!input.canSettle) issues.push('Falta la autorización del pago');
  return issues;
}

// ---------------------------------------------------------------------------
// Cobros
// ---------------------------------------------------------------------------

export function matchPaymentCommand(
  zohoPaymentId: string,
  allocations: ReadonlyArray<{ obligationId: string; amount: string }>
): Command {
  return command(
    FINANCE_COMMANDS.collectionMatchPayment,
    { type: FINANCE_OBJECT_TYPES.customerPayment, id: zohoPaymentId },
    { zohoPaymentId, allocations: allocations.map((entry) => ({ ...entry })) }
  );
}

export function recordUnexpectedCollectionCommand(input: {
  zohoPaymentId: string;
  amount?: string | null;
  categoryId?: string | null;
  description?: string | null;
}): Command {
  return command(
    FINANCE_COMMANDS.collectionRecordUnexpected,
    { type: FINANCE_OBJECT_TYPES.customerPayment, id: input.zohoPaymentId },
    {
      zohoPaymentId: input.zohoPaymentId,
      ...definedFields({
        amount: input.amount,
        categoryId: input.categoryId,
        description: input.description,
      }),
    }
  );
}

/** Allocations must add up to something payable and never exceed the payment. */
export function allocationIssues(
  remaining: string,
  allocations: ReadonlyArray<{ obligationId: string; amount: string }>
): string[] {
  const issues: string[] = [];
  const usable = allocations.filter((entry) => Number(entry.amount) > 0);
  if (usable.length === 0) return ['Asigna al menos una cuenta por cobrar'];
  const total = usable.reduce((sum, entry) => sum + Number(entry.amount), 0);
  const available = Number(remaining);
  if (Number.isFinite(available) && total - available > 0.005) {
    issues.push(`Estás asignando más de lo que quedó del pago (${formatMoney(remaining)})`);
  }
  if (usable.some((entry) => !Number.isFinite(Number(entry.amount)))) {
    issues.push('Un importe no es un número válido');
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Libro: reverso
// ---------------------------------------------------------------------------

export function reverseEntryCommand(
  entryId: string,
  reason: string,
  date?: string | null
): Command {
  return command(
    FINANCE_COMMANDS.ledgerReverse,
    { type: FINANCE_OBJECT_TYPES.ledgerEntry, id: entryId },
    { entryId, reason: reason.trim(), ...definedFields({ date }) }
  );
}

/** Only a manual entry is reversed from the cash book; domain entries have their own flow. */
export function canReverseEntry(row: {
  sourceType: string | null;
  reversedByEntryId: string | null;
  reversesEntryId: string | null;
}): boolean {
  if (row.reversedByEntryId || row.reversesEntryId) return false;
  return row.sourceType === null || row.sourceType === 'manual';
}

export function reverseBlockedReason(sourceType: string | null): string {
  switch (sourceType) {
    case 'obligation':
      return 'Pertenece a una obligación: cancélala, castígala o reversa su liquidación.';
    case 'expense':
      return 'Pertenece a un gasto contabilizado: revérsalo desde el gasto.';
    case 'payroll_run':
      return 'Pertenece a una nómina: cancela la corrida.';
    default:
      return 'Este asiento ya fue reversado o es el reverso de otro.';
  }
}

// ---------------------------------------------------------------------------
// Presupuestos
// ---------------------------------------------------------------------------

export function setBudgetCommand(input: {
  periodKey: string;
  costCenterId: string;
  categoryId: string;
  amount: string;
  currency?: string;
}): Command {
  const costCenterId = input.costCenterId ?? '';
  const categoryId = input.categoryId ?? '';
  return command(
    FINANCE_COMMANDS.budgetSet,
    { type: 'budget', id: `${input.periodKey}:${costCenterId}:${categoryId}` },
    {
      periodKey: input.periodKey,
      costCenterId,
      categoryId,
      amount: input.amount,
      ...definedFields({ currency: input.currency }),
    }
  );
}

// ---------------------------------------------------------------------------
// Cierre
// ---------------------------------------------------------------------------

export interface CashCountInput {
  cashAccountId: string;
  counted: string;
}

/** Counts a person typed; empty boxes are simply not sent. */
export function cashCounts(inputs: Readonly<Record<string, string>>): CashCountInput[] {
  return Object.entries(inputs)
    .filter(([, value]) => value.trim() !== '' && Number.isFinite(Number(value)))
    .map(([cashAccountId, counted]) => ({ cashAccountId, counted: counted.trim() }));
}

export function dailyCloseCommand(dateKey: string, counts: readonly CashCountInput[]): Command {
  return command(
    FINANCE_COMMANDS.closeDaily,
    { type: FINANCE_OBJECT_TYPES.periodClose, id: `daily:${dateKey}` },
    { date: dateKey, counts: counts.map((entry) => ({ ...entry })) }
  );
}

export function monthlyCloseCommand(periodKey: string, counts: readonly CashCountInput[]): Command {
  return command(
    FINANCE_COMMANDS.closeMonthly,
    { type: FINANCE_OBJECT_TYPES.periodClose, id: `monthly:${periodKey}` },
    { periodKey, counts: counts.map((entry) => ({ ...entry })) }
  );
}

export const REOPEN_REASON_MIN_LENGTH = 10;

export function reopenPeriodCommand(
  kind: 'daily' | 'monthly',
  periodKey: string,
  reason: string
): Command {
  return command(
    FINANCE_COMMANDS.closeReopen,
    { type: FINANCE_OBJECT_TYPES.periodClose, id: `${kind}:${periodKey}` },
    { kind, periodKey, reason: reason.trim() }
  );
}

export function reopenReasonIssue(reason: string): string | null {
  const text = reason.trim();
  if (text.length < REOPEN_REASON_MIN_LENGTH) {
    return `Escribe el motivo de la reapertura (al menos ${REOPEN_REASON_MIN_LENGTH} caracteres)`;
  }
  if (text.length > 1000) return 'El motivo admite hasta 1000 caracteres';
  return null;
}

/** Tone of a cash count box: the difference between the ledger and what was counted. */
export function countTone(ledgerBalance: string, counted: string): ContabilidadTone {
  const difference = countDifference(ledgerBalance, counted);
  if (difference === null) return 'default';
  if (Math.abs(difference) < 0.01) return 'success';
  return Math.abs(difference) > 100 ? 'danger' : 'warning';
}

// ---------------------------------------------------------------------------
// Nómina
// ---------------------------------------------------------------------------

export interface PayrollLineInput {
  employeeId: string;
  gross: string;
  costCenterId?: string | null;
}

export function createPayrollRunCommand(input: {
  periodStart: string;
  periodEnd: string;
  lines: readonly PayrollLineInput[];
  currency?: string;
}): Command {
  return command(
    FINANCE_COMMANDS.payrollCreate,
    { type: FINANCE_OBJECT_TYPES.payrollRun, id: NEW },
    {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      ...definedFields({ currency: input.currency }),
      lines: input.lines.map((line) => ({
        employeeId: line.employeeId,
        gross: line.gross,
        ...definedFields({ costCenterId: line.costCenterId }),
      })),
    }
  );
}

function payrollCommand(
  type: string,
  payrollRunId: string,
  version: number,
  payload: Record<string, unknown> = {}
): Command {
  return command(
    type,
    { type: FINANCE_OBJECT_TYPES.payrollRun, id: payrollRunId },
    { payrollRunId, ...payload },
    version
  );
}

export function submitPayrollRunCommand(payrollRunId: string, version: number): Command {
  return payrollCommand(FINANCE_COMMANDS.payrollSubmit, payrollRunId, version);
}

export function createPayrollObligationsCommand(
  payrollRunId: string,
  version: number,
  input: { date?: string | null; dueDate?: string | null } = {}
): Command {
  return payrollCommand(
    FINANCE_COMMANDS.payrollCreateObligations,
    payrollRunId,
    version,
    definedFields(input as Record<string, unknown>)
  );
}

export function payPayrollLineCommand(
  payrollRunId: string,
  version: number,
  input: { employeeId: string; cashAccountId: string; date?: string | null }
): Command {
  return payrollCommand(FINANCE_COMMANDS.payrollPayLine, payrollRunId, version, {
    employeeId: input.employeeId,
    cashAccountId: input.cashAccountId,
    ...definedFields({ date: input.date }),
  });
}

export function closePayrollRunCommand(payrollRunId: string, version: number): Command {
  return payrollCommand(FINANCE_COMMANDS.payrollClose, payrollRunId, version);
}

export function cancelPayrollRunCommand(
  payrollRunId: string,
  version: number,
  reason: string
): Command {
  return payrollCommand(FINANCE_COMMANDS.payrollCancel, payrollRunId, version, {
    reason: reason.trim(),
  });
}

export interface PayrollStep {
  key: 'edit' | 'submit' | 'obligations' | 'pay' | 'close' | 'done';
  label: string;
  detail: string;
}

/** Next step of a payroll run (the primary button of its card). */
export function nextPayrollStep(status: string): PayrollStep {
  switch (status) {
    case 'draft':
      return {
        key: 'submit',
        label: 'Enviar a aprobación',
        detail: 'La corrida se firma antes de crear las cuentas por pagar.',
      };
    case 'pending_approval':
      return {
        key: 'edit',
        label: 'Esperando aprobación',
        detail: 'Quien aprueba la firma desde Mi trabajo.',
      };
    case 'approved':
      return {
        key: 'obligations',
        label: 'Crear cuentas por pagar',
        detail: 'Genera una obligación por empleado con su neto.',
      };
    case 'obligations_created':
      return { key: 'pay', label: 'Pagar líneas', detail: 'Registra el pago de cada empleado.' };
    case 'paid':
      return { key: 'close', label: 'Cerrar corrida', detail: 'Todas las líneas están pagadas.' };
    default:
      return { key: 'done', label: 'Sin pendientes', detail: 'Esta corrida ya está cerrada.' };
  }
}

// ---------------------------------------------------------------------------
// Catálogos
// ---------------------------------------------------------------------------

export function createCashAccountCommand(input: {
  key: string;
  name: string;
  kind: string;
  currency?: string;
  openingBalance?: string;
}): Command {
  return command(
    FINANCE_COMMANDS.cashAccountCreate,
    { type: FINANCE_OBJECT_TYPES.cashAccount, id: `key:${input.key}` },
    {
      key: input.key.trim(),
      name: input.name.trim(),
      kind: input.kind,
      ...definedFields({ currency: input.currency, openingBalance: input.openingBalance }),
    }
  );
}

export function updateCashAccountCommand(
  cashAccountId: string,
  version: number,
  patch: { name?: string; kind?: string; status?: string }
): Command {
  return command(
    FINANCE_COMMANDS.cashAccountUpdate,
    { type: FINANCE_OBJECT_TYPES.cashAccount, id: cashAccountId },
    { cashAccountId, ...definedFields(patch as Record<string, unknown>) },
    version
  );
}

export function createCategoryCommand(input: {
  key: string;
  name: string;
  kind: string;
  isDirect?: boolean;
}): Command {
  return command(
    FINANCE_COMMANDS.categoryCreate,
    { type: 'finance_category', id: `key:${input.key}` },
    {
      key: input.key.trim(),
      name: input.name.trim(),
      kind: input.kind,
      ...(input.isDirect === undefined ? {} : { isDirect: input.isDirect }),
    }
  );
}

export function updateCategoryCommand(
  categoryId: string,
  patch: { name?: string; status?: string; isDirect?: boolean }
): Command {
  return command(
    FINANCE_COMMANDS.categoryUpdate,
    { type: 'finance_category', id: categoryId },
    {
      categoryId,
      ...definedFields({ name: patch.name, status: patch.status }),
      ...(patch.isDirect === undefined ? {} : { isDirect: patch.isDirect }),
    }
  );
}

export function createCostCenterCommand(input: {
  key: string;
  name: string;
  areaKey?: string | null;
}): Command {
  return command(
    FINANCE_COMMANDS.costCenterCreate,
    { type: 'cost_center', id: `key:${input.key}` },
    { key: input.key.trim(), name: input.name.trim(), ...definedFields({ areaKey: input.areaKey }) }
  );
}

export function updateCostCenterCommand(
  costCenterId: string,
  patch: { name?: string; areaKey?: string | null; status?: string }
): Command {
  return command(
    FINANCE_COMMANDS.costCenterUpdate,
    { type: 'cost_center', id: costCenterId },
    { costCenterId, ...definedFields(patch as Record<string, unknown>) }
  );
}

/**
 * Alta en el directorio de empleados (plan 6.0: «no todo empleado tiene
 * login»). `userId` liga al empleado con su cuenta y `areaKey` con su área;
 * ambos son opcionales justamente porque hay empleados sin acceso al sistema.
 *
 * `null` viaja tal cual (desligar), a diferencia de `definedFields`, que lo
 * descartaría: el servicio distingue «no lo toques» (`undefined`) de «déjalo
 * vacío» (`null`).
 */
export function createEmployeeCommand(input: {
  name: string;
  position?: string | null;
  userId?: string | null;
  areaKey?: string | null;
  costCenterId?: string | null;
}): Command {
  return command(
    FINANCE_COMMANDS.employeeCreate,
    { type: FINANCE_OBJECT_TYPES.employee, id: NEW },
    {
      name: input.name.trim(),
      ...definedFields({
        position: input.position,
        userId: input.userId,
        areaKey: input.areaKey,
        costCenterId: input.costCenterId,
      }),
    }
  );
}

export function updateEmployeeCommand(
  employeeId: string,
  patch: {
    name?: string;
    position?: string | null;
    active?: boolean;
    /** `null` desliga la cuenta; `undefined` la deja como está. */
    userId?: string | null;
    /** `null` deja al empleado sin área; `undefined` la deja como está. */
    areaKey?: string | null;
    costCenterId?: string | null;
  }
): Command {
  return command(
    FINANCE_COMMANDS.employeeUpdate,
    { type: FINANCE_OBJECT_TYPES.employee, id: employeeId },
    {
      employeeId,
      ...definedFields({
        name: patch.name,
        position: patch.position,
        costCenterId: patch.costCenterId,
      }),
      ...(patch.userId === undefined ? {} : { userId: patch.userId }),
      ...(patch.areaKey === undefined ? {} : { areaKey: patch.areaKey }),
      ...(patch.active === undefined ? {} : { active: patch.active }),
    }
  );
}

/** Catalog keys are lowercase, without spaces: the same shape `catalog-service` accepts. */
export function normalizeCatalogKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}
