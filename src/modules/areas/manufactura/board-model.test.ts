import { describe, expect, it } from 'vitest';
import {
  BOARD_LANES,
  boardTotals,
  buildScheduleCommand,
  canMoveOrder,
  cardBadges,
  describeMove,
  groupByLane,
  isRealMove,
  laneForStatus,
  nextCenterIndex,
  scrapPercent,
  utilizationTone,
  type BoardCard,
  type BoardCenter,
} from './board-model';

const NOW = new Date('2026-09-15T18:00:00.000Z');

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: 'op-1',
    number: 'OP-0001',
    title: 'Tablero melamina',
    status: 'in_progress',
    statusLabel: 'En proceso',
    lane: 'active',
    kind: 'transformation',
    priority: 'normal',
    workCenterId: 'wc-1',
    workCenterName: 'Corte',
    plannedStartAt: '2026-09-15T14:00:00.000Z',
    plannedEndAt: '2026-09-16T14:00:00.000Z',
    plannedQty: '10',
    plannedUnit: 'm2',
    producedQty: '0',
    scrapQty: '0',
    caseId: null,
    caseNumber: null,
    customerName: null,
    blockedReason: null,
    version: 3,
    runningOperation: null,
    pendingOperations: 1,
    ...overrides,
  };
}

describe('carriles del tablero', () => {
  it('coloca cada estado en su carril', () => {
    expect(laneForStatus('blocked')).toBe('blocked');
    expect(laneForStatus('draft')).toBe('queued');
    expect(laneForStatus('reserved')).toBe('queued');
    expect(laneForStatus('prepared')).toBe('queued');
    expect(laneForStatus('in_progress')).toBe('active');
    expect(laneForStatus('inspection')).toBe('active');
    expect(laneForStatus('completed')).toBe('done');
  });

  it('no muestra órdenes liberadas ni canceladas', () => {
    expect(laneForStatus('released')).toBeNull();
    expect(laneForStatus('cancelled')).toBeNull();
  });

  it('agrupa por carril sin perder tarjetas', () => {
    const cards = [
      card({ id: 'a', lane: 'queued' }),
      card({ id: 'b', lane: 'queued' }),
      card({ id: 'c', lane: 'blocked' }),
    ];
    const lanes = groupByLane(cards);
    expect(lanes.queued.map((entry) => entry.id)).toStrictEqual(['a', 'b']);
    expect(lanes.blocked).toHaveLength(1);
    expect(lanes.active).toStrictEqual([]);
    expect(BOARD_LANES.flatMap((lane) => lanes[lane])).toHaveLength(3);
  });

  it('suma los totales del tablero y las órdenes sin centro', () => {
    const centers: BoardCenter[] = [
      {
        id: null,
        key: null,
        name: 'Sin centro asignado',
        capacityUnit: 'minutes',
        capacityUnitLabel: 'minutos',
        capacityPerShift: 0,
        status: 'active',
        windows: [],
        summary: null,
        cards: [card({ id: 'a', lane: 'queued', workCenterId: null })],
      },
      {
        id: 'wc-1',
        key: 'corte',
        name: 'Corte',
        capacityUnit: 'm2',
        capacityUnitLabel: 'm²',
        capacityPerShift: 120,
        status: 'active',
        windows: [],
        summary: null,
        cards: [card({ id: 'b', lane: 'active' }), card({ id: 'c', lane: 'blocked' })],
      },
    ];
    expect(boardTotals(centers)).toStrictEqual({
      orders: 3,
      blocked: 1,
      active: 1,
      queued: 1,
      done: 0,
      unassigned: 1,
    });
  });
});

describe('mover una orden de centro', () => {
  it('permite mover una orden de transformación programable', () => {
    expect(canMoveOrder(card({ status: 'draft' }))).toStrictEqual({ ok: true, reason: null });
    expect(canMoveOrder(card({ status: 'blocked' })).ok).toBe(true);
    expect(canMoveOrder(card({ status: 'reserved' })).ok).toBe(true);
  });

  it('no mueve una orden con lista de materiales', () => {
    const check = canMoveOrder(card({ kind: 'bom', status: 'draft' }));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('lista de materiales');
  });

  it('no mueve una orden ya preparada', () => {
    const check = canMoveOrder(card({ status: 'prepared' }));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('surtió');
  });

  it('no mueve una orden que el motor ya no programa', () => {
    for (const status of ['in_progress', 'inspection', 'completed', 'released', 'cancelled']) {
      expect(canMoveOrder(card({ status })).ok).toBe(false);
    }
  });

  it('ignora una soltada que no cambia nada', () => {
    expect(isRealMove(card(), { workCenterId: 'wc-1' })).toBe(false);
    expect(isRealMove(card(), { workCenterId: 'wc-2' })).toBe(true);
    expect(
      isRealMove(card(), { workCenterId: 'wc-1', plannedStartAt: '2026-09-16T13:00:00.000Z' })
    ).toBe(true);
  });

  it('arma el comando real de programación con la versión de la orden', () => {
    expect(
      buildScheduleCommand(card({ id: 'op-9', version: 7 }), {
        workCenterId: 'wc-2',
        plannedStartAt: '2026-09-16T13:00:00.000Z',
      })
    ).toStrictEqual({
      type: 'manufacturing.order.schedule',
      aggregate: { type: 'production_order', id: 'op-9' },
      payload: {
        productionOrderId: 'op-9',
        workCenterId: 'wc-2',
        plannedStartAt: '2026-09-16T13:00:00.000Z',
      },
      expectedVersion: 7,
    });
  });

  it('omite la fecha cuando el planeador decide', () => {
    const command = buildScheduleCommand(card({ id: 'op-9', version: 1 }), {
      workCenterId: 'wc-2',
      plannedStartAt: null,
    });
    expect(command.payload).toStrictEqual({ productionOrderId: 'op-9', workCenterId: 'wc-2' });
  });

  it('describe el movimiento en español', () => {
    expect(describeMove(card(), 'Acabado')).toBe('Mover OP-0001 de Corte a Acabado');
    expect(describeMove(card({ workCenterName: null }), 'Acabado')).toBe('Mover OP-0001 a Acabado');
  });
});

describe('insignias de la tarjeta', () => {
  it('avisa del material faltante con su motivo', () => {
    const badges = cardBadges(
      card({ status: 'blocked', lane: 'blocked', blockedReason: 'Faltan 4 m2 de melamina' }),
      NOW
    );
    const material = badges.find((badge) => badge.id === 'material');
    expect(material?.tone).toBe('danger');
    expect(material?.title).toContain('Faltan 4 m2');
  });

  it('marca la retención de calidad', () => {
    const badges = cardBadges(card({ status: 'inspection' }), NOW);
    expect(badges.some((badge) => badge.id === 'quality')).toBe(true);
  });

  it('calcula la merma sobre lo que salió de la orden', () => {
    expect(scrapPercent({ producedQty: '9', scrapQty: '1' })).toBe(10);
    expect(scrapPercent({ producedQty: '0', scrapQty: '0' })).toBeNull();
    const badges = cardBadges(card({ producedQty: '9', scrapQty: '1' }), NOW);
    const scrap = badges.find((badge) => badge.id === 'scrap');
    expect(scrap?.label).toContain('10');
    expect(scrap?.tone).toBe('danger');
  });

  it('marca como atrasada una orden que pasó su fecha, salvo si ya está para liberar', () => {
    const late = card({ plannedEndAt: '2026-09-14T14:00:00.000Z' });
    expect(cardBadges(late, NOW).some((badge) => badge.id === 'late')).toBe(true);
    expect(
      cardBadges({ ...late, lane: 'done', status: 'completed' }, NOW).some(
        (badge) => badge.id === 'late'
      )
    ).toBe(false);
  });

  it('muestra la prioridad sólo cuando no es normal', () => {
    expect(cardBadges(card(), NOW).some((badge) => badge.id === 'priority')).toBe(false);
    expect(
      cardBadges(card({ priority: 'urgent' }), NOW).some((badge) => badge.id === 'priority')
    ).toBe(true);
  });
});

describe('capacidad', () => {
  it('colorea la utilización por umbrales', () => {
    expect(utilizationTone(50)).toBe('success');
    expect(utilizationTone(85)).toBe('success');
    expect(utilizationTone(90)).toBe('warning');
    expect(utilizationTone(140)).toBe('danger');
  });
});

describe('navegación móvil', () => {
  it('gira entre centros sin salirse', () => {
    expect(nextCenterIndex(0, 1, 3)).toBe(1);
    expect(nextCenterIndex(2, 1, 3)).toBe(0);
    expect(nextCenterIndex(0, -1, 3)).toBe(2);
    expect(nextCenterIndex(0, 1, 0)).toBe(0);
  });
});
