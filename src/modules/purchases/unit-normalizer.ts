import { normalizeUnit } from '@/modules/inventory/stock-math';

/**
 * Unit normalization of supplier quotes (plan 6.1, `unit-normalizer.ts`).
 *
 * Suppliers quote in their own words ("caja", "M²", "tonelada", "1,250.00"):
 * this module turns those into canonical units and factors so a quote can be
 * compared with what the RFQ asked for and received into the inventory.
 *
 * - Canonical names reuse `normalizeUnit` of the inventory (pz, m2, m, kg, l,
 *   caja, rollo…) plus the extra units suppliers use (cm, mm, km, lb, ft,
 *   pulgada, docena, millar…). "ml" stays ambiguous on purpose: in Mexican
 *   hardware it usually means "metro lineal", not millilitre, so it is never
 *   converted without an explicit conversion of the item profile.
 * - Standard factors only inside a physical family (length, area, volume,
 *   mass, count); anything else needs the item profile conversions
 *   (`{unit, factor}` = base units per unit, as in `ProductInventoryProfile`).
 * - `parseLocaleNumber` reads amounts written by people or models
 *   ("$1,250.50", "1.250,50", "1 250").
 *
 * Pure module.
 */

export type UnitFamily = 'length' | 'area' | 'volume' | 'mass' | 'count';

const EXTRA_SYNONYMS: Record<string, string> = {};

function synonyms(canonical: string, list: string[]): void {
  for (const name of [canonical, ...list]) EXTRA_SYNONYMS[name] = canonical;
}

synonyms('cm', ['cms', 'centimetro', 'centimetros']);
synonyms('mm', ['mms', 'milimetro', 'milimetros']);
synonyms('km', ['kms', 'kilometro', 'kilometros']);
synonyms('ft', ['pie', 'pies', 'feet', 'foot']);
synonyms('in', ['pulg', 'pulgada', 'pulgadas', 'inch', 'inches']);
synonyms('cm2', ['cm^2', 'centimetro2', 'centimetroscuadrados', 'centimetrocuadrado']);
synonyms('ft2', ['pie2', 'pies2', 'sqft', 'piecuadrado', 'piescuadrados']);
synonyms('mililitro', ['mililitros']);
synonyms('lb', ['lbs', 'libra', 'libras']);
synonyms('docena', ['docenas', 'doc', 'dz']);
synonyms('millar', ['millares', 'mil']);
synonyms('ciento', ['cientos']);
synonyms('m', ['metrolineal', 'metroslineales', 'mlineal']);

/** Base factor of each unit inside its family (family base: m, m2, m3, kg, pz). */
const FAMILY_FACTORS: Record<UnitFamily, Record<string, number>> = {
  length: { m: 1, cm: 0.01, mm: 0.001, km: 1000, ft: 0.3048, in: 0.0254 },
  area: { m2: 1, cm2: 0.0001, ft2: 0.09290304 },
  volume: { m3: 1, l: 0.001, mililitro: 0.000001, galon: 0.003785411784 },
  mass: { kg: 1, g: 0.001, ton: 1000, lb: 0.45359237 },
  count: { pz: 1, par: 2, docena: 12, ciento: 100, millar: 1000 },
};

function clean(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .toLowerCase()
    .replace(/[^a-z0-9^]/g, '')
    .slice(0, 30);
}

/** `'Metros cuadrados'` → `'m2'`, `'Centímetros'` → `'cm'`, `'PZA.'` → `'pz'`; unknown units keep their cleaned form. */
export function canonicalUnit(raw: string | null | undefined): string {
  const cleaned = clean(raw ?? '');
  if (!cleaned) return '';
  return EXTRA_SYNONYMS[cleaned] ?? normalizeUnit(cleaned);
}

export function unitFamily(unit: string | null | undefined): UnitFamily | null {
  const canonical = canonicalUnit(unit);
  if (!canonical) return null;
  for (const [family, factors] of Object.entries(FAMILY_FACTORS) as [UnitFamily, Record<string, number>][]) {
    if (canonical in factors) return family;
  }
  return null;
}

/** How many `to` units fit in one `from` unit using the physical tables; null across families or unknown units. */
export function standardFactor(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = canonicalUnit(from);
  const b = canonicalUnit(to);
  if (!a || !b) return null;
  if (a === b) return 1;
  const family = unitFamily(a);
  if (!family || unitFamily(b) !== family) return null;
  return FAMILY_FACTORS[family][a] / FAMILY_FACTORS[family][b];
}

export interface UnitConversionLike {
  unit: string;
  /** Base units per one `unit`. */
  factor: number | string | { toString(): string };
}

export interface UnitProfileLike {
  baseUnit: string;
  conversions?: readonly UnitConversionLike[] | null;
}

function positive(value: unknown): number | null {
  const parsed = Number(typeof value === 'object' && value !== null ? String(value) : value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Base units (of `profile.baseUnit`) per one `unit`, or null when unknown. */
export function baseUnitsPer(unit: string | null | undefined, profile: UnitProfileLike): number | null {
  const target = canonicalUnit(unit);
  const base = canonicalUnit(profile.baseUnit);
  if (!target || !base) return null;
  if (target === base) return 1;
  const explicit = (profile.conversions ?? []).find((entry) => canonicalUnit(entry.unit) === target);
  if (explicit) return positive(explicit.factor);
  return standardFactor(target, base);
}

/**
 * Multiplier `m` such that `quantityInTo = quantityInFrom × m`. Uses the item
 * profile when given (explicit conversions first, then the physical tables
 * through the base unit) and the physical tables otherwise. Two empty units are
 * the same unit; one empty unit is unknown.
 */
export function resolveUnitFactor(
  from: string | null | undefined,
  to: string | null | undefined,
  profile?: UnitProfileLike | null
): number | null {
  const a = canonicalUnit(from);
  const b = canonicalUnit(to);
  if (!a && !b) return 1;
  if (!a || !b) return null;
  if (a === b) return 1;
  if (profile) {
    const fa = baseUnitsPer(a, profile);
    const fb = baseUnitsPer(b, profile);
    if (fa !== null && fb !== null) return fa / fb;
  }
  return standardFactor(a, b);
}

/** `quantity` expressed in `to`, rounded to 6 decimals; null when the units cannot be converted. */
export function convertQuantity(
  quantity: number,
  from: string | null | undefined,
  to: string | null | undefined,
  profile?: UnitProfileLike | null
): number | null {
  if (!Number.isFinite(quantity)) return null;
  const factor = resolveUnitFactor(from, to, profile);
  if (factor === null) return null;
  return Math.round(quantity * factor * 1e6) / 1e6;
}

/** True when both texts name the same unit ("M²" and "metros cuadrados"). */
export function sameCanonicalUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = canonicalUnit(a);
  return left !== '' && left === canonicalUnit(b);
}

/**
 * Reads a number written by a person or a model. Mexican convention first
 * (comma thousands, dot decimals), European when both separators appear in
 * the other order. Currency symbols, codes and spaces are ignored. Null when
 * there is no number.
 */
export function parseLocaleNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const negative = /^\s*-|\(\s*[\d$]/.test(value);
  let text = value.replace(/[^\d.,]/g, '');
  if (!/\d/.test(text)) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    text = text.split(thousands).join('');
    if (decimal === ',') text = text.replace(',', '.');
  } else if (lastComma >= 0) {
    const parts = text.split(',');
    const tail = parts[parts.length - 1];
    text = parts.length > 2 || tail.length === 3 ? parts.join('') : `${parts.slice(0, -1).join('')}.${tail}`;
  } else if (lastDot >= 0) {
    const parts = text.split('.');
    if (parts.length > 2) text = parts.join('');
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}
