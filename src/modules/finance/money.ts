import { Prisma } from '@prisma/client';
import { z } from 'zod';

/**
 * Money helpers of the finance module. Pure (Prisma.Decimal is decimal.js,
 * no database access).
 *
 * Amounts are stored as Decimal(18,4) but every posted amount is rounded to
 * cents (half-up), so `Σdebit = Σcredit` is an exact comparison and the
 * rounding residue of splits is placed deterministically (largest remainder).
 */

export type Money = Prisma.Decimal;

export const ZERO: Money = new Prisma.Decimal(0);
/** Half a cent: two amounts closer than this are the same money. */
export const MONEY_TOLERANCE: Money = new Prisma.Decimal('0.005');
const MAX_ABS = new Prisma.Decimal('100000000000000'); // 1e14 < Decimal(18,4)

export function D(value: Prisma.Decimal.Value | null | undefined): Money {
  if (value === null || value === undefined || value === '') return new Prisma.Decimal(0);
  return new Prisma.Decimal(value);
}

/** Parses a number, numeric string or Decimal; null when not a finite amount. */
export function parseMoney(value: unknown): Money | null {
  if (value === null || value === undefined) return null;
  try {
    if (Prisma.Decimal.isDecimal(value)) {
      const d = new Prisma.Decimal(value as Prisma.Decimal);
      return d.isFinite() ? d : null;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? new Prisma.Decimal(value) : null;
    }
    if (typeof value === 'string') {
      const text = value.trim().replace(/[$,\s]/g, '');
      if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
      return new Prisma.Decimal(text);
    }
  } catch {
    return null;
  }
  return null;
}

export function roundMoney(value: Prisma.Decimal.Value): Money {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function sumMoney(values: Iterable<Prisma.Decimal.Value | null | undefined>): Money {
  let total = new Prisma.Decimal(0);
  for (const value of values) total = total.plus(D(value));
  return total;
}

export function moneyEquals(
  a: Prisma.Decimal.Value,
  b: Prisma.Decimal.Value,
  tolerance: Prisma.Decimal.Value = MONEY_TOLERANCE
): boolean {
  return new Prisma.Decimal(a).minus(b).abs().lessThanOrEqualTo(tolerance);
}

export function maxMoney(a: Prisma.Decimal.Value, b: Prisma.Decimal.Value): Money {
  const x = new Prisma.Decimal(a);
  const y = new Prisma.Decimal(b);
  return x.greaterThanOrEqualTo(y) ? x : y;
}

export function minMoney(a: Prisma.Decimal.Value, b: Prisma.Decimal.Value): Money {
  const x = new Prisma.Decimal(a);
  const y = new Prisma.Decimal(b);
  return x.lessThanOrEqualTo(y) ? x : y;
}

/** '1234.50' (always 2 decimals, dot separator): the JSON form of money in DTOs. */
export function moneyString(value: Prisma.Decimal.Value | null | undefined): string {
  return roundMoney(D(value)).toFixed(2);
}

export function formatMxn(value: Prisma.Decimal.Value, currency = 'MXN'): string {
  const amount = roundMoney(D(value)).toNumber();
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * Splits `total` (rounded to cents) proportionally to `weights` so the parts
 * add up exactly; the residue goes to the parts with the largest remainders
 * (ties: earlier index). Zero or empty weights split evenly.
 */
export function allocateMoney(total: Prisma.Decimal.Value, weights: Prisma.Decimal.Value[]): Money[] {
  const count = weights.length;
  if (count === 0) return [];
  const cents = roundMoney(total).times(100);
  const w = weights.map((value) => D(value).abs());
  const weightSum = sumMoney(w);
  const normalized = weightSum.isZero() ? w.map(() => new Prisma.Decimal(1)) : w;
  const normalizedSum = weightSum.isZero() ? new Prisma.Decimal(count) : weightSum;
  const raw = normalized.map((weight) => cents.times(weight).dividedBy(normalizedSum));
  const floors = raw.map((value) => value.toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR));
  let residue = cents.minus(sumMoney(floors)).toNumber();
  const order = raw
    .map((value, index) => ({ index, remainder: value.minus(floors[index]) }))
    .sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index);
  const result = [...floors];
  for (let i = 0; residue > 0 && order.length > 0; i = (i + 1) % order.length) {
    result[order[i].index] = result[order[i].index].plus(1);
    residue -= 1;
  }
  return result.map((value) => value.dividedBy(100));
}

const amountText = z
  .union([z.number(), z.string(), z.instanceof(Prisma.Decimal)])
  .transform((value, issue) => {
    const parsed = parseMoney(value);
    if (!parsed || parsed.abs().greaterThanOrEqualTo(MAX_ABS)) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: 'Monto inválido' });
      return z.NEVER;
    }
    return roundMoney(parsed);
  });

// After an invalid amount zod still runs the refinement with z.NEVER: guard the type.
const isDecimal = (value: unknown): value is Prisma.Decimal => Prisma.Decimal.isDecimal(value);

/** Amount > 0, rounded to cents. */
export const positiveMoneySchema = amountText.refine((d) => !isDecimal(d) || d.greaterThan(0), {
  message: 'El monto debe ser mayor que cero',
});

/** Amount ≥ 0, rounded to cents. */
export const nonNegativeMoneySchema = amountText.refine((d) => !isDecimal(d) || !d.isNegative(), {
  message: 'El monto no puede ser negativo',
});

export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Moneda inválida (ISO 4217)');
