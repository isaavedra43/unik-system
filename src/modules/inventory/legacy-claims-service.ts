import { Prisma, type LegacyCommitmentClaim } from '@prisma/client';
import { requireCommandContext, type CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { getOperationsConfig } from '@/modules/operations/operations-config';
import { qty } from './inventory-dto';
import { lockStockItemsForProduct } from './inventory-locks';
import {
  assertReservationCapacity,
  loadGroupAvailability,
  reserveStock,
  type ReserveStockResult,
} from './inventory-service';
import {
  INVENTORY_AREA_KEY,
  INVENTORY_EVENTS,
  LEGACY_CLAIM_SOURCES,
  inventoryError,
  toConfidenceLevel,
  type ConfidenceLevel,
  type LegacyClaimSource,
} from './inventory-types';
import { getOrCreateProfile, toUnitProfile } from './profiles-service';
import { StockMathError, roundQty, toBase, type DecimalLike } from './stock-math';
import { validateVariant, type VariantInput } from './variant-key';

/**
 * Commitments made before the cutover (plan §3.3 "Reclamos legados").
 *
 * Stock promised to a customer before UNIK controlled the warehouse (an order
 * older than `cutoverDate`, a verbal agreement) is recorded as a
 * `LegacyCommitmentClaim`: while `claimed` it is subtracted from the available
 * stock of its item/warehouse/variant. It ends as:
 * - `confirmed`: tied to a case demand, it becomes a regular reservation in
 *   the same transaction (available does not move);
 * - `released`: the commitment no longer exists;
 * - `expired`: the TTL (`legacyClaimTtlDays`) passed; the supervisor calls
 *   `expireDueLegacyClaims` (inventory-commands.ts).
 *
 * Quantities are stored in the item's base unit (`unit` = base unit); the
 * captured quantity and unit travel in the `stock.legacy_claimed` event.
 */

type Db = Prisma.TransactionClient;

/** Unit conversion errors as the stable `invalid_unit` rejection. */
function guardUnits<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof StockMathError) throw inventoryError('invalid_unit', err.message);
    throw err;
  }
}
type Decimal = Prisma.Decimal;

const MAX_TTL_DAYS = 365;
const DAY_MS = 86_400_000;

function requireId(value: string | null | undefined, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new OperationsError('invalid_payload', `Falta ${field}`);
  return text;
}

export interface ClaimLegacyInput {
  zohoItemId: string;
  warehouseId: string;
  variantKey?: string | null;
  variant?: VariantInput | null;
  quantity: DecimalLike;
  unit?: string | null;
  source: LegacyClaimSource;
  /** Order number, customer, agreement… */
  reference?: string | null;
  /** Default: now + `legacyClaimTtlDays`. */
  expiresAt?: Date | null;
  note?: string | null;
}

export interface ClaimLegacyResult {
  claim: LegacyCommitmentClaim;
  confidence: ConfidenceLevel;
  availableBefore: Decimal;
  availableAfter: Decimal;
  /** The claim leaves the group below zero (with CONTROLLED stock an incident is opened). */
  exceedsAvailable: boolean;
  incidentId: string | null;
}

export async function claimLegacyCommitment(
  tx: Db,
  input: ClaimLegacyInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<ClaimLegacyResult> {
  const zohoItemId = requireId(input.zohoItemId, 'el artículo');
  const warehouseId = requireId(input.warehouseId, 'la bodega');
  if (!(LEGACY_CLAIM_SOURCES as readonly string[]).includes(input.source)) {
    throw new OperationsError('invalid_payload', 'Origen del compromiso inválido');
  }
  const warehouse = await tx.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw new OperationsError('not_found', 'No se encontró la bodega');
  if (!warehouse.active)
    throw new OperationsError('invalid_state', `La bodega ${warehouse.name} está desactivada`);

  const profile = await getOrCreateProfile(tx, zohoItemId);
  const units = toUnitProfile(profile);
  let quantity: Decimal;
  try {
    quantity = toBase(input.quantity, input.unit || units.baseUnit, units);
  } catch (err) {
    if (err instanceof StockMathError) throw inventoryError(err.code, err.message);
    throw err;
  }
  if (quantity.lte(0))
    throw inventoryError('invalid_quantity', 'La cantidad debe ser mayor que cero');
  const variant = validateVariant(input.variant ?? input.variantKey ?? '', profile.variantAxes);
  if (!variant.ok) throw inventoryError('invalid_variant', variant.message);

  const config = await getOperationsConfig();
  const expiresAt =
    input.expiresAt ?? new Date(ctx.now.getTime() + config.legacyClaimTtlDays * DAY_MS);
  if (
    expiresAt.getTime() <= ctx.now.getTime() ||
    expiresAt.getTime() > ctx.now.getTime() + MAX_TTL_DAYS * DAY_MS
  ) {
    throw new OperationsError(
      'invalid_payload',
      `El vencimiento debe estar entre hoy y ${MAX_TTL_DAYS} días`
    );
  }

  await lockStockItemsForProduct(tx, { zohoItemId, warehouseId, variantKey: variant.variantKey });
  const group = await loadGroupAvailability(tx, {
    zohoItemId,
    warehouseId,
    variantKey: variant.variantKey,
  });
  const claim = await tx.legacyCommitmentClaim.create({
    data: {
      zohoItemId,
      warehouseId,
      variantKey: variant.variantKey,
      quantity,
      unit: units.baseUnit,
      source: input.source,
      reference: input.reference?.trim().slice(0, 200) || null,
      status: 'claimed',
      claimedBy: ctx.actor.id,
      expiresAt,
    },
  });
  const confidence = toConfidenceLevel(profile.confidence);
  const availableAfter = roundQty(group.available.minus(quantity));
  const exceedsAvailable = availableAfter.lt(0);
  let incidentId: string | null = null;
  if (exceedsAvailable && confidence === 'CONTROLLED') {
    const product = await tx.product.findUnique({
      where: { zohoItemId },
      select: { name: true, sku: true },
    });
    const { incident } = await ctx.openIncident({
      kind: 'stock_conflict',
      areaKey: INVENTORY_AREA_KEY,
      title: `Compromiso previo sin existencia suficiente: ${product?.name ?? product?.sku ?? zohoItemId}`,
      dedupeKey: `inventory:legacy_claim:${claim.id}`,
      severity: 'medium',
      detail: {
        claimId: claim.id,
        zohoItemId,
        warehouseId,
        variantKey: variant.variantKey,
        quantity: qty(quantity),
        availableBefore: qty(group.available),
        availableAfter: qty(availableAfter),
      },
    });
    incidentId = incident.id;
  }
  ctx.emit(
    INVENTORY_EVENTS.legacyClaimed,
    {
      claimId: claim.id,
      zohoItemId,
      warehouseId,
      variantKey: variant.variantKey,
      quantity: qty(quantity),
      unit: units.baseUnit,
      capturedQuantity: String(input.quantity),
      capturedUnit: input.unit || units.baseUnit,
      source: input.source,
      reference: claim.reference,
      expiresAt: expiresAt.toISOString(),
      availableBefore: qty(group.available),
      availableAfter: qty(availableAfter),
      confidence,
      note: input.note?.trim().slice(0, 500) || null,
    },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'legacy_claim', objectId: claim.id }
  );
  return {
    claim,
    confidence,
    availableBefore: group.available,
    availableAfter,
    exceedsAvailable,
    incidentId,
  };
}

export interface ConfirmLegacyClaimInput {
  claimId: string;
  caseId: string;
  demandId: string;
  allocationId?: string | null;
  /** Reserve from this row only. */
  stockItemId?: string | null;
  /** Explicit human decision when the stock is PROVISIONAL. */
  allowProvisional?: boolean;
}

/** Ties a claim to a case demand and turns it into a reservation (same transaction). */
export async function confirmLegacyClaim(
  tx: Db,
  input: ConfirmLegacyClaimInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<{ claim: LegacyCommitmentClaim; reservation: ReserveStockResult }> {
  const claimId = requireId(input.claimId, 'el reclamo');
  const caseId = requireId(input.caseId, 'el expediente');
  const claim = await tx.legacyCommitmentClaim.findUnique({ where: { id: claimId } });
  if (!claim) throw new OperationsError('not_found', 'No se encontró el reclamo');
  if (claim.status !== 'claimed')
    throw new OperationsError('invalid_state', 'El reclamo ya fue resuelto');
  if (claim.expiresAt.getTime() <= ctx.now.getTime()) {
    throw inventoryError(
      'legacy_claim_expired',
      'El reclamo venció; regístralo de nuevo si sigue vigente'
    );
  }

  // Same lock as reservations and claims: the claim stops counting and the
  // reservation starts counting in one serialized decision.
  await lockStockItemsForProduct(tx, {
    zohoItemId: claim.zohoItemId,
    warehouseId: claim.warehouseId,
    variantKey: claim.variantKey,
  });
  // A demand is never promised twice: the claim may only fund what the active
  // reservations of the demand do not cover yet (e.g. the case engine already
  // reserved free stock for it). Same rule as every reservation, checked under
  // the same lock before the claim stops counting.
  const demand = await tx.caseDemand.findUnique({
    where: { id: requireId(input.demandId, 'la necesidad') },
    select: { id: true, caseId: true, baseQuantity: true, baseUnit: true, fulfilledQuantity: true },
  });
  if (demand && demand.caseId === caseId) {
    const units = toUnitProfile(await getOrCreateProfile(tx, claim.zohoItemId));
    const claimBase = guardUnits(() => toBase(claim.quantity, claim.unit || units.baseUnit, units));
    await assertReservationCapacity(tx, {
      demand,
      allocationId: input.allocationId ?? null,
      quantity: claimBase,
      units,
    });
  }
  const updated = await tx.legacyCommitmentClaim.updateMany({
    where: { id: claim.id, status: 'claimed' },
    data: { status: 'confirmed', caseId, resolvedAt: ctx.now, version: { increment: 1 } },
  });
  if (updated.count !== 1) throw new OperationsError('invalid_state', 'El reclamo ya fue resuelto');

  const reservation = await reserveStock(
    tx,
    {
      caseId,
      demandId: input.demandId,
      allocationId: input.allocationId ?? null,
      zohoItemId: claim.zohoItemId,
      warehouseId: claim.warehouseId,
      variantKey: claim.variantKey,
      quantity: claim.quantity,
      unit: claim.unit,
      stockItemId: input.stockItemId ?? null,
      allowProvisional: input.allowProvisional === true,
      note: `Compromiso previo ${claim.reference ?? claim.id}`,
    },
    ctx
  );
  await ctx.relate(
    { type: 'legacy_claim', id: claim.id },
    { type: 'stock_reservation', id: reservation.primaryReservationId },
    'converted_to'
  );
  await ctx.relate(
    { type: 'legacy_claim', id: claim.id },
    { type: 'operational_case', id: caseId },
    'claimed_for'
  );
  const fresh = (await tx.legacyCommitmentClaim.findUnique({ where: { id: claim.id } })) ?? claim;
  ctx.emit(
    INVENTORY_EVENTS.legacyConfirmed,
    {
      claimId: claim.id,
      demandId: input.demandId,
      reservationIds: reservation.reservations.map((r) => r.id),
      quantity: qty(claim.quantity),
      unit: claim.unit,
      provisional: reservation.provisional,
    },
    { caseId, areaKey: INVENTORY_AREA_KEY, objectType: 'legacy_claim', objectId: claim.id }
  );
  return { claim: fresh, reservation };
}

async function closeClaim(
  tx: Db,
  claimId: string,
  status: 'released' | 'expired',
  ctx: CommandContext,
  reason: string | null
): Promise<LegacyCommitmentClaim> {
  const claim = await tx.legacyCommitmentClaim.findUnique({ where: { id: claimId } });
  if (!claim) throw new OperationsError('not_found', 'No se encontró el reclamo');
  if (claim.status !== 'claimed')
    throw new OperationsError('invalid_state', 'El reclamo ya fue resuelto');
  if (status === 'expired' && claim.expiresAt.getTime() > ctx.now.getTime()) {
    throw new OperationsError('invalid_state', 'El reclamo aún no vence');
  }
  const updated = await tx.legacyCommitmentClaim.updateMany({
    where: { id: claim.id, status: 'claimed' },
    data: { status, resolvedAt: ctx.now, version: { increment: 1 } },
  });
  if (updated.count !== 1) throw new OperationsError('invalid_state', 'El reclamo ya fue resuelto');
  ctx.emit(
    status === 'released' ? INVENTORY_EVENTS.legacyReleased : INVENTORY_EVENTS.legacyExpired,
    {
      claimId: claim.id,
      zohoItemId: claim.zohoItemId,
      warehouseId: claim.warehouseId,
      variantKey: claim.variantKey,
      quantity: qty(claim.quantity),
      unit: claim.unit,
      reason,
    },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'legacy_claim', objectId: claim.id }
  );
  return (await tx.legacyCommitmentClaim.findUnique({ where: { id: claim.id } })) ?? claim;
}

/** The commitment no longer exists: its quantity is available again. */
export function releaseLegacyClaim(
  tx: Db,
  input: { claimId: string; reason?: string | null },
  ctx: CommandContext = requireCommandContext(tx)
): Promise<LegacyCommitmentClaim> {
  return closeClaim(
    tx,
    requireId(input.claimId, 'el reclamo'),
    'released',
    ctx,
    input.reason?.trim().slice(0, 500) || null
  );
}

/** Expires a claim whose TTL passed (supervisor). */
export function expireLegacyClaim(
  tx: Db,
  input: { claimId: string },
  ctx: CommandContext = requireCommandContext(tx)
): Promise<LegacyCommitmentClaim> {
  return closeClaim(tx, requireId(input.claimId, 'el reclamo'), 'expired', ctx, 'ttl');
}

/** Ids of claims past their TTL, oldest first. */
export async function listDueLegacyClaimIds(db: Db, now: Date, limit = 200): Promise<string[]> {
  const rows = await db.legacyCommitmentClaim.findMany({
    where: { status: 'claimed', expiresAt: { lte: now } },
    orderBy: { expiresAt: 'asc' },
    take: Math.min(Math.max(limit, 1), 500),
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
