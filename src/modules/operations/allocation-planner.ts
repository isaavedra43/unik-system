import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  dec,
  isVerificationRecent,
  roundQty,
  type DecimalLike,
} from '@/modules/inventory/stock-math';
import { ALLOCATION_SOURCES, type AllocationSource } from './types';

/**
 * Pure allocation planner of a case demand (plan section 2.3,
 * `planAllocations(demand, availability, profile, decision?)`).
 *
 * The uncovered base quantity of a demand (base quantity minus what its
 * active allocations already cover) is split:
 *
 * 1. First, available stock that can be promised: CONTROLLED always;
 *    PROVISIONAL only with an explicit human decision (`allowProvisional`) and
 *    a verification within `provisionalMaxHours`. UNCOUNTED and DISPUTED stock
 *    is never promised.
 * 2. The rest goes to the decision's `remainderSource`, or to the profile's
 *    `defaultSource` (purchase when the default is stock).
 *
 * A decision may instead list the exact lines (`source` + base `quantity`);
 * they must add up to the uncovered quantity and never promise more stock
 * than allowed. `coveredByControlledStock` is the auto-approval rule of step
 * `plan_abastecimiento`: everything covered by CONTROLLED stock.
 */

export const PLAN_QTY_TOLERANCE = new Prisma.Decimal('0.0001');

const quantitySchema = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^\d+(\.\d+)?$/),
  ])
  .transform((value) => Number(value))
  .pipe(z.number().finite().positive().max(1e12));

const isoDateSchema = z
  .string()
  .trim()
  .refine((value) => /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value)), {
    message: 'Fecha inválida (usa formato ISO)',
  });

export const allocationPlanLineSchema = z
  .object({
    source: z.enum(ALLOCATION_SOURCES),
    /** Base units. */
    quantity: quantitySchema,
    expectedAt: isoDateSchema.nullish(),
  })
  .strict();

/** Shape of the `allocation_plan` result of the `plan_abastecimiento` work item. */
export const allocationDecisionSchema = z
  .object({
    /** Accept the proposal shown in the work item. */
    acceptProposal: z.boolean().optional(),
    lines: z.array(allocationPlanLineSchema).min(1).max(10).optional(),
    remainderSource: z.enum(ALLOCATION_SOURCES).optional(),
    /** Explicit decision to promise PROVISIONAL stock (humans only). */
    allowProvisional: z.boolean().optional(),
    expectedAt: isoDateSchema.nullish(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type AllocationDecision = z.output<typeof allocationDecisionSchema>;
export type AllocationDecisionInput = z.input<typeof allocationDecisionSchema>;

export interface PlanDemandInput {
  baseQuantity: DecimalLike;
  /** Σ of its active allocations (default 0). */
  allocatedQuantity?: DecimalLike | null;
}

export interface PlanAvailabilityInput {
  confidence: string;
  available: DecimalLike;
  lastVerifiedAt: Date | null;
}

export interface PlanProfileInput {
  defaultSource: string;
}

export interface PlanOptions {
  now: Date;
  provisionalMaxHours: number;
  /** True when a person takes the decision (required to promise PROVISIONAL stock). */
  humanDecision?: boolean;
}

export interface PlannedAllocationLine {
  source: AllocationSource;
  quantity: Prisma.Decimal;
  expectedAt: Date | null;
}

export type PlanRejectionCode =
  | 'plan_quantity_mismatch'
  | 'plan_stock_exceeded'
  | 'stock_not_promisable'
  | 'provisional_not_allowed'
  | 'provisional_verification_stale';

export type AllocationPlanResult =
  | {
      ok: true;
      uncovered: Prisma.Decimal;
      lines: PlannedAllocationLine[];
      stockQuantity: Prisma.Decimal;
      /** Stock that could be promised under the decision. */
      promisableStock: Prisma.Decimal;
      /** Base quantity not covered by stock (goes to purchase/manufacture/direct). */
      shortfall: Prisma.Decimal;
      coveredByControlledStock: boolean;
      requiresDecision: boolean;
      provisional: boolean;
      remainderSource: AllocationSource;
    }
  | { ok: false; code: PlanRejectionCode; message: string };

const zero = () => new Prisma.Decimal(0);

function isSource(value: string): value is AllocationSource {
  return (ALLOCATION_SOURCES as readonly string[]).includes(value);
}

/** Default destination of what stock cannot cover. */
export function defaultRemainderSource(profile: PlanProfileInput | null): AllocationSource {
  const source = profile?.defaultSource ?? 'stock';
  return isSource(source) && source !== 'stock' ? source : 'purchase';
}

function promisable(
  availability: PlanAvailabilityInput | null,
  decision: AllocationDecision | undefined,
  options: PlanOptions
): { quantity: Prisma.Decimal; provisional: boolean; blocked: PlanRejectionCode | null } {
  if (!availability)
    return { quantity: zero(), provisional: false, blocked: 'stock_not_promisable' };
  const available = Prisma.Decimal.max(roundQty(dec(availability.available)), 0);
  if (availability.confidence === 'CONTROLLED') {
    return { quantity: available, provisional: false, blocked: null };
  }
  if (availability.confidence === 'PROVISIONAL') {
    if (!decision?.allowProvisional || !options.humanDecision) {
      return { quantity: zero(), provisional: false, blocked: 'provisional_not_allowed' };
    }
    if (
      !isVerificationRecent(availability.lastVerifiedAt, options.now, options.provisionalMaxHours)
    ) {
      return { quantity: zero(), provisional: false, blocked: 'provisional_verification_stale' };
    }
    return { quantity: available, provisional: true, blocked: null };
  }
  return { quantity: zero(), provisional: false, blocked: 'stock_not_promisable' };
}

const REJECTION_MESSAGES: Record<PlanRejectionCode, string> = {
  plan_quantity_mismatch: 'Las cantidades del plan no suman lo que falta cubrir de la partida',
  plan_stock_exceeded: 'El plan toma más existencia de la disponible',
  stock_not_promisable:
    'La existencia de este artículo no se ha contado o está en disputa; no puede prometerse',
  provisional_not_allowed:
    'La existencia es provisional: prometerla requiere la decisión explícita de una persona',
  provisional_verification_stale:
    'La última verificación de la existencia provisional es muy antigua; vuelve a contar',
};

function reject(code: PlanRejectionCode, message = REJECTION_MESSAGES[code]): AllocationPlanResult {
  return { ok: false, code, message };
}

function parseExpectedAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function planAllocations(
  demand: PlanDemandInput,
  availability: PlanAvailabilityInput | null,
  profile: PlanProfileInput | null,
  decision: AllocationDecision | undefined,
  options: PlanOptions
): AllocationPlanResult {
  const base = Prisma.Decimal.max(roundQty(dec(demand.baseQuantity)), 0);
  const allocated = Prisma.Decimal.max(roundQty(dec(demand.allocatedQuantity ?? 0)), 0);
  const uncovered = Prisma.Decimal.max(base.minus(allocated), 0);
  const stock = promisable(availability, decision, options);
  const remainderSource = decision?.remainderSource ?? defaultRemainderSource(profile);
  const controlled = availability?.confidence === 'CONTROLLED';
  const coveredByControlledStock = uncovered.lte(PLAN_QTY_TOLERANCE)
    ? true
    : controlled && stock.quantity.gte(uncovered);
  const defaultExpectedAt = parseExpectedAt(decision?.expectedAt ?? null);

  if (uncovered.lte(PLAN_QTY_TOLERANCE)) {
    return {
      ok: true,
      uncovered: zero(),
      lines: [],
      stockQuantity: zero(),
      promisableStock: stock.quantity,
      shortfall: zero(),
      coveredByControlledStock: true,
      requiresDecision: false,
      provisional: false,
      remainderSource,
    };
  }

  if (decision?.lines && decision.lines.length > 0) {
    const merged = new Map<AllocationSource, PlannedAllocationLine>();
    for (const line of decision.lines) {
      const quantity = roundQty(dec(line.quantity));
      const current = merged.get(line.source);
      merged.set(line.source, {
        source: line.source,
        quantity: current ? current.quantity.plus(quantity) : quantity,
        expectedAt: current?.expectedAt ?? parseExpectedAt(line.expectedAt) ?? defaultExpectedAt,
      });
    }
    const lines = [...merged.values()];
    const total = lines.reduce((sum, line) => sum.plus(line.quantity), zero());
    if (total.minus(uncovered).abs().gt(PLAN_QTY_TOLERANCE)) {
      return reject(
        'plan_quantity_mismatch',
        `Las cantidades del plan suman ${total.toString()} y falta cubrir ${uncovered.toString()}`
      );
    }
    const stockLine = merged.get('stock');
    const stockQuantity = stockLine?.quantity ?? zero();
    if (stockQuantity.gt(stock.quantity.plus(PLAN_QTY_TOLERANCE))) {
      if (stock.blocked) return reject(stock.blocked);
      return reject(
        'plan_stock_exceeded',
        `El plan toma ${stockQuantity.toString()} de existencia y sólo hay ${stock.quantity.toString()} disponible`
      );
    }
    return {
      ok: true,
      uncovered,
      lines,
      stockQuantity,
      promisableStock: stock.quantity,
      shortfall: Prisma.Decimal.max(uncovered.minus(stockQuantity), 0),
      coveredByControlledStock,
      requiresDecision: !coveredByControlledStock,
      provisional: stock.provisional && stockQuantity.gt(0),
      remainderSource,
    };
  }

  if (
    decision?.allowProvisional &&
    availability?.confidence === 'PROVISIONAL' &&
    stock.blocked &&
    stock.blocked !== 'stock_not_promisable'
  ) {
    return reject(stock.blocked);
  }
  if (remainderSource === 'stock' && stock.quantity.lt(uncovered)) {
    return reject(
      'plan_stock_exceeded',
      `Sólo hay ${stock.quantity.toString()} disponible y falta cubrir ${uncovered.toString()}`
    );
  }
  const stockQuantity = Prisma.Decimal.min(stock.quantity, uncovered);
  const remainder = uncovered.minus(stockQuantity);
  const lines: PlannedAllocationLine[] = [];
  if (stockQuantity.gt(0))
    lines.push({ source: 'stock', quantity: stockQuantity, expectedAt: null });
  if (remainder.gt(PLAN_QTY_TOLERANCE)) {
    lines.push({ source: remainderSource, quantity: remainder, expectedAt: defaultExpectedAt });
  }
  return {
    ok: true,
    uncovered,
    lines,
    stockQuantity,
    promisableStock: stock.quantity,
    shortfall: remainder,
    coveredByControlledStock,
    requiresDecision: !coveredByControlledStock,
    provisional: stock.provisional && stockQuantity.gt(0),
    remainderSource,
  };
}

export const ALLOCATION_SOURCE_SPANISH: Record<AllocationSource, string> = {
  stock: 'existencia',
  purchase: 'compra',
  manufacture: 'manufactura',
  direct_supplier: 'entrega directa del proveedor',
};

/** "6 pz de existencia + 4 pz de compra" (for work item descriptions). */
export function describePlanLines(lines: readonly PlannedAllocationLine[], unit: string): string {
  if (lines.length === 0) return 'Nada por cubrir';
  return lines
    .map(
      (line) => `${line.quantity.toString()} ${unit} de ${ALLOCATION_SOURCE_SPANISH[line.source]}`
    )
    .join(' + ');
}
