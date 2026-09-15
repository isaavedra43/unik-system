import {
  Prisma,
  type CaseDemand,
  type DemandAllocation,
  type ProductInventoryProfile,
  type StockItem,
  type StockMovement,
  type StockReservation,
  type StorageLocation,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hasPermission } from '@/modules/auth/authorization';
import { requireCommandContext, type CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { toOperationalJson } from '@/modules/operations/events-service';
import { getOperationsConfig } from '@/modules/operations/operations-config';
import { qty, toStockItemDTO, type StockItemDTO } from './inventory-dto';
import { lockStockItem, lockStockItems, lockStockItemsForProduct } from './inventory-locks';
import {
  CONFIDENCE_LABELS,
  INVENTORY_AREA_KEY,
  INVENTORY_EVENTS,
  MOVEMENT_EVENT,
  SCRAP_LOCATION_CODE,
  inventoryError,
  isInboundKind,
  isMovementKind,
  isOutboundKind,
  isSignedKind,
  toConfidenceLevel,
  type ConfidenceLevel,
  type MovementKind,
} from './inventory-types';
import { containerPolicyFor, nextContainerKey, normalizeContainerKey } from './labels-service';
import { getOrCreateProfile, toUnitProfile, DEFAULT_BASE_UNIT } from './profiles-service';
import {
  StockMathError,
  applyMovement,
  canPromise,
  computeAvailable,
  dec,
  evaluateReservation,
  itemAvailable,
  normalizeUnit,
  planReservationSplit,
  roundQty,
  sumDecimals,
  toBase,
  toStockState,
  type DecimalLike,
  type StockState,
} from './stock-math';
import { VariantKeyError, validateVariant, type VariantInput } from './variant-key';
import {
  ensureGeneralLocation,
  ensureScrapLocation,
  normalizeLocationCode,
} from './warehouses-service';

/**
 * Stock movements, availability and reservations of the progressive inventory
 * (plan §3.3 and the produce/consume/leftover part of §6.2).
 *
 * Every mutating function takes the command transaction (`tx`) and runs inside
 * an operations command (`requireCommandContext`): events, incidents and
 * relations go through the command context, and the command ledger makes
 * retries idempotent. Other modules (purchases receipts, manufacturing,
 * logistics, the case engine) call these functions from their own commands.
 *
 * Concurrency: decisions that depend on counters are taken after
 * `SELECT … FOR UPDATE` (`inventory-locks.ts`). Reservations and unreserved
 * outbound movements of CONTROLLED stock lock the whole product group
 * (warehouse + variant), so legacy claims are part of the same decision.
 *
 * Invariants:
 * - CONTROLLED stock never goes below zero automatically (`insufficient_stock`).
 * - PROVISIONAL stock is only reserved with an explicit human decision and a
 *   verification within `provisionalVerificationMaxHours`.
 * - Stock in the SCRAP location is always blocked (never available).
 * - `Product.stockOnHand/availableStock` from Zoho are informational only.
 */

type Db = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'inventory-service', event, ...extra }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function translateMathError(err: unknown): never {
  if (err instanceof StockMathError) throw inventoryError(err.code, err.message);
  if (err instanceof VariantKeyError) throw inventoryError('invalid_variant', err.message);
  throw err;
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    return translateMathError(err);
  }
}

function requireId(value: string | null | undefined, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new OperationsError('invalid_payload', `Falta ${field}`);
  return text;
}

/** System and Zoho actors are trusted; humans and bots need the permission. */
export function actorMay(ctx: CommandContext, permission: string): boolean {
  if (ctx.actor.type === 'system' || ctx.actor.type === 'zoho') return true;
  return Boolean(ctx.user && hasPermission(ctx.user, permission));
}

function note(value: string | null | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 500) : null;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface StockItemKey {
  zohoItemId: string;
  warehouseId: string;
  locationId: string;
  variantKey: string;
  containerKey: string;
}

/** Returns the stock row of a key, creating it with zero counters (INSERT … ON CONFLICT DO NOTHING). */
export async function ensureStockItem(
  tx: Db,
  key: StockItemKey,
  extra: {
    variantJson?: Record<string, string> | null;
    originProductionOrderId?: string | null;
    dimensions?: Record<string, unknown> | null;
  } = {}
): Promise<StockItem> {
  await tx.stockItem.createMany({
    data: [
      {
        ...key,
        ...(extra.variantJson ? { variantJson: extra.variantJson } : {}),
        ...(extra.originProductionOrderId
          ? { originProductionOrderId: extra.originProductionOrderId }
          : {}),
        ...(extra.dimensions ? { dimensions: toOperationalJson(extra.dimensions) } : {}),
      },
    ],
    skipDuplicates: true,
  });
  const item = await tx.stockItem.findUnique({
    where: { zohoItemId_warehouseId_locationId_variantKey_containerKey: key },
  });
  if (!item) throw new Error('Stock item could not be read after insert');
  return item;
}

/** Locks a stock row and reads it after the lock. */
async function lockAndLoad(tx: Db, stockItemId: string): Promise<StockItem> {
  const exists = await lockStockItem(tx, stockItemId);
  const item = exists ? await tx.stockItem.findUnique({ where: { id: stockItemId } }) : null;
  if (!item) throw new OperationsError('not_found', 'No se encontró la existencia');
  return item;
}

async function writeState(
  tx: Db,
  stockItemId: string,
  next: StockState,
  extra: Prisma.StockItemUpdateInput = {}
): Promise<StockItem> {
  return tx.stockItem.update({
    where: { id: stockItemId },
    data: {
      baseline: next.baseline,
      receipts: next.receipts,
      returns: next.returns,
      produced: next.produced,
      issued: next.issued,
      consumed: next.consumed,
      adjustments: next.adjustments,
      reserved: next.reserved,
      blocked: next.blocked,
      assignedToProduction: next.assignedToProduction,
      knownQty: next.knownQty,
      version: { increment: 1 },
      ...extra,
    },
  });
}

/** Resolves the target location of a warehouse: explicit id, code (GENERAL/SCRAP are created on demand) or GENERAL. */
export async function resolveLocation(
  tx: Db,
  warehouseId: string,
  locationId?: string | null,
  locationCode?: string | null
): Promise<StorageLocation> {
  const warehouse = await tx.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw new OperationsError('not_found', 'No se encontró la bodega');
  if (!warehouse.active)
    throw new OperationsError('invalid_state', `La bodega ${warehouse.name} está desactivada`);
  let location: StorageLocation | null;
  if (locationId) {
    location = await tx.storageLocation.findUnique({ where: { id: locationId } });
    if (!location || location.warehouseId !== warehouseId) {
      throw new OperationsError('not_found', 'La ubicación no pertenece a la bodega');
    }
  } else if (locationCode) {
    const code = normalizeLocationCode(locationCode);
    if (code === 'GENERAL') location = await ensureGeneralLocation(tx, warehouseId);
    else if (code === SCRAP_LOCATION_CODE) location = await ensureScrapLocation(tx, warehouseId);
    else {
      location = await tx.storageLocation.findUnique({
        where: { warehouseId_code: { warehouseId, code } },
      });
      if (!location)
        throw new OperationsError(
          'not_found',
          `No existe la ubicación ${code} en ${warehouse.name}`
        );
    }
  } else {
    location = await ensureGeneralLocation(tx, warehouseId);
  }
  if (!location.active)
    throw new OperationsError('invalid_state', `La ubicación ${location.code} está desactivada`);
  return location;
}

async function productLabel(db: Db, zohoItemId: string): Promise<string> {
  const product = await db.product.findUnique({
    where: { zohoItemId },
    select: { name: true, sku: true },
  });
  return product?.name ?? product?.sku ?? zohoItemId;
}

// ---------------------------------------------------------------------------
// Group availability
// ---------------------------------------------------------------------------

export interface GroupScope {
  zohoItemId: string;
  /** null/undefined: every warehouse. */
  warehouseId?: string | null;
  /** null/undefined: every variant ('' is "no variant"). */
  variantKey?: string | null;
}

export interface GroupAvailability {
  /** Rows of the group (including SCRAP rows). */
  items: StockItem[];
  /** Rows that can be promised (SCRAP excluded). */
  usable: StockItem[];
  known: Decimal;
  reserved: Decimal;
  blocked: Decimal;
  assignedToProduction: Decimal;
  legacyClaims: Decimal;
  available: Decimal;
  lastVerifiedAt: Date | null;
}

/** Reads a product group and computes its availability (no locks: callers lock first). */
export async function loadGroupAvailability(db: Db, scope: GroupScope): Promise<GroupAvailability> {
  const warehouseFilter = scope.warehouseId ? { warehouseId: scope.warehouseId } : {};
  const variantFilter =
    scope.variantKey !== undefined && scope.variantKey !== null
      ? { variantKey: scope.variantKey }
      : {};
  const [items, scrapLocations, claims] = await Promise.all([
    db.stockItem.findMany({
      where: { zohoItemId: scope.zohoItemId, ...warehouseFilter, ...variantFilter },
      orderBy: { id: 'asc' },
    }),
    db.storageLocation.findMany({
      where: { code: SCRAP_LOCATION_CODE, ...warehouseFilter },
      select: { id: true },
    }),
    db.legacyCommitmentClaim.findMany({
      where: {
        zohoItemId: scope.zohoItemId,
        status: 'claimed',
        ...warehouseFilter,
        ...variantFilter,
      },
      select: { quantity: true },
    }),
  ]);
  const scrap = new Set(scrapLocations.map((l) => l.id));
  const usable = items.filter((item) => !scrap.has(item.locationId));
  const known = sumDecimals(usable.map((i) => i.knownQty));
  const reserved = sumDecimals(usable.map((i) => i.reserved));
  const blocked = sumDecimals(usable.map((i) => i.blocked));
  const assignedToProduction = sumDecimals(usable.map((i) => i.assignedToProduction));
  const legacyClaims = sumDecimals(claims.map((c) => c.quantity));
  const lastVerifiedAt = usable.reduce<Date | null>(
    (latest, item) =>
      item.lastCountedAt && (!latest || item.lastCountedAt > latest) ? item.lastCountedAt : latest,
    null
  );
  return {
    items,
    usable,
    known,
    reserved,
    blocked,
    assignedToProduction,
    legacyClaims,
    available: computeAvailable({ known, reserved, blocked, assignedToProduction, legacyClaims }),
    lastVerifiedAt,
  };
}

// ---------------------------------------------------------------------------
// verifyAvailability
// ---------------------------------------------------------------------------

export interface AvailabilityQuery {
  zohoItemId: string;
  warehouseId?: string | null;
  variantKey?: string | null;
  /** Quantity in base unit the demand needs (0 when omitted). */
  quantityBase?: DecimalLike | null;
}

export interface AvailabilityItem {
  stockItemId: string;
  warehouseId: string;
  locationId: string;
  variantKey: string;
  containerKey: string;
  known: Decimal;
  reserved: Decimal;
  blocked: Decimal;
  assignedToProduction: Decimal;
  available: Decimal;
  lastCountedAt: Date | null;
}

export interface AvailabilityResult {
  zohoItemId: string;
  warehouseId: string | null;
  variantKey: string | null;
  confidence: ConfidenceLevel;
  baseUnit: string;
  profileExists: boolean;
  known: Decimal;
  reserved: Decimal;
  blocked: Decimal;
  assignedToProduction: Decimal;
  legacyClaims: Decimal;
  available: Decimal;
  quantity: Decimal;
  /** Automatic promise allowed (CONTROLLED and enough). */
  canPromise: boolean;
  shortfall: Decimal;
  /** Stock that is not CONTROLLED needs a spot count before promising (adoption by demand). */
  requiresCount: boolean;
  lastVerifiedAt: Date | null;
  items: AvailabilityItem[];
  /** Zoho figures, informational only (never in formulas). */
  zoho: { stockOnHand: Decimal | null; availableStock: Decimal | null } | null;
}

/** Availability of an item for a demand (read only; callers inside a command may pass `tx`). */
export async function verifyAvailability(
  db: Db,
  query: AvailabilityQuery
): Promise<AvailabilityResult> {
  const zohoItemId = requireId(query.zohoItemId, 'el artículo');
  const [profile, product, group] = await Promise.all([
    db.productInventoryProfile.findUnique({ where: { zohoItemId } }),
    db.product.findUnique({
      where: { zohoItemId },
      select: { unit: true, stockOnHand: true, availableStock: true },
    }),
    loadGroupAvailability(db, {
      zohoItemId,
      warehouseId: query.warehouseId ?? null,
      variantKey: query.variantKey ?? null,
    }),
  ]);
  const confidence = toConfidenceLevel(profile?.confidence);
  const quantity = roundQty(dec(query.quantityBase ?? 0));
  const shortfall = Prisma.Decimal.max(quantity.minus(Prisma.Decimal.max(group.available, 0)), 0);
  return {
    zohoItemId,
    warehouseId: query.warehouseId ?? null,
    variantKey: query.variantKey ?? null,
    confidence,
    baseUnit: profile
      ? toUnitProfile(profile).baseUnit
      : normalizeUnit(product?.unit) || DEFAULT_BASE_UNIT,
    profileExists: Boolean(profile),
    known: group.known,
    reserved: group.reserved,
    blocked: group.blocked,
    assignedToProduction: group.assignedToProduction,
    legacyClaims: group.legacyClaims,
    available: group.available,
    quantity,
    canPromise: canPromise(confidence, group.available, quantity),
    shortfall,
    requiresCount: confidence !== 'CONTROLLED',
    lastVerifiedAt: group.lastVerifiedAt,
    items: group.usable.map((item) => ({
      stockItemId: item.id,
      warehouseId: item.warehouseId,
      locationId: item.locationId,
      variantKey: item.variantKey,
      containerKey: item.containerKey,
      known: dec(item.knownQty),
      reserved: dec(item.reserved),
      blocked: dec(item.blocked),
      assignedToProduction: dec(item.assignedToProduction),
      available: itemAvailable(item),
      lastCountedAt: item.lastCountedAt,
    })),
    zoho: product
      ? {
          stockOnHand: product.stockOnHand ?? null,
          availableStock: product.availableStock ?? null,
        }
      : null,
  };
}

export interface AvailabilityDTO {
  zohoItemId: string;
  warehouseId: string | null;
  variantKey: string | null;
  confidence: ConfidenceLevel;
  confidenceLabel: string;
  baseUnit: string;
  known: string;
  reserved: string;
  blocked: string;
  assignedToProduction: string;
  legacyClaims: string;
  available: string;
  quantity: string;
  canPromise: boolean;
  shortfall: string;
  requiresCount: boolean;
  lastVerifiedAt: string | null;
  items: Array<{
    stockItemId: string;
    warehouseId: string;
    locationId: string;
    variantKey: string;
    containerKey: string;
    known: string;
    reserved: string;
    blocked: string;
    available: string;
    lastCountedAt: string | null;
  }>;
  zoho: { stockOnHand: string | null; availableStock: string | null } | null;
}

export function toAvailabilityDTO(result: AvailabilityResult): AvailabilityDTO {
  return {
    zohoItemId: result.zohoItemId,
    warehouseId: result.warehouseId,
    variantKey: result.variantKey,
    confidence: result.confidence,
    confidenceLabel: CONFIDENCE_LABELS[result.confidence],
    baseUnit: result.baseUnit,
    known: qty(result.known),
    reserved: qty(result.reserved),
    blocked: qty(result.blocked),
    assignedToProduction: qty(result.assignedToProduction),
    legacyClaims: qty(result.legacyClaims),
    available: qty(result.available),
    quantity: qty(result.quantity),
    canPromise: result.canPromise,
    shortfall: qty(result.shortfall),
    requiresCount: result.requiresCount,
    lastVerifiedAt: result.lastVerifiedAt?.toISOString() ?? null,
    items: result.items.map((item) => ({
      stockItemId: item.stockItemId,
      warehouseId: item.warehouseId,
      locationId: item.locationId,
      variantKey: item.variantKey,
      containerKey: item.containerKey,
      known: qty(item.known),
      reserved: qty(item.reserved),
      blocked: qty(item.blocked),
      available: qty(item.available),
      lastCountedAt: item.lastCountedAt?.toISOString() ?? null,
    })),
    zoho: result.zoho
      ? {
          stockOnHand: result.zoho.stockOnHand === null ? null : qty(result.zoho.stockOnHand),
          availableStock:
            result.zoho.availableStock === null ? null : qty(result.zoho.availableStock),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// recordInventoryMovement
// ---------------------------------------------------------------------------

export interface MovementInput {
  kind: MovementKind;
  zohoItemId: string;
  warehouseId: string;
  /** Existing stock row; otherwise the row is resolved from location/variant/container. */
  stockItemId?: string | null;
  locationId?: string | null;
  /** Location code of the warehouse (GENERAL and SCRAP are created on demand). */
  locationCode?: string | null;
  /** Canonical key or structured variant (validated against the profile axes). */
  variantKey?: string | null;
  variant?: VariantInput | null;
  /** Display values for a new row (defaults to the parsed key). */
  variantJson?: Record<string, string> | null;
  containerKey?: string | null;
  /** Inbound movement that creates a new labeled container (RL-/PL-/CT-). */
  newContainer?: boolean;
  /** Signed for `adjust` and `baseline`; positive otherwise. */
  quantity: DecimalLike;
  /** Unit of `quantity` (default: base unit). */
  unit?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  note?: string | null;
  occurredAt?: Date | null;
  /** issue/consume/transfer_out against an active reservation of the same row. */
  reservationId?: string | null;
  /** Traceability of produced stock (manufacturing). */
  originProductionOrderId?: string | null;
  /** Dimensions of a saleable leftover (creates a CT- container when no container is given). */
  dimensions?: Record<string, unknown> | null;
  /** Verification instant (counts): updates `lastCountedAt`. */
  countedAt?: Date | null;
  /** Count-driven movements may leave a negative book (an incident is opened). */
  allowNegative?: boolean;
  /** Emit the per-movement event (default true; transfers and counts emit their own). */
  emitEvent?: boolean;
  /** Case of the movement (events and incidents). */
  caseId?: string | null;
}

export interface MovementResult {
  movement: StockMovement;
  stockItem: StockItem;
  profile: ProductInventoryProfile;
  /** Quantity in base unit (signed for adjust/baseline). */
  quantityBase: Decimal;
  baseUnit: string;
  confidence: ConfidenceLevel;
  /** Container created by this movement ('' when none). */
  createdContainerKey: string;
}

/**
 * Records one inventory movement: converts to base unit, resolves or creates
 * the stock row, locks it, validates the business rules, updates counters and
 * `knownQty`, appends the `StockMovement` and emits the event.
 *
 * Rules: `adjust` needs `inventory.adjust` (system actors are trusted);
 * unreserved outbound movements of CONTROLLED stock cannot exceed the row's
 * available nor the group's (legacy claims included); an outbound movement
 * against a reservation consumes it; blocking cannot exceed the unblocked
 * stock; non-CONTROLLED outbound movements may leave a negative book, which
 * opens a `stock_conflict` incident; stock entering SCRAP is blocked.
 */
export async function recordInventoryMovement(
  tx: Db,
  input: MovementInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<MovementResult> {
  const kind = input.kind;
  if (!isMovementKind(kind))
    throw new OperationsError('invalid_payload', 'Tipo de movimiento inválido');
  if (kind === 'adjust' && !actorMay(ctx, 'inventory.adjust')) {
    throw new OperationsError('forbidden', 'No tienes permiso para ajustar inventario');
  }
  const zohoItemId = requireId(input.zohoItemId, 'el artículo');
  const warehouseId = requireId(input.warehouseId, 'la bodega');
  const profile = await getOrCreateProfile(tx, zohoItemId);
  const units = toUnitProfile(profile);
  const quantity = guard(() => toBase(input.quantity, input.unit || units.baseUnit, units));
  if (isSignedKind(kind) ? quantity.isZero() : quantity.lte(0)) {
    throw inventoryError(
      'invalid_quantity',
      isSignedKind(kind) ? 'La cantidad no puede ser cero' : 'La cantidad debe ser mayor que cero'
    );
  }
  if (input.reservationId && kind !== 'issue' && kind !== 'consume' && kind !== 'transfer_out') {
    throw new OperationsError(
      'invalid_payload',
      'Sólo una salida, consumo o traspaso puede usar una reserva'
    );
  }

  // Stock row
  let item: StockItem;
  let createdContainerKey = '';
  if (input.stockItemId) {
    const found = await tx.stockItem.findUnique({ where: { id: input.stockItemId } });
    if (!found) throw new OperationsError('not_found', 'No se encontró la existencia');
    if (found.zohoItemId !== zohoItemId || found.warehouseId !== warehouseId) {
      throw new OperationsError(
        'invalid_payload',
        'La existencia no corresponde al artículo o a la bodega'
      );
    }
    item = found;
  } else {
    const variant = validateVariant(input.variant ?? input.variantKey ?? '', profile.variantAxes);
    if (!variant.ok) {
      throw inventoryError('invalid_variant', variant.message, {
        unknownAxes: variant.unknownAxes,
      });
    }
    const location = await resolveLocation(tx, warehouseId, input.locationId, input.locationCode);
    let containerKey = '';
    if (input.containerKey) {
      containerKey = normalizeContainerKey(input.containerKey);
      if (!containerKey)
        throw new OperationsError('invalid_payload', 'Código de contenedor inválido');
    }
    const wantsContainer =
      input.newContainer === true ||
      (Boolean(input.dimensions) && !containerKey && isInboundKind(kind));
    if (wantsContainer) {
      if (!isInboundKind(kind)) {
        throw new OperationsError(
          'invalid_payload',
          'Sólo una entrada puede crear un contenedor nuevo'
        );
      }
      const policy =
        containerPolicyFor(profile.trackingPolicy) ?? (input.dimensions ? 'container' : null);
      if (!policy) {
        throw new OperationsError(
          'invalid_state',
          'El artículo no se controla por rollo, placa o contenedor'
        );
      }
      containerKey = await nextContainerKey(tx, policy);
      createdContainerKey = containerKey;
    }
    const key: StockItemKey = {
      zohoItemId,
      warehouseId,
      locationId: location.id,
      variantKey: variant.variantKey,
      containerKey,
    };
    if (isOutboundKind(kind) || kind === 'block' || kind === 'unblock') {
      const found = await tx.stockItem.findUnique({
        where: { zohoItemId_warehouseId_locationId_variantKey_containerKey: key },
      });
      if (!found) {
        throw inventoryError(
          'insufficient_stock',
          'No hay existencia registrada en esa ubicación',
          {
            zohoItemId,
            warehouseId,
            locationId: location.id,
          }
        );
      }
      item = found;
    } else {
      item = await ensureStockItem(tx, key, {
        variantJson: input.variantJson ?? variant.variantJson,
        originProductionOrderId: input.originProductionOrderId ?? null,
        dimensions: input.dimensions ?? null,
      });
    }
  }

  const location = await tx.storageLocation.findUnique({
    where: { id: item.locationId },
    select: { code: true },
  });
  const isScrap = location?.code === SCRAP_LOCATION_CODE;
  const confidence = toConfidenceLevel(profile.confidence);
  const groupCheck =
    isOutboundKind(kind) && !input.reservationId && confidence === 'CONTROLLED' && !isScrap;
  if (groupCheck) {
    await lockStockItemsForProduct(tx, { zohoItemId, warehouseId, variantKey: item.variantKey });
  }
  const fresh = await lockAndLoad(tx, item.id);

  let reservation: StockReservation | null = null;
  if (input.reservationId) {
    reservation = await tx.stockReservation.findUnique({ where: { id: input.reservationId } });
    if (!reservation || reservation.stockItemId !== fresh.id) {
      throw new OperationsError('not_found', 'No se encontró la reserva de esta existencia');
    }
    if (reservation.status !== 'active') {
      throw new OperationsError('invalid_state', 'La reserva ya no está activa');
    }
    if (quantity.gt(reservation.quantity)) {
      throw inventoryError(
        'invalid_quantity',
        `La cantidad excede la reserva (${qty(reservation.quantity)} ${units.baseUnit})`
      );
    }
  }

  const state = toStockState(fresh);
  let next = guard(() => applyMovement(state, kind, quantity));
  if (reservation) {
    next = { ...next, reserved: roundQty(Prisma.Decimal.max(next.reserved.minus(quantity), 0)) };
  }

  if (isOutboundKind(kind) && confidence === 'CONTROLLED' && !isScrap) {
    if (reservation) {
      if (next.knownQty.lt(0)) {
        throw inventoryError(
          'insufficient_stock',
          'La existencia física no cubre la reserva; cuenta el artículo',
          {
            known: qty(state.knownQty),
            quantity: qty(quantity),
          }
        );
      }
    } else {
      const rowAvailable = itemAvailable(state);
      if (rowAvailable.lt(quantity)) {
        throw inventoryError(
          'insufficient_stock',
          `Existencia disponible insuficiente: ${qty(rowAvailable)} ${units.baseUnit}`,
          { available: qty(rowAvailable), quantity: qty(quantity) }
        );
      }
      const group = await loadGroupAvailability(tx, {
        zohoItemId,
        warehouseId,
        variantKey: fresh.variantKey,
      });
      if (group.available.lt(quantity)) {
        throw inventoryError(
          'insufficient_stock',
          `La existencia está comprometida con reservas o reclamos: disponible ${qty(group.available)} ${units.baseUnit}`,
          { available: qty(group.available), quantity: qty(quantity) }
        );
      }
    }
  }
  if (kind === 'block') {
    if (isScrap) throw new OperationsError('invalid_state', 'La merma ya está bloqueada');
    const unblocked = Prisma.Decimal.max(state.knownQty.minus(state.blocked), 0);
    if (quantity.gt(unblocked)) {
      throw inventoryError(
        'invalid_quantity',
        `Sólo hay ${qty(unblocked)} ${units.baseUnit} sin bloquear`
      );
    }
  }
  if (kind === 'unblock') {
    if (isScrap) throw new OperationsError('invalid_state', 'La merma no se puede desbloquear');
    if (quantity.gt(state.blocked)) {
      throw inventoryError(
        'invalid_quantity',
        `Sólo hay ${qty(state.blocked)} ${units.baseUnit} bloqueados`
      );
    }
  }
  if (isSignedKind(kind) && next.knownQty.lt(0) && !input.allowNegative) {
    throw inventoryError('negative_stock', 'El movimiento dejaría existencias negativas');
  }
  if (isScrap) next = { ...next, blocked: roundQty(Prisma.Decimal.max(next.knownQty, 0)) };

  const extra: Prisma.StockItemUpdateInput = {};
  if (input.countedAt) extra.lastCountedAt = input.countedAt;
  if (input.originProductionOrderId && !fresh.originProductionOrderId) {
    extra.originProductionOrderId = input.originProductionOrderId;
  }
  if (input.dimensions && !fresh.dimensions) extra.dimensions = toOperationalJson(input.dimensions);
  const stockItem = await writeState(tx, fresh.id, next, extra);

  if (reservation) {
    const remaining = roundQty(dec(reservation.quantity).minus(quantity));
    reservation = await tx.stockReservation.update({
      where: { id: reservation.id },
      data: remaining.lte(0)
        ? { status: 'consumed', version: { increment: 1 } }
        : { quantity: remaining, version: { increment: 1 } },
    });
  }

  const referenceType = input.referenceType ?? (reservation ? 'stock_reservation' : null);
  const referenceId = input.referenceId ?? reservation?.id ?? null;
  const movement = await tx.stockMovement.create({
    data: {
      stockItemId: stockItem.id,
      zohoItemId,
      warehouseId,
      kind,
      quantity,
      originalQuantity: roundQty(dec(input.quantity)),
      originalUnit: normalizeUnit(input.unit) || units.baseUnit,
      referenceType,
      referenceId,
      commandId: ctx.commandId,
      actorId: ctx.actor.id,
      note: note(input.note),
      occurredAt: input.occurredAt ?? ctx.now,
    },
  });

  const caseId = input.caseId ?? reservation?.caseId ?? null;
  const availableAfter = itemAvailable(next);
  const eventOptions = {
    caseId,
    areaKey: INVENTORY_AREA_KEY,
    objectType: 'stock_item',
    objectId: stockItem.id,
  };

  if (createdContainerKey) {
    ctx.emit(
      INVENTORY_EVENTS.containerCreated,
      { stockItemId: stockItem.id, zohoItemId, warehouseId, containerKey: createdContainerKey },
      eventOptions
    );
  }
  if (input.emitEvent !== false) {
    ctx.emit(
      MOVEMENT_EVENT[kind],
      {
        movementId: movement.id,
        stockItemId: stockItem.id,
        zohoItemId,
        warehouseId,
        locationId: stockItem.locationId,
        variantKey: stockItem.variantKey,
        containerKey: stockItem.containerKey,
        kind,
        quantity: qty(quantity),
        unit: units.baseUnit,
        knownAfter: qty(next.knownQty),
        availableAfter: qty(availableAfter),
        confidence,
        referenceType,
        referenceId,
        reservationId: reservation?.id ?? null,
      },
      eventOptions
    );
  }

  const day = utcDay(ctx.now);
  if (next.knownQty.lt(0)) {
    const label = await productLabel(tx, zohoItemId);
    await ctx.openIncident({
      kind: 'stock_conflict',
      areaKey: INVENTORY_AREA_KEY,
      title: `Existencia negativa: ${label}`,
      dedupeKey: `inventory:negative:${stockItem.id}:${day}`,
      severity: 'medium',
      caseId,
      detail: {
        stockItemId: stockItem.id,
        zohoItemId,
        warehouseId,
        known: qty(next.knownQty),
        movementId: movement.id,
        confidence,
      },
    });
    ctx.emit(
      INVENTORY_EVENTS.negative,
      { stockItemId: stockItem.id, zohoItemId, known: qty(next.knownQty), movementId: movement.id },
      eventOptions
    );
  }
  // An unreserved outbound movement never eats reservations silently (non-CONTROLLED
  // stock may go below what is promised): the row or the whole group is flagged.
  const unreservedOutbound = isOutboundKind(kind) && !input.reservationId;
  if (
    next.reserved.gt(0) &&
    availableAfter.lt(0) &&
    (!isOutboundKind(kind) || unreservedOutbound)
  ) {
    const label = await productLabel(tx, zohoItemId);
    await ctx.openIncident({
      kind: 'stock_conflict',
      areaKey: INVENTORY_AREA_KEY,
      title: `Reservas sin cobertura: ${label}`,
      dedupeKey: `inventory:uncovered:${stockItem.id}:${day}`,
      severity: 'high',
      caseId,
      detail: {
        stockItemId: stockItem.id,
        zohoItemId,
        warehouseId,
        reserved: qty(next.reserved),
        available: qty(availableAfter),
        movementId: movement.id,
      },
    });
  } else if (unreservedOutbound && !isScrap) {
    const group = await loadGroupAvailability(tx, {
      zohoItemId,
      warehouseId,
      variantKey: stockItem.variantKey,
    });
    if (group.reserved.gt(0) && group.available.lt(0)) {
      const label = await productLabel(tx, zohoItemId);
      await ctx.openIncident({
        kind: 'stock_conflict',
        areaKey: INVENTORY_AREA_KEY,
        title: `Reservas sin cobertura: ${label}`,
        dedupeKey: `inventory:uncovered:group:${zohoItemId}:${warehouseId}:${stockItem.variantKey}:${day}`,
        severity: 'high',
        caseId,
        detail: {
          zohoItemId,
          warehouseId,
          variantKey: stockItem.variantKey,
          reserved: qty(group.reserved),
          available: qty(group.available),
          movementId: movement.id,
          confidence,
        },
      });
    }
  }

  return {
    movement,
    stockItem,
    profile,
    quantityBase: quantity,
    baseUnit: units.baseUnit,
    confidence,
    createdContainerKey,
  };
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export interface TransferInput {
  zohoItemId: string;
  fromWarehouseId: string;
  fromStockItemId?: string | null;
  fromLocationId?: string | null;
  fromLocationCode?: string | null;
  variantKey?: string | null;
  variant?: VariantInput | null;
  containerKey?: string | null;
  toWarehouseId: string;
  toLocationId?: string | null;
  toLocationCode?: string | null;
  quantity: DecimalLike;
  unit?: string | null;
  note?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  caseId?: string | null;
}

export interface TransferResult {
  out: MovementResult;
  in: MovementResult;
}

/** Moves stock between locations/warehouses as `transfer_out` + `transfer_in` in the same command. */
export async function transferStock(
  tx: Db,
  input: TransferInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<TransferResult> {
  const zohoItemId = requireId(input.zohoItemId, 'el artículo');
  const fromWarehouseId = requireId(input.fromWarehouseId, 'la bodega de origen');
  const toWarehouseId = requireId(input.toWarehouseId, 'la bodega de destino');

  let source: StockItem | null;
  if (input.fromStockItemId) {
    source = await tx.stockItem.findUnique({ where: { id: input.fromStockItemId } });
    if (source && (source.zohoItemId !== zohoItemId || source.warehouseId !== fromWarehouseId)) {
      throw new OperationsError(
        'invalid_payload',
        'La existencia de origen no corresponde al artículo o a la bodega'
      );
    }
  } else {
    const profile = await getOrCreateProfile(tx, zohoItemId);
    const variant = validateVariant(input.variant ?? input.variantKey ?? '', profile.variantAxes);
    if (!variant.ok) throw inventoryError('invalid_variant', variant.message);
    const fromLocation = await resolveLocation(
      tx,
      fromWarehouseId,
      input.fromLocationId,
      input.fromLocationCode
    );
    const containerKey = input.containerKey ? normalizeContainerKey(input.containerKey) : '';
    source = await tx.stockItem.findUnique({
      where: {
        zohoItemId_warehouseId_locationId_variantKey_containerKey: {
          zohoItemId,
          warehouseId: fromWarehouseId,
          locationId: fromLocation.id,
          variantKey: variant.variantKey,
          containerKey,
        },
      },
    });
  }
  if (!source)
    throw inventoryError('insufficient_stock', 'No hay existencia registrada en el origen');
  const sourceLocation = await tx.storageLocation.findUnique({
    where: { id: source.locationId },
    select: { code: true },
  });
  if (sourceLocation?.code === SCRAP_LOCATION_CODE) {
    // Scrap is always blocked: moving it elsewhere would make it promisable without a count.
    throw new OperationsError(
      'invalid_state',
      'La merma no se puede traspasar; usa un ajuste autorizado'
    );
  }

  const destination = await resolveLocation(
    tx,
    toWarehouseId,
    input.toLocationId,
    input.toLocationCode
  );
  if (destination.id === source.locationId) {
    throw new OperationsError('invalid_payload', 'El origen y el destino son la misma ubicación');
  }
  // Every row this transfer locks (the source group and the destination row) is
  // locked up front in one id-ordered statement, like reservations do.
  const destinationRow = await ensureStockItem(tx, {
    zohoItemId,
    warehouseId: toWarehouseId,
    locationId: destination.id,
    variantKey: source.variantKey,
    containerKey: source.containerKey,
  });
  const sourceGroup = await tx.stockItem.findMany({
    where: { zohoItemId, warehouseId: source.warehouseId, variantKey: source.variantKey },
    select: { id: true },
  });
  await lockStockItems(tx, [...sourceGroup.map((row) => row.id), destinationRow.id]);

  if (source.containerKey) {
    const units = toUnitProfile(await getOrCreateProfile(tx, zohoItemId));
    const requested = guard(() => toBase(input.quantity, input.unit || units.baseUnit, units));
    if (!requested.equals(dec(source.knownQty))) {
      throw new OperationsError(
        'invalid_payload',
        `El contenedor ${source.containerKey} se traspasa completo (${qty(source.knownQty)} ${units.baseUnit}); usa una salida para cortarlo`
      );
    }
  }

  const referenceType = input.referenceType ?? 'stock_transfer';
  const referenceId = input.referenceId ?? ctx.commandId;
  const out = await recordInventoryMovement(
    tx,
    {
      kind: 'transfer_out',
      zohoItemId,
      warehouseId: source.warehouseId,
      stockItemId: source.id,
      quantity: input.quantity,
      unit: input.unit,
      referenceType,
      referenceId,
      note: input.note,
      emitEvent: false,
      caseId: input.caseId,
    },
    ctx
  );
  const variantJson =
    source.variantJson &&
    typeof source.variantJson === 'object' &&
    !Array.isArray(source.variantJson)
      ? (source.variantJson as Record<string, string>)
      : null;
  const inbound = await recordInventoryMovement(
    tx,
    {
      kind: 'transfer_in',
      zohoItemId,
      warehouseId: toWarehouseId,
      locationId: destination.id,
      variantKey: source.variantKey,
      variantJson,
      containerKey: source.containerKey || null,
      quantity: out.quantityBase,
      unit: out.baseUnit,
      referenceType,
      referenceId,
      note: input.note,
      originProductionOrderId: source.originProductionOrderId,
      dimensions:
        source.dimensions &&
        typeof source.dimensions === 'object' &&
        !Array.isArray(source.dimensions)
          ? (source.dimensions as Record<string, unknown>)
          : null,
      emitEvent: false,
      caseId: input.caseId,
    },
    ctx
  );
  ctx.emit(
    INVENTORY_EVENTS.transferred,
    {
      zohoItemId,
      quantity: qty(out.quantityBase),
      unit: out.baseUnit,
      from: {
        stockItemId: out.stockItem.id,
        warehouseId: out.stockItem.warehouseId,
        locationId: out.stockItem.locationId,
        movementId: out.movement.id,
      },
      to: {
        stockItemId: inbound.stockItem.id,
        warehouseId: inbound.stockItem.warehouseId,
        locationId: inbound.stockItem.locationId,
        movementId: inbound.movement.id,
      },
      referenceType,
      referenceId,
    },
    {
      caseId: input.caseId ?? null,
      areaKey: INVENTORY_AREA_KEY,
      objectType: 'stock_item',
      objectId: out.stockItem.id,
    }
  );
  return { out, in: inbound };
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

export interface ReserveStockInput {
  caseId: string;
  demandId: string;
  allocationId?: string | null;
  zohoItemId: string;
  warehouseId: string;
  /** Default: the demand's variant. */
  variantKey?: string | null;
  quantity: DecimalLike;
  unit?: string | null;
  /** Reserve from this row only. */
  stockItemId?: string | null;
  /** Explicit human decision to promise PROVISIONAL stock. */
  allowProvisional?: boolean;
  /**
   * Receipt/production movements that brought this material in for the
   * allocation (awaited purchase or production): validated, and the item's
   * confidence does not block the reservation.
   */
  receiptMovementIds?: string[] | null;
  note?: string | null;
}

export interface ReceiptMovementsInput {
  movementIds: readonly string[];
  /** Accepted movement kinds (e.g. `receipt` for a purchase, `produce` for production). */
  kinds: readonly MovementKind[];
  zohoItemId: string;
  /** When known, every movement must be of this warehouse. */
  warehouseId?: string | null;
  /** Base quantity the movements must cover together. */
  minQuantity?: Decimal | null;
}

/**
 * Checks that the movements given as evidence of an awaited receipt or
 * production really brought the material in: they exist, are of the accepted
 * kinds, of the item and of a single warehouse, and together cover the
 * quantity. Material that is only expected never counts as ready.
 */
export async function assertReceiptMovements(
  tx: Db,
  input: ReceiptMovementsInput
): Promise<{ warehouseId: string; quantity: Decimal; movementIds: string[] }> {
  const ids = [...new Set(input.movementIds.map((id) => String(id).trim()).filter(Boolean))];
  const kindsLabel = input.kinds.join(' / ');
  if (ids.length === 0) {
    throw new OperationsError(
      'evidence_invalid',
      `Indica el movimiento de inventario (${kindsLabel}) con el que entró el material`
    );
  }
  const movements = await tx.stockMovement.findMany({ where: { id: { in: ids } } });
  if (movements.length !== ids.length) {
    throw new OperationsError(
      'evidence_invalid',
      'El movimiento indicado no existe en el inventario; registra primero la entrada'
    );
  }
  for (const movement of movements) {
    if (!(input.kinds as readonly string[]).includes(movement.kind)) {
      throw new OperationsError(
        'evidence_invalid',
        `El movimiento ${movement.id} no es una entrada de tipo ${kindsLabel}`
      );
    }
    if (movement.zohoItemId !== input.zohoItemId) {
      throw new OperationsError(
        'evidence_invalid',
        `El movimiento ${movement.id} es de otro artículo`
      );
    }
  }
  const warehouses = new Set(movements.map((movement) => movement.warehouseId));
  const [warehouseId] = [...warehouses];
  if (warehouses.size !== 1 || (input.warehouseId && warehouseId !== input.warehouseId)) {
    throw new OperationsError(
      'evidence_invalid',
      'Los movimientos deben ser de la bodega de la asignación'
    );
  }
  const quantity = roundQty(sumDecimals(movements.map((movement) => movement.quantity)));
  if (input.minQuantity && quantity.lt(input.minQuantity)) {
    throw new OperationsError(
      'evidence_invalid',
      `Los movimientos cubren ${qty(quantity)} y la asignación necesita ${qty(input.minQuantity)}`
    );
  }
  return { warehouseId, quantity, movementIds: ids };
}

export interface ReserveStockResult {
  reservations: StockReservation[];
  primaryReservationId: string;
  provisional: boolean;
  confidence: ConfidenceLevel;
  quantityBase: Decimal;
  baseUnit: string;
  availableBefore: Decimal;
  availableAfter: Decimal;
}

/**
 * Locks the rows of a product group and reads its availability. The lock only
 * covers the rows that existed when it was taken, so the rows read afterwards
 * are locked too and the group is read again until both sets match (a receipt
 * that created a row in between is then serialized as well).
 */
async function lockAndLoadGroup(
  tx: Db,
  scope: { zohoItemId: string; warehouseId: string; variantKey: string }
): Promise<GroupAvailability> {
  const locked = new Set(await lockStockItemsForProduct(tx, scope));
  for (let attempt = 0; attempt < 5; attempt++) {
    const group = await loadGroupAvailability(tx, scope);
    const unlocked = group.items.map((item) => item.id).filter((id) => !locked.has(id));
    if (unlocked.length === 0) return group;
    for (const id of await lockStockItems(tx, [...locked, ...unlocked])) locked.add(id);
  }
  throw new Error(`Stock group of ${scope.zohoItemId} kept changing while it was being locked`);
}

/**
 * A demand is never promised twice nor beyond what it still needs. Under the
 * product lock, the quantity (profile base unit) must fit in
 * `baseQuantity − fulfilledQuantity − Σ active reservations` of the demand and,
 * with an allocation, in `allocation.quantity − Σ its active reservations`.
 * Used by every path that reserves (`stock.reserve`, the case engine, legacy
 * claims), so a double click or a retry with a new command id cannot starve
 * other orders.
 */
export async function assertReservationCapacity(
  tx: Db,
  input: {
    demand: Pick<CaseDemand, 'id' | 'baseQuantity' | 'baseUnit' | 'fulfilledQuantity'>;
    allocationId?: string | null;
    quantity: Decimal;
    units: ReturnType<typeof toUnitProfile>;
  }
): Promise<void> {
  const { demand, quantity, units } = input;
  const needed = guard(() =>
    toBase(
      Prisma.Decimal.max(dec(demand.baseQuantity).minus(demand.fulfilledQuantity), 0),
      demand.baseUnit || units.baseUnit,
      units
    )
  );
  const active = await tx.stockReservation.findMany({
    where: { demandId: demand.id, status: 'active' },
    select: { quantity: true, allocationId: true },
  });
  const reservedForDemand = sumDecimals(active.map((row) => row.quantity));
  const outstanding = Prisma.Decimal.max(roundQty(needed.minus(reservedForDemand)), 0);
  if (quantity.gt(outstanding)) {
    throw inventoryError(
      'demand_over_reserved',
      outstanding.lte(0)
        ? 'La necesidad ya tiene reservada toda su existencia'
        : `La necesidad ya tiene reservada su existencia: sólo faltan ${qty(outstanding)} ${units.baseUnit}`,
      {
        demandId: demand.id,
        quantity: qty(quantity),
        outstanding: qty(outstanding),
        reserved: qty(reservedForDemand),
      }
    );
  }
  if (!input.allocationId) return;
  const allocation: Pick<DemandAllocation, 'id' | 'quantity'> | null =
    await tx.demandAllocation.findUnique({
      where: { id: input.allocationId },
      select: { id: true, quantity: true },
    });
  if (!allocation) return;
  const reservedForAllocation = sumDecimals(
    active.filter((row) => row.allocationId === allocation.id).map((row) => row.quantity)
  );
  const allocationOutstanding = Prisma.Decimal.max(
    roundQty(dec(allocation.quantity).minus(reservedForAllocation)),
    0
  );
  if (quantity.gt(allocationOutstanding)) {
    throw inventoryError(
      'demand_over_reserved',
      allocationOutstanding.lte(0)
        ? 'La asignación ya tiene su existencia reservada'
        : `La asignación sólo admite ${qty(allocationOutstanding)} ${units.baseUnit} más`,
      {
        allocationId: allocation.id,
        quantity: qty(quantity),
        outstanding: qty(allocationOutstanding),
      }
    );
  }
}

/**
 * Reserves stock for a case demand under lock (plan §3.3 `stock.reserve`).
 * The group (item + warehouse + variant) is locked, availability recomputed
 * (legacy claims included) and `evaluateReservation` decides; one row covering
 * the whole quantity is preferred, otherwise it is split across rows.
 */
export async function reserveStock(
  tx: Db,
  input: ReserveStockInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<ReserveStockResult> {
  const zohoItemId = requireId(input.zohoItemId, 'el artículo');
  const warehouseId = requireId(input.warehouseId, 'la bodega');
  const demand = await tx.caseDemand.findUnique({
    where: { id: requireId(input.demandId, 'la necesidad') },
  });
  if (!demand) throw new OperationsError('not_found', 'No se encontró la necesidad del expediente');
  if (demand.caseId !== input.caseId) {
    throw new OperationsError('invalid_payload', 'La necesidad no pertenece a este expediente');
  }
  if (demand.zohoItemId && demand.zohoItemId !== zohoItemId) {
    throw new OperationsError('invalid_payload', 'La necesidad es de otro artículo');
  }
  if (demand.status === 'cancelled' || demand.status === 'fulfilled') {
    throw new OperationsError('invalid_state', 'La necesidad ya está cerrada');
  }
  if (input.allocationId) {
    const allocation = await tx.demandAllocation.findUnique({ where: { id: input.allocationId } });
    if (!allocation || allocation.demandId !== demand.id) {
      throw new OperationsError('not_found', 'No se encontró la asignación de la necesidad');
    }
  }
  if (input.allowProvisional && ctx.actor.type !== 'user') {
    throw inventoryError(
      'provisional_requires_human',
      'Sólo una persona puede decidir reservar existencia provisional'
    );
  }
  const warehouse = await tx.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw new OperationsError('not_found', 'No se encontró la bodega');
  if (!warehouse.active)
    throw new OperationsError('invalid_state', `La bodega ${warehouse.name} está desactivada`);

  const initialProfile = await getOrCreateProfile(tx, zohoItemId);
  const units = toUnitProfile(initialProfile);
  const quantity = guard(() => toBase(input.quantity, input.unit || units.baseUnit, units));
  const variantKey = input.variantKey ?? demand.variantKey ?? '';

  const receiptBacked = Boolean(input.receiptMovementIds && input.receiptMovementIds.length > 0);
  if (receiptBacked) {
    await assertReceiptMovements(tx, {
      movementIds: input.receiptMovementIds!,
      kinds: ['receipt', 'produce'],
      zohoItemId,
      warehouseId,
      minQuantity: quantity,
    });
  }
  const group = await lockAndLoadGroup(tx, { zohoItemId, warehouseId, variantKey });
  await assertReservationCapacity(tx, {
    demand,
    allocationId: input.allocationId,
    quantity,
    units,
  });
  const profile =
    (await tx.productInventoryProfile.findUnique({ where: { id: initialProfile.id } })) ??
    initialProfile;
  const confidence = toConfidenceLevel(profile.confidence);
  const config = await getOperationsConfig();

  const decision = evaluateReservation({
    confidence,
    available: group.available,
    quantity,
    allowProvisional: input.allowProvisional === true,
    lastVerifiedAt: group.lastVerifiedAt,
    now: ctx.now,
    provisionalMaxHours: config.provisionalVerificationMaxHours,
    receiptBacked,
  });
  const details = {
    zohoItemId,
    warehouseId,
    variantKey,
    confidence,
    available: qty(group.available),
    quantity: qty(quantity),
    baseUnit: units.baseUnit,
  };
  if (!decision.ok) {
    throw inventoryError(decision.code, decision.message, {
      ...details,
      shortfall: qty(decision.shortfall),
    });
  }

  let parts: Array<{ id: string; quantity: Decimal }> | null;
  if (input.stockItemId) {
    const row = group.usable.find((i) => i.id === input.stockItemId);
    if (!row)
      throw new OperationsError('not_found', 'La existencia no pertenece a este artículo y bodega');
    const rowAvailable = itemAvailable(row);
    if (rowAvailable.lt(quantity)) {
      throw inventoryError(
        'insufficient_stock',
        `Existencia insuficiente en esa ubicación: disponible ${qty(rowAvailable)} ${units.baseUnit}`,
        { ...details, available: qty(rowAvailable) }
      );
    }
    parts = [{ id: row.id, quantity }];
  } else {
    parts = planReservationSplit(
      group.usable.map((row) => ({ id: row.id, available: itemAvailable(row) })),
      quantity
    );
  }
  if (!parts || parts.length === 0) {
    throw inventoryError('insufficient_stock', 'Existencia insuficiente para reservar', details);
  }

  const reservations: StockReservation[] = [];
  for (const part of parts) {
    const row = group.usable.find((i) => i.id === part.id)!;
    await tx.stockItem.update({
      where: { id: row.id },
      // Relative write: never a lost update over a stale read of the counter.
      data: { reserved: { increment: part.quantity }, version: { increment: 1 } },
    });
    const reservation = await tx.stockReservation.create({
      data: {
        stockItemId: row.id,
        zohoItemId,
        warehouseId,
        caseId: demand.caseId,
        demandId: demand.id,
        allocationId: input.allocationId ?? null,
        quantity: part.quantity,
        status: 'active',
        confidenceAtReserve: confidence,
      },
    });
    reservations.push(reservation);
    await ctx.relate(
      { type: 'stock_reservation', id: reservation.id },
      { type: 'case_demand', id: demand.id },
      'reserved_for'
    );
  }

  const availableAfter = roundQty(group.available.minus(quantity));
  ctx.emit(
    decision.provisional ? INVENTORY_EVENTS.reservedProvisional : INVENTORY_EVENTS.reserved,
    {
      reservationIds: reservations.map((r) => r.id),
      demandId: demand.id,
      allocationId: input.allocationId ?? null,
      zohoItemId,
      warehouseId,
      variantKey,
      quantity: qty(quantity),
      unit: units.baseUnit,
      confidence,
      allowProvisional: input.allowProvisional === true,
      availableBefore: qty(group.available),
      availableAfter: qty(availableAfter),
      note: note(input.note),
      parts: parts.map((p) => ({ stockItemId: p.id, quantity: qty(p.quantity) })),
    },
    {
      caseId: demand.caseId,
      areaKey: INVENTORY_AREA_KEY,
      objectType: 'stock_reservation',
      objectId: reservations[0].id,
    }
  );
  return {
    reservations,
    primaryReservationId: reservations[0].id,
    provisional: decision.provisional,
    confidence,
    quantityBase: quantity,
    baseUnit: units.baseUnit,
    availableBefore: group.available,
    availableAfter,
  };
}

export interface ReleaseReservationInput {
  reservationId: string;
  reason?: string | null;
  /** `expired` for supervisor sweeps; default `released`. */
  status?: 'released' | 'expired';
}

/** Releases an active reservation (the reserved counter of its row goes back). */
export async function releaseReservation(
  tx: Db,
  input: ReleaseReservationInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<StockReservation> {
  const reservationId = requireId(input.reservationId, 'la reserva');
  const initial = await tx.stockReservation.findUnique({ where: { id: reservationId } });
  if (!initial) throw new OperationsError('not_found', 'No se encontró la reserva');
  const row = await lockAndLoad(tx, initial.stockItemId);
  const reservation = await tx.stockReservation.findUnique({ where: { id: reservationId } });
  if (!reservation || reservation.status !== 'active') {
    throw new OperationsError('invalid_state', 'La reserva ya no está activa');
  }
  const reserved = dec(row.reserved).minus(reservation.quantity);
  if (reserved.lt(0)) {
    log('reserved_counter_inconsistent', {
      stockItemId: row.id,
      reserved: qty(row.reserved),
      reservationId,
      quantity: qty(reservation.quantity),
    });
  }
  await tx.stockItem.update({
    where: { id: row.id },
    data: { reserved: roundQty(Prisma.Decimal.max(reserved, 0)), version: { increment: 1 } },
  });
  const status = input.status ?? 'released';
  const updated = await tx.stockReservation.update({
    where: { id: reservation.id },
    data: { status, releasedAt: ctx.now, version: { increment: 1 } },
  });
  ctx.emit(
    INVENTORY_EVENTS.released,
    {
      reservationId: reservation.id,
      stockItemId: row.id,
      zohoItemId: reservation.zohoItemId,
      warehouseId: reservation.warehouseId,
      demandId: reservation.demandId,
      allocationId: reservation.allocationId,
      quantity: qty(reservation.quantity),
      status,
      reason: note(input.reason),
    },
    {
      caseId: reservation.caseId,
      areaKey: INVENTORY_AREA_KEY,
      objectType: 'stock_reservation',
      objectId: reservation.id,
    }
  );
  return updated;
}

export interface ConsumeReservationInput {
  reservationId: string;
  /** Default: the whole remaining reservation (base unit). */
  quantity?: DecimalLike | null;
  unit?: string | null;
  /** `issue` (order preparation, delivery) or `consume` (production). */
  kind?: 'issue' | 'consume';
  referenceType?: string | null;
  referenceId?: string | null;
  note?: string | null;
}

/** Issues or consumes reserved stock (partial consumption keeps the rest reserved). */
export async function consumeReservation(
  tx: Db,
  input: ConsumeReservationInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<MovementResult & { reservation: StockReservation }> {
  const reservationId = requireId(input.reservationId, 'la reserva');
  const reservation = await tx.stockReservation.findUnique({ where: { id: reservationId } });
  if (!reservation) throw new OperationsError('not_found', 'No se encontró la reserva');
  if (reservation.status !== 'active')
    throw new OperationsError('invalid_state', 'La reserva ya no está activa');
  const wholeReservation = input.quantity === undefined || input.quantity === null;
  const result = await recordInventoryMovement(
    tx,
    {
      kind: input.kind ?? 'issue',
      zohoItemId: reservation.zohoItemId,
      warehouseId: reservation.warehouseId,
      stockItemId: reservation.stockItemId,
      reservationId: reservation.id,
      quantity: wholeReservation ? reservation.quantity : input.quantity!,
      unit: wholeReservation ? null : input.unit,
      referenceType: input.referenceType ?? 'stock_reservation',
      referenceId: input.referenceId ?? reservation.id,
      note: input.note,
      caseId: reservation.caseId,
    },
    ctx
  );
  const updated =
    (await tx.stockReservation.findUnique({ where: { id: reservation.id } })) ?? reservation;
  ctx.emit(
    INVENTORY_EVENTS.reservationConsumed,
    {
      reservationId: reservation.id,
      movementId: result.movement.id,
      demandId: reservation.demandId,
      allocationId: reservation.allocationId,
      quantity: qty(result.quantityBase),
      remaining: updated.status === 'active' ? qty(updated.quantity) : '0',
      status: updated.status,
    },
    {
      caseId: reservation.caseId,
      areaKey: INVENTORY_AREA_KEY,
      objectType: 'stock_reservation',
      objectId: reservation.id,
    }
  );
  return { ...result, reservation: updated };
}

// ---------------------------------------------------------------------------
// Block / unblock / containers
// ---------------------------------------------------------------------------

export interface BlockStockInput {
  stockItemId: string;
  quantity: DecimalLike;
  unit?: string | null;
  reason: string;
}

async function blockOrUnblock(
  tx: Db,
  kind: 'block' | 'unblock',
  input: BlockStockInput,
  ctx: CommandContext
): Promise<MovementResult> {
  const row = await tx.stockItem.findUnique({
    where: { id: requireId(input.stockItemId, 'la existencia') },
  });
  if (!row) throw new OperationsError('not_found', 'No se encontró la existencia');
  const reason = note(input.reason);
  if (!reason) throw new OperationsError('invalid_payload', 'Indica el motivo');
  return recordInventoryMovement(
    tx,
    {
      kind,
      zohoItemId: row.zohoItemId,
      warehouseId: row.warehouseId,
      stockItemId: row.id,
      quantity: input.quantity,
      unit: input.unit,
      note: reason,
      referenceType: 'stock_block',
      referenceId: row.id,
    },
    ctx
  );
}

/** Blocks stock (quality hold, damage): it stays known but stops being available. */
export function blockStock(
  tx: Db,
  input: BlockStockInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<MovementResult> {
  return blockOrUnblock(tx, 'block', input, ctx);
}

export function unblockStock(
  tx: Db,
  input: BlockStockInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<MovementResult> {
  return blockOrUnblock(tx, 'unblock', input, ctx);
}

export interface CreateContainerInput {
  zohoItemId: string;
  warehouseId: string;
  locationId?: string | null;
  locationCode?: string | null;
  variantKey?: string | null;
  variant?: VariantInput | null;
}

/** Creates an empty labeled container row (RL-/PL-/CT-) for items tracked per unit. */
export async function createContainerStockItem(
  tx: Db,
  input: CreateContainerInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<{ stockItem: StockItem; containerKey: string }> {
  const zohoItemId = requireId(input.zohoItemId, 'el artículo');
  const warehouseId = requireId(input.warehouseId, 'la bodega');
  const profile = await getOrCreateProfile(tx, zohoItemId);
  const policy = containerPolicyFor(profile.trackingPolicy);
  if (!policy) {
    throw new OperationsError(
      'invalid_state',
      'El artículo no se controla por rollo, placa o contenedor'
    );
  }
  const variant = validateVariant(input.variant ?? input.variantKey ?? '', profile.variantAxes);
  if (!variant.ok) throw inventoryError('invalid_variant', variant.message);
  const location = await resolveLocation(tx, warehouseId, input.locationId, input.locationCode);
  const containerKey = await nextContainerKey(tx, policy);
  const stockItem = await ensureStockItem(
    tx,
    {
      zohoItemId,
      warehouseId,
      locationId: location.id,
      variantKey: variant.variantKey,
      containerKey,
    },
    { variantJson: variant.variantJson }
  );
  ctx.emit(
    INVENTORY_EVENTS.containerCreated,
    { stockItemId: stockItem.id, zohoItemId, warehouseId, locationId: location.id, containerKey },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'stock_item', objectId: stockItem.id }
  );
  return { stockItem, containerKey };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface StockSnapshotFilter {
  zohoItemId?: string | null;
  warehouseId?: string | null;
  locationId?: string | null;
}

export interface StockSnapshotProduct {
  zohoItemId: string;
  productName: string | null;
  sku: string | null;
  baseUnit: string;
  confidence: ConfidenceLevel;
  confidenceLabel: string;
  totals: {
    known: string;
    reserved: string;
    blocked: string;
    assignedToProduction: string;
    legacyClaims: string;
    available: string;
  };
  /** Zoho figures, informational column only. */
  zoho: { stockOnHand: string | null; availableStock: string | null };
  items: StockItemDTO[];
}

export interface StockSnapshot {
  filter: StockSnapshotFilter;
  products: StockSnapshotProduct[];
  truncated: boolean;
}

const SNAPSHOT_LIMIT = 1000;

/**
 * Stock by product, warehouse or location with totals per product and the
 * Zoho figures as an informational column. Totals exclude SCRAP rows; legacy
 * claims count only when the filter is not a single location.
 */
export async function getStockSnapshot(
  filter: StockSnapshotFilter,
  db: Db = prisma
): Promise<StockSnapshot> {
  if (!filter.zohoItemId && !filter.warehouseId && !filter.locationId) {
    throw new OperationsError('invalid_payload', 'Indica un artículo, una bodega o una ubicación');
  }
  const where: Prisma.StockItemWhereInput = {
    ...(filter.zohoItemId ? { zohoItemId: filter.zohoItemId } : {}),
    ...(filter.warehouseId ? { warehouseId: filter.warehouseId } : {}),
    ...(filter.locationId ? { locationId: filter.locationId } : {}),
  };
  const rows = await db.stockItem.findMany({
    where,
    orderBy: [
      { zohoItemId: 'asc' },
      { warehouseId: 'asc' },
      { locationId: 'asc' },
      { variantKey: 'asc' },
      { containerKey: 'asc' },
    ],
    take: SNAPSHOT_LIMIT + 1,
  });
  const truncated = rows.length > SNAPSHOT_LIMIT;
  const items = rows.slice(0, SNAPSHOT_LIMIT);
  const itemIds = [
    ...new Set([
      ...(filter.zohoItemId ? [filter.zohoItemId] : []),
      ...items.map((i) => i.zohoItemId),
    ]),
  ];
  const [profiles, products, locations, warehouses, claims] = await Promise.all([
    db.productInventoryProfile.findMany({ where: { zohoItemId: { in: itemIds } } }),
    db.product.findMany({
      where: { zohoItemId: { in: itemIds } },
      select: {
        zohoItemId: true,
        name: true,
        sku: true,
        unit: true,
        stockOnHand: true,
        availableStock: true,
      },
    }),
    db.storageLocation.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.locationId))] } },
      select: { id: true, code: true },
    }),
    db.warehouse.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.warehouseId))] } },
      select: { id: true, name: true },
    }),
    filter.locationId
      ? Promise.resolve([] as Array<{ zohoItemId: string; quantity: Prisma.Decimal }>)
      : db.legacyCommitmentClaim.findMany({
          where: {
            zohoItemId: { in: itemIds },
            status: 'claimed',
            ...(filter.warehouseId ? { warehouseId: filter.warehouseId } : {}),
          },
          select: { zohoItemId: true, quantity: true },
        }),
  ]);
  const profileBy = new Map(profiles.map((p) => [p.zohoItemId, p]));
  const productBy = new Map(products.map((p) => [p.zohoItemId, p]));
  const locationBy = new Map(locations.map((l) => [l.id, l.code]));
  const warehouseBy = new Map(warehouses.map((w) => [w.id, w.name]));

  const result: StockSnapshotProduct[] = itemIds.map((zohoItemId) => {
    const profile = profileBy.get(zohoItemId);
    const product = productBy.get(zohoItemId);
    const own = items.filter((i) => i.zohoItemId === zohoItemId);
    const usable = own.filter((i) => locationBy.get(i.locationId) !== SCRAP_LOCATION_CODE);
    const known = sumDecimals(usable.map((i) => i.knownQty));
    const reserved = sumDecimals(usable.map((i) => i.reserved));
    const blocked = sumDecimals(usable.map((i) => i.blocked));
    const assignedToProduction = sumDecimals(usable.map((i) => i.assignedToProduction));
    const legacyClaims = sumDecimals(
      claims.filter((c) => c.zohoItemId === zohoItemId).map((c) => c.quantity)
    );
    const confidence = toConfidenceLevel(profile?.confidence);
    return {
      zohoItemId,
      productName: product?.name ?? null,
      sku: product?.sku ?? null,
      baseUnit: profile
        ? toUnitProfile(profile).baseUnit
        : normalizeUnit(product?.unit) || DEFAULT_BASE_UNIT,
      confidence,
      confidenceLabel: CONFIDENCE_LABELS[confidence],
      totals: {
        known: qty(known),
        reserved: qty(reserved),
        blocked: qty(blocked),
        assignedToProduction: qty(assignedToProduction),
        legacyClaims: qty(legacyClaims),
        available: qty(
          computeAvailable({ known, reserved, blocked, assignedToProduction, legacyClaims })
        ),
      },
      zoho: {
        stockOnHand: product?.stockOnHand ? qty(product.stockOnHand) : null,
        availableStock: product?.availableStock ? qty(product.availableStock) : null,
      },
      items: own.map((item) =>
        toStockItemDTO(item, {
          locationCode: locationBy.get(item.locationId) ?? null,
          warehouseName: warehouseBy.get(item.warehouseId) ?? null,
          productName: product?.name ?? null,
          sku: product?.sku ?? null,
        })
      ),
    };
  });
  return { filter, products: result, truncated };
}
