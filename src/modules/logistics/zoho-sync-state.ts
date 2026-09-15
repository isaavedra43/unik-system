/**
 * Pure rules of the Zoho mirror of a delivery order (plan sections 4.2 and 6.3).
 *
 * `DeliveryOrder.zohoSyncState` follows "write → read back → reconcile":
 *
 *   not_required ─ship_requested→ pending_write ─(Zoho confirms)→ readback_ok
 *                                   │  └─(local patch: API budget)→ written ─(sweep)→ readback_ok | readback_mismatch
 *                                   └─(retries exhausted)→ failed ─(sweep reads a matching shipment)→ readback_ok
 *   readback_ok | readback_mismatch ─delivery_write_requested→ delivered_pending_write → delivered_written
 *   any shipment state ─cancel_requested→ pending_write (status cancelled) ─shipment_cancelled→ not_required
 *
 * Zoho is the authority of the package: when the read-back differs from what
 * UNIK asked to write, the visible values are Zoho's and a human decides
 * whether to write again. No Prisma, no server imports.
 */

export const ZOHO_SYNC_STATES = [
  'not_required',
  'pending_write',
  'written',
  'readback_ok',
  'readback_mismatch',
  'delivered_pending_write',
  'delivered_written',
  'failed',
] as const;
export type ZohoSyncState = (typeof ZOHO_SYNC_STATES)[number];

export const ZOHO_SYNC_STATE_LABELS: Record<ZohoSyncState, string> = {
  not_required: 'Sin escritura en Zoho',
  pending_write: 'Escritura pendiente en Zoho',
  written: 'Escrito; falta releer Zoho',
  readback_ok: 'Confirmado por Zoho',
  readback_mismatch: 'Zoho devolvió otros valores',
  delivered_pending_write: 'Entrega pendiente de marcar en Zoho',
  delivered_written: 'Entrega marcada en Zoho',
  failed: 'Falló la escritura en Zoho',
};

export function isZohoSyncState(value: unknown): value is ZohoSyncState {
  return typeof value === 'string' && (ZOHO_SYNC_STATES as readonly string[]).includes(value);
}

export const ZOHO_SYNC_EVENTS = [
  'ship_requested',
  'write_applied_locally',
  'readback_matched',
  'readback_mismatched',
  'write_failed',
  'delivery_write_requested',
  'delivery_written',
  'cancel_requested',
  'shipment_cancelled',
] as const;
export type ZohoSyncEvent = (typeof ZOHO_SYNC_EVENTS)[number];

/** States in which a shipment order exists, is being written or was attempted. */
const SHIPMENT_STATES: readonly ZohoSyncState[] = [
  'pending_write',
  'written',
  'readback_ok',
  'readback_mismatch',
  'failed',
];

export const ZOHO_SYNC_TRANSITIONS: Record<
  ZohoSyncEvent,
  { from: readonly ZohoSyncState[]; to: ZohoSyncState }
> = {
  ship_requested: { from: ['not_required', ...SHIPMENT_STATES], to: 'pending_write' },
  write_applied_locally: { from: ['pending_write', 'written'], to: 'written' },
  readback_matched: { from: SHIPMENT_STATES, to: 'readback_ok' },
  readback_mismatched: { from: SHIPMENT_STATES, to: 'readback_mismatch' },
  write_failed: {
    from: ['pending_write', 'written', 'failed', 'delivered_pending_write'],
    to: 'failed',
  },
  // `not_required` too: the package may carry a shipment created by hand in Zoho.
  delivery_write_requested: {
    from: ['not_required', ...SHIPMENT_STATES, 'delivered_pending_write'],
    to: 'delivered_pending_write',
  },
  delivery_written: {
    from: ['delivered_pending_write', 'delivered_written', 'failed'],
    to: 'delivered_written',
  },
  cancel_requested: { from: SHIPMENT_STATES, to: 'pending_write' },
  shipment_cancelled: { from: ['not_required', ...SHIPMENT_STATES], to: 'not_required' },
};

export type ZohoSyncTransition =
  | { ok: true; state: ZohoSyncState; changed: boolean }
  | { ok: false; from: string; event: ZohoSyncEvent; message: string };

/** Applies an event to the current state; never throws. */
export function transitionZohoSync(from: string, event: ZohoSyncEvent): ZohoSyncTransition {
  const rule = ZOHO_SYNC_TRANSITIONS[event];
  if (!isZohoSyncState(from) || !rule.from.includes(from)) {
    const label = isZohoSyncState(from) ? ZOHO_SYNC_STATE_LABELS[from] : from;
    return {
      ok: false,
      from,
      event,
      message: `La sincronización con Zoho no admite este cambio desde "${label}"`,
    };
  }
  return { ok: true, state: rule.to, changed: rule.to !== from };
}

export type ZohoOperation = 'ship' | 'mark_delivered' | 'cancel_shipment';

export const ZOHO_OPERATION_LABELS: Record<ZohoOperation, string> = {
  ship: 'crear la orden de envío',
  mark_delivered: 'marcar la entrega',
  cancel_shipment: 'cancelar la orden de envío',
};

/** Write still owed to Zoho for a delivery order, derived from its status and sync state. */
export function pendingZohoOperation(status: string, syncState: string): ZohoOperation | null {
  if (syncState === 'delivered_pending_write') return 'mark_delivered';
  if (syncState !== 'pending_write') return null;
  return status === 'cancelled' ? 'cancel_shipment' : 'ship';
}

/** Which write failed for a delivery order in `failed`. */
export function failedZohoOperation(status: string, syncState: string): ZohoOperation | null {
  if (syncState !== 'failed') return null;
  if (status === 'cancelled') return 'cancel_shipment';
  if (status === 'delivered' || status === 'partially_delivered') return 'mark_delivered';
  return 'ship';
}

/** States the 30-minute sweep re-reads from Zoho. */
export function needsZohoReadback(syncState: string): boolean {
  return syncState === 'written' || syncState === 'readback_mismatch' || syncState === 'failed';
}

// ---------------------------------------------------------------------------
// Read-back comparison
// ---------------------------------------------------------------------------

/** What UNIK asked Zoho to store (`DeliveryOrder.shipmentInput`). */
export interface ShipmentExpectation {
  carrier: string;
  /** YYYY-MM-DD */
  shipmentDate: string;
  trackingNumber: string | null;
}

/** What the package row holds after the write (Zoho read-back, local patch or mock). */
export interface ShipmentReadback {
  carrier: string | null;
  shipmentDate: string | null;
  trackingNumber: string | null;
  zohoShipmentId: string | null;
  shipmentNumber?: string | null;
  status?: string | null;
}

/** zoho = detail re-read from Zoho; local = patched locally (API budget); mock = ZOHO_BOOKS_MOCK. */
export type ReadbackSource = 'zoho' | 'local' | 'mock';

export type ShipmentField = 'carrier' | 'shipmentDate' | 'trackingNumber';

export const SHIPMENT_FIELD_LABELS: Record<ShipmentField, string> = {
  carrier: 'Transportista',
  shipmentDate: 'Fecha de envío',
  trackingNumber: 'Número de guía',
};

export interface ShipmentDifference {
  field: ShipmentField;
  expected: string | null;
  actual: string | null;
}

export function normalizeCarrier(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeTracking(value: string | null | undefined): string | null {
  const cleaned = (value ?? '').replace(/\s+/g, '').toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}

/** 'YYYY-MM-DD' from an ISO string or a Date (UTC day, as Zoho dates are stored at midnight UTC). */
export function toIsoDay(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1] : null;
}

/** Compares carrier (accent/case-insensitive), day and tracking (only when UNIK sent one). */
export function compareShipment(
  expected: ShipmentExpectation,
  readback: ShipmentReadback
): { matches: boolean; differences: ShipmentDifference[] } {
  const differences: ShipmentDifference[] = [];
  if (normalizeCarrier(expected.carrier) !== normalizeCarrier(readback.carrier)) {
    differences.push({ field: 'carrier', expected: expected.carrier, actual: readback.carrier });
  }
  const expectedDay = toIsoDay(expected.shipmentDate);
  const actualDay = toIsoDay(readback.shipmentDate);
  if (expectedDay !== actualDay) {
    differences.push({ field: 'shipmentDate', expected: expectedDay, actual: actualDay });
  }
  const expectedTracking = normalizeTracking(expected.trackingNumber);
  if (
    expectedTracking !== null &&
    expectedTracking !== normalizeTracking(readback.trackingNumber)
  ) {
    differences.push({
      field: 'trackingNumber',
      expected: expected.trackingNumber,
      actual: readback.trackingNumber,
    });
  }
  return { matches: differences.length === 0, differences };
}

export type ReadbackOutcome = 'awaiting_readback' | 'not_written' | 'match' | 'mismatch';

/**
 * Outcome of a write:
 * - a local patch is not Zoho's word → `awaiting_readback` (stays pending_external);
 * - no shipment order in the package → `not_written`;
 * - otherwise the comparison decides `match` / `mismatch`.
 */
export function evaluateShipmentReadback(
  expected: ShipmentExpectation,
  readback: ShipmentReadback,
  source: ReadbackSource
): ReadbackOutcome {
  if (source === 'local') return 'awaiting_readback';
  if (!readback.zohoShipmentId) return 'not_written';
  return compareShipment(expected, readback).matches ? 'match' : 'mismatch';
}

/**
 * Where the package values come from after `shipPackage`: in mock mode the DB is
 * the simulated Zoho; otherwise only a detail fetched after the write started is
 * Zoho's read-back (the local patch clears `lastDetailFetchedAt`).
 */
export function readbackSource(input: {
  mock: boolean;
  lastDetailFetchedAt: Date | null;
  writeStartedAt: Date;
  toleranceMs?: number;
}): ReadbackSource {
  if (input.mock) return 'mock';
  if (!input.lastDetailFetchedAt) return 'local';
  const tolerance = input.toleranceMs ?? 5_000;
  return input.lastDetailFetchedAt.getTime() >= input.writeStartedAt.getTime() - tolerance
    ? 'zoho'
    : 'local';
}

/** Human summary of the differences for incidents and work items. */
export function describeDifferences(differences: ShipmentDifference[]): string {
  return differences
    .map(
      (d) =>
        `${SHIPMENT_FIELD_LABELS[d.field]}: UNIK pidió "${d.expected ?? 'vacío'}" y Zoho tiene "${d.actual ?? 'vacío'}"`
    )
    .join('; ');
}
