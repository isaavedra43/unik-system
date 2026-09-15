import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { financeError } from './finance-errors';
import { addDaysToKey, compareKeys, isDateKey, toDbDate, dateKeyOf } from './finance-dates';
import { normalizeSupplierName } from './expense-duplicates';
import type { ObligationAllocation } from './obligation-rules';
import { D, parseMoney, roundMoney, sumMoney, type Money } from './money';
import {
  EXPENSE_CATEGORY_KINDS,
  PAYMENT_METHODS,
  RECURRENCE_FREQUENCIES,
  type PaymentMethod,
  type RecurrenceFrequency,
} from './types';

/**
 * Deterministic expense rules (pure): classification suggested by history and
 * area, completeness before submitting, splits, merge of the AI proposal
 * (never over what the person typed) and recurrence of templates.
 */

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export interface CategoryRef {
  id: string;
  key: string;
  name: string;
  kind: string;
  status: string;
  defaultCostCenterId: string | null;
}

export interface CostCenterRef {
  id: string;
  key: string;
  name: string;
  areaKey: string | null;
  status: string;
}

export interface SupplierRef {
  id: string;
  name: string;
  legalName?: string | null;
  taxRegNo?: string | null;
}

export interface CashAccountRef {
  id: string;
  key: string;
  name: string;
  status: string;
  currency: string;
}

export function isExpenseCategory(category: Pick<CategoryRef, 'kind' | 'status'>): boolean {
  return category.status === 'active' && EXPENSE_CATEGORY_KINDS.includes(category.kind as never);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Keywords of the seeded categories (catalog-service keys) used when there is no history. */
export const CATEGORY_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  combustible: ['gasolina', 'diesel', 'combustible', 'gas lp', 'pemex', 'magna', 'premium'],
  fletes: ['flete', 'fletes', 'envio', 'paqueteria', 'estafeta', 'dhl', 'fedex', 'mudanza'],
  mantenimiento: ['mantenimiento', 'reparacion', 'refaccion', 'refacciones', 'taller', 'llanta'],
  papeleria: ['papeleria', 'oficina', 'impresion', 'toner', 'hojas', 'plumas'],
  servicios: ['luz', 'cfe', 'agua', 'internet', 'telefono', 'telmex', 'celular', 'plan'],
  renta: ['renta', 'arrendamiento', 'alquiler'],
  viaticos: ['viatico', 'viaticos', 'comida', 'hotel', 'caseta', 'casetas', 'peaje', 'estacionamiento', 'uber'],
  compras_mercancia: ['material', 'materiales', 'mercancia', 'insumo', 'insumos'],
  honorarios: ['honorarios', 'asesoria', 'consultoria', 'contador', 'abogado'],
  comisiones_bancarias: ['comision', 'comisiones', 'bancaria', 'terminal'],
  publicidad: ['publicidad', 'anuncio', 'facebook', 'google', 'volantes', 'marketing'],
  impuestos: ['impuesto', 'impuestos', 'isr', 'iva', 'predial', 'tenencia'],
  nomina_sueldos: ['sueldo', 'sueldos', 'nomina', 'salario', 'aguinaldo'],
  gastos_generales: [],
};

export function tokenize(text: string | null | undefined): string[] {
  return normalizeSupplierName(text)
    .split(' ')
    .filter((token) => token.length > 1);
}

export interface ExpenseHistoryRow {
  supplierKey: string;
  categoryId: string | null;
  costCenterId: string | null;
  dateKey: string;
}

export interface ClassificationSuggestion {
  categoryId: string | null;
  costCenterId: string | null;
  confidence: number;
  reasons: string[];
}

function modeOf(values: Array<{ id: string; dateKey: string }>): { id: string; count: number } | null {
  const counts = new Map<string, { count: number; last: string }>();
  for (const value of values) {
    const current = counts.get(value.id) ?? { count: 0, last: '' };
    counts.set(value.id, {
      count: current.count + 1,
      last: compareKeys(value.dateKey, current.last) > 0 ? value.dateKey : current.last,
    });
  }
  let best: { id: string; count: number; last: string } | null = null;
  for (const [id, stat] of counts) {
    if (
      !best ||
      stat.count > best.count ||
      (stat.count === best.count && compareKeys(stat.last, best.last) > 0) ||
      (stat.count === best.count && stat.last === best.last && id < best.id)
    ) {
      best = { id, ...stat };
    }
  }
  return best ? { id: best.id, count: best.count } : null;
}

function keywordCategory(description: string | null | undefined, categories: readonly CategoryRef[]) {
  const tokens = new Set(tokenize(description));
  const text = normalizeSupplierName(description);
  if (tokens.size === 0) return null;
  for (const category of categories) {
    if (!isExpenseCategory(category)) continue;
    const keywords = CATEGORY_KEYWORDS[category.key] ?? [];
    const hit = keywords.find((keyword) =>
      keyword.includes(' ') ? ` ${text} `.includes(` ${keyword} `) : tokens.has(keyword)
    );
    if (hit) return { category, keyword: hit };
  }
  return null;
}

/**
 * Category and cost center for an expense:
 * 1. the supplier's history (most frequent, ties → most recent);
 * 2. keywords of the description;
 * 3. `gastos_generales`.
 * The cost center follows the history, then the area of the person, then the
 * category default.
 */
export function suggestExpenseClassification(input: {
  supplierKey: string;
  areaKey?: string | null;
  description?: string | null;
  history: readonly ExpenseHistoryRow[];
  categories: readonly CategoryRef[];
  costCenters: readonly CostCenterRef[];
}): ClassificationSuggestion {
  const activeCategories = new Map(
    input.categories.filter(isExpenseCategory).map((c) => [c.id, c] as const)
  );
  const activeCenters = new Map(
    input.costCenters.filter((c) => c.status === 'active').map((c) => [c.id, c] as const)
  );
  const reasons: string[] = [];
  let categoryId: string | null = null;
  let costCenterId: string | null = null;
  let confidence = 0;

  const supplierRows = input.supplierKey
    ? input.history.filter((row) => row.supplierKey === input.supplierKey)
    : [];
  if (supplierRows.length > 0) {
    const categoryMode = modeOf(
      supplierRows
        .filter((row) => row.categoryId && activeCategories.has(row.categoryId))
        .map((row) => ({ id: row.categoryId as string, dateKey: row.dateKey }))
    );
    if (categoryMode) {
      categoryId = categoryMode.id;
      const share = categoryMode.count / supplierRows.length;
      confidence = categoryMode.count >= 2 && share >= 0.6 ? 0.9 : 0.7;
      reasons.push(
        `Historial del proveedor: ${categoryMode.count} de ${supplierRows.length} gasto(s) en ${activeCategories.get(categoryMode.id)?.name}`
      );
    }
    const centerMode = modeOf(
      supplierRows
        .filter((row) => row.costCenterId && activeCenters.has(row.costCenterId))
        .map((row) => ({ id: row.costCenterId as string, dateKey: row.dateKey }))
    );
    if (centerMode) costCenterId = centerMode.id;
  }

  if (!categoryId) {
    const keyword = keywordCategory(input.description, input.categories);
    if (keyword) {
      categoryId = keyword.category.id;
      confidence = 0.6;
      reasons.push(`La descripción menciona «${keyword.keyword}»`);
    }
  }
  if (!categoryId) {
    const general = input.categories.find((c) => c.key === 'gastos_generales' && isExpenseCategory(c));
    if (general) {
      categoryId = general.id;
      confidence = 0.3;
      reasons.push('Sin historial ni pistas: gastos generales');
    }
  }

  if (!costCenterId && input.areaKey) {
    const area = input.costCenters.find((c) => c.status === 'active' && c.areaKey === input.areaKey);
    if (area) {
      costCenterId = area.id;
      reasons.push(`Centro de costo del área ${area.name}`);
    }
  }
  if (!costCenterId && categoryId) {
    const fallback = activeCategories.get(categoryId)?.defaultCostCenterId ?? null;
    if (fallback && activeCenters.has(fallback)) costCenterId = fallback;
  }
  return { categoryId, costCenterId, confidence, reasons };
}

// ---------------------------------------------------------------------------
// Splits and completeness
// ---------------------------------------------------------------------------

export interface SplitInput {
  amount: Prisma.Decimal.Value;
  pct?: Prisma.Decimal.Value | null;
  costCenterId?: string | null;
  caseId?: string | null;
  projectRef?: string | null;
}

export function splitIssues(amount: Prisma.Decimal.Value, splits: readonly SplitInput[]): string[] {
  if (splits.length === 0) return [];
  const issues: string[] = [];
  splits.forEach((split, index) => {
    const n = index + 1;
    const value = parseMoney(split.amount);
    if (!value || !value.greaterThan(0)) issues.push(`Reparto ${n}: el importe debe ser mayor que cero`);
    if (split.pct !== null && split.pct !== undefined) {
      const pct = parseMoney(split.pct);
      if (!pct || pct.isNegative() || pct.greaterThan(100)) issues.push(`Reparto ${n}: porcentaje inválido`);
    }
    if (!split.costCenterId && !split.caseId && !split.projectRef) {
      issues.push(`Reparto ${n}: indica el centro de costo, el expediente o el proyecto`);
    }
  });
  const total = roundMoney(sumMoney(splits.map((s) => parseMoney(s.amount) ?? 0)));
  if (!total.equals(roundMoney(D(amount)))) {
    issues.push(`El reparto suma ${total.toFixed(2)} y el gasto es de ${roundMoney(D(amount)).toFixed(2)}`);
  }
  return issues;
}

export interface ExpenseCompletenessSubject {
  amount: Prisma.Decimal.Value;
  currency: string;
  dateKey: string;
  categoryId: string | null;
  costCenterId: string | null;
  isPaid: boolean;
  cashAccountId: string | null;
  splits: readonly SplitInput[];
}

/** Spanish issues that prevent submitting (or posting) an expense; empty when complete. */
export function expenseCompletenessIssues(
  subject: ExpenseCompletenessSubject,
  refs: {
    categories: ReadonlyMap<string, CategoryRef>;
    costCenters: ReadonlyMap<string, CostCenterRef>;
    cashAccounts: ReadonlyMap<string, CashAccountRef>;
    todayKey: string;
    requireCashAccount: boolean;
  }
): string[] {
  const issues: string[] = [];
  const amount = parseMoney(subject.amount);
  if (!amount || !amount.greaterThan(0)) issues.push('Falta el importe del gasto');
  if (!isDateKey(subject.dateKey)) issues.push('Falta la fecha del gasto');
  else if (compareKeys(subject.dateKey, addDaysToKey(refs.todayKey, 1)) > 0) {
    issues.push('La fecha del gasto no puede ser futura');
  }
  if (!subject.categoryId) issues.push('Falta la categoría');
  else {
    const category = refs.categories.get(subject.categoryId);
    if (!category) issues.push('La categoría no existe');
    else if (!isExpenseCategory(category)) issues.push(`La categoría ${category.name} no admite gastos`);
  }
  if (subject.costCenterId) {
    const center = refs.costCenters.get(subject.costCenterId);
    if (!center || center.status !== 'active') issues.push('El centro de costo no existe o está archivado');
  }
  if (subject.isPaid && refs.requireCashAccount) {
    if (!subject.cashAccountId) issues.push('Indica de qué cuenta salió el dinero');
    else {
      const account = refs.cashAccounts.get(subject.cashAccountId);
      if (!account || account.status !== 'active') issues.push('La cuenta de pago no existe o está cerrada');
      else if (account.currency !== subject.currency) {
        issues.push(`La cuenta ${account.name} es en ${account.currency} y el gasto en ${subject.currency}`);
      }
    }
  }
  for (const split of subject.splits) {
    if (split.costCenterId) {
      const center = refs.costCenters.get(split.costCenterId);
      if (!center || center.status !== 'active') {
        issues.push('Un centro de costo del reparto no existe o está archivado');
        break;
      }
    }
  }
  issues.push(...splitIssues(subject.amount, subject.splits));
  return issues;
}

/** Category side of the posting: one allocation per split, or the whole amount on the expense dimensions. */
export function expenseLedgerAllocations(expense: {
  amount: Prisma.Decimal.Value;
  costCenterId: string | null;
  caseId: string | null;
  splits: readonly SplitInput[];
}): ObligationAllocation[] {
  if (expense.splits.length === 0) {
    return [
      {
        amount: roundMoney(D(expense.amount)),
        costCenterId: expense.costCenterId,
        caseId: expense.caseId,
        projectRef: null,
      },
    ];
  }
  return expense.splits.map((split) => ({
    amount: roundMoney(D(split.amount)),
    costCenterId: split.costCenterId ?? null,
    caseId: split.caseId ?? expense.caseId ?? null,
    projectRef: split.projectRef ?? null,
  }));
}

// ---------------------------------------------------------------------------
// AI proposal
// ---------------------------------------------------------------------------

const numberish = z.preprocess((value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parseMoney(value);
  return parsed ? parsed.toNumber() : null;
}, z.number().nullable());

const nullableText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null),
    z.string().nullable()
  );

/** JSON the model returns for an expense (validated before anything is used). */
export const expenseProposalSchema = z
  .object({
    amount: numberish.optional().default(null),
    currency: nullableText(3).optional().default(null),
    date: nullableText(10).optional().default(null),
    supplierName: nullableText(200).optional().default(null),
    supplierRfc: nullableText(20).optional().default(null),
    categoryKey: nullableText(80).optional().default(null),
    costCenterKey: nullableText(80).optional().default(null),
    description: nullableText(500).optional().default(null),
    paymentMethod: z
      .preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : null), z.string().nullable())
      .optional()
      .default(null),
    isPaid: z.preprocess((v) => (typeof v === 'boolean' ? v : null), z.boolean().nullable()).optional().default(null),
    splits: z
      .array(
        z.object({
          costCenterKey: nullableText(80).optional().default(null),
          amount: numberish.optional().default(null),
          pct: numberish.optional().default(null),
        })
      )
      .max(20)
      .optional()
      .default([]),
    confidence: numberish.optional().default(null),
    warnings: z.array(z.string().max(300)).max(20).optional().default([]),
  })
  .passthrough();

export type ExpenseProposalRaw = z.output<typeof expenseProposalSchema>;

export interface ResolvedExpenseProposal {
  amount: string | null;
  dateKey: string | null;
  supplierId: string | null;
  supplierNameFree: string | null;
  categoryId: string | null;
  costCenterId: string | null;
  description: string | null;
  paymentMethod: PaymentMethod | null;
  isPaid: boolean | null;
  splits: Array<{ amount: string; pct: string | null; costCenterId: string }>;
  confidence: number;
  warnings: string[];
  reasons: string[];
}

function findSupplier(
  suppliers: readonly SupplierRef[],
  name: string | null,
  rfc: string | null
): SupplierRef | null {
  const cleanRfc = rfc?.toUpperCase().replace(/[^A-Z0-9&Ñ]/g, '') || null;
  if (cleanRfc) {
    const byRfc = suppliers.find((s) => (s.taxRegNo ?? '').toUpperCase() === cleanRfc);
    if (byRfc) return byRfc;
  }
  const normalized = normalizeSupplierName(name);
  if (!normalized) return null;
  return (
    suppliers.find(
      (s) => normalizeSupplierName(s.name) === normalized || normalizeSupplierName(s.legalName) === normalized
    ) ?? null
  );
}

/**
 * Validates the model's proposal against the catalog (keys → ids), fills gaps
 * with the deterministic suggestion and reports what it could not use.
 */
export function resolveExpenseProposal(
  raw: ExpenseProposalRaw | null,
  refs: {
    categories: readonly CategoryRef[];
    costCenters: readonly CostCenterRef[];
    suppliers: readonly SupplierRef[];
    todayKey: string;
    fallback: ClassificationSuggestion;
    expenseCurrency: string;
  }
): ResolvedExpenseProposal {
  const warnings = [...(raw?.warnings ?? [])];
  const reasons = [...refs.fallback.reasons];
  const categoriesByKey = new Map(refs.categories.map((c) => [c.key, c] as const));
  const centersByKey = new Map(refs.costCenters.map((c) => [c.key, c] as const));

  let amount: string | null = null;
  if (raw?.amount !== null && raw?.amount !== undefined) {
    const value = roundMoney(raw.amount);
    if (value.greaterThan(0)) amount = value.toFixed(2);
    else warnings.push('El importe propuesto no es válido');
  }
  if (raw?.currency && raw.currency.toUpperCase() !== refs.expenseCurrency) {
    warnings.push(`El comprobante parece estar en ${raw.currency.toUpperCase()}; el gasto se registra en ${refs.expenseCurrency}`);
  }

  let dateKey: string | null = null;
  if (raw?.date) {
    if (!isDateKey(raw.date)) warnings.push('La fecha propuesta no es válida');
    else if (compareKeys(raw.date, addDaysToKey(refs.todayKey, 1)) > 0) warnings.push('La fecha propuesta es futura; se ignoró');
    else if (compareKeys(raw.date, addDaysToKey(refs.todayKey, -366)) < 0) warnings.push('La fecha propuesta tiene más de un año; revísala');
    else dateKey = raw.date;
  }

  const supplier = findSupplier(refs.suppliers, raw?.supplierName ?? null, raw?.supplierRfc ?? null);
  const supplierId = supplier?.id ?? null;
  const supplierNameFree = supplier ? null : (raw?.supplierName ?? null);

  let categoryId: string | null = null;
  if (raw?.categoryKey) {
    const category = categoriesByKey.get(raw.categoryKey);
    if (category && isExpenseCategory(category)) {
      categoryId = category.id;
      reasons.unshift(`La IA propuso la categoría ${category.name}`);
    } else warnings.push(`La categoría «${raw.categoryKey}» no existe en el catálogo`);
  }
  categoryId = categoryId ?? refs.fallback.categoryId;

  let costCenterId: string | null = null;
  if (raw?.costCenterKey) {
    const center = centersByKey.get(raw.costCenterKey);
    if (center && center.status === 'active') costCenterId = center.id;
    else warnings.push(`El centro de costo «${raw.costCenterKey}» no existe`);
  }
  costCenterId = costCenterId ?? refs.fallback.costCenterId;

  const paymentMethod =
    raw?.paymentMethod && (PAYMENT_METHODS as readonly string[]).includes(raw.paymentMethod)
      ? (raw.paymentMethod as PaymentMethod)
      : null;

  const splits: ResolvedExpenseProposal['splits'] = [];
  if (raw && raw.splits.length > 0 && amount) {
    const resolved = raw.splits.map((split) => {
      const center = split.costCenterKey ? centersByKey.get(split.costCenterKey) : undefined;
      const value =
        split.amount !== null
          ? roundMoney(split.amount)
          : split.pct !== null
            ? roundMoney(D(amount).times(split.pct).dividedBy(100))
            : null;
      return center && center.status === 'active' && value && value.greaterThan(0)
        ? { amount: value.toFixed(2), pct: split.pct !== null ? String(split.pct) : null, costCenterId: center.id }
        : null;
    });
    const valid = resolved.filter((s): s is NonNullable<typeof s> => s !== null);
    if (valid.length === resolved.length && splitIssues(amount, valid).length === 0) splits.push(...valid);
    else warnings.push('El reparto propuesto no cuadra con el importe o usa centros inexistentes; se ignoró');
  }

  const modelConfidence = raw?.confidence ?? null;
  const confidence =
    modelConfidence !== null && modelConfidence >= 0 && modelConfidence <= 1
      ? Math.round(modelConfidence * 100) / 100
      : refs.fallback.confidence;

  return {
    amount,
    dateKey,
    supplierId,
    supplierNameFree,
    categoryId,
    costCenterId,
    description: raw?.description ?? null,
    paymentMethod,
    isPaid: raw?.isPaid ?? null,
    splits,
    confidence,
    warnings,
    reasons,
  };
}

/** Fields of an expense the person typed (the proposal never overwrites them). */
export const PROPOSABLE_FIELDS = [
  'amount',
  'date',
  'supplier',
  'categoryId',
  'costCenterId',
  'description',
  'paymentMethod',
  'isPaid',
  'splits',
] as const;
export type ProposableField = (typeof PROPOSABLE_FIELDS)[number];

export interface ExpenseMergeState {
  amount: Prisma.Decimal.Value;
  dateKey: string;
  supplierId: string | null;
  supplierNameFree: string | null;
  categoryId: string | null;
  costCenterId: string | null;
  description: string | null;
  paymentMethod: string | null;
  isPaid: boolean;
  splitCount: number;
}

export interface ExpenseMergePatch {
  amount?: Money;
  date?: Date;
  supplierId?: string | null;
  supplierNameFree?: string | null;
  categoryId?: string;
  costCenterId?: string;
  description?: string;
  paymentMethod?: PaymentMethod;
  isPaid?: boolean;
  splits?: ResolvedExpenseProposal['splits'];
}

/** Patch that applies the proposal only to fields the person did not provide and that are still empty. */
export function mergeProposalIntoExpense(
  current: ExpenseMergeState,
  proposal: ResolvedExpenseProposal,
  userProvided: ReadonlySet<string>
): ExpenseMergePatch {
  const patch: ExpenseMergePatch = {};
  const free = (field: ProposableField) => !userProvided.has(field);
  if (free('amount') && !D(current.amount).greaterThan(0) && proposal.amount) {
    patch.amount = roundMoney(proposal.amount);
  }
  if (free('date') && proposal.dateKey && proposal.dateKey !== current.dateKey) {
    patch.date = toDbDate(proposal.dateKey);
  }
  if (free('supplier') && !current.supplierId && !current.supplierNameFree) {
    if (proposal.supplierId) patch.supplierId = proposal.supplierId;
    else if (proposal.supplierNameFree) patch.supplierNameFree = proposal.supplierNameFree;
  }
  if (free('categoryId') && !current.categoryId && proposal.categoryId) patch.categoryId = proposal.categoryId;
  if (free('costCenterId') && !current.costCenterId && proposal.costCenterId) {
    patch.costCenterId = proposal.costCenterId;
  }
  if (free('description') && !current.description && proposal.description) patch.description = proposal.description;
  if (free('paymentMethod') && !current.paymentMethod && proposal.paymentMethod) {
    patch.paymentMethod = proposal.paymentMethod;
  }
  if (free('isPaid') && proposal.isPaid !== null && proposal.isPaid !== current.isPaid) patch.isPaid = proposal.isPaid;
  if (free('splits') && current.splitCount === 0 && proposal.splits.length > 0) {
    const finalAmount = patch.amount ?? D(current.amount);
    if (splitIssues(finalAmount, proposal.splits).length === 0) patch.splits = proposal.splits;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Recurrence of templates
// ---------------------------------------------------------------------------

export const recurrenceSchema = z
  .object({
    freq: z.enum(RECURRENCE_FREQUENCIES),
    interval: z.number().int().min(1).max(365).default(1),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    /** 0 = domingo … 6 = sábado */
    weekday: z.number().int().min(0).max(6).optional(),
  })
  .strict();

export type Recurrence = z.output<typeof recurrenceSchema>;

export function parseRecurrence(value: unknown): Recurrence | null {
  const parsed = recurrenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function monthlyKey(year: number, monthIndex: number, day: number): string {
  const normalizedYear = year + Math.floor(monthIndex / 12);
  const normalizedMonth = ((monthIndex % 12) + 12) % 12;
  const clamped = Math.min(day, daysInMonth(normalizedYear, normalizedMonth));
  return dateKeyOf(new Date(Date.UTC(normalizedYear, normalizedMonth, clamped)));
}

/** Next run strictly after `fromKey`. */
export function nextRecurrenceKey(recurrence: Recurrence, fromKey: string): string {
  if (!isDateKey(fromKey)) throw financeError('invalid_recurrence', 'Fecha base de la recurrencia inválida');
  const from = toDbDate(fromKey);
  const interval = Math.max(1, recurrence.interval);
  switch (recurrence.freq as RecurrenceFrequency) {
    case 'daily':
      return addDaysToKey(fromKey, interval);
    case 'weekly': {
      if (recurrence.weekday === undefined) return addDaysToKey(fromKey, 7 * interval);
      const delta = (recurrence.weekday - from.getUTCDay() + 7) % 7 || 7;
      return addDaysToKey(fromKey, delta + 7 * (interval - 1));
    }
    case 'monthly': {
      const day = recurrence.dayOfMonth ?? from.getUTCDate();
      const sameMonth = monthlyKey(from.getUTCFullYear(), from.getUTCMonth(), day);
      if (interval === 1 && compareKeys(sameMonth, fromKey) > 0 && recurrence.dayOfMonth !== undefined) {
        return sameMonth;
      }
      return monthlyKey(from.getUTCFullYear(), from.getUTCMonth() + interval, day);
    }
    case 'yearly':
      return monthlyKey(from.getUTCFullYear() + interval, from.getUTCMonth(), from.getUTCDate());
    default:
      throw financeError('invalid_recurrence', 'Frecuencia de recurrencia inválida');
  }
}
