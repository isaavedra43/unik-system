import { describe, expect, it } from 'vitest';
import {
  consolidationKey,
  groupRequestLines,
  isoWeekKey,
  remainingToOrder,
  requestLineStatus,
  requestStatusFromLines,
  suggestConsolidations,
  type ConsolidationLine,
} from './request-rules';

describe('isoWeekKey (hora de la Ciudad de México)', () => {
  it('semana ISO del día local', () => {
    expect(isoWeekKey(new Date('2026-09-15T18:00:00.000Z'))).toBe('2026-W38');
    // Domingo 20 a las 21:00 en México (ya lunes 21 en UTC).
    expect(isoWeekKey(new Date('2026-09-21T03:00:00.000Z'))).toBe('2026-W38');
    expect(isoWeekKey(new Date('2026-09-21T18:00:00.000Z'))).toBe('2026-W39');
  });

  it('cambios de año ISO', () => {
    expect(isoWeekKey(new Date('2027-01-01T18:00:00.000Z'))).toBe('2026-W53');
    expect(isoWeekKey(new Date('2029-12-31T18:00:00.000Z'))).toBe('2030-W01');
  });

  it('consolidationKey = artículo|semana', () => {
    expect(consolidationKey('LP-01', new Date('2026-09-15T18:00:00.000Z'))).toBe('LP-01|2026-W38');
    expect(consolidationKey(null, new Date())).toBeNull();
    expect(consolidationKey('LP-01', null)).toBeNull();
    expect(consolidationKey('LP-01', new Date('x'))).toBeNull();
  });
});

describe('estados de líneas y solicitudes', () => {
  const line = (status: string, qty: number, qtyOrdered: number, qtyReceived: number) => ({ status, qty, qtyOrdered, qtyReceived });

  it('requestLineStatus y remainingToOrder', () => {
    expect(requestLineStatus(line('open', 10, 0, 0))).toBe('open');
    expect(requestLineStatus(line('open', 10, 10, 0))).toBe('ordered');
    expect(requestLineStatus(line('ordered', 10, 10, 10))).toBe('received');
    expect(requestLineStatus(line('cancelled', 10, 10, 10))).toBe('cancelled');
    expect(remainingToOrder(line('open', 10, 4, 0))).toBe(6);
    expect(remainingToOrder(line('open', 10, 12, 0))).toBe(0);
    expect(remainingToOrder(line('cancelled', 10, 0, 0))).toBe(0);
  });

  it('requestStatusFromLines', () => {
    expect(requestStatusFromLines('open', [line('cancelled', 5, 0, 0)])).toBe('cancelled');
    expect(requestStatusFromLines('ordered', [line('received', 5, 5, 5), line('cancelled', 1, 0, 0)])).toBe('closed');
    expect(requestStatusFromLines('sourcing', [line('ordered', 5, 5, 0), line('received', 2, 2, 2)])).toBe('ordered');
    expect(requestStatusFromLines('ordered', [line('open', 5, 2, 0)])).toBe('open');
    expect(requestStatusFromLines('sourcing', [line('open', 5, 0, 0)])).toBe('sourcing');
    expect(requestStatusFromLines('consolidated', [line('open', 5, 0, 0)])).toBe('consolidated');
    expect(requestStatusFromLines('cancelled', [line('open', 5, 0, 0)])).toBe('cancelled');
    expect(requestStatusFromLines('draft', [])).toBe('draft');
  });
});

describe('suggestConsolidations', () => {
  const base = (overrides: Partial<ConsolidationLine> & { id: string; requestId: string }): ConsolidationLine => ({
    zohoItemId: 'LP-01',
    consolidationKey: 'LP-01|2026-W38',
    description: 'Porcelanato 60x60',
    qty: 10,
    qtyOrdered: 0,
    unit: 'm2',
    status: 'open',
    ...overrides,
  });

  it('agrupa el mismo artículo y semana de dos o más solicitudes', () => {
    const groups = suggestConsolidations([
      base({ id: 'l1', requestId: 'r1' }),
      base({ id: 'l2', requestId: 'r2', unit: 'Metros cuadrados', qty: 5 }),
      base({ id: 'l3', requestId: 'r3', qtyOrdered: 1 }),
      base({ id: 'l4', requestId: 'r4', status: 'cancelled' }),
      base({ id: 'l5', requestId: 'r5', consolidationKey: 'LP-01|2026-W39' }),
      base({ id: 'l6', requestId: 'r1', zohoItemId: 'X', consolidationKey: 'X|2026-W38' }),
      base({ id: 'l7', requestId: 'r1', zohoItemId: 'X', consolidationKey: 'X|2026-W38' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: 'LP-01|2026-W38',
      zohoItemId: 'LP-01',
      week: '2026-W38',
      lineIds: ['l1', 'l2'],
      requestIds: ['r1', 'r2'],
      totals: [{ unit: 'm2', qty: 15 }],
    });
  });
});

describe('groupRequestLines', () => {
  it('una partida por artículo y unidad, cada fuente conserva su venta', () => {
    const groups = groupRequestLines([
      { id: 'a', zohoItemId: 'LP-01', description: 'Porcelanato', unit: 'm2', remaining: 10, demandId: 'd1', allocationId: 'al1' },
      { id: 'b', zohoItemId: 'LP-01', description: 'Porcelanato gris', unit: 'M²', remaining: 5, demandId: 'd2', allocationId: null },
      { id: 'c', zohoItemId: 'LP-01', description: 'Porcelanato', unit: 'caja', remaining: 3, demandId: 'd3', allocationId: null },
      { id: 'd', zohoItemId: null, description: 'Silicón  transparente', unit: 'pz', remaining: 2, demandId: null, allocationId: null },
      { id: 'e', zohoItemId: null, description: 'silicón transparente', unit: 'pz', remaining: 4, demandId: null, allocationId: null },
      { id: 'f', zohoItemId: 'LP-02', description: 'Sin pendiente', unit: 'pz', remaining: 0, demandId: 'd4', allocationId: null },
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ zohoItemId: 'LP-01', unit: 'm2', qty: 15 });
    expect(groups[0].sources).toEqual([
      { requestLineId: 'a', demandId: 'd1', allocationId: 'al1', qty: 10 },
      { requestLineId: 'b', demandId: 'd2', allocationId: null, qty: 5 },
    ]);
    expect(groups[1]).toMatchObject({ unit: 'caja', qty: 3 });
    expect(groups[2]).toMatchObject({ zohoItemId: null, qty: 6 });
  });
});
