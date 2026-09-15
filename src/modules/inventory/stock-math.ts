import { Prisma } from '@prisma/client';
import {
  PROMOTION_GOOD_COUNTS,
  isSignedKind,
  type ConfidenceLevel,
  type CountLineResolution,
  type MovementKind,
} from './inventory-types';

/**
 * Pure business rules of the progressive inventory (plan §3.2). No I/O.
 *
 * Quantities are `Prisma.Decimal` in the item's base unit with the scale of
 * the database columns (`Decimal(18,4)`):
 *
 *   known     = baseline + receipts + returns + produced − issued − consumed + adjustments
 *   available = known − reserved − blocked − assignedToProduction − legacyClaims
 *
 * Only CONTROLLED stock can be promised automatically; PROVISIONAL stock needs
 * an explicit human decision and a recent verification; UNCOUNTED and
 * DISPUTED stock is never reserved. Zoho's `stockOnHand` / `availableStock`
 * never enter these formulas.
 */

export type DecimalLike = Prisma.Decimal | number | string;

/** Scale of every quantity column. */
export const QTY_SCALE = 4;

export class StockMathError extends Error {
  constructor(
    readonly code: 'invalid_quantity' | 'invalid_unit',
    message: string
  ) {
    super(message);
    this.name = 'StockMathError';
  }
}

/** Decimal from a number/string/Decimal; null/undefined/'' → 0. Throws on non-finite input. */
export function dec(value: DecimalLike | null | undefined): Prisma.Decimal {
  if (value === null || value === undefined || value === '') return new Prisma.Decimal(0);
  let parsed: Prisma.Decimal;
  try {
    parsed = new Prisma.Decimal(value as Prisma.Decimal.Value);
  } catch {
    throw new StockMathError('invalid_quantity', `Cantidad inválida: ${String(value)}`);
  }
  if (!parsed.isFinite()) {
    throw new StockMathError('invalid_quantity', `Cantidad inválida: ${String(value)}`);
  }
  return parsed;
}

export type RoundingMode = 'nearest' | 'up' | 'down';

const ROUNDING: Record<RoundingMode, Prisma.Decimal.Rounding> = {
  nearest: Prisma.Decimal.ROUND_HALF_UP,
  up: Prisma.Decimal.ROUND_CEIL,
  down: Prisma.Decimal.ROUND_FLOOR,
};

/** Rounds to `decimals` (clamped to 0…4): nearest (half up), up (ceil) or down (floor). */
export function roundQty(
  value: DecimalLike,
  decimals: number = QTY_SCALE,
  mode: RoundingMode = 'nearest'
): Prisma.Decimal {
  const places = Math.max(
    0,
    Math.min(QTY_SCALE, Math.trunc(Number.isFinite(decimals) ? decimals : QTY_SCALE))
  );
  return dec(value).toDecimalPlaces(places, ROUNDING[mode]);
}

export function sumDecimals(values: ReadonlyArray<DecimalLike | null | undefined>): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, value) => acc.plus(dec(value)), new Prisma.Decimal(0));
}

export function maxDecimal(a: DecimalLike, b: DecimalLike): Prisma.Decimal {
  return Prisma.Decimal.max(dec(a), dec(b));
}

// ---------------------------------------------------------------------------
// Known / available
// ---------------------------------------------------------------------------

export interface StockCounters {
  baseline: DecimalLike;
  receipts: DecimalLike;
  returns: DecimalLike;
  produced: DecimalLike;
  issued: DecimalLike;
  consumed: DecimalLike;
  /** Signed. */
  adjustments: DecimalLike;
}

/** known = baseline + receipts + returns + produced − issued − consumed + adjustments */
export function computeKnown(counters: StockCounters): Prisma.Decimal {
  return roundQty(
    dec(counters.baseline)
      .plus(dec(counters.receipts))
      .plus(dec(counters.returns))
      .plus(dec(counters.produced))
      .minus(dec(counters.issued))
      .minus(dec(counters.consumed))
      .plus(dec(counters.adjustments))
  );
}

export interface AvailabilityInput {
  known: DecimalLike;
  reserved?: DecimalLike | null;
  blocked?: DecimalLike | null;
  assignedToProduction?: DecimalLike | null;
  legacyClaims?: DecimalLike | null;
}

/** available = known − reserved − blocked − assignedToProduction − legacyClaims (may be negative). */
export function computeAvailable(input: AvailabilityInput): Prisma.Decimal {
  return roundQty(
    dec(input.known)
      .minus(dec(input.reserved))
      .minus(dec(input.blocked))
      .minus(dec(input.assignedToProduction))
      .minus(dec(input.legacyClaims))
  );
}

/** Counter touched by each movement kind (transfers reuse receipts/issued). */
export const MOVEMENT_COUNTER: Record<MovementKind, keyof StockCounters | 'blocked'> = {
  baseline: 'baseline',
  receipt: 'receipts',
  transfer_in: 'receipts',
  return: 'returns',
  produce: 'produced',
  issue: 'issued',
  transfer_out: 'issued',
  consume: 'consumed',
  adjust: 'adjustments',
  block: 'blocked',
  unblock: 'blocked',
};

export interface StockState {
  baseline: Prisma.Decimal;
  receipts: Prisma.Decimal;
  returns: Prisma.Decimal;
  produced: Prisma.Decimal;
  issued: Prisma.Decimal;
  consumed: Prisma.Decimal;
  adjustments: Prisma.Decimal;
  reserved: Prisma.Decimal;
  blocked: Prisma.Decimal;
  assignedToProduction: Prisma.Decimal;
  knownQty: Prisma.Decimal;
}

export type StockStateSource = StockCounters & {
  reserved?: DecimalLike | null;
  blocked?: DecimalLike | null;
  assignedToProduction?: DecimalLike | null;
};

export function toStockState(row: StockStateSource): StockState {
  const state = {
    baseline: dec(row.baseline),
    receipts: dec(row.receipts),
    returns: dec(row.returns),
    produced: dec(row.produced),
    issued: dec(row.issued),
    consumed: dec(row.consumed),
    adjustments: dec(row.adjustments),
    reserved: dec(row.reserved),
    blocked: dec(row.blocked),
    assignedToProduction: dec(row.assignedToProduction),
    knownQty: new Prisma.Decimal(0),
  };
  state.knownQty = computeKnown(state);
  return state;
}

/** Available of one stock row (optionally minus legacy claims). */
export function itemAvailable(
  state: StockStateSource,
  legacyClaims: DecimalLike = 0
): Prisma.Decimal {
  return computeAvailable({
    known: computeKnown(state),
    reserved: state.reserved,
    blocked: state.blocked,
    assignedToProduction: state.assignedToProduction,
    legacyClaims,
  });
}

/**
 * Applies a movement to the counters and recomputes `knownQty`. `adjust` and
 * `baseline` take a signed non-zero quantity; every other kind a positive one.
 * Business validations (never negative, reservations…) belong to the caller.
 */
export function applyMovement(
  state: StockState,
  kind: MovementKind,
  quantity: DecimalLike
): StockState {
  const q = roundQty(quantity);
  if (isSignedKind(kind) ? q.isZero() : q.lte(0)) {
    throw new StockMathError(
      'invalid_quantity',
      isSignedKind(kind)
        ? 'La cantidad del ajuste no puede ser cero'
        : 'La cantidad debe ser mayor que cero'
    );
  }
  const next: StockState = { ...state };
  const counter = MOVEMENT_COUNTER[kind];
  if (kind === 'unblock') next.blocked = roundQty(state.blocked.minus(q));
  else next[counter] = roundQty(state[counter].plus(q));
  next.knownQty = computeKnown(next);
  return next;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export interface UnitConversion {
  unit: string;
  /** Base units per one `unit`. */
  factor: DecimalLike;
  /** Decimal places allowed for quantities in this unit (0…4). */
  decimals?: number;
}

export interface UnitProfile {
  baseUnit: string;
  conversions: readonly UnitConversion[];
}

const UNIT_SYNONYMS: Record<string, string> = {};

function synonyms(canonical: string, list: string[]): void {
  for (const name of [canonical, ...list]) UNIT_SYNONYMS[name] = canonical;
}

synonyms('pz', [
  'pza',
  'pzas',
  'pzs',
  'pieza',
  'piezas',
  'pc',
  'pcs',
  'unidad',
  'unidades',
  'und',
  'unds',
  'ud',
  'uds',
  'ea',
  'each',
  'unit',
  'units',
]);
synonyms('m2', [
  'mt2',
  'mts2',
  'm^2',
  'metro2',
  'metros2',
  'metrocuadrado',
  'metroscuadrados',
  'sqm',
]);
synonyms('m3', ['mt3', 'mts3', 'm^3', 'metro3', 'metros3', 'metrocubico', 'metroscubicos']);
synonyms('m', ['mt', 'mts', 'metro', 'metros']);
synonyms('kg', ['kgs', 'kilo', 'kilos', 'kilogramo', 'kilogramos']);
synonyms('g', ['gr', 'grs', 'gramo', 'gramos']);
synonyms('l', ['lt', 'lts', 'litro', 'litros']);
synonyms('ton', ['tons', 'tonelada', 'toneladas']);
synonyms('caja', ['cajas', 'cja', 'cjas', 'cj']);
synonyms('rollo', ['rollos']);
synonyms('placa', ['placas']);
synonyms('hoja', ['hojas']);
synonyms('juego', ['juegos', 'jgo', 'jgos']);
synonyms('par', ['pares']);
synonyms('bulto', ['bultos']);
synonyms('saco', ['sacos']);
synonyms('cubeta', ['cubetas']);
synonyms('galon', ['galones', 'gal']);
synonyms('tramo', ['tramos']);
synonyms('paquete', ['paquetes', 'paq', 'pqt']);
synonyms('tarima', ['tarimas', 'pallet', 'pallets']);

/** Decimal places by canonical unit when the profile does not say otherwise. */
export const UNIT_DEFAULT_DECIMALS: Readonly<Record<string, number>> = {
  pz: 0,
  caja: 0,
  rollo: 0,
  placa: 0,
  hoja: 0,
  juego: 0,
  par: 0,
  bulto: 0,
  saco: 0,
  cubeta: 0,
  tramo: 0,
  paquete: 0,
  tarima: 0,
  g: 0,
  m: 2,
  m2: 2,
  l: 2,
  galon: 2,
  m3: 3,
  kg: 3,
  ton: 3,
};

/** `'M²'` → `'m2'`, `'PZA.'` → `'pz'`, `'Metros'` → `'m'`; unknown units keep their cleaned form. */
export function normalizeUnit(unit: string | null | undefined): string {
  const cleaned = String(unit ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .toLowerCase()
    .replace(/[^a-z0-9^]/g, '')
    .slice(0, 30);
  if (!cleaned) return '';
  return UNIT_SYNONYMS[cleaned] ?? cleaned;
}

export function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeUnit(a);
  return left !== '' && left === normalizeUnit(b);
}

function findConversion(unit: string, profile: UnitProfile): UnitConversion | undefined {
  const target = normalizeUnit(unit);
  return profile.conversions.find((entry) => normalizeUnit(entry.unit) === target);
}

/** Decimal places for quantities in `unit`: explicit in the profile, default table, else 4. */
export function unitDecimals(unit: string, profile?: UnitProfile | null): number {
  const explicit = profile ? findConversion(unit, profile)?.decimals : undefined;
  if (typeof explicit === 'number' && Number.isInteger(explicit)) {
    return Math.max(0, Math.min(QTY_SCALE, explicit));
  }
  return UNIT_DEFAULT_DECIMALS[normalizeUnit(unit)] ?? QTY_SCALE;
}

/** Base units per one `unit`. Throws `invalid_unit` when the profile has no conversion. */
export function conversionFactor(
  unit: string | null | undefined,
  profile: UnitProfile
): Prisma.Decimal {
  const target = normalizeUnit(unit);
  if (!target || target === normalizeUnit(profile.baseUnit)) return new Prisma.Decimal(1);
  const entry = findConversion(target, profile);
  if (!entry) {
    throw new StockMathError(
      'invalid_unit',
      `La unidad "${String(unit)}" no tiene conversión a ${profile.baseUnit}`
    );
  }
  const factor = dec(entry.factor);
  if (factor.lte(0)) {
    throw new StockMathError('invalid_unit', `El factor de la unidad "${entry.unit}" es inválido`);
  }
  return factor;
}

/** Quantity in `unit` → base unit, rounded to the base unit's precision. Empty unit = base. */
export function toBase(
  quantity: DecimalLike,
  unit: string | null | undefined,
  profile: UnitProfile,
  mode: RoundingMode = 'nearest'
): Prisma.Decimal {
  const factor = conversionFactor(unit, profile);
  return roundQty(dec(quantity).times(factor), unitDecimals(profile.baseUnit, profile), mode);
}

/** Base quantity → `unit`, rounded to that unit's precision (use `up` for "units needed"). */
export function fromBase(
  quantityBase: DecimalLike,
  unit: string | null | undefined,
  profile: UnitProfile,
  mode: RoundingMode = 'nearest'
): Prisma.Decimal {
  const factor = conversionFactor(unit, profile);
  const target = normalizeUnit(unit) || profile.baseUnit;
  return roundQty(dec(quantityBase).dividedBy(factor), unitDecimals(target, profile), mode);
}

/** Lenient reader of `ProductInventoryProfile.conversions` (invalid entries are skipped). */
export function parseConversions(value: unknown): UnitConversion[] {
  if (!Array.isArray(value)) return [];
  const out: UnitConversion[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const unit = normalizeUnit(typeof entry.unit === 'string' ? entry.unit : '');
    if (!unit || seen.has(unit)) continue;
    let factor: Prisma.Decimal;
    try {
      factor = dec(entry.factor as DecimalLike);
    } catch {
      continue;
    }
    if (factor.lte(0)) continue;
    const decimals =
      typeof entry.decimals === 'number' && Number.isInteger(entry.decimals)
        ? Math.max(0, Math.min(QTY_SCALE, entry.decimals))
        : undefined;
    seen.add(unit);
    out.push({ unit, factor: factor.toString(), ...(decimals !== undefined ? { decimals } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/** |counted − expected| ≤ |expected| × tolerancePct / 100 (expected 0 ⇒ exact). */
export function withinTolerance(
  expected: DecimalLike,
  counted: DecimalLike,
  tolerancePct: DecimalLike
): boolean {
  const pct = Prisma.Decimal.max(dec(tolerancePct), 0);
  const allowed = roundQty(dec(expected).abs().times(pct).dividedBy(100));
  const diff = roundQty(dec(counted).minus(dec(expected)).abs());
  return diff.lte(allowed);
}

/** counted − expected, rounded to the column scale. */
export function countDifference(expected: DecimalLike, counted: DecimalLike): Prisma.Decimal {
  return roundQty(dec(counted).minus(dec(expected)));
}

/**
 * Promotion to CONTROLLED: the item is PROVISIONAL, this count is within
 * tolerance, it makes `PROMOTION_GOOD_COUNTS` consecutive good counts and no
 * dispute is open.
 */
export function promotionEligible(
  profile: { confidence: ConfidenceLevel; consecutiveGoodCounts: number },
  lineWithinTolerance: boolean,
  openDisputes: number
): boolean {
  return (
    profile.confidence === 'PROVISIONAL' &&
    lineWithinTolerance &&
    openDisputes === 0 &&
    Math.max(0, profile.consecutiveGoodCounts) + 1 >= PROMOTION_GOOD_COUNTS
  );
}

export interface CountLineInput {
  expected: DecimalLike;
  counted: DecimalLike;
}

export interface CountCloseInput {
  confidence: ConfidenceLevel;
  consecutiveGoodCounts: number;
  tolerancePct: DecimalLike;
  /** Lines of one item (product) in the count being closed. */
  lines: readonly CountLineInput[];
  /** Disputed lines of the same item in other counts. */
  openDisputesOutsideCount: number;
  /** Whether the closer may apply adjustments (`inventory.adjust` or a system actor). */
  canAdjust: boolean;
}

export interface CountLineOutcome {
  diff: Prisma.Decimal;
  withinTolerance: boolean;
  resolution: CountLineResolution;
  /** Movement to record for the difference (null: none). */
  movement: 'baseline' | 'adjust' | null;
  /** Whether the line verifies the stock (updates `lastCountedAt`). */
  verified: boolean;
}

export interface CountCloseOutcome {
  baseline: boolean;
  previousConfidence: ConfidenceLevel;
  nextConfidence: ConfidenceLevel;
  nextConsecutiveGoodCounts: number;
  promoted: boolean;
  disputed: boolean;
  /** A DISPUTED item without open disputes returned to PROVISIONAL. */
  disputeCleared: boolean;
  lines: CountLineOutcome[];
}

/**
 * Decides what closing a count does to one item (plan §3.3, `stock.count`):
 *
 * - UNCOUNTED: every line becomes a `baseline` movement of its difference;
 *   the item becomes PROVISIONAL with one good count.
 * - Any line out of tolerance: those lines are `disputed`; the item becomes
 *   DISPUTED with the counter at 0 (the caller opens a `count_dispute`).
 * - Otherwise: lines without difference are `accepted`; differences are
 *   `adjusted` when the closer can adjust, else `pending` (work item); the
 *   counter grows and a PROVISIONAL item with 2 good counts and no open
 *   disputes becomes CONTROLLED.
 */
export function evaluateCountClose(input: CountCloseInput): CountCloseOutcome {
  const previous = input.confidence;
  const counter = Math.max(0, Math.trunc(input.consecutiveGoodCounts));
  const measured = input.lines.map((line) => ({
    diff: countDifference(line.expected, line.counted),
    withinTolerance: withinTolerance(line.expected, line.counted, input.tolerancePct),
  }));
  const base = {
    previousConfidence: previous,
    promoted: false,
    disputed: false,
    disputeCleared: false,
  };

  if (input.lines.length === 0) {
    return {
      ...base,
      baseline: false,
      nextConfidence: previous,
      nextConsecutiveGoodCounts: counter,
      lines: [],
    };
  }

  if (previous === 'UNCOUNTED') {
    return {
      ...base,
      baseline: true,
      nextConfidence: 'PROVISIONAL',
      nextConsecutiveGoodCounts: 1,
      lines: measured.map((m) => ({
        ...m,
        resolution: 'accepted',
        movement: m.diff.isZero() ? null : 'baseline',
        verified: true,
      })),
    };
  }

  const lines: CountLineOutcome[] = measured.map((m) => {
    if (!m.withinTolerance)
      return { ...m, resolution: 'disputed', movement: null, verified: false };
    if (m.diff.isZero()) return { ...m, resolution: 'accepted', movement: null, verified: true };
    return input.canAdjust
      ? { ...m, resolution: 'adjusted', movement: 'adjust', verified: true }
      : { ...m, resolution: 'pending', movement: null, verified: true };
  });

  if (lines.some((line) => line.resolution === 'disputed')) {
    return {
      ...base,
      baseline: false,
      disputed: true,
      nextConfidence: 'DISPUTED',
      nextConsecutiveGoodCounts: 0,
      lines,
    };
  }

  if (previous === 'DISPUTED') {
    const cleared = input.openDisputesOutsideCount === 0;
    return {
      ...base,
      baseline: false,
      disputeCleared: cleared,
      nextConfidence: cleared ? 'PROVISIONAL' : 'DISPUTED',
      nextConsecutiveGoodCounts: cleared ? 1 : 0,
      lines,
    };
  }

  const promoted = promotionEligible(
    { confidence: previous, consecutiveGoodCounts: counter },
    true,
    input.openDisputesOutsideCount
  );
  return {
    ...base,
    baseline: false,
    promoted,
    nextConfidence: promoted ? 'CONTROLLED' : previous,
    nextConsecutiveGoodCounts: counter + 1,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Promises and reservations
// ---------------------------------------------------------------------------

/** Automatic promise: only CONTROLLED stock with enough availability. */
export function canPromise(
  confidence: ConfidenceLevel,
  available: DecimalLike,
  quantity: DecimalLike
): boolean {
  const q = dec(quantity);
  return confidence === 'CONTROLLED' && q.gt(0) && dec(available).gte(q);
}

/** Whether the last verification is within `maxHours` of `now`. */
export function isVerificationRecent(
  lastVerifiedAt: Date | null | undefined,
  now: Date,
  maxHours: number
): boolean {
  if (!lastVerifiedAt) return false;
  const age = now.getTime() - lastVerifiedAt.getTime();
  return age <= Math.max(0, maxHours) * 3_600_000;
}

export type ReservationRejectionCode =
  | 'invalid_quantity'
  | 'stock_uncounted'
  | 'stock_disputed'
  | 'provisional_not_allowed'
  | 'provisional_verification_stale'
  | 'insufficient_stock';

export interface ReservationDecisionInput {
  confidence: ConfidenceLevel;
  /** Available of the group being reserved (items minus legacy claims). */
  available: DecimalLike;
  quantity: DecimalLike;
  /** Explicit human decision to promise PROVISIONAL stock. */
  allowProvisional?: boolean;
  lastVerifiedAt?: Date | null;
  now: Date;
  provisionalMaxHours: number;
  /**
   * The quantity is backed by receipt/production movements of this very
   * allocation: the goods are physically in, so the item's confidence does not
   * block promising them (the availability check still applies).
   */
  receiptBacked?: boolean;
}

export type ReservationDecision =
  | { ok: true; provisional: boolean }
  | { ok: false; code: ReservationRejectionCode; message: string; shortfall: Prisma.Decimal };

/** Decides whether a reservation may be taken (never below zero, confidence rules of §3.3 and §10). */
export function evaluateReservation(input: ReservationDecisionInput): ReservationDecision {
  const quantity = roundQty(input.quantity);
  const available = roundQty(input.available);
  const shortfall = Prisma.Decimal.max(quantity.minus(Prisma.Decimal.max(available, 0)), 0);
  const reject = (code: ReservationRejectionCode, message: string): ReservationDecision => ({
    ok: false,
    code,
    message,
    shortfall,
  });
  if (quantity.lte(0))
    return reject('invalid_quantity', 'La cantidad a reservar debe ser mayor que cero');
  if (input.receiptBacked) {
    if (available.lt(quantity)) {
      return reject(
        'insufficient_stock',
        `Existencia insuficiente: disponible ${available.toString()}, solicitado ${quantity.toString()}`
      );
    }
    return { ok: true, provisional: false };
  }
  if (input.confidence === 'UNCOUNTED') {
    return reject(
      'stock_uncounted',
      'El artículo no se ha contado; haz un conteo antes de reservar'
    );
  }
  if (input.confidence === 'DISPUTED') {
    return reject(
      'stock_disputed',
      'El artículo tiene una diferencia de conteo abierta; resuélvela antes de reservar'
    );
  }
  const provisional = input.confidence === 'PROVISIONAL';
  if (provisional && !input.allowProvisional) {
    return reject(
      'provisional_not_allowed',
      'La existencia es provisional: reservarla requiere una decisión explícita'
    );
  }
  if (
    provisional &&
    !isVerificationRecent(input.lastVerifiedAt, input.now, input.provisionalMaxHours)
  ) {
    return reject(
      'provisional_verification_stale',
      `La última verificación tiene más de ${input.provisionalMaxHours} horas; vuelve a contar antes de reservar`
    );
  }
  if (available.lt(quantity)) {
    return reject(
      'insufficient_stock',
      `Existencia insuficiente: disponible ${available.toString()}, solicitado ${quantity.toString()}`
    );
  }
  return { ok: true, provisional };
}

export interface SplittableItem {
  id: string;
  available: DecimalLike;
  /** Preferred when several rows can cover the whole quantity (e.g. the location asked for). */
  preferred?: boolean;
}

/**
 * Distributes a quantity across stock rows. One row covering everything is
 * preferred (preferred rows first, then the smallest sufficient one, so big
 * rolls stay whole); otherwise the largest rows are taken first. Returns null
 * when the rows cannot cover the quantity.
 */
export function planReservationSplit(
  items: readonly SplittableItem[],
  quantity: DecimalLike
): Array<{ id: string; quantity: Prisma.Decimal }> | null {
  const target = roundQty(quantity);
  if (target.lte(0)) return [];
  const usable = items
    .map((item) => ({
      id: item.id,
      available: roundQty(item.available),
      preferred: Boolean(item.preferred),
    }))
    .filter((item) => item.available.gt(0));

  const covering = usable
    .filter((item) => item.available.gte(target))
    .sort((a, b) => {
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
      const c = a.available.comparedTo(b.available);
      return c !== 0 ? c : a.id.localeCompare(b.id);
    });
  if (covering.length > 0) return [{ id: covering[0].id, quantity: target }];

  const total = sumDecimals(usable.map((item) => item.available));
  if (total.lt(target)) return null;
  const parts: Array<{ id: string; quantity: Prisma.Decimal }> = [];
  let remaining = target;
  for (const item of [...usable].sort((a, b) => {
    const c = b.available.comparedTo(a.available);
    return c !== 0 ? c : a.id.localeCompare(b.id);
  })) {
    if (remaining.lte(0)) break;
    const take = Prisma.Decimal.min(item.available, remaining);
    parts.push({ id: item.id, quantity: take });
    remaining = remaining.minus(take);
  }
  return parts;
}
