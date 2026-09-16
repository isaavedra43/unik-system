import { describe, expect, it } from 'vitest';
import { foldCaseState, replayTimestamps, type ReplayEvent } from './replay';

/**
 * Reproducción de un expediente: el estado sale de los HECHOS, no de una foto.
 * Lo que se prueba es que rebobinar a un instante dé exactamente lo que había
 * en ese instante, y que los eventos de auditoría de la IA no muevan el negocio.
 */

let seq = 0;
function event(
  type: string,
  at: string,
  payload: Record<string, unknown> = {},
  extra: Partial<ReplayEvent> = {}
): ReplayEvent {
  seq += 1;
  return { id: String(seq), type, occurredAt: at, payload, ...extra };
}

function baseTimeline(): ReplayEvent[] {
  seq = 0;
  return [
    event('case.created', '2026-09-01T10:00:00.000Z', {
      caseNumber: 'EXP-12',
      customerName: 'Aceros del Norte',
      salesOrderNumber: 'SO-99',
      ownerUserId: 'u1',
    }),
    event('case.phase_changed', '2026-09-01T10:05:00.000Z', { to: 'sourcing' }),
    event('step.ready', '2026-09-01T10:06:00.000Z', {
      stepKey: 'verificar',
      scopeKey: 'd1',
      areaKey: 'inventario',
      dueAt: '2026-09-01T12:00:00.000Z',
    }),
    event(
      'step.started',
      '2026-09-01T10:10:00.000Z',
      { stepKey: 'verificar', scopeKey: 'd1' },
      { areaKey: 'inventario' }
    ),
    event('workitem.created', '2026-09-01T10:10:00.000Z', {
      workItemId: 'w1',
      title: 'Verificar existencia',
      ownerUserId: 'u2',
      backupUserId: 'u3',
      dueAt: '2026-09-01T12:00:00.000Z',
    }),
    event('ai.turn', '2026-09-01T10:11:00.000Z', { tokens: 900 }),
    event('request.created', '2026-09-01T10:20:00.000Z', {
      requestId: 'r1',
      kind: 'purchase',
      fromAreaKey: 'ventas',
      toAreaKey: 'compras',
      blocksDelivery: true,
      dueAt: '2026-09-02T10:00:00.000Z',
    }),
    event('incident.opened', '2026-09-01T11:00:00.000Z', {
      incidentId: 'i1',
      kind: 'stock_conflict',
      severity: 'high',
      title: 'Faltan 3 piezas',
    }),
    event(
      'step.completed',
      '2026-09-01T11:30:00.000Z',
      { stepKey: 'verificar', scopeKey: 'd1' },
      { areaKey: 'inventario' }
    ),
    event('workitem.completed', '2026-09-01T11:30:00.000Z', { workItemId: 'w1' }),
    event('request.resolved', '2026-09-02T09:00:00.000Z', { requestId: 'r1' }),
    event('incident.resolved', '2026-09-02T09:05:00.000Z', { incidentId: 'i1' }),
    event('case.status_changed', '2026-09-02T18:00:00.000Z', { to: 'closed' }),
  ];
}

describe('replayTimestamps', () => {
  it('devuelve los instantes distintos, ordenados', () => {
    const stamps = replayTimestamps(baseTimeline());
    expect(stamps[0]).toBe('2026-09-01T10:00:00.000Z');
    expect(stamps).toEqual([...stamps].sort());
    // 10:10 aparece dos veces en la bitácora y una sola en el deslizador
    expect(stamps.filter((value) => value === '2026-09-01T10:10:00.000Z')).toHaveLength(1);
  });
});

describe('foldCaseState', () => {
  it('sin instante reproduce hasta el último evento', () => {
    const state = foldCaseState(baseTimeline());
    expect(state.caseNumber).toBe('EXP-12');
    expect(state.customerName).toBe('Aceros del Norte');
    expect(state.salesOrderNumber).toBe('SO-99');
    expect(state.status).toBe('closed');
    expect(state.phase).toBe('sourcing');
    expect(state.closedAt).toBe('2026-09-02T18:00:00.000Z');
    expect(state.counters.openSteps).toBe(0);
    expect(state.counters.openWorkItems).toBe(0);
    expect(state.counters.openRequests).toBe(0);
    expect(state.counters.openIncidents).toBe(0);
  });

  it('rebobina: a las 10:30 el paso está activo y la solicitud sigue abierta', () => {
    const state = foldCaseState(baseTimeline(), '2026-09-01T10:30:00.000Z');
    expect(state.at).toBe('2026-09-01T10:30:00.000Z');
    expect(state.status).toBe('open');
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]).toMatchObject({
      stepKey: 'verificar',
      scopeKey: 'd1',
      status: 'active',
      areaKey: 'inventario',
      startedAt: '2026-09-01T10:10:00.000Z',
    });
    expect(state.workItems[0]).toMatchObject({ id: 'w1', status: 'open', ownerUserId: 'u2' });
    expect(state.requests[0]).toMatchObject({ id: 'r1', status: 'sent', blocksDelivery: true });
    expect(state.counters.openSteps).toBe(1);
    expect(state.counters.openRequests).toBe(1);
    expect(state.counters.blockingRequests).toBe(1);
    expect(state.counters.openIncidents).toBe(0); // la incidencia abre a las 11:00
  });

  it('un instante anterior al primer evento deja el expediente sin empezar', () => {
    const state = foldCaseState(baseTimeline(), '2026-08-01T00:00:00.000Z');
    expect(state.eventsApplied).toBe(0);
    expect(state.started).toBe(false);
    expect(state.caseNumber).toBeNull();
    expect(state.steps).toEqual([]);
  });

  it('los eventos de auditoría de la IA no cuentan ni mueven el estado', () => {
    const withAi = foldCaseState(baseTimeline(), '2026-09-01T10:15:00.000Z');
    const withoutAi = foldCaseState(
      baseTimeline().filter((entry) => !entry.type.startsWith('ai.')),
      '2026-09-01T10:15:00.000Z'
    );
    expect(withAi.eventsApplied).toBe(withoutAi.eventsApplied);
    expect(withAi.counters).toEqual(withoutAi.counters);
  });

  it('cuenta el trabajo vencido respecto del instante reproducido, no de ahora', () => {
    const events: ReplayEvent[] = [
      event('workitem.created', '2026-09-01T08:00:00.000Z', {
        workItemId: 'w9',
        title: 'Cargar camión',
        ownerUserId: 'u5',
        dueAt: '2026-09-01T10:00:00.000Z',
      }),
    ];
    expect(foldCaseState(events, '2026-09-01T09:00:00.000Z').counters.overdueWorkItems).toBe(0);
    expect(foldCaseState(events, '2026-09-01T11:00:00.000Z').counters.overdueWorkItems).toBe(1);
  });

  it('reabrir un paso lo devuelve a listo y borra su cierre', () => {
    const events: ReplayEvent[] = [
      event('step.completed', '2026-09-01T10:00:00.000Z', { stepKey: 'a', scopeKey: '' }),
      event('step.reopened', '2026-09-01T11:00:00.000Z', { stepKey: 'a', scopeKey: '' }),
    ];
    const state = foldCaseState(events);
    expect(state.steps[0]).toMatchObject({ status: 'ready', completedAt: null });
    expect(state.counters.openSteps).toBe(1);
  });

  it('aplica los eventos en orden aunque lleguen desordenados, y desempata por id', () => {
    const events: ReplayEvent[] = [
      {
        id: '2',
        type: 'case.status_changed',
        occurredAt: '2026-09-01T10:00:00.000Z',
        payload: { to: 'blocked' },
      },
      {
        id: '1',
        type: 'case.status_changed',
        occurredAt: '2026-09-01T10:00:00.000Z',
        payload: { to: 'waiting' },
      },
      {
        id: '0',
        type: 'case.created',
        occurredAt: '2026-09-01T09:00:00.000Z',
        payload: { caseNumber: 'EXP-1' },
      },
    ];
    const state = foldCaseState(events);
    expect(state.caseNumber).toBe('EXP-1');
    expect(state.status).toBe('blocked'); // id 2 es el último del mismo instante
  });

  it('el escalamiento y la reasignación quedan reflejados', () => {
    const events: ReplayEvent[] = [
      event('workitem.created', '2026-09-01T08:00:00.000Z', {
        workItemId: 'w1',
        title: 'Surtir',
        ownerUserId: 'u1',
        dueAt: '2026-09-01T09:00:00.000Z',
      }),
      event('workitem.escalated', '2026-09-01T09:30:00.000Z', { workItemId: 'w1', level: 2 }),
      event('workitem.reassigned', '2026-09-01T09:40:00.000Z', {
        workItemId: 'w1',
        ownerUserId: 'u2',
        backupUserId: 'u3',
      }),
    ];
    const state = foldCaseState(events);
    expect(state.workItems[0]).toMatchObject({
      status: 'escalated',
      escalationLevel: 2,
      ownerUserId: 'u2',
      backupUserId: 'u3',
    });
  });

  it('un expediente cancelado queda cancelado con su fecha', () => {
    const events: ReplayEvent[] = [
      event('case.created', '2026-09-01T08:00:00.000Z', { caseNumber: 'EXP-3' }),
      event('case.cancelled', '2026-09-03T08:00:00.000Z', {}),
    ];
    const state = foldCaseState(events);
    expect(state.status).toBe('cancelled');
    expect(state.cancelledAt).toBe('2026-09-03T08:00:00.000Z');
  });

  it('una bitácora vacía devuelve un estado inicial coherente', () => {
    const state = foldCaseState([]);
    expect(state.eventsApplied).toBe(0);
    expect(state.status).toBe('open');
    expect(state.phase).toBe('planning');
    expect(state.counters.openWorkItems).toBe(0);
    expect(state.at).toBe(new Date(0).toISOString());
  });
});
