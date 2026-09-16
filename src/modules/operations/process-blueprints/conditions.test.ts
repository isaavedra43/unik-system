import { describe, expect, it } from 'vitest';
import {
  CONDITION_KEYS,
  CONDITION_LABELS,
  evaluateCondition,
  isConditionKey,
  isCarrierDelivery,
  isCustomerPickup,
  uncoveredQuantity,
  type AllocationFacts,
  type CaseFacts,
  type ConditionScope,
  type DeliveryOrderFacts,
  type DemandFacts,
} from './conditions';

function demand(overrides: Partial<DemandFacts> = {}): DemandFacts {
  return {
    id: 'd1',
    status: 'verifying',
    zohoItemId: 'item-1',
    quantity: 10,
    fulfilledQuantity: 0,
    allocatedQuantity: 0,
    availability: { confidence: 'CONTROLLED', available: 12, lastVerifiedAt: null },
    ...overrides,
  };
}

function allocation(overrides: Partial<AllocationFacts> = {}): AllocationFacts {
  return {
    id: 'a1',
    demandId: 'd1',
    source: 'stock',
    status: 'planned',
    quantity: 10,
    deliveredQuantity: 0,
    stockReservationId: null,
    hasActiveReservation: false,
    linkedId: null,
    readyAt: null,
    expectedAt: null,
    ...overrides,
  };
}

function order(overrides: Partial<DeliveryOrderFacts> = {}): DeliveryOrderFacts {
  return {
    id: 'do1',
    status: 'planned',
    mode: 'own_fleet',
    zohoSyncState: 'not_required',
    allocationIds: ['a1'],
    plannedDate: null,
    ...overrides,
  };
}

function facts(overrides: Partial<CaseFacts> = {}): CaseFacts {
  return {
    case: { id: 'c1', status: 'open', deliveryMethod: 'Entrega a domicilio' },
    salesOrder: {
      status: 'confirmed',
      invoicedStatus: 'not_invoiced',
      paidStatus: 'unpaid',
      shippedStatus: 'pending',
    },
    demands: [demand()],
    allocations: [],
    deliveryOrders: [],
    ...overrides,
  };
}

const demandScope: ConditionScope = { scope: 'demand', demandId: 'd1', allocationId: null };
const allocationScope: ConditionScope = { scope: 'allocation', demandId: 'd1', allocationId: 'a1' };
const caseScope: ConditionScope = { scope: 'case', demandId: null, allocationId: null };

describe('condiciones de necesidad', () => {
  it('controlledStockSufficient: sólo existencia CONTROLLED que cubre lo que falta', () => {
    expect(evaluateCondition('controlledStockSufficient', facts(), demandScope)).toBe(true);
    expect(
      evaluateCondition(
        'controlledStockSufficient',
        facts({
          demands: [
            demand({
              availability: { confidence: 'CONTROLLED', available: 6, lastVerifiedAt: null },
            }),
          ],
        }),
        demandScope
      )
    ).toBe(false);
    expect(
      evaluateCondition(
        'controlledStockSufficient',
        facts({
          demands: [
            demand({
              availability: { confidence: 'PROVISIONAL', available: 50, lastVerifiedAt: null },
            }),
          ],
        }),
        demandScope
      )
    ).toBe(false);
    expect(
      evaluateCondition(
        'controlledStockSufficient',
        facts({ demands: [demand({ availability: null })] }),
        demandScope
      )
    ).toBe(false);
  });

  it('planCoveredByControlledStock considera lo ya asignado y se cumple si no falta nada', () => {
    const partial = demand({
      allocatedQuantity: 6,
      availability: { confidence: 'CONTROLLED', available: 4, lastVerifiedAt: null },
    });
    expect(
      evaluateCondition('planCoveredByControlledStock', facts({ demands: [partial] }), demandScope)
    ).toBe(true);
    const covered = demand({ allocatedQuantity: 10, availability: null });
    expect(
      evaluateCondition('planCoveredByControlledStock', facts({ demands: [covered] }), demandScope)
    ).toBe(true);
    expect(uncoveredQuantity({ quantity: 10, allocatedQuantity: 12 })).toBe(0);
  });
});

describe('condiciones de asignación', () => {
  it('allocationReserved con reserva activa, id de reserva o estado posterior', () => {
    const check = (a: Partial<AllocationFacts>) =>
      evaluateCondition(
        'allocationReserved',
        facts({ allocations: [allocation(a)] }),
        allocationScope
      );
    expect(check({})).toBe(false);
    expect(check({ hasActiveReservation: true })).toBe(true);
    expect(check({ stockReservationId: 'r1' })).toBe(true);
    expect(check({ status: 'ready' })).toBe(true);
    expect(evaluateCondition('allocationReserved', facts(), allocationScope)).toBe(false);
  });

  it('allocationRequested, allocationReady y directDeliveryConfirmed', () => {
    const f = (a: Partial<AllocationFacts>) => facts({ allocations: [allocation(a)] });
    expect(
      evaluateCondition('allocationRequested', f({ source: 'purchase' }), allocationScope)
    ).toBe(false);
    expect(
      evaluateCondition(
        'allocationRequested',
        f({ source: 'purchase', linkedId: 'req1' }),
        allocationScope
      )
    ).toBe(true);
    expect(
      evaluateCondition(
        'allocationRequested',
        f({ source: 'purchase', status: 'in_progress' }),
        allocationScope
      )
    ).toBe(true);
    expect(evaluateCondition('allocationReady', f({ status: 'requested' }), allocationScope)).toBe(
      false
    );
    expect(
      evaluateCondition(
        'allocationReady',
        f({ status: 'requested', readyAt: '2026-09-15T00:00:00.000Z' }),
        allocationScope
      )
    ).toBe(true);
    expect(evaluateCondition('allocationReady', f({ status: 'ready' }), allocationScope)).toBe(
      true
    );
    expect(
      evaluateCondition(
        'directDeliveryConfirmed',
        f({ source: 'direct_supplier', deliveredQuantity: 4 }),
        allocationScope
      )
    ).toBe(false);
    expect(
      evaluateCondition(
        'directDeliveryConfirmed',
        f({ source: 'direct_supplier', deliveredQuantity: 10 }),
        allocationScope
      )
    ).toBe(true);
    expect(
      evaluateCondition(
        'directDeliveryConfirmed',
        f({ source: 'direct_supplier', status: 'delivered' }),
        allocationScope
      )
    ).toBe(true);
  });
});

describe('condiciones del caso', () => {
  it('hasWarehouseAllocations excluye proveedor directo y canceladas', () => {
    expect(evaluateCondition('hasWarehouseAllocations', facts(), caseScope)).toBe(false);
    expect(
      evaluateCondition(
        'hasWarehouseAllocations',
        facts({
          allocations: [
            allocation({ source: 'direct_supplier' }),
            allocation({ id: 'a2', status: 'cancelled' }),
          ],
        }),
        caseScope
      )
    ).toBe(false);
    expect(
      evaluateCondition(
        'hasWarehouseAllocations',
        facts({ allocations: [allocation()] }),
        caseScope
      )
    ).toBe(true);
  });

  it('requiresTransport es falso si el cliente recoge o todas las entregas son sin embarque', () => {
    const base = { allocations: [allocation()] };
    expect(evaluateCondition('requiresTransport', facts(base), caseScope)).toBe(true);
    expect(
      evaluateCondition(
        'requiresTransport',
        facts({ ...base, case: { id: 'c1', status: 'open', deliveryMethod: 'RECOGE EN BODEGA' } }),
        caseScope
      )
    ).toBe(false);
    expect(
      evaluateCondition(
        'requiresTransport',
        facts({ ...base, deliveryOrders: [order({ mode: 'customer_pickup' })] }),
        caseScope
      )
    ).toBe(false);
    expect(evaluateCondition('requiresTransport', facts({ allocations: [] }), caseScope)).toBe(
      false
    );
  });

  it('deliveryPlanned, transportConfirmed y deliveriesClosed leen las órdenes de entrega vivas', () => {
    const base = { allocations: [allocation({ status: 'ready' })] };
    expect(evaluateCondition('deliveryPlanned', facts(base), caseScope)).toBe(false);
    expect(
      evaluateCondition(
        'deliveryPlanned',
        facts({ ...base, deliveryOrders: [order({ status: 'cancelled' })] }),
        caseScope
      )
    ).toBe(false);
    expect(
      evaluateCondition('deliveryPlanned', facts({ ...base, deliveryOrders: [order()] }), caseScope)
    ).toBe(true);

    expect(
      evaluateCondition(
        'transportConfirmed',
        facts({
          ...base,
          deliveryOrders: [order({ status: 'pending_external', zohoSyncState: 'written' })],
        }),
        caseScope
      )
    ).toBe(false);
    expect(
      evaluateCondition(
        'transportConfirmed',
        facts({
          ...base,
          deliveryOrders: [order({ status: 'assigned', zohoSyncState: 'readback_ok' })],
        }),
        caseScope
      )
    ).toBe(true);
    expect(
      evaluateCondition(
        'transportConfirmed',
        facts({ ...base, deliveryOrders: [order({ mode: 'customer_pickup' })] }),
        caseScope
      )
    ).toBe(false);
    // A trip that left, or a failed write that kept the order dispatched, confirms nothing.
    for (const zohoSyncState of ['not_required', 'pending_write', 'failed', 'readback_mismatch']) {
      expect(
        evaluateCondition(
          'transportConfirmed',
          facts({ ...base, deliveryOrders: [order({ status: 'dispatched', zohoSyncState })] }),
          caseScope
        )
      ).toBe(false);
    }

    expect(evaluateCondition('deliveriesClosed', facts(base), caseScope)).toBe(false);
    expect(
      evaluateCondition(
        'deliveriesClosed',
        facts({
          ...base,
          deliveryOrders: [
            order({ status: 'partially_delivered' }),
            order({ id: 'do2', status: 'pending' }),
          ],
        }),
        caseScope
      )
    ).toBe(false);
    expect(
      evaluateCondition(
        'deliveriesClosed',
        facts({
          ...base,
          deliveryOrders: [
            order({ status: 'partially_delivered' }),
            order({ id: 'do2', status: 'delivered' }),
            order({ id: 'do3', status: 'cancelled' }),
          ],
        }),
        caseScope
      )
    ).toBe(true);
  });

  it('allDemandsFulfilled ignora canceladas y exige al menos una activa', () => {
    expect(evaluateCondition('allDemandsFulfilled', facts(), caseScope)).toBe(false);
    expect(
      evaluateCondition(
        'allDemandsFulfilled',
        facts({
          demands: [demand({ status: 'fulfilled' }), demand({ id: 'd2', status: 'cancelled' })],
        }),
        caseScope
      )
    ).toBe(true);
    expect(
      evaluateCondition(
        'allDemandsFulfilled',
        facts({ demands: [demand({ fulfilledQuantity: 10 })] }),
        caseScope
      )
    ).toBe(true);
    expect(
      evaluateCondition(
        'allDemandsFulfilled',
        facts({ demands: [demand({ status: 'cancelled' })] }),
        caseScope
      )
    ).toBe(false);
  });

  it('salesOrderInvoicedAndPaid requiere facturada y pagada', () => {
    const so = (invoicedStatus: string, paidStatus: string) =>
      facts({
        salesOrder: { status: 'confirmed', invoicedStatus, paidStatus, shippedStatus: 'fulfilled' },
      });
    expect(evaluateCondition('salesOrderInvoicedAndPaid', so('invoiced', 'paid'), caseScope)).toBe(
      true
    );
    expect(
      evaluateCondition('salesOrderInvoicedAndPaid', so('invoiced', 'partially_paid'), caseScope)
    ).toBe(false);
    expect(
      evaluateCondition('salesOrderInvoicedAndPaid', so('partially_invoiced', 'paid'), caseScope)
    ).toBe(false);
    expect(
      evaluateCondition('salesOrderInvoicedAndPaid', facts({ salesOrder: null }), caseScope)
    ).toBe(false);
  });
});

describe('catálogo', () => {
  it('toda condición tiene etiqueta y las claves desconocidas son falsas', () => {
    expect(CONDITION_KEYS.every((key) => CONDITION_LABELS[key].length > 0)).toBe(true);
    expect(isConditionKey('allDemandsFulfilled')).toBe(true);
    expect(isConditionKey('toString')).toBe(false);
    expect(evaluateCondition('noExiste', facts(), caseScope)).toBe(false);
  });

  it.each([
    ['RECOGE EN BODEGA', true],
    ['Recolección en sucursal', true],
    ['Cliente recoge', true],
    ['Pick up', true],
    ['Mostrador', true],
    ['Entrega a domicilio', false],
    ['Paquetería', false],
    [null, false],
  ])('isCustomerPickup(%s) = %s', (value, expected) => {
    expect(isCustomerPickup(value)).toBe(expected);
  });

  /**
   * Plan §4: el método de entrega de Zoho decide si la entrega nace `carrier`
   * (paquetería) en vez de `own_fleet`. La lista es corta a propósito: un falso
   * positivo crea una entrega que no se puede cargar en un viaje de la
   * flotilla, así que lo ambiguo («flete», «envío») se deja fuera.
   */
  it.each([
    ['PAQUETERÍA', true],
    ['Paqueteria DHL', true],
    ['Mensajería', true],
    ['Transportista externo', true],
    ['Entrega a domicilio', false],
    ['Flete pagado', false],
    ['Envío', false],
    // Si el cliente recoge, recoge: no es un envío por paquetería.
    ['Recoge en paquetería', false],
    [null, false],
    ['', false],
  ])('isCarrierDelivery(%s) = %s', (value, expected) => {
    expect(isCarrierDelivery(value)).toBe(expected);
  });
});
