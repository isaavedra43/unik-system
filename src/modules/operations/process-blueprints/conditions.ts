import type { StepScope } from '../types';

/**
 * Serializable conditions of the process blueprints (plan section 2.3).
 *
 * Blueprints reference conditions by key; the predicates below are pure
 * functions over `CaseFacts`, a plain snapshot the case engine builds from the
 * database (quantities in base units as numbers, dates as ISO strings). A key
 * never changes meaning once published: a different rule gets a new key.
 *
 * Pure module.
 */

export const QTY_EPSILON = 1e-6;

export interface AvailabilityFacts {
  /** UNCOUNTED | PROVISIONAL | CONTROLLED | DISPUTED */
  confidence: string;
  /** Available quantity in base units (may be negative when over-committed). */
  available: number;
  lastVerifiedAt: string | null;
}

export interface DemandFacts {
  id: string;
  status: string;
  zohoItemId: string | null;
  /** Base quantity the demand needs. */
  quantity: number;
  fulfilledQuantity: number;
  /** Σ quantity of its non-cancelled allocations. */
  allocatedQuantity: number;
  /** Availability of its warehouse (null when unknown or not needed). */
  availability: AvailabilityFacts | null;
}

export interface AllocationFacts {
  id: string;
  demandId: string;
  /** stock | purchase | manufacture | direct_supplier */
  source: string;
  status: string;
  quantity: number;
  deliveredQuantity: number;
  stockReservationId: string | null;
  /** An active StockReservation points at this allocation. */
  hasActiveReservation: boolean;
  linkedId: string | null;
  readyAt: string | null;
  expectedAt: string | null;
}

export interface DeliveryOrderFacts {
  id: string;
  status: string;
  mode: string;
  zohoSyncState: string;
  allocationIds: string[];
  plannedDate: string | null;
}

export interface CaseFacts {
  case: { id: string; status: string; deliveryMethod: string | null };
  salesOrder: {
    status: string | null;
    invoicedStatus: string | null;
    paidStatus: string | null;
    shippedStatus: string | null;
  } | null;
  demands: DemandFacts[];
  allocations: AllocationFacts[];
  deliveryOrders: DeliveryOrderFacts[];
}

export interface ConditionScope {
  scope: StepScope;
  demandId: string | null;
  allocationId: string | null;
}

export type ConditionPredicate = (facts: CaseFacts, scope: ConditionScope) => boolean;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOCATION_READY_STATUSES = ['ready', 'released', 'delivered'];
const ALLOCATION_RESERVED_STATUSES = ['reserved', 'ready', 'released', 'delivered'];
const ALLOCATION_REQUESTED_STATUSES = [
  'requested',
  'in_progress',
  'ready',
  'released',
  'delivered',
];
const DELIVERY_SHIPPING_MODES = ['own_fleet', 'carrier'];
const DELIVERY_CLOSED_OK = ['delivered', 'partially_delivered'];
/** Zoho read back the shipment (or its delivery write is owed on top of a shipment). */
const TRANSPORT_CONFIRMED_SYNC = ['readback_ok', 'delivered_pending_write', 'delivered_written'];

function demandOf(facts: CaseFacts, scope: ConditionScope): DemandFacts | null {
  if (scope.demandId) return facts.demands.find((d) => d.id === scope.demandId) ?? null;
  if (scope.allocationId) {
    const allocation = allocationOf(facts, scope);
    return allocation ? (facts.demands.find((d) => d.id === allocation.demandId) ?? null) : null;
  }
  return null;
}

function allocationOf(facts: CaseFacts, scope: ConditionScope): AllocationFacts | null {
  return scope.allocationId
    ? (facts.allocations.find((a) => a.id === scope.allocationId) ?? null)
    : null;
}

function activeAllocations(facts: CaseFacts): AllocationFacts[] {
  return facts.allocations.filter((a) => a.status !== 'cancelled');
}

function activeDemands(facts: CaseFacts): DemandFacts[] {
  return facts.demands.filter((d) => d.status !== 'cancelled');
}

function warehouseAllocations(facts: CaseFacts): AllocationFacts[] {
  return activeAllocations(facts).filter((a) => a.source !== 'direct_supplier');
}

function liveDeliveryOrders(facts: CaseFacts): DeliveryOrderFacts[] {
  return facts.deliveryOrders.filter((o) => o.status !== 'cancelled');
}

/** Base quantity of a demand not yet covered by allocations (never negative). */
export function uncoveredQuantity(
  demand: Pick<DemandFacts, 'quantity' | 'allocatedQuantity'>
): number {
  return Math.max(demand.quantity - demand.allocatedQuantity, 0);
}

function controlledStockCovers(demand: DemandFacts | null): boolean {
  if (!demand) return false;
  const uncovered = uncoveredQuantity(demand);
  if (uncovered <= QTY_EPSILON) return true;
  const availability = demand.availability;
  return (
    Boolean(availability) &&
    availability!.confidence === 'CONTROLLED' &&
    availability!.available + QTY_EPSILON >= uncovered
  );
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const PICKUP_PATTERNS = [
  /\brecoge\b/,
  /\brecoger\b/,
  /\brecolecc?ion\b/,
  /\bpick ?up\b/,
  /\ben bodega\b/,
  /\ben tienda\b/,
  /\ben sucursal\b/,
  /\bmostrador\b/,
];

/**
 * Whether Zoho's delivery method means the customer picks the order up
 * (`RECOGE EN BODEGA`, `Recolección en sucursal`, `Pickup`...).
 */
export function isCustomerPickup(deliveryMethod: string | null | undefined): boolean {
  const text = normalizeText(deliveryMethod);
  if (!text) return false;
  return PICKUP_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const CONDITIONS = {
  /** Step 1: CONTROLLED stock covers the uncovered quantity of the demand. */
  controlledStockSufficient: (facts, scope) => controlledStockCovers(demandOf(facts, scope)),
  /** Step 2: the whole uncovered quantity can be planned from CONTROLLED stock. */
  planCoveredByControlledStock: (facts, scope) => controlledStockCovers(demandOf(facts, scope)),
  /** Step 3: the allocation holds a reservation (or already moved past it). */
  allocationReserved: (facts, scope) => {
    const allocation = allocationOf(facts, scope);
    if (!allocation) return false;
    return (
      allocation.hasActiveReservation ||
      Boolean(allocation.stockReservationId) ||
      ALLOCATION_RESERVED_STATUSES.includes(allocation.status)
    );
  },
  /** Steps 4, 6 and 8: the request to the executing area exists. */
  allocationRequested: (facts, scope) => {
    const allocation = allocationOf(facts, scope);
    if (!allocation) return false;
    return (
      Boolean(allocation.linkedId) || ALLOCATION_REQUESTED_STATUSES.includes(allocation.status)
    );
  },
  /** Steps 5 and 7: the purchased or produced material is ready. */
  allocationReady: (facts, scope) => {
    const allocation = allocationOf(facts, scope);
    if (!allocation) return false;
    return Boolean(allocation.readyAt) || ALLOCATION_READY_STATUSES.includes(allocation.status);
  },
  /** Step 9: the supplier delivered the allocation. */
  directDeliveryConfirmed: (facts, scope) => {
    const allocation = allocationOf(facts, scope);
    if (!allocation) return false;
    return (
      allocation.status === 'delivered' ||
      (allocation.quantity > QTY_EPSILON &&
        allocation.deliveredQuantity + QTY_EPSILON >= allocation.quantity)
    );
  },
  /** Entry of steps 10, 11 and 13: something leaves from a UNIK warehouse. */
  hasWarehouseAllocations: (facts) => warehouseAllocations(facts).length > 0,
  /** Entry of step 12: warehouse material that UNIK must ship (not a customer pickup). */
  requiresTransport: (facts) => {
    if (warehouseAllocations(facts).length === 0) return false;
    if (isCustomerPickup(facts.case.deliveryMethod)) return false;
    const orders = liveDeliveryOrders(facts);
    if (orders.length > 0 && orders.every((o) => !DELIVERY_SHIPPING_MODES.includes(o.mode))) {
      return false;
    }
    return true;
  },
  /** Step 11: a live delivery order covers warehouse allocations. */
  deliveryPlanned: (facts) => {
    const ids = new Set(warehouseAllocations(facts).map((a) => a.id));
    return liveDeliveryOrders(facts).some((o) => o.allocationIds.some((id) => ids.has(id)));
  },
  /**
   * Step 12: Zoho confirmed the shipment of every live shipping delivery order.
   * Only the sync state counts: a UNIK status (a trip that started, a failed
   * write that kept `dispatched`) never confirms what Zoho has not read back.
   */
  transportConfirmed: (facts) => {
    const shipping = liveDeliveryOrders(facts).filter((o) =>
      DELIVERY_SHIPPING_MODES.includes(o.mode)
    );
    if (shipping.length === 0) return false;
    return shipping.every((o) => TRANSPORT_CONFIRMED_SYNC.includes(o.zohoSyncState));
  },
  /** Step 13: every live delivery order was delivered (fully or partially, no remainder open). */
  deliveriesClosed: (facts) => {
    const orders = liveDeliveryOrders(facts);
    return orders.length > 0 && orders.every((o) => DELIVERY_CLOSED_OK.includes(o.status));
  },
  /** Step 14: every active demand is fulfilled. */
  allDemandsFulfilled: (facts) => {
    const demands = activeDemands(facts);
    return (
      demands.length > 0 &&
      demands.every(
        (d) => d.status === 'fulfilled' || d.fulfilledQuantity + QTY_EPSILON >= d.quantity
      )
    );
  },
  /** Step 15: the synchronized sales order is invoiced and paid. */
  salesOrderInvoicedAndPaid: (facts) => {
    const order = facts.salesOrder;
    if (!order) return false;
    return (
      normalizeText(order.invoicedStatus) === 'invoiced' &&
      normalizeText(order.paidStatus) === 'paid'
    );
  },
} satisfies Record<string, ConditionPredicate>;

export type ConditionKey = keyof typeof CONDITIONS;

export const CONDITION_KEYS = Object.keys(CONDITIONS) as ConditionKey[];

export const CONDITION_LABELS: Record<ConditionKey, string> = {
  controlledStockSufficient: 'Existencia controlada suficiente',
  planCoveredByControlledStock: 'Todo se cubre con existencia controlada',
  allocationReserved: 'Existencia reservada',
  allocationRequested: 'Solicitud enviada al área',
  allocationReady: 'Material recibido o producido',
  directDeliveryConfirmed: 'Entrega del proveedor confirmada',
  hasWarehouseAllocations: 'Hay material que sale de bodega',
  requiresTransport: 'Requiere transporte',
  deliveryPlanned: 'Orden de entrega creada',
  transportConfirmed: 'Zoho confirmó el embarque',
  deliveriesClosed: 'Entregas registradas',
  allDemandsFulfilled: 'Todas las partidas entregadas',
  salesOrderInvoicedAndPaid: 'Orden facturada y pagada en Zoho',
};

export function isConditionKey(value: unknown): value is ConditionKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONDITIONS, value);
}

/** Evaluates a condition by key (unknown keys are false, never an exception). */
export function evaluateCondition(key: string, facts: CaseFacts, scope: ConditionScope): boolean {
  if (!isConditionKey(key)) return false;
  return CONDITIONS[key](facts, scope);
}
