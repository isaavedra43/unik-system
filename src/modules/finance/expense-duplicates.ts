import { Prisma } from '@prisma/client';
import { addDaysToKey, daysBetweenKeys, isDateKey } from './finance-dates';
import { D, roundMoney } from './money';
import type { DuplicateStatus } from './types';

/**
 * Pure duplicate detection of expenses (plan 6.4):
 *
 * - exact: same `amount|date|supplier` key (normalized) or the same receipt
 *   hash (sha256 of the uploaded file);
 * - fuzzy: amounts within ±1 % of the larger one, dates within ±3 days and
 *   compatible suppliers (the same one, or one of them unknown).
 *
 * A match marks the expense `suspect`; the person resolves it (unique or
 * duplicate) before submitting. A confirmed decision is kept while the
 * identity of the expense (amount, date, supplier, receipt) does not change.
 */

export const FUZZY_AMOUNT_PCT = 0.01;
export const FUZZY_DAYS = 3;

const LEGAL_SUFFIXES = [
  's a p i de c v',
  's a b de c v',
  's de r l de c v',
  's a de c v',
  's de r l',
  's c',
  'a c',
  'sapi de cv',
  'sa de cv',
  's de rl de cv',
  's de rl',
  'sa',
];

export function normalizeSupplierName(name: string | null | undefined): string {
  if (!name) return '';
  let text = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const suffix of LEGAL_SUFFIXES) {
    if (text === suffix) break;
    if (text.endsWith(` ${suffix}`)) {
      text = text.slice(0, -suffix.length - 1).trim();
      break;
    }
  }
  return text;
}

export function supplierKeyOf(input: {
  supplierId?: string | null;
  supplierNameFree?: string | null;
}): string {
  if (input.supplierId) return `s:${input.supplierId}`;
  const name = normalizeSupplierName(input.supplierNameFree);
  return name ? `n:${name}` : '';
}

export interface DuplicateSubject {
  id?: string | null;
  amount: Prisma.Decimal.Value;
  dateKey: string;
  supplierId?: string | null;
  supplierNameFree?: string | null;
  receiptHash?: string | null;
}

/** `amount|date|supplier` (amount in cents); null while the amount is not known. */
export function buildDuplicateKey(subject: DuplicateSubject): string | null {
  const amount = roundMoney(D(subject.amount));
  if (!amount.greaterThan(0) || !isDateKey(subject.dateKey)) return null;
  return `${amount.toFixed(2)}|${subject.dateKey}|${supplierKeyOf(subject)}`;
}

export interface DuplicateCandidate extends DuplicateSubject {
  id: string;
  number: string;
  status: string;
  duplicateStatus: string;
}

export type DuplicateMatchKind = 'receipt' | 'exact' | 'fuzzy';

export interface DuplicateMatch {
  expenseId: string;
  number: string;
  kind: DuplicateMatchKind;
  /** |a − b| / max(a, b) as a fraction (0.004 = 0.4 %). */
  amountDiffPct: number;
  daysApart: number;
  reason: string;
}

const KIND_ORDER: Record<DuplicateMatchKind, number> = { receipt: 0, exact: 1, fuzzy: 2 };

export interface DuplicateOptions {
  amountPct?: number;
  days?: number;
}

function suppliersCompatible(a: string, b: string): boolean {
  return a === b || a === '' || b === '';
}

/** Matches of `subject` among `candidates` (self, rejected and confirmed duplicates excluded). */
export function findDuplicateMatches(
  subject: DuplicateSubject,
  candidates: readonly DuplicateCandidate[],
  options: DuplicateOptions = {}
): DuplicateMatch[] {
  const pct = options.amountPct ?? FUZZY_AMOUNT_PCT;
  const days = options.days ?? FUZZY_DAYS;
  const amount = roundMoney(D(subject.amount));
  const key = buildDuplicateKey(subject);
  const supplier = supplierKeyOf(subject);
  const matches: DuplicateMatch[] = [];
  for (const candidate of candidates) {
    if (subject.id && candidate.id === subject.id) continue;
    if (candidate.status === 'rejected' || candidate.duplicateStatus === 'confirmed_duplicate') continue;
    const other = roundMoney(D(candidate.amount));
    const larger = amount.greaterThan(other) ? amount : other;
    const diffPct = larger.isZero() ? 0 : amount.minus(other).abs().dividedBy(larger).toNumber();
    const apart =
      isDateKey(subject.dateKey) && isDateKey(candidate.dateKey)
        ? Math.abs(daysBetweenKeys(subject.dateKey, candidate.dateKey))
        : Number.POSITIVE_INFINITY;
    const base = {
      expenseId: candidate.id,
      number: candidate.number,
      amountDiffPct: Math.round(diffPct * 10000) / 10000,
      daysApart: Number.isFinite(apart) ? apart : -1,
    };
    if (subject.receiptHash && candidate.receiptHash && subject.receiptHash === candidate.receiptHash) {
      matches.push({ ...base, kind: 'receipt', reason: `El comprobante es el mismo archivo que ${candidate.number}` });
      continue;
    }
    if (key && key === buildDuplicateKey(candidate)) {
      matches.push({
        ...base,
        kind: 'exact',
        reason: `Mismo importe, fecha y proveedor que ${candidate.number}`,
      });
      continue;
    }
    if (
      amount.greaterThan(0) &&
      other.greaterThan(0) &&
      diffPct <= pct + 1e-9 &&
      apart <= days &&
      suppliersCompatible(supplier, supplierKeyOf(candidate))
    ) {
      matches.push({
        ...base,
        kind: 'fuzzy',
        reason: `Importe parecido (±${(pct * 100).toFixed(0)} %) a ${candidate.number} con ${apart} día(s) de diferencia`,
      });
    }
  }
  return matches.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.amountDiffPct - b.amountDiffPct ||
      a.daysApart - b.daysApart ||
      a.number.localeCompare(b.number)
  );
}

/** Search window of the candidates of `subject` (dates ±days, amounts ±pct). */
export function duplicateSearchWindow(
  subject: DuplicateSubject,
  options: DuplicateOptions = {}
): { fromKey: string; toKey: string; minAmount: Prisma.Decimal; maxAmount: Prisma.Decimal } | null {
  if (!isDateKey(subject.dateKey)) return null;
  const days = options.days ?? FUZZY_DAYS;
  const pct = options.amountPct ?? FUZZY_AMOUNT_PCT;
  const amount = roundMoney(D(subject.amount));
  // |a − b| ≤ pct·max(a, b) ⇔ b ∈ [a·(1 − pct), a / (1 − pct)]
  return {
    fromKey: addDaysToKey(subject.dateKey, -days),
    toKey: addDaysToKey(subject.dateKey, days),
    minAmount: amount.times(1 - pct).toDecimalPlaces(2, Prisma.Decimal.ROUND_FLOOR),
    maxAmount: amount.dividedBy(1 - pct).toDecimalPlaces(2, Prisma.Decimal.ROUND_CEIL),
  };
}

export interface DuplicateIdentity {
  amount: Prisma.Decimal.Value;
  dateKey: string;
  supplierId?: string | null;
  supplierNameFree?: string | null;
  receiptHash?: string | null;
}

export function duplicateIdentityChanged(before: DuplicateIdentity, after: DuplicateIdentity): boolean {
  return (
    !roundMoney(D(before.amount)).equals(roundMoney(D(after.amount))) ||
    before.dateKey !== after.dateKey ||
    supplierKeyOf(before) !== supplierKeyOf(after) ||
    (before.receiptHash ?? null) !== (after.receiptHash ?? null)
  );
}

/** New duplicate state after a check. A confirmed decision survives while the identity is unchanged. */
export function evaluateDuplicateStatus(input: {
  matches: readonly DuplicateMatch[];
  previousStatus: string;
  previousDuplicateOfId?: string | null;
  identityChanged: boolean;
}): { status: DuplicateStatus; duplicateOfId: string | null } {
  if (!input.identityChanged) {
    if (input.previousStatus === 'confirmed_unique') return { status: 'confirmed_unique', duplicateOfId: null };
    if (input.previousStatus === 'confirmed_duplicate') {
      return { status: 'confirmed_duplicate', duplicateOfId: input.previousDuplicateOfId ?? null };
    }
  }
  const first = input.matches[0];
  return first ? { status: 'suspect', duplicateOfId: first.expenseId } : { status: 'none', duplicateOfId: null };
}
