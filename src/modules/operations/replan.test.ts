import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: vi.fn(),
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));

import {
  assessImpact,
  cancellationCompensation,
  diffOrderForCase,
  planAllocationReduction,
  type DiffDemand,
  type DiffOrderLine,
  type ImpactAllocation,
  type ImpactInput,
  type OrderDiff,
} from './replan';

function demand(overrides: Partial<DiffDemand> = {}): DiffDemand {
  return {
    id: 'd1',
    lineRef: 'li-1',
    zohoItemId: 'item-1',
    variantKey: '',
    quantity: 10,
    unit: 'pz',
    status: 'allocated',
    ...overrides,
  };
}

function line(overrides: Partial<DiffOrderLine> = {}): DiffOrderLine {
  return {
    zohoLineItemId: 'li-1',
    zohoItemId: 'item-1',
    sku: 'SKU-1',
    name: 'Loseta',
    quantity: 10,
    unit: 'pz',
    locationId: 'loc-1',
    sortOrder: 1,
    ...overrides,
  };
}

function allocation(overrides: Partial<ImpactAllocation> = {}): ImpactAllocation {
  return {
    id: 'a1',
    demandId: 'd1',
    source: 'stock',
    status: 'planned',
    quantity: 10,
    deliveredQuantity: 0,
    hasActiveReservation: false,
    requestStatus: null,
    ...overrides,
  };
}

function emptyDiff(overrides: Partial<OrderDiff> = {}): OrderDiff {
  return {
    cancelled: false,
    matched: [],
    quantityChanges: [],
    added: [],
    removed: [],
    addressChanged: false,
    addressFields: [],
    deliveryMethod: null,
    hasChanges: true,
    ...overrides,
  };
}

function impact(overrides: Partial<ImpactInput>) {
  return assessImpact({
    diff: emptyDiff(),
    baseQuantities: {},
    allocations: [],
    deliveryOrders: [],
    preparationStatus: 'pending',
    ...overrides,
  });
}

describe('diffOrderForCase', () => {
  it('empareja por zohoLineItemId y detecta cambios de cantidad o unidad', () => {
    const diff = diffOrderForCase({
      demands: [demand(), demand({ id: 'd2', lineRef: 'li-2', zohoItemId: 'item-2', quantity: 4 })],
      lines: [
        line({ quantity: 6 }),
        line({ zohoLineItemId: 'li-2', zohoItemId: 'item-2', quantity: 4, unit: 'caja' }),
      ],
    });
    expect(diff.matched.map((m) => m.demandId)).toEqual(['d1', 'd2']);
    expect(diff.quantityChanges.map((c) => [c.demandId, c.before, c.after])).toEqual([
      ['d1', { quantity: '10', unit: 'pz' }, { quantity: '6', unit: 'pz' }],
      ['d2', { quantity: '4', unit: 'pz' }, { quantity: '4', unit: 'caja' }],
    ]);
    expect(diff).toMatchObject({ added: [], removed: [], hasChanges: true, cancelled: false });
  });

  it('sin id de línea empareja por posición o por artículo', () => {
    const diff = diffOrderForCase({
      demands: [
        demand({ lineRef: 'idx:1' }),
        demand({ id: 'd2', lineRef: 'idx:2', zohoItemId: 'item-2' }),
      ],
      lines: [
        line({ zohoLineItemId: null, zohoItemId: 'item-2', sortOrder: 5 }),
        line({ zohoLineItemId: null, sortOrder: 1 }),
      ],
    });
    expect(diff.matched.map((m) => m.demandId).sort()).toEqual(['d1', 'd2']);
    expect(diff.added).toEqual([]);
    expect(diff.hasChanges).toBe(false);
  });

  it('una línea nueva recibe un lineRef que no choca con necesidades canceladas', () => {
    const diff = diffOrderForCase({
      demands: [
        demand(),
        demand({ id: 'dx', lineRef: 'li-9', zohoItemId: 'item-9', status: 'cancelled' }),
      ],
      lines: [line(), line({ zohoLineItemId: 'li-9', zohoItemId: 'item-9b', quantity: 2 })],
    });
    expect(diff.added.map((a) => a.lineRef)).toEqual(['li-9~2']);
  });

  it('detecta líneas eliminadas (o en cero), anulación, dirección y método de entrega', () => {
    const diff = diffOrderForCase({
      demands: [demand(), demand({ id: 'd2', lineRef: 'li-2', zohoItemId: 'item-2' })],
      lines: [line(), line({ zohoLineItemId: 'li-2', zohoItemId: 'item-2', quantity: 0 })],
      orderStatus: 'confirmed',
      fieldChanges: {
        shippingCity: { before: 'Monterrey', after: 'Saltillo' },
        deliveryMethod: { before: 'Domicilio', after: 'RECOGE EN BODEGA' },
        paidStatus: { before: 'unpaid', after: 'paid' },
      },
    });
    expect(diff.removed).toEqual([{ demandId: 'd2', lineRef: 'li-2' }]);
    expect(diff).toMatchObject({
      addressChanged: true,
      addressFields: ['shippingCity'],
      deliveryMethod: { before: 'Domicilio', after: 'RECOGE EN BODEGA' },
    });
    expect(
      diffOrderForCase({ demands: [demand()], lines: [line()], orderStatus: 'void' })
    ).toMatchObject({
      cancelled: true,
      hasChanges: true,
    });
    expect(
      diffOrderForCase({
        demands: [demand()],
        lines: [line()],
        fieldChanges: { paidStatus: { before: 'a', after: 'b' } },
      }).hasChanges
    ).toBe(false);
  });
});

describe('assessImpact', () => {
  const down = (after: number) =>
    emptyDiff({
      quantityChanges: [
        {
          demandId: 'd1',
          lineRef: 'li-1',
          before: { quantity: '10', unit: 'pz' },
          after: { quantity: String(after), unit: 'pz' },
          line: line({ quantity: after }),
        },
      ],
    });

  it('cantidad a la baja: reduce lo planeado y libera la reserva de lo reservado', () => {
    expect(
      impact({
        diff: down(6),
        baseQuantities: { d1: { before: 10, after: 6 } },
        allocations: [allocation()],
      }).actions
    ).toEqual([
      { type: 'update_demand', demandId: 'd1' },
      {
        type: 'reduce_allocation',
        demandId: 'd1',
        allocationId: 'a1',
        newQuantity: 6,
        reducedBy: 4,
        compensation: 'none',
      },
    ]);
    const reserved = impact({
      diff: down(6),
      baseQuantities: { d1: { before: 10, after: 6 } },
      allocations: [allocation({ status: 'reserved', hasActiveReservation: true })],
    });
    expect(reserved.actions[1]).toMatchObject({
      type: 'reduce_allocation',
      compensation: 'release_reservation',
    });
    expect(reserved.summary.quantityDown).toBe(1);
  });

  it('toma primero lo menos comprometido y abre conflicto por lo ya en curso', () => {
    const actions = planAllocationReduction(
      'd1',
      [
        allocation({ id: 'a1', status: 'in_progress', source: 'purchase', quantity: 5 }),
        allocation({ id: 'a2', status: 'reserved', hasActiveReservation: true, quantity: 3 }),
        allocation({ id: 'a3', status: 'planned', quantity: 2 }),
      ],
      7
    );
    expect(actions).toEqual([
      {
        type: 'cancel_allocation',
        demandId: 'd1',
        allocationId: 'a3',
        quantity: 2,
        compensation: 'none',
      },
      {
        type: 'cancel_allocation',
        demandId: 'd1',
        allocationId: 'a2',
        quantity: 3,
        compensation: 'release_reservation',
      },
      {
        type: 'conflict_incident',
        demandId: 'd1',
        allocationId: 'a1',
        lineRef: null,
        reason: 'committed',
        quantity: 2,
        severity: 'high',
      },
    ]);
  });

  it('una compra solicitada se cancela si no la aceptaron; si ya la aceptaron se pide cancelar', () => {
    const sent = planAllocationReduction(
      'd1',
      [allocation({ status: 'requested', source: 'purchase', requestStatus: 'sent' })],
      10
    );
    expect(sent).toEqual([
      {
        type: 'cancel_allocation',
        demandId: 'd1',
        allocationId: 'a1',
        quantity: 10,
        compensation: 'cancel_request',
      },
    ]);
    const accepted = planAllocationReduction(
      'd1',
      [allocation({ status: 'requested', source: 'purchase', requestStatus: 'accepted' })],
      4
    );
    expect(accepted).toEqual([
      {
        type: 'reduce_allocation',
        demandId: 'd1',
        allocationId: 'a1',
        newQuantity: 6,
        reducedBy: 4,
        compensation: 'request_cancel',
      },
    ]);
    const resolved = planAllocationReduction(
      'd1',
      [allocation({ status: 'requested', source: 'purchase', requestStatus: 'resolved' })],
      10
    );
    expect(resolved.map((a) => a.type)).toEqual(['cancel_allocation', 'conflict_incident']);
    expect(resolved[1]).toMatchObject({ reason: 'request_answered', severity: 'medium' });
  });

  it('lo ya entregado no se puede reducir: incidencia alta', () => {
    const actions = planAllocationReduction(
      'd1',
      [allocation({ status: 'delivered', deliveredQuantity: 10 })],
      3
    );
    expect(actions).toEqual([
      {
        type: 'conflict_incident',
        demandId: 'd1',
        allocationId: null,
        lineRef: null,
        reason: 'already_delivered',
        quantity: 3,
        severity: 'high',
      },
    ]);
  });

  it('a la baja sólo devuelve lo asignado por encima de la nueva cantidad', () => {
    const result = impact({
      diff: down(8),
      baseQuantities: { d1: { before: 10, after: 8 } },
      allocations: [allocation({ quantity: 6 })],
    });
    expect(result.actions).toEqual([{ type: 'update_demand', demandId: 'd1' }]);
  });

  it('a la alza reabre el plan y, si el pedido ya se preparó, abre conflicto', () => {
    const up = emptyDiff({
      quantityChanges: [
        {
          demandId: 'd1',
          lineRef: 'li-1',
          before: { quantity: '10', unit: 'pz' },
          after: { quantity: '14', unit: 'pz' },
          line: line({ quantity: 14 }),
        },
      ],
    });
    expect(impact({ diff: up, baseQuantities: { d1: { before: 10, after: 14 } } }).actions).toEqual(
      [
        { type: 'update_demand', demandId: 'd1' },
        { type: 'reopen_plan', demandId: 'd1', extraBase: 4 },
      ]
    );
    const prepared = impact({
      diff: up,
      baseQuantities: { d1: { before: 10, after: 14 } },
      preparationStatus: 'done',
    });
    expect(prepared.actions[2]).toMatchObject({
      type: 'conflict_incident',
      reason: 'prepared',
      quantity: 4,
      severity: 'medium',
    });
  });

  it('línea nueva crea necesidad; línea eliminada cancela con compensación', () => {
    const added = impact({
      diff: emptyDiff({ added: [{ lineRef: 'li-3', line: line({ zohoLineItemId: 'li-3' }) }] }),
    });
    expect(added.actions).toEqual([
      { type: 'create_demand', lineRef: 'li-3', line: line({ zohoLineItemId: 'li-3' }) },
    ]);

    const removed = impact({
      diff: emptyDiff({ removed: [{ demandId: 'd1', lineRef: 'li-1' }] }),
      allocations: [
        allocation({ id: 'a1', status: 'reserved', hasActiveReservation: true, quantity: 6 }),
        allocation({ id: 'a2', status: 'delivered', quantity: 4, deliveredQuantity: 4 }),
      ],
    });
    expect(removed.actions).toEqual([
      {
        type: 'cancel_allocation',
        demandId: 'd1',
        allocationId: 'a1',
        quantity: 6,
        compensation: 'release_reservation',
      },
      {
        type: 'conflict_incident',
        demandId: 'd1',
        allocationId: null,
        lineRef: 'li-1',
        reason: 'already_delivered',
        quantity: 4,
        severity: 'high',
      },
      { type: 'cancel_demand', demandId: 'd1' },
    ]);
    expect(removed.summary).toMatchObject({ removed: 1, conflicts: 1 });
  });

  it('dirección: parchea entregas sin transporte asignado e incidencia si ya está asignada', () => {
    const result = impact({
      diff: emptyDiff({ addressChanged: true, addressFields: ['shippingCity'] }),
      deliveryOrders: [
        { id: 'do1', status: 'planned', mode: 'own_fleet' },
        { id: 'do2', status: 'assigned', mode: 'carrier' },
        { id: 'do3', status: 'dispatched', mode: 'own_fleet' },
        { id: 'do4', status: 'pending', mode: 'customer_pickup' },
        { id: 'do5', status: 'delivered', mode: 'own_fleet' },
      ],
    });
    expect(result.actions).toEqual([
      { type: 'patch_delivery', deliveryOrderId: 'do1' },
      {
        type: 'delivery_change_incident',
        deliveryOrderId: 'do2',
        reason: 'address',
        severity: 'medium',
      },
      {
        type: 'delivery_change_incident',
        deliveryOrderId: 'do3',
        reason: 'address',
        severity: 'high',
      },
    ]);
    expect(result.summary).toMatchObject({ deliveryPatches: 1, deliveryIncidents: 2 });
  });

  it('cambio de método de entrega avisa a logística por cada entrega viva', () => {
    const result = impact({
      diff: emptyDiff({ deliveryMethod: { before: 'Domicilio', after: 'RECOGE EN BODEGA' } }),
      deliveryOrders: [
        { id: 'do1', status: 'pending', mode: 'own_fleet' },
        { id: 'do2', status: 'cancelled', mode: 'own_fleet' },
      ],
    });
    expect(result.actions).toEqual([
      {
        type: 'delivery_change_incident',
        deliveryOrderId: 'do1',
        reason: 'delivery_method',
        severity: 'medium',
      },
    ]);
  });

  it('orden anulada: una sola acción de cancelar el expediente', () => {
    expect(
      impact({
        diff: emptyDiff({ cancelled: true, removed: [{ demandId: 'd1', lineRef: 'li-1' }] }),
      }).actions
    ).toEqual([{ type: 'cancel_case' }]);
  });
});

describe('cancellationCompensation', () => {
  it.each([
    [
      { source: 'stock', status: 'planned', deliveredQuantity: 0 },
      null,
      { sendCancelRequest: false, severity: null, areaKey: 'inventario' },
    ],
    [
      { source: 'stock', status: 'reserved', deliveredQuantity: 0 },
      null,
      { sendCancelRequest: false, severity: null, areaKey: 'inventario' },
    ],
    [
      { source: 'purchase', status: 'requested', deliveredQuantity: 0 },
      'sent',
      { sendCancelRequest: false, severity: 'low', areaKey: 'compras' },
    ],
    [
      { source: 'purchase', status: 'requested', deliveredQuantity: 0 },
      'accepted',
      { sendCancelRequest: true, severity: 'medium', areaKey: 'compras' },
    ],
    [
      { source: 'purchase', status: 'requested', deliveredQuantity: 0 },
      'resolved',
      { sendCancelRequest: true, severity: 'high', areaKey: 'compras' },
    ],
    [
      { source: 'manufacture', status: 'in_progress', deliveredQuantity: 0 },
      'accepted',
      { sendCancelRequest: true, severity: 'high', areaKey: 'manufactura' },
    ],
    [
      { source: 'purchase', status: 'ready', deliveredQuantity: 0 },
      'resolved',
      { sendCancelRequest: false, severity: 'medium', areaKey: 'inventario' },
    ],
    [
      { source: 'stock', status: 'delivered', deliveredQuantity: 5 },
      null,
      { sendCancelRequest: false, severity: 'high', areaKey: 'ventas' },
    ],
  ])('%j con solicitud %s', (allocationFacts, requestStatus, expected) => {
    expect(cancellationCompensation(allocationFacts, requestStatus)).toEqual(expected);
  });
});
