/**
 * Pure rules of a delivery record (plan section 4.3):
 *
 * - what is still owed per allocation of a delivery order
 *   (`quantity − deliveredQuantity`, base unit);
 * - validation and summary of the delivered lines: short quantities make the
 *   delivery partial (the remainder becomes a child delivery order), more than
 *   owed or nothing at all is rejected;
 * - a delivery closes only with physical evidence (photo or signature whose
 *   file already reached storage).
 *
 * No Prisma, no server imports.
 */

/** Quantities are Decimal(18,4): compare with half of the last digit. */
export const QUANTITY_EPSILON = 0.00005;

export function roundQuantity(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export interface AllocationExpectation {
  allocationId: string;
  demandId: string;
  quantity: number;
  deliveredQuantity: number;
}

export interface DeliveredLineInput {
  allocationId: string;
  deliveredQty: number;
}

export interface DeliveryLineSummary {
  allocationId: string;
  demandId: string;
  expectedQty: number;
  deliveredQty: number;
  shortQty: number;
  fullyDelivered: boolean;
}

export interface DeliverySummary {
  lines: DeliveryLineSummary[];
  /** Every allocation received what it was owed. */
  complete: boolean;
  totalDelivered: number;
  totalShort: number;
  shortAllocationIds: string[];
}

export type DeliverySummaryErrorCode =
  | 'unknown_allocation'
  | 'duplicate_line'
  | 'invalid_quantity'
  | 'quantity_exceeds'
  | 'nothing_delivered';

export type DeliverySummaryResult =
  | { ok: true; summary: DeliverySummary }
  | { ok: false; code: DeliverySummaryErrorCode; message: string; allocationId?: string };

export function expectedQuantity(allocation: AllocationExpectation): number {
  return roundQuantity(Math.max(0, allocation.quantity - allocation.deliveredQuantity));
}

/** Allocations without a line count as nothing delivered (short). */
export function summarizeDelivery(
  expectations: AllocationExpectation[],
  lines: DeliveredLineInput[]
): DeliverySummaryResult {
  const byId = new Map(expectations.map((e) => [e.allocationId, e]));
  const delivered = new Map<string, number>();
  for (const line of lines) {
    if (!byId.has(line.allocationId)) {
      return {
        ok: false,
        code: 'unknown_allocation',
        allocationId: line.allocationId,
        message: 'Una línea entregada no pertenece a esta orden de entrega',
      };
    }
    if (delivered.has(line.allocationId)) {
      return {
        ok: false,
        code: 'duplicate_line',
        allocationId: line.allocationId,
        message: 'La misma línea aparece dos veces en la entrega',
      };
    }
    if (!Number.isFinite(line.deliveredQty) || line.deliveredQty < 0) {
      return {
        ok: false,
        code: 'invalid_quantity',
        allocationId: line.allocationId,
        message: 'La cantidad entregada debe ser un número mayor o igual a cero',
      };
    }
    delivered.set(line.allocationId, roundQuantity(line.deliveredQty));
  }

  const summaryLines: DeliveryLineSummary[] = [];
  for (const expectation of expectations) {
    const expectedQty = expectedQuantity(expectation);
    const deliveredQty = delivered.get(expectation.allocationId) ?? 0;
    if (deliveredQty > expectedQty + QUANTITY_EPSILON) {
      return {
        ok: false,
        code: 'quantity_exceeds',
        allocationId: expectation.allocationId,
        message: `Se registró ${deliveredQty} y sólo quedaban ${expectedQty} por entregar en esa línea`,
      };
    }
    const shortQty = roundQuantity(Math.max(0, expectedQty - deliveredQty));
    summaryLines.push({
      allocationId: expectation.allocationId,
      demandId: expectation.demandId,
      expectedQty,
      deliveredQty,
      shortQty,
      fullyDelivered: shortQty <= QUANTITY_EPSILON,
    });
  }

  const totalDelivered = roundQuantity(summaryLines.reduce((sum, l) => sum + l.deliveredQty, 0));
  if (totalDelivered <= QUANTITY_EPSILON) {
    return {
      ok: false,
      code: 'nothing_delivered',
      message: 'No se entregó nada: registra la parada como entrega fallida',
    };
  }
  const shortLines = summaryLines.filter((l) => !l.fullyDelivered);
  return {
    ok: true,
    summary: {
      lines: summaryLines,
      complete: shortLines.length === 0,
      totalDelivered,
      totalShort: roundQuantity(shortLines.reduce((sum, l) => sum + l.shortQty, 0)),
      shortAllocationIds: shortLines.map((l) => l.allocationId),
    },
  };
}

/** Storage statuses whose bytes already arrived (validation may still be running). */
export const EVIDENCE_READY_OBJECT_STATUSES = ['ready', 'validating'] as const;

/** Storage statuses that can never become evidence. */
export const EVIDENCE_INVALID_OBJECT_STATUSES = [
  'rejected',
  'aborted',
  'missing',
  'deleted',
] as const;

export function hasPhysicalEvidence(
  items: Array<{ kind: string; objectStatus: string | null }>
): boolean {
  return items.some(
    (item) =>
      (item.kind === 'photo' || item.kind === 'signature') &&
      item.objectStatus !== null &&
      (EVIDENCE_READY_OBJECT_STATUSES as readonly string[]).includes(item.objectStatus)
  );
}

/** New fulfilled quantity of a demand after a delivery and whether it is now complete. */
export function demandFulfillment(
  baseQuantity: number,
  fulfilledQuantity: number,
  added: number
): { fulfilledQuantity: number; fulfilled: boolean } {
  const next = roundQuantity(fulfilledQuantity + added);
  return { fulfilledQuantity: next, fulfilled: next + QUANTITY_EPSILON >= baseQuantity };
}

export interface LinkablePackageCandidate {
  id: string;
  /** Zoho item ids of the package lines (empty when its lines were not synced). */
  itemIds: readonly string[];
}

/**
 * Package to link automatically to a delivery order. A package whose lines
 * are exactly the items of the order wins when it is the only one; a package
 * without synced lines is only taken when it is the sole free package. Two
 * matches, or packages of other deliveries, are never guessed: Logística links
 * one explicitly (`delivery.link_package` with `packageId`). Pure.
 */
export function chooseLinkablePackage(
  candidates: readonly LinkablePackageCandidate[],
  orderItemIds: readonly string[]
): string | null {
  if (candidates.length === 0) return null;
  const wanted = new Set(orderItemIds.filter(Boolean));
  const sameItems = (itemIds: readonly string[]) => {
    const set = new Set(itemIds.filter(Boolean));
    return set.size > 0 && set.size === wanted.size && [...set].every((id) => wanted.has(id));
  };
  const matching = candidates.filter((candidate) => sameItems(candidate.itemIds));
  if (matching.length === 1) return matching[0].id;
  if (matching.length > 1) return null;
  if (candidates.length === 1 && candidates[0].itemIds.filter(Boolean).length === 0) {
    return candidates[0].id;
  }
  return null;
}
