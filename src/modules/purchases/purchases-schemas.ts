import { z } from 'zod';

/**
 * Zod building blocks shared by the purchases commands (Spanish messages).
 * Pure module.
 */

export const idText = z.string().trim().min(1).max(120);

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

export const requiredText = (max: number, message = 'Campo requerido') => z.string().trim().min(1, message).max(max);

const DECIMAL_PATTERN = /^-?\d{1,14}(\.\d{1,6})?$/;

/** Number or numeric string (Decimal.toString()) → number. */
const numeric = z.union([z.number(), z.string().trim().regex(DECIMAL_PATTERN, 'Número inválido')]).transform(Number);

export const positiveQty = numeric.pipe(z.number().finite().positive('La cantidad debe ser mayor que cero').max(1e12));
export const nonNegativeQty = numeric.pipe(z.number().finite().min(0, 'La cantidad no puede ser negativa').max(1e12));
export const moneyAmount = numeric.pipe(z.number().finite().min(0, 'El importe no puede ser negativo').max(1e13));
export const rateFraction = numeric.pipe(z.number().finite().min(0).max(1, 'La tasa va de 0 a 1 (0.16 = 16 %)'));

export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Moneda inválida (ISO 4217)');

export const isoDateText = z
  .string()
  .trim()
  .refine((value) => /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value)), {
    message: 'Fecha inválida (usa formato AAAA-MM-DD)',
  });

export function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value.length === 10 ? `${value}T12:00:00.000Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'URL inválida (debe iniciar con https://)');
