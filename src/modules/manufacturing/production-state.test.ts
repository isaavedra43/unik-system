import { describe, expect, it } from 'vitest';
import { PRODUCTION_ORDER_STATUSES } from './manufacturing-types';
import {
  accumulatedMinutes,
  allOperationsClosed,
  allowedOrderActions,
  canApplyOrderAction,
  classifyConsumption,
  compareBoardOrders,
  evaluateRelease,
  materialNeeds,
  minutesBetween,
  nextStartableOperation,
  operationFinishError,
  operationPauseError,
  operationStartError,
  orderActionError,
  orderStatusAfterOperations,
  parseTransformationInputs,
  requiredInputQty,
  reworkPlacement,
  transformationRecipe,
  type OperationFacts,
  type RecipeLine,
  type ReleaseFacts,
} from './production-state';

describe('order actions', () => {
  it('follows the flow of the order', () => {
    expect(allowedOrderActions('draft')).toEqual(['schedule', 'reserve_materials', 'cancel']);
    expect(allowedOrderActions('blocked')).toEqual(['schedule', 'reserve_materials', 'cancel']);
    expect(allowedOrderActions('reserved')).toEqual(['schedule', 'reserve_materials', 'prepare', 'cancel']);
    expect(allowedOrderActions('prepared')).toEqual(['schedule', 'start_operation', 'cancel']);
    expect(allowedOrderActions('in_progress')).toEqual([
      'start_operation',
      'pause_operation',
      'finish_operation',
      'record_consumption',
      'inspect',
      'record_other_output',
      'request_scrap_review',
      'cancel',
    ]);
    expect(allowedOrderActions('inspection')).toEqual([
      'record_consumption',
      'inspect',
      'record_other_output',
      'request_scrap_review',
      'cancel',
    ]);
    expect(allowedOrderActions('completed')).toEqual([
      'record_consumption',
      'record_finished_output',
      'record_other_output',
      'request_scrap_review',
      'release',
      'cancel',
    ]);
    expect(allowedOrderActions('released')).toEqual([]);
    expect(allowedOrderActions('cancelled')).toEqual([]);
  });

  it('explains why an action is not allowed', () => {
    expect(orderActionError('release', 'in_progress')).toBe('No se puede liberar una orden en proceso');
    expect(orderActionError('record_finished_output', 'inspection')).toMatch(/después de una inspección aprobada/);
    expect(orderActionError('prepare', 'weird')).toBe('No se puede preparar una orden weird');
    expect(orderActionError('cancel', 'draft')).toBeNull();
    for (const status of PRODUCTION_ORDER_STATUSES) {
      expect(canApplyOrderAction('cancel', status)).toBe(status !== 'released' && status !== 'cancelled');
    }
  });
});

const op = (overrides: Partial<OperationFacts> & { id: string; seq: number }): OperationFacts => ({
  name: `Op ${overrides.seq}`,
  status: 'pending',
  qcRequired: false,
  passedCheck: false,
  ...overrides,
});

describe('operations', () => {
  it('starts operations in sequence', () => {
    const ops = [op({ id: 'a', seq: 1 }), op({ id: 'b', seq: 2 })];
    expect(operationStartError(ops, 'a')).toBeNull();
    expect(operationStartError(ops, 'b')).toBe('Primero termina la operación 1. Op 1');
    expect(operationStartError(ops, 'zzz')).toBe('La operación no pertenece a esta orden');
    expect(nextStartableOperation(ops)?.id).toBe('a');
  });

  it('allows only one running operation and resumes paused ones', () => {
    const running = [op({ id: 'a', seq: 1, status: 'running' }), op({ id: 'b', seq: 2 })];
    expect(operationStartError(running, 'a')).toBe('La operación ya está en curso');
    expect(operationStartError(running, 'b')).toMatch(/Termina o pausa la operación en curso/);
    const paused = [op({ id: 'a', seq: 1, status: 'paused' }), op({ id: 'b', seq: 2 })];
    expect(operationStartError(paused, 'a')).toBeNull();
    expect(nextStartableOperation(paused)?.id).toBe('a');
    expect(operationStartError([op({ id: 'a', seq: 1, status: 'done' })], 'a')).toBe('La operación ya terminó');
  });

  it('requires a passing check after an operation with quality control', () => {
    const ops = [op({ id: 'a', seq: 1, status: 'done', qcRequired: true }), op({ id: 'b', seq: 2 })];
    expect(operationStartError(ops, 'b')).toMatch(/requiere una inspección aprobada/);
    expect(nextStartableOperation(ops)).toBeNull();
    ops[0].passedCheck = true;
    expect(operationStartError(ops, 'b')).toBeNull();
    expect(operationStartError([op({ id: 'a', seq: 1, status: 'skipped', qcRequired: true }), op({ id: 'b', seq: 2 })], 'b')).toBeNull();
  });

  it('pauses running operations and finishes running or paused ones', () => {
    expect(operationPauseError({ status: 'running' })).toBeNull();
    expect(operationPauseError({ status: 'paused' })).toMatch(/Sólo se pausa una operación en curso/);
    expect(operationPauseError(null)).toMatch(/no pertenece/);
    expect(operationFinishError({ status: 'running' })).toBeNull();
    expect(operationFinishError({ status: 'paused' })).toBeNull();
    expect(operationFinishError({ status: 'pending' })).toBe('Inicia la operación antes de terminarla');
    expect(operationFinishError({ status: 'done' })).toBe('La operación ya terminó');
  });

  it('goes to inspection once every operation is closed', () => {
    expect(allOperationsClosed([])).toBe(false);
    expect(orderStatusAfterOperations([{ status: 'done' }, { status: 'skipped' }])).toBe('inspection');
    expect(orderStatusAfterOperations([{ status: 'done' }, { status: 'pending' }])).toBe('in_progress');
  });

  it('places rework after the failed operation or at the end', () => {
    const ops = [
      { id: 'a', seq: 1 },
      { id: 'b', seq: 2 },
      { id: 'c', seq: 3 },
    ];
    expect(reworkPlacement(ops, null)).toEqual({ seq: 4, renumber: [] });
    expect(reworkPlacement(ops, 'a')).toEqual({
      seq: 2,
      renumber: [
        { id: 'c', seq: 4 },
        { id: 'b', seq: 3 },
      ],
    });
    expect(reworkPlacement(ops, 'c')).toEqual({ seq: 4, renumber: [] });
    expect(reworkPlacement([], 'x')).toEqual({ seq: 1, renumber: [] });
  });

  it('accumulates real minutes over paused segments', () => {
    const t0 = new Date('2026-09-15T15:00:00Z');
    expect(minutesBetween(t0, new Date('2026-09-15T15:30:29Z'))).toBe(30);
    expect(minutesBetween(new Date('2026-09-15T16:00:00Z'), t0)).toBe(0);
    expect(accumulatedMinutes(null, t0, new Date('2026-09-15T15:45:00Z'))).toBe(45);
    expect(accumulatedMinutes(20, t0, new Date('2026-09-15T15:10:00Z'))).toBe(30);
    expect(accumulatedMinutes(20, null, t0)).toBe(20);
  });
});

describe('materials', () => {
  it('reads transformation inputs tolerantly', () => {
    expect(
      parseTransformationInputs([
        { zohoItemId: 'lamina', qty: 105, unit: 'm2', substituteZohoItemIds: ['lamina', 'lamina-b', 'lamina-b'], scrapAllowancePct: 120 },
        { zohoItemId: 'canto', qty: '4', unit: 'm' },
        { zohoItemId: '', qty: 1, unit: 'm' },
        { zohoItemId: 'x', qty: -1, unit: 'm' },
        'nope',
      ])
    ).toEqual([
      { zohoItemId: 'lamina', qty: 105, unit: 'm2', substituteZohoItemIds: ['lamina-b'], variantKey: null, scrapAllowancePct: 100 },
      { zohoItemId: 'canto', qty: 4, unit: 'm', substituteZohoItemIds: [], variantKey: null, scrapAllowancePct: null },
    ]);
    expect(parseTransformationInputs(null)).toEqual([]);
  });

  it('builds the implicit BOM of a transformation', () => {
    const inputs = parseTransformationInputs([{ zohoItemId: 'lamina', qty: 105, unit: 'm2' }]);
    const recipe = transformationRecipe(inputs, 100, 5);
    expect(recipe.allowancePct).toBe(5);
    expect(recipe.lines[0]).toMatchObject({ inputZohoItemId: 'lamina', qtyPerOutput: 1.05, unit: 'm2' });
    expect(requiredInputQty(recipe.lines[0], 100)).toBe(105);
    expect(requiredInputQty(recipe.lines[0], 50)).toBe(52.5);
    const custom = transformationRecipe(
      parseTransformationInputs([
        { zohoItemId: 'a', qty: 1, unit: 'm2', scrapAllowancePct: 2 },
        { zohoItemId: 'b', qty: 1, unit: 'm2', scrapAllowancePct: 8 },
      ]),
      0,
      5
    );
    expect(custom.allowancePct).toBe(8);
    expect(custom.lines[0].qtyPerOutput).toBe(1);
  });

  it('computes what is still missing per input', () => {
    expect(
      materialNeeds([
        { zohoItemId: 'a', required: 105, assigned: 60 },
        { zohoItemId: 'b', required: 10, assigned: 12 },
      ])
    ).toEqual([
      { zohoItemId: 'a', required: 105, assigned: 60, missing: 45, covered: false },
      { zohoItemId: 'b', required: 10, assigned: 12, missing: 0, covered: true },
    ]);
  });

  const lines: RecipeLine[] = [
    { inputZohoItemId: 'lamina', qtyPerOutput: 1, unit: 'm2', substitutes: ['lamina-b'], scrapPct: null, variantKey: null },
    { inputZohoItemId: 'canto', qtyPerOutput: 1, unit: 'm', substitutes: ['canto-b'], scrapPct: null, variantKey: null },
    { inputZohoItemId: 'tapa', qtyPerOutput: 1, unit: 'pz', substitutes: ['canto-b'], scrapPct: null, variantKey: null },
  ];

  it('classifies consumed materials against the BOM', () => {
    expect(classifyConsumption(lines, 'lamina')).toEqual({ role: 'planned', inputZohoItemId: 'lamina' });
    expect(classifyConsumption(lines, 'lamina', 'lamina')).toEqual({ role: 'planned', inputZohoItemId: 'lamina' });
    expect(classifyConsumption(lines, 'lamina-b')).toEqual({ role: 'declared_substitute', inputZohoItemId: 'lamina' });
    expect(classifyConsumption(lines, 'lamina-b', 'lamina')).toEqual({ role: 'declared_substitute', inputZohoItemId: 'lamina' });
    expect(classifyConsumption(lines, 'lamina-c', 'lamina')).toEqual({ role: 'unplanned_substitute', inputZohoItemId: 'lamina' });
    expect(classifyConsumption(lines, 'canto-b', 'tapa')).toEqual({ role: 'declared_substitute', inputZohoItemId: 'tapa' });
  });

  it('rejects ambiguous or unknown materials', () => {
    expect(classifyConsumption(lines, 'lamina-c')).toMatchObject({ role: 'invalid', message: expect.stringMatching(/indica qué insumo sustituye/) });
    expect(classifyConsumption(lines, 'canto-b')).toMatchObject({ role: 'invalid', message: expect.stringMatching(/varios insumos/) });
    expect(classifyConsumption(lines, 'lamina-c', 'otro')).toMatchObject({ role: 'invalid', message: expect.stringMatching(/no está en la orden/) });
    expect(classifyConsumption(lines, 'lamina', 'canto')).toMatchObject({ role: 'invalid', message: expect.stringMatching(/ya es un insumo/) });
  });
});

describe('evaluateRelease', () => {
  const ready: ReleaseFacts = {
    status: 'completed',
    operations: [{ status: 'done' }],
    producedBase: 100,
    requiredBase: 100,
    baseUnit: 'm2',
    lastOrderCheck: 'pass',
    pendingSubstitutions: 0,
    scrapExceeded: false,
    scrapApproval: 'none',
    balanceComparable: true,
    balanceBalanced: true,
    acceptBalanceDifference: false,
  };
  const codes = (facts: Partial<ReleaseFacts>) => evaluateRelease({ ...ready, ...facts }).blockers.map((b) => b.code);

  it('releases a completed, inspected and balanced order', () => {
    expect(evaluateRelease(ready)).toEqual({ ready: true, blockers: [], requestScrapApproval: false });
    expect(evaluateRelease({ ...ready, lastOrderCheck: 'conditional', requiredBase: null, producedBase: 5 }).ready).toBe(true);
  });

  it('lists every blocker', () => {
    expect(codes({ status: 'inspection' })).toEqual(['status']);
    expect(codes({ operations: [{ status: 'done' }, { status: 'pending' }] })).toEqual(['operations']);
    expect(codes({ lastOrderCheck: 'fail' })).toEqual(['quality']);
    expect(codes({ lastOrderCheck: null })).toEqual(['quality']);
    expect(codes({ producedBase: 0 })).toEqual(['no_output']);
    expect(codes({ producedBase: 90 })).toEqual(['short_output']);
    expect(evaluateRelease({ ...ready, producedBase: 90 }).blockers[0].message).toBe('Se produjeron 90 de 100 m2 que necesita la venta');
    expect(codes({ pendingSubstitutions: 2 })).toEqual(['substitution_pending']);
    expect(codes({ balanceBalanced: false })).toEqual(['balance']);
    expect(codes({ balanceBalanced: false, balanceComparable: false })).toEqual([]);
    expect(codes({ balanceBalanced: false, acceptBalanceDifference: true })).toEqual([]);
  });

  it('gates excess scrap on its approval', () => {
    expect(evaluateRelease({ ...ready, scrapExceeded: true, scrapApproval: 'none' })).toMatchObject({ ready: false, requestScrapApproval: true });
    expect(evaluateRelease({ ...ready, scrapExceeded: true, scrapApproval: 'stale' }).requestScrapApproval).toBe(true);
    expect(evaluateRelease({ ...ready, scrapExceeded: true, scrapApproval: 'pending' })).toMatchObject({ ready: false, requestScrapApproval: false });
    expect(evaluateRelease({ ...ready, scrapExceeded: true, scrapApproval: 'rejected' }).blockers[0].message).toMatch(/rechazada/);
    expect(evaluateRelease({ ...ready, scrapExceeded: true, scrapApproval: 'approved' }).ready).toBe(true);
  });
});

describe('compareBoardOrders', () => {
  it('orders by priority, planned start (unplanned last) and age', () => {
    const d = (iso: string) => new Date(iso);
    const rows = [
      { id: '1', priority: 'normal', plannedStartAt: null, createdAt: d('2026-09-01') },
      { id: '2', priority: 'normal', plannedStartAt: d('2026-09-20'), createdAt: d('2026-09-02') },
      { id: '3', priority: 'urgent', plannedStartAt: null, createdAt: d('2026-09-03') },
      { id: '4', priority: 'high', plannedStartAt: d('2026-09-25'), createdAt: d('2026-09-04') },
      { id: '5', priority: 'normal', plannedStartAt: d('2026-09-20'), createdAt: d('2026-09-01') },
    ];
    expect([...rows].sort(compareBoardOrders).map((row) => row.id)).toEqual(['3', '4', '5', '2', '1']);
  });
});

describe('release hardening', () => {
  const base: ReleaseFacts = {
    status: 'completed',
    operations: [{ status: 'done' }],
    producedBase: 4,
    requiredBase: null,
    baseUnit: 'pz',
    lastOrderCheck: 'pass',
    pendingSubstitutions: 0,
    scrapExceeded: false,
    scrapApproval: 'none',
    balanceComparable: false,
    balanceBalanced: true,
    acceptBalanceDifference: false,
  };
  const codes = (facts: Partial<ReleaseFacts>) => evaluateRelease({ ...base, ...facts }).blockers.map((b) => b.code);

  it('never releases assigned material nobody consumed, nor scrap without a basis', () => {
    const unconsumed = [{ zohoItemId: 'lamina', label: 'Lámina', assigned: 10, consumed: 0, expected: 10, tolerancePct: 5, comparable: false }];
    expect(codes({ materials: unconsumed, scrapPending: true })).toEqual(['scrap_pending', 'not_consumed']);
    // Accepting a balance difference does not release unconsumed material.
    expect(codes({ materials: unconsumed, acceptBalanceDifference: true })).toEqual(['not_consumed']);
    expect(evaluateRelease({ ...base, materials: unconsumed }).blockers[0].message).toContain('Lámina');
  });

  it('flags under-consumption of materials the balance cannot judge, unless the difference is accepted', () => {
    const under = [{ zohoItemId: 'lamina', assigned: 10, consumed: 6, expected: 10, tolerancePct: 5, comparable: false }];
    expect(codes({ materials: under })).toEqual(['under_consumed']);
    expect(codes({ materials: under, acceptBalanceDifference: true })).toEqual([]);
    expect(codes({ materials: [{ ...under[0], consumed: 9.6 }] })).toEqual([]);
    // Comparable lines are judged by the balance, not here.
    expect(codes({ materials: [{ ...under[0], comparable: true }] })).toEqual([]);
    expect(codes({ materials: [{ ...under[0], assigned: 0, consumed: 0 }] })).toEqual(['under_consumed']);
    expect(codes({ materials: [{ ...under[0], assigned: 0, consumed: 0, expected: 0 }] })).toEqual([]);
  });

  it('grossRequiredInputQty adds the expected scrap and divides by the yield (BOM)', async () => {
    const { grossRequiredInputQty } = await import('./production-state');
    expect(grossRequiredInputQty({ qtyPerOutput: 2, scrapPct: null }, 10)).toBe(20);
    expect(grossRequiredInputQty({ qtyPerOutput: 2, scrapPct: 5 }, 10)).toBe(21);
    expect(grossRequiredInputQty({ qtyPerOutput: 2, scrapPct: 5 }, 10, 0.95)).toBe(22.1053);
    expect(grossRequiredInputQty({ qtyPerOutput: 2, scrapPct: null }, 10, 0)).toBe(20);
    expect(grossRequiredInputQty({ qtyPerOutput: 2, scrapPct: null }, 10, 1.5)).toBe(20);
    expect(grossRequiredInputQty({ qtyPerOutput: -1, scrapPct: -5 }, 10)).toBe(0);
  });
});
