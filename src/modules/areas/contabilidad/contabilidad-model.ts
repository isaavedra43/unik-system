import {
  EXPENSE_STATUS_LABELS,
  OBLIGATION_STATUS_LABELS,
  PAYROLL_STATUS_LABELS,
  type ExpenseStatus,
  type ObligationStatus,
  type PayrollStatus,
} from '@/modules/finance/types';

/**
 * Vocabulary of the Contabilidad area (plan 7.3, 7.4 y 7.6). PURE and
 * ISOMORPHIC: no Prisma, no React and no I/O, so the SQL branches, the
 * dashboard, the special view (Libro de caja) and the management pages read the
 * same labels, tones and links.
 *
 * Dates and money are formatted here (es-MX, America/Mexico_City) instead of in
 * each component: `@/modules/finance/money` and `@/modules/finance/finance-dates`
 * pull `@prisma/client`, which must never reach the browser bundle.
 */

export const CONTABILIDAD_AREA_KEY = 'contabilidad' as const;

/** Row kinds Contabilidad adds to the common ones (declared in `AREA_REGISTRY`). */
export const EXPENSE_ROW_KIND = 'expense';
export const OBLIGATION_ROW_KIND = 'obligation';
export const PERIOD_CLOSE_ROW_KIND = 'period_close_task';

export const CONTABILIDAD_ROW_KINDS = [
  EXPENSE_ROW_KIND,
  OBLIGATION_ROW_KIND,
  PERIOD_CLOSE_ROW_KIND,
] as const;

export type ContabilidadRowKind = (typeof CONTABILIDAD_ROW_KINDS)[number];

export const CONTABILIDAD_ROW_KIND_LABELS: Readonly<Record<string, string>> = {
  [EXPENSE_ROW_KIND]: 'Gasto',
  [OBLIGATION_ROW_KIND]: 'Obligación',
  [PERIOD_CLOSE_ROW_KIND]: 'Cierre de periodo',
};

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const CONTABILIDAD_BASE_PATH = `/app/areas/${CONTABILIDAD_AREA_KEY}`;

/** A section of Contabilidad: where a kind of work is actually attended. */
export interface ContabilidadSection {
  id: string;
  label: string;
  href: string;
  description: string;
  /** Any of these opens it (plus `operations.admin`, added by the pages). */
  anyOf: readonly string[];
}

/**
 * Sections of the area. `libro` and `gastos` are spaces of the area registry
 * (they appear as tabs); the rest are management pages of Contabilidad, linked
 * from the Libro de caja, from the panel and from the work rows.
 */
export const CONTABILIDAD_SECTIONS: readonly ContabilidadSection[] = [
  {
    id: 'libro',
    label: 'Libro de caja',
    href: `${CONTABILIDAD_BASE_PATH}/libro`,
    description: 'Saldos, movimientos, presupuesto y avance del cierre.',
    anyOf: ['finance.view'],
  },
  {
    id: 'gastos',
    label: 'Gastos',
    href: `${CONTABILIDAD_BASE_PATH}/gastos`,
    description: 'Gastos capturados, su aprobación y su comprobante.',
    anyOf: ['finance.view', 'finance.capture_expense'],
  },
  {
    id: 'gastos-nuevo',
    label: 'Capturar gasto',
    href: `${CONTABILIDAD_BASE_PATH}/gastos/nuevo`,
    description: 'Un botón: escribe, dicta o toma la foto del ticket.',
    anyOf: ['finance.capture_expense'],
  },
  {
    id: 'obligaciones',
    label: 'Obligaciones',
    href: `${CONTABILIDAD_BASE_PATH}/obligaciones`,
    description: 'Por pagar y por cobrar con su antigüedad, pagos y cobros sin asignar.',
    anyOf: ['finance.view', 'finance.manage_obligations'],
  },
  {
    id: 'nomina',
    label: 'Nómina',
    href: `${CONTABILIDAD_BASE_PATH}/nomina`,
    description: 'Corridas de nómina, sus líneas y sus pagos.',
    anyOf: ['finance.view', 'finance.payroll'],
  },
  {
    id: 'presupuestos',
    label: 'Presupuestos',
    href: `${CONTABILIDAD_BASE_PATH}/presupuestos`,
    description: 'Presupuesto por periodo, centro y categoría contra el real.',
    anyOf: ['finance.view', 'finance.manage_catalog'],
  },
  {
    id: 'cierre',
    label: 'Cierre',
    href: `${CONTABILIDAD_BASE_PATH}/cierre`,
    description: 'Checklist del cierre diario y mensual, bloqueos y reapertura.',
    anyOf: ['finance.view', 'finance.close'],
  },
  {
    id: 'catalogos',
    label: 'Catálogos',
    href: `${CONTABILIDAD_BASE_PATH}/catalogos`,
    description: 'Cuentas, categorías, centros de costo y empleados.',
    anyOf: ['finance.view', 'finance.manage_catalog'],
  },
];

export interface PermissionHolder {
  permissionKeys: readonly string[];
  isSuperAdmin: boolean;
}

export function holdsAnyFinance(user: PermissionHolder, keys: readonly string[]): boolean {
  return user.isSuperAdmin || keys.some((key) => user.permissionKeys.includes(key));
}

/** Sections this person may open (the server checks again on every page). */
export function visibleContabilidadSections(user: PermissionHolder): ContabilidadSection[] {
  return CONTABILIDAD_SECTIONS.filter((section) =>
    holdsAnyFinance(user, [...section.anyOf, 'operations.admin'])
  );
}

export function contabilidadSection(id: string): ContabilidadSection | null {
  return CONTABILIDAD_SECTIONS.find((section) => section.id === id) ?? null;
}

/** Deep link that focuses one record inside its section (`?gasto=`, `?obligacion=`…). */
export function contabilidadFocusHref(rowKind: string, sourceId: string): string | null {
  if (rowKind === EXPENSE_ROW_KIND) {
    return `${CONTABILIDAD_BASE_PATH}/gastos/nuevo?gasto=${encodeURIComponent(sourceId)}`;
  }
  if (rowKind === OBLIGATION_ROW_KIND) {
    return `${CONTABILIDAD_BASE_PATH}/obligaciones?obligacion=${encodeURIComponent(sourceId)}`;
  }
  if (rowKind === PERIOD_CLOSE_ROW_KIND) {
    return `${CONTABILIDAD_BASE_PATH}/cierre`;
  }
  return null;
}

/** Where a row of Contabilidad is attended, in words (shown in the drawer). */
export function whereItIsAttended(rowKind: string): string {
  switch (rowKind) {
    case EXPENSE_ROW_KIND:
      return 'Contabilidad › Capturar gasto: completa los datos, resuelve el duplicado y envíalo.';
    case OBLIGATION_ROW_KIND:
      return 'Contabilidad › Obligaciones: liquidar, pedir autorización, cancelar o castigar.';
    case PERIOD_CLOSE_ROW_KIND:
      return 'Contabilidad › Cierre: arqueo, checklist y reapertura con motivo.';
    default:
      return 'Contabilidad › Libro de caja.';
  }
}

// ---------------------------------------------------------------------------
// Status labels and tones
// ---------------------------------------------------------------------------

export type ContabilidadTone = 'default' | 'success' | 'danger' | 'warning' | 'info' | 'weak';

export function expenseStatusLabel(status: string): string {
  return EXPENSE_STATUS_LABELS[status as ExpenseStatus] ?? status;
}

export function expenseStatusTone(status: string): ContabilidadTone {
  switch (status) {
    case 'draft':
      return 'warning';
    case 'pending_approval':
      return 'info';
    case 'approved':
      return 'info';
    case 'posted':
      return 'success';
    case 'rejected':
      return 'weak';
    default:
      return 'default';
  }
}

export function obligationStatusLabel(status: string): string {
  return OBLIGATION_STATUS_LABELS[status as ObligationStatus] ?? status;
}

export function obligationStatusTone(status: string): ContabilidadTone {
  switch (status) {
    case 'expected':
      return 'default';
    case 'partially_settled':
      return 'info';
    case 'settled':
      return 'success';
    case 'written_off':
      return 'weak';
    case 'cancelled':
      return 'weak';
    default:
      return 'default';
  }
}

export function payrollStatusLabel(status: string): string {
  return PAYROLL_STATUS_LABELS[status as PayrollStatus] ?? status;
}

export const PERIOD_CLOSE_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: 'Abierto',
  closing: 'En cierre',
  closed: 'Cerrado',
  reopened: 'Reabierto',
};

export function closeStatusLabel(status: string): string {
  return PERIOD_CLOSE_STATUS_LABELS[status] ?? status;
}

export function closeStatusTone(status: string): ContabilidadTone {
  switch (status) {
    case 'closed':
      return 'success';
    case 'closing':
      return 'info';
    case 'reopened':
      return 'warning';
    default:
      return 'default';
  }
}

export const PERIOD_CLOSE_KIND_LABELS: Readonly<Record<string, string>> = {
  daily: 'diario',
  monthly: 'mensual',
};

export function closeKindLabel(kind: string): string {
  return PERIOD_CLOSE_KIND_LABELS[kind] ?? kind;
}

export function closeRowTitle(kind: string, periodKey: string): string {
  return `Cierre ${closeKindLabel(kind)} ${periodKey}`;
}

// ---------------------------------------------------------------------------
// Duplicates and payment authorization
// ---------------------------------------------------------------------------

export const DUPLICATE_STATUS_LABELS: Readonly<Record<string, string>> = {
  none: 'Sin duplicados',
  suspect: 'Posible duplicado',
  confirmed_unique: 'Confirmado como único',
  confirmed_duplicate: 'Marcado como duplicado',
};

export function duplicateStatusLabel(status: string): string {
  return DUPLICATE_STATUS_LABELS[status] ?? status;
}

export const DUPLICATE_MATCH_LABELS: Readonly<Record<string, string>> = {
  receipt: 'mismo comprobante',
  exact: 'mismo importe, fecha y proveedor',
  fuzzy: 'importe y fecha muy parecidos',
};

export function duplicateMatchLabel(kind: string): string {
  return DUPLICATE_MATCH_LABELS[kind] ?? kind;
}

export const PAYMENT_AUTHORIZATION_LABELS: Readonly<Record<string, string>> = {
  not_required: 'No requiere autorización',
  approved: 'Pago autorizado',
  pending: 'Autorización pendiente',
  rejected: 'Autorización rechazada',
  missing: 'Falta autorización',
};

export function paymentAuthorizationLabel(state: string): string {
  return PAYMENT_AUTHORIZATION_LABELS[state] ?? state;
}

export function paymentAuthorizationTone(state: string): ContabilidadTone {
  switch (state) {
    case 'approved':
    case 'not_required':
      return 'success';
    case 'pending':
      return 'warning';
    case 'rejected':
    case 'missing':
      return 'danger';
    default:
      return 'default';
  }
}

/** True when the person can still register the payment of this obligation. */
export function canSettleNow(input: {
  status: string;
  kind: string;
  paymentAuthorization: string;
}): boolean {
  if (input.status !== 'expected' && input.status !== 'partially_settled') return false;
  if (input.kind !== 'payable') return true;
  return input.paymentAuthorization === 'approved' || input.paymentAuthorization === 'not_required';
}

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

/**
 * Same buckets as `obligation-rules.AGING_BUCKETS`, restated here because that
 * module imports Prisma and this one also runs in the browser. The unit test
 * keeps both lists identical.
 */
export const AGING_BUCKETS_UI = [
  'not_due',
  'd1_30',
  'd31_60',
  'd61_90',
  'd90_plus',
  'no_due_date',
] as const;

export type AgingBucketUi = (typeof AGING_BUCKETS_UI)[number];

export const AGING_BUCKET_LABELS_UI: Readonly<Record<AgingBucketUi, string>> = {
  not_due: 'Por vencer',
  d1_30: '1 a 30 días',
  d31_60: '31 a 60 días',
  d61_90: '61 a 90 días',
  d90_plus: 'Más de 90 días',
  no_due_date: 'Sin vencimiento',
};

export function agingBucketLabel(bucket: string): string {
  return AGING_BUCKET_LABELS_UI[bucket as AgingBucketUi] ?? bucket;
}

export function agingBucketTone(bucket: string): ContabilidadTone {
  switch (bucket) {
    case 'not_due':
      return 'default';
    case 'd1_30':
      return 'warning';
    case 'd31_60':
    case 'd61_90':
      return 'danger';
    case 'd90_plus':
      return 'danger';
    default:
      return 'weak';
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const CONTABILIDAD_TIMEZONE = 'America/Mexico_City';

/** Money in es-MX; `—` when the value is missing or not a number. */
export function formatMoney(value: string | number | null | undefined, currency = 'MXN'): string {
  if (value === null || value === undefined || value === '') return '—';
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return '—';
  try {
    return amount.toLocaleString('es-MX', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Compact money for tiles: `$1.2 M`, `$845.3 k`, `$980`. */
export function formatMoneyCompact(
  value: string | number | null | undefined,
  currency = 'MXN'
): string {
  if (value === null || value === undefined || value === '') return '—';
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return '—';
  const abs = Math.abs(amount);
  if (abs < 10_000) return formatMoney(Math.round(amount), currency);
  const sign = amount < 0 ? '-' : '';
  const symbol = currency === 'MXN' ? '$' : `${currency} `;
  if (abs >= 1_000_000) {
    return `${sign}${symbol}${(abs / 1_000_000).toLocaleString('es-MX', { maximumFractionDigits: 1 })} M`;
  }
  return `${sign}${symbol}${(abs / 1_000).toLocaleString('es-MX', { maximumFractionDigits: 1 })} k`;
}

/** Percentage 0–100 already computed; `—` when there is nothing to compare. */
export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('es-MX', { maximumFractionDigits: digits })} %`;
}

export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('es-MX') : '0';
}

/** `YYYY-MM-DD` of an instant in the accounting time zone. */
export function dateKeyOfInstant(instant: Date, timeZone = CONTABILIDAD_TIMEZONE): string {
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}

/** `YYYY-MM` of a date key or an instant. */
export function periodKeyOf(value: string | Date, timeZone = CONTABILIDAD_TIMEZONE): string {
  const key = typeof value === 'string' ? value : dateKeyOfInstant(value, timeZone);
  return key.slice(0, 7);
}

/** `YYYY-MM-DD` shifted by whole days (never crosses a time zone). */
export function addDaysToDateKey(key: string, days: number): string {
  const [year, month, day] = key.split('-').map((part) => Number(part));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return key;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** First and last day of a `YYYY-MM` period. */
export function periodRange(periodKey: string): { from: string; to: string } {
  const [year, month] = periodKey.split('-').map((part) => Number(part));
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return { from: `${periodKey}-01`, to: `${periodKey}-28` };
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${periodKey}-01`, to: `${periodKey}-${String(last).padStart(2, '0')}` };
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: CONTABILIDAD_TIMEZONE,
};

/** `15 sep 2026` from a `YYYY-MM-DD` key; `—` when empty. */
export function formatDateKey(key: string | null | undefined): string {
  if (!key) return '—';
  const date = new Date(`${key.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  try {
    return new Intl.DateTimeFormat('es-MX', DAY_FORMAT).format(date);
  } catch {
    return key;
  }
}

const MONTH_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
};

/** `septiembre de 2026` from a `YYYY-MM` period key. */
export function formatPeriodKey(periodKey: string | null | undefined): string {
  if (!periodKey) return '—';
  const date = new Date(`${periodKey}-01T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return periodKey;
  try {
    return new Intl.DateTimeFormat('es-MX', MONTH_FORMAT).format(date);
  } catch {
    return periodKey;
  }
}

// ---------------------------------------------------------------------------
// Budget and close
// ---------------------------------------------------------------------------

/** Consumed share of a budget (0–∞); null when there is no budget to compare. */
export function budgetUsedPercent(
  actual: string | number | null | undefined,
  budget: string | number | null | undefined
): number | null {
  const spent = typeof actual === 'number' ? actual : Number(actual ?? NaN);
  const planned = typeof budget === 'number' ? budget : Number(budget ?? NaN);
  if (!Number.isFinite(spent) || !Number.isFinite(planned) || planned <= 0) return null;
  return Math.round((spent / planned) * 1000) / 10;
}

/** Tone of a budget tile; narrower than `ContabilidadTone` so it fits `StatCard`. */
export function budgetTone(
  usedPercent: number | null
): 'default' | 'success' | 'warning' | 'danger' {
  if (usedPercent === null) return 'default';
  if (usedPercent > 100) return 'danger';
  if (usedPercent > 85) return 'warning';
  return 'success';
}

/** Check of a close as the UI reads it (same shape as `close-rules.CloseCheck`). */
export interface CloseCheckView {
  key: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
}

/** Parses the `checks` JSON of a `PeriodClose` row, dropping anything malformed. */
export function parseCloseChecks(value: unknown): CloseCheckView[] {
  if (!Array.isArray(value)) return [];
  const out: CloseCheckView[] = [];
  for (const raw of value.slice(0, 40)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key : '';
    if (!key) continue;
    out.push({
      key,
      label: typeof record.label === 'string' ? record.label : key,
      ok: record.ok === true,
      blocking: record.blocking === true,
      detail: typeof record.detail === 'string' ? record.detail.slice(0, 300) : '',
    });
  }
  return out;
}

export interface CloseProgress {
  total: number;
  ok: number;
  blockers: CloseCheckView[];
  warnings: CloseCheckView[];
  /** 0–100; null when the close has never been attempted. */
  percent: number | null;
}

/** Progress of a close attempt: what passes, what blocks and what only warns. */
export function summarizeCloseChecks(checks: readonly CloseCheckView[]): CloseProgress {
  if (checks.length === 0) return { total: 0, ok: 0, blockers: [], warnings: [], percent: null };
  const ok = checks.filter((check) => check.ok).length;
  return {
    total: checks.length,
    ok,
    blockers: checks.filter((check) => !check.ok && check.blocking),
    warnings: checks.filter((check) => !check.ok && !check.blocking),
    percent: Math.round((ok / checks.length) * 100),
  };
}

/** One sentence with what is missing to close, or the reassuring one. */
export function describeCloseProgress(progress: CloseProgress): string {
  if (progress.total === 0) return 'Todavía no se intenta el cierre de este periodo.';
  if (progress.blockers.length === 0) {
    return progress.warnings.length > 0
      ? `Sin bloqueos; ${progress.warnings.length} ${progress.warnings.length === 1 ? 'advertencia' : 'advertencias'} por revisar.`
      : 'Sin bloqueos: el periodo puede cerrarse.';
  }
  return progress.blockers.length === 1
    ? `1 bloqueo: ${progress.blockers[0].label}.`
    : `${progress.blockers.length} bloqueos, empezando por ${progress.blockers[0].label}.`;
}

// ---------------------------------------------------------------------------
// Row actions of the work centre
// ---------------------------------------------------------------------------

/**
 * Action a SQL branch attaches to a row (`extra.actions`), validated again by
 * `work-actions.parseBranchActions` before it is shown and by `executeCommand`
 * before it runs. Finance commands name their own record inside the payload
 * (`expenseId`, `obligationId`…), which the branch adds per row.
 */
export interface BranchRowAction {
  id: string;
  label: string;
  commandType: string;
  aggregateType: string;
  form: 'none' | 'note' | 'reason' | 'wait' | 'answer';
  tone: 'primary' | 'default' | 'danger';
  confirm: string | null;
  successMessage: string;
  hint: string | null;
  /** Any of these lets a person see (and try) the action. */
  permissions: string[];
}

const SUBMIT_EXPENSE: BranchRowAction = {
  id: 'expense.submit',
  label: 'Enviar a aprobación',
  commandType: 'finance.expense.submit',
  aggregateType: 'expense',
  form: 'none',
  tone: 'primary',
  confirm: null,
  successMessage: 'Gasto enviado a aprobación',
  hint: 'Se aplica la política de aprobación que corresponda al monto.',
  permissions: ['finance.capture_expense'],
};

const DISCARD_DRAFT_EXPENSE: BranchRowAction = {
  id: 'expense.discard',
  label: 'Descartar gasto',
  commandType: 'finance.expense.reject',
  aggregateType: 'expense',
  form: 'reason',
  tone: 'danger',
  confirm: '¿Descartar este gasto? Quedará registrado como rechazado.',
  successMessage: 'Gasto descartado',
  hint: 'Explica por qué no procede (hasta 500 caracteres).',
  permissions: ['finance.capture_expense'],
};

const POST_EXPENSE: BranchRowAction = {
  id: 'expense.post',
  label: 'Contabilizar',
  commandType: 'finance.expense.post',
  aggregateType: 'expense',
  form: 'none',
  tone: 'primary',
  confirm: null,
  successMessage: 'Gasto contabilizado',
  hint: 'Genera el asiento; si no está pagado, abre la cuenta por pagar.',
  permissions: ['finance.post'],
};

const DISCARD_APPROVED_EXPENSE: BranchRowAction = {
  ...DISCARD_DRAFT_EXPENSE,
  id: 'expense.discard_approved',
  confirm: '¿Descartar un gasto ya aprobado? Quedará como rechazado.',
  permissions: ['finance.post'],
};

/** Actions of a `Expense` row, by status (`pending_approval` se firma en Mi trabajo). */
export const EXPENSE_ROW_ACTIONS: Readonly<Record<string, readonly BranchRowAction[]>> = {
  draft: [SUBMIT_EXPENSE, DISCARD_DRAFT_EXPENSE],
  approved: [POST_EXPENSE, DISCARD_APPROVED_EXPENSE],
};

/** Cancelling an open obligation reverses its entry: available for both kinds. */
export const OBLIGATION_CANCEL_ACTIONS: readonly BranchRowAction[] = [
  {
    id: 'obligation.cancel',
    label: 'Cancelar obligación',
    commandType: 'finance.obligation.cancel',
    aggregateType: 'obligation',
    form: 'reason',
    tone: 'danger',
    confirm: '¿Cancelar esta obligación? Se revierte su asiento.',
    successMessage: 'Obligación cancelada',
    hint: 'Di por qué ya no aplica (hasta 500 caracteres).',
    permissions: ['finance.manage_obligations'],
  },
];

/** Only for a payable that still has no open payment authorization. */
export const OBLIGATION_AUTHORIZATION_ACTIONS: readonly BranchRowAction[] = [
  {
    id: 'obligation.request_authorization',
    label: 'Pedir autorización de pago',
    commandType: 'finance.payment.request_authorization',
    aggregateType: 'obligation',
    form: 'none',
    tone: 'primary',
    confirm: null,
    successMessage: 'Autorización de pago solicitada',
    hint: 'La firman desde Mi trabajo quienes aprueban pagos; quien la pide no la firma.',
    permissions: ['finance.manage_obligations'],
  },
];

// ---------------------------------------------------------------------------
// Cash accounts
// ---------------------------------------------------------------------------

/** Accounts whose physical count the daily close asks for (`DAILY_COUNT_ACCOUNT_KINDS`). */
export const COUNTED_ACCOUNT_KINDS: readonly string[] = ['cash', 'petty_cash'];

export function needsCashCount(kind: string): boolean {
  return COUNTED_ACCOUNT_KINDS.includes(kind);
}

/** Difference between what the system says and what was counted. */
export function countDifference(
  ledgerBalance: string | number | null | undefined,
  counted: string | number | null | undefined
): number | null {
  // An empty box is "not counted yet", never a count of zero.
  const parse = (value: string | number | null | undefined): number => {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
    return Number(value);
  };
  const book = parse(ledgerBalance);
  const real = parse(counted);
  if (!Number.isFinite(book) || !Number.isFinite(real)) return null;
  return Math.round((real - book) * 100) / 100;
}
