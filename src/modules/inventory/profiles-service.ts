import { Prisma, type ProductInventoryProfile } from '@prisma/client';
import { z } from 'zod';
import { requireCommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { ALLOCATION_SOURCES } from '@/modules/operations/types';
import {
  DEFAULT_TOLERANCE_PCT,
  INVENTORY_AREA_KEY,
  INVENTORY_EVENTS,
  TRACKING_POLICIES,
  inventoryError,
} from './inventory-types';
import { QTY_SCALE, dec, normalizeUnit, parseConversions, type UnitProfile } from './stock-math';
import { normalizeVariantAxis, parseVariantKey } from './variant-key';

/**
 * Inventory profile of a Zoho item (`ProductInventoryProfile`): base unit,
 * unit conversions, count tolerance, variant axes, tracking policy, default
 * source and the confidence level (which only counts change).
 *
 * Profiles are created lazily the first time the item is touched by the
 * inventory (demand, count, movement): base unit from `Product.unit`
 * (normalized), 2 % tolerance, UNCOUNTED.
 */

type Db = Prisma.TransactionClient;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'inventory-profiles', event, ...extra }));

/** Base unit when the Zoho item has none. */
export const DEFAULT_BASE_UNIT = 'pz';
const MAX_CONVERSIONS = 20;
const MAX_VARIANT_AXES = 8;

/** Pure view of a profile used by the unit conversions of stock-math. */
export function toUnitProfile(
  profile: Pick<ProductInventoryProfile, 'baseUnit' | 'conversions'>
): UnitProfile {
  return {
    baseUnit: normalizeUnit(profile.baseUnit) || DEFAULT_BASE_UNIT,
    conversions: parseConversions(profile.conversions),
  };
}

/** Returns the profile of a Zoho item, creating it (UNCOUNTED) when missing. Race-safe. */
export async function getOrCreateProfile(
  db: Db,
  zohoItemId: string
): Promise<ProductInventoryProfile> {
  const id = typeof zohoItemId === 'string' ? zohoItemId.trim() : '';
  if (!id) throw new OperationsError('invalid_payload', 'Falta el artículo');
  const existing = await db.productInventoryProfile.findUnique({ where: { zohoItemId: id } });
  if (existing) return existing;

  const product = await db.product.findUnique({
    where: { zohoItemId: id },
    select: { unit: true },
  });
  const baseUnit = normalizeUnit(product?.unit) || DEFAULT_BASE_UNIT;
  const [created] = await db.productInventoryProfile.createManyAndReturn({
    data: [
      {
        zohoItemId: id,
        baseUnit,
        conversions: [],
        tolerancePct: new Prisma.Decimal(DEFAULT_TOLERANCE_PCT),
        isBulk: false,
        trackingPolicy: 'none',
        variantAxes: [],
        defaultSource: 'stock',
        confidence: 'UNCOUNTED',
      },
    ],
    skipDuplicates: true,
  });
  if (created) {
    log('profile_created', { zohoItemId: id, baseUnit, productFound: Boolean(product) });
    return created;
  }
  const winner = await db.productInventoryProfile.findUnique({ where: { zohoItemId: id } });
  if (!winner) throw new Error(`Inventory profile of ${id} conflicted but could not be read`);
  return winner;
}

export async function findProfile(
  db: Db,
  zohoItemId: string
): Promise<ProductInventoryProfile | null> {
  return db.productInventoryProfile.findUnique({ where: { zohoItemId } });
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

const factorSchema = z.union([z.number(), z.string().trim().min(1)]).transform((value, ctx) => {
  try {
    const factor = dec(value);
    if (factor.lte(0) || factor.gt(1_000_000_000)) throw new Error('out of range');
    return factor.toDecimalPlaces(6).toString();
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Factor de conversión inválido' });
    return z.NEVER;
  }
});

export const conversionInputSchema = z
  .object({
    unit: z.string().trim().min(1, 'Falta la unidad').max(30),
    factor: factorSchema,
    decimals: z.number().int().min(0).max(QTY_SCALE).optional(),
  })
  .strict();

export type ConversionInput = z.output<typeof conversionInputSchema>;

export interface StoredConversion {
  unit: string;
  factor: string;
  decimals?: number;
}

/**
 * Normalizes and validates conversions against the base unit: known unit
 * names, no duplicates, and an entry for the base unit itself (used only to
 * set its decimal places) must have factor 1.
 */
export function validateConversions(
  baseUnit: string,
  conversions: readonly ConversionInput[]
): { ok: true; conversions: StoredConversion[] } | { ok: false; message: string } {
  const base = normalizeUnit(baseUnit);
  if (!base) return { ok: false, message: 'Unidad base inválida' };
  if (conversions.length > MAX_CONVERSIONS) {
    return { ok: false, message: `Máximo ${MAX_CONVERSIONS} conversiones por artículo` };
  }
  const seen = new Set<string>();
  const out: StoredConversion[] = [];
  for (const entry of conversions) {
    const unit = normalizeUnit(entry.unit);
    if (!unit) return { ok: false, message: `Unidad inválida: "${entry.unit}"` };
    if (seen.has(unit)) return { ok: false, message: `La unidad ${unit} está repetida` };
    if (unit === base && !dec(entry.factor).equals(1)) {
      return { ok: false, message: `La unidad base ${base} sólo admite factor 1` };
    }
    seen.add(unit);
    out.push({
      unit,
      factor: entry.factor,
      ...(entry.decimals !== undefined ? { decimals: entry.decimals } : {}),
    });
  }
  return { ok: true, conversions: out };
}

/** Normalizes variant axes; returns null when one of them is invalid. */
export function normalizeVariantAxes(axes: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const raw of axes) {
    const axis = normalizeVariantAxis(raw);
    if (!axis) return null;
    if (!out.includes(axis)) out.push(axis);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Update (command profile.update)
// ---------------------------------------------------------------------------

const optionalMeasure = z.number().finite().min(0).max(1_000_000_000).nullable().optional();

export const updateProfileInputSchema = z
  .object({
    profileId: z.string().trim().min(1),
    baseUnit: z.string().trim().min(1).max(30).optional(),
    conversions: z.array(conversionInputSchema).max(MAX_CONVERSIONS).optional(),
    tolerancePct: z.number().finite().min(0).max(100).optional(),
    isBulk: z.boolean().optional(),
    trackingPolicy: z.enum(TRACKING_POLICIES).optional(),
    variantAxes: z.array(z.string().trim().min(1).max(30)).max(MAX_VARIANT_AXES).optional(),
    defaultSource: z.enum(ALLOCATION_SOURCES).optional(),
    weightKgPerBaseUnit: optionalMeasure,
    areaM2PerBaseUnit: optionalMeasure,
  })
  .strict();

export type UpdateProfileInput = z.output<typeof updateProfileInputSchema>;

/**
 * Applies a profile patch. Runs inside `profile.update`, whose engine bumps
 * the profile version (this function does not touch it). The base unit is
 * frozen once the item has movements, active reservations or legacy claims,
 * and an axis cannot be removed while stock or claims use it.
 */
export async function updateProfile(
  tx: Db,
  input: UpdateProfileInput
): Promise<ProductInventoryProfile> {
  const ctx = requireCommandContext(tx);
  const profile = await tx.productInventoryProfile.findUnique({ where: { id: input.profileId } });
  if (!profile) throw new OperationsError('not_found', 'No se encontró el perfil del artículo');

  const data: Prisma.ProductInventoryProfileUpdateInput = {};
  const fields: string[] = [];
  const currentBase = normalizeUnit(profile.baseUnit) || DEFAULT_BASE_UNIT;
  let nextBase = currentBase;

  if (input.baseUnit !== undefined) {
    nextBase = normalizeUnit(input.baseUnit);
    if (!nextBase) throw inventoryError('invalid_unit', 'Unidad base inválida');
    if (nextBase !== currentBase) {
      // Open demands (and their allocations) hold quantities computed in the current base unit.
      const [movements, reservations, claims, openDemands] = await Promise.all([
        tx.stockMovement.count({ where: { zohoItemId: profile.zohoItemId } }),
        tx.stockReservation.count({ where: { zohoItemId: profile.zohoItemId, status: 'active' } }),
        tx.legacyCommitmentClaim.count({
          where: { zohoItemId: profile.zohoItemId, status: 'claimed' },
        }),
        tx.caseDemand.count({
          where: { zohoItemId: profile.zohoItemId, status: { notIn: ['cancelled', 'fulfilled'] } },
        }),
      ]);
      if (movements + reservations + claims + openDemands > 0) {
        throw new OperationsError(
          'invalid_state',
          'No se puede cambiar la unidad base de un artículo con movimientos, reservas, reclamos o partidas de expedientes abiertos'
        );
      }
      data.baseUnit = nextBase;
      fields.push('baseUnit');
    }
  }

  if (input.conversions !== undefined || nextBase !== currentBase) {
    const source: ConversionInput[] =
      input.conversions ??
      parseConversions(profile.conversions).map((c) => ({
        unit: c.unit,
        factor: String(c.factor),
        ...(c.decimals !== undefined ? { decimals: c.decimals } : {}),
      }));
    const validation = validateConversions(nextBase, source);
    if (!validation.ok) throw inventoryError('invalid_unit', validation.message);
    data.conversions = validation.conversions as unknown as Prisma.InputJsonValue;
    fields.push('conversions');
  }

  if (input.tolerancePct !== undefined && !dec(profile.tolerancePct).equals(input.tolerancePct)) {
    data.tolerancePct = new Prisma.Decimal(input.tolerancePct);
    fields.push('tolerancePct');
  }
  if (input.isBulk !== undefined && input.isBulk !== profile.isBulk) {
    data.isBulk = input.isBulk;
    fields.push('isBulk');
  }
  if (input.trackingPolicy !== undefined && input.trackingPolicy !== profile.trackingPolicy) {
    data.trackingPolicy = input.trackingPolicy;
    fields.push('trackingPolicy');
  }
  if (input.variantAxes !== undefined) {
    const axes = normalizeVariantAxes(input.variantAxes);
    if (!axes) throw inventoryError('invalid_variant', 'Hay un eje de variante inválido');
    const removed = profile.variantAxes.filter((axis) => !axes.includes(axis));
    if (removed.length > 0) {
      const [items, claims] = await Promise.all([
        tx.stockItem.findMany({
          where: { zohoItemId: profile.zohoItemId, variantKey: { not: '' } },
          select: { variantKey: true },
          distinct: ['variantKey'],
          take: 500,
        }),
        tx.legacyCommitmentClaim.findMany({
          where: { zohoItemId: profile.zohoItemId, status: 'claimed', variantKey: { not: '' } },
          select: { variantKey: true },
          distinct: ['variantKey'],
          take: 500,
        }),
      ]);
      const used = new Set<string>();
      for (const row of [...items, ...claims]) {
        try {
          for (const axis of Object.keys(parseVariantKey(row.variantKey))) used.add(axis);
        } catch {
          // Non-canonical legacy keys do not block the change.
        }
      }
      const blocking = removed.filter((axis) => used.has(axis));
      if (blocking.length > 0) {
        throw new OperationsError(
          'invalid_state',
          `Hay existencias o reclamos que usan el eje ${blocking.join(', ')}`
        );
      }
    }
    if (axes.join('|') !== profile.variantAxes.join('|')) {
      data.variantAxes = axes;
      fields.push('variantAxes');
    }
  }
  if (input.defaultSource !== undefined && input.defaultSource !== profile.defaultSource) {
    data.defaultSource = input.defaultSource;
    fields.push('defaultSource');
  }
  if (input.weightKgPerBaseUnit !== undefined) {
    data.weightKgPerBaseUnit =
      input.weightKgPerBaseUnit === null ? null : new Prisma.Decimal(input.weightKgPerBaseUnit);
    fields.push('weightKgPerBaseUnit');
  }
  if (input.areaM2PerBaseUnit !== undefined) {
    data.areaM2PerBaseUnit =
      input.areaM2PerBaseUnit === null ? null : new Prisma.Decimal(input.areaM2PerBaseUnit);
    fields.push('areaM2PerBaseUnit');
  }

  if (fields.length === 0) return profile;
  const updated = await tx.productInventoryProfile.update({ where: { id: profile.id }, data });
  ctx.emit(
    INVENTORY_EVENTS.profileUpdated,
    { profileId: updated.id, zohoItemId: updated.zohoItemId, fields },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'inventory_profile', objectId: updated.id }
  );
  return updated;
}
