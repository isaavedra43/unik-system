import { describe, expect, it } from 'vitest';
import { foldCaseState, type ReplayCaseState } from '@/modules/control-tower/replay';
import {
  atForIndex,
  caseStatusTone,
  clampIndex,
  describeFrame,
  initialIndex,
  miniStepViews,
  nextIndex,
  replayCounters,
  stepStatusLabel,
  stepStatusTone,
  timelineRows,
  workItemStatusLabel,
} from './replay-model';

const TIMESTAMPS = [
  '2026-03-01T10:00:00.000Z',
  '2026-03-01T11:00:00.000Z',
  '2026-03-01T12:00:00.000Z',
];

describe('deslizador', () => {
  it('acota la posición dentro de la historia', () => {
    expect(clampIndex(-5, 3)).toBe(0);
    expect(clampIndex(99, 3)).toBe(2);
    expect(clampIndex(1.4, 3)).toBe(1);
    expect(clampIndex(0, 0)).toBe(0);
  });

  it('cada posición corresponde a un instante', () => {
    expect(atForIndex(TIMESTAMPS, 1)).toBe(TIMESTAMPS[1]);
    expect(atForIndex(TIMESTAMPS, 42)).toBe(TIMESTAMPS[2]);
    expect(atForIndex([], 0)).toBeNull();
  });

  it('sin ?at abre al final de la historia', () => {
    expect(initialIndex(TIMESTAMPS, null)).toBe(2);
    expect(initialIndex([], null)).toBe(0);
  });

  it('con ?at exacto abre en ese evento', () => {
    expect(initialIndex(TIMESTAMPS, TIMESTAMPS[1]!)).toBe(1);
  });

  it('con ?at intermedio abre en el último evento ya ocurrido', () => {
    expect(initialIndex(TIMESTAMPS, '2026-03-01T11:30:00.000Z')).toBe(1);
    expect(initialIndex(TIMESTAMPS, '2026-02-01T00:00:00.000Z')).toBe(0);
  });

  it('con ?at basura no rompe: abre al final', () => {
    expect(initialIndex(TIMESTAMPS, 'mañana')).toBe(2);
  });

  it('la reproducción avanza hasta el final y ahí se detiene', () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(2, 3)).toBeNull();
    expect(nextIndex(0, 0)).toBeNull();
  });
});

describe('cronología', () => {
  const entries = TIMESTAMPS.map((occurredAt, index) => ({
    id: String(index + 1),
    type: 'step.completed',
    occurredAt,
    areaKey: index === 0 ? 'ventas' : 'compras',
    actorType: 'user',
    line: `10:0${index} Paso ${index + 1}`,
  }));

  it('separa pasado, actual y futuro', () => {
    const rows = timelineRows(entries, TIMESTAMPS[1]!);
    expect(rows.map((row) => row.future)).toEqual([false, false, true]);
    expect(rows.map((row) => row.current)).toEqual([false, true, false]);
  });

  it('sin instante todo es pasado y el último es el actual', () => {
    const rows = timelineRows(entries, null);
    expect(rows.every((row) => !row.future)).toBe(true);
    expect(rows.at(-1)?.current).toBe(true);
  });

  it('ordena por instante aunque lleguen desordenados', () => {
    const rows = timelineRows([entries[2]!, entries[0]!, entries[1]!], null);
    expect(rows.map((row) => row.id)).toEqual(['1', '2', '3']);
  });

  it('traduce el área de cada línea', () => {
    expect(timelineRows(entries, null)[0]?.areaLabel).toBe('Ventas');
  });
});

describe('estado en el tiempo', () => {
  const events = [
    {
      id: '1',
      type: 'case.created',
      occurredAt: TIMESTAMPS[0]!,
      payload: { caseNumber: 'EXP-1', customerName: 'Cliente' },
    },
    {
      id: '2',
      type: 'step.started',
      occurredAt: TIMESTAMPS[1]!,
      areaKey: 'compras',
      payload: { stepKey: 'comprar', scopeKey: '' },
    },
    {
      id: '3',
      type: 'incident.opened',
      occurredAt: TIMESTAMPS[2]!,
      areaKey: 'compras',
      payload: { incidentId: 'i1', title: 'Proveedor no responde', severity: 'high' },
    },
  ];

  it('rebobinar quita lo que todavía no pasaba', () => {
    const before = foldCaseState(events, TIMESTAMPS[1]!);
    const after = foldCaseState(events, TIMESTAMPS[2]!);
    expect(before.counters.openIncidents).toBe(0);
    expect(after.counters.openIncidents).toBe(1);
  });

  it('el mini visor colorea cada paso por su estado', () => {
    const state = foldCaseState(events, TIMESTAMPS[2]!);
    const steps = miniStepViews(state, new Map([['comprar', 'Comprar material']]));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.label).toBe('Comprar material');
    expect(steps[0]?.status).toBe('active');
    expect(steps[0]?.tone).toBe('brand');
    expect(steps[0]?.areaLabel).toBe('Compras');
  });

  it('sin etiqueta del proceso el mini visor usa la clave del paso', () => {
    const state = foldCaseState(events, TIMESTAMPS[2]!);
    expect(miniStepViews(state)[0]?.label).toBe('comprar');
  });

  it('los contadores marcan lo que estaba mal en ese instante', () => {
    const tiles = replayCounters(foldCaseState(events, TIMESTAMPS[2]!));
    const incidents = tiles.find((tile) => tile.key === 'incidents');
    expect(incidents?.value).toBe(1);
    expect(incidents?.tone).toBe('danger');
  });

  it('cada estado de paso tiene etiqueta y tono', () => {
    expect(stepStatusLabel('waiting')).toBe('En espera');
    expect(stepStatusTone('failed')).toBe('danger');
    expect(stepStatusTone('done')).toBe('success');
    expect(workItemStatusLabel('escalated')).toBe('Escalado');
  });
});

describe('encabezado del reproductor', () => {
  const state = (partial: Partial<ReplayCaseState> = {}): ReplayCaseState =>
    ({
      at: TIMESTAMPS[1]!,
      eventsApplied: 2,
      lastEventId: '2',
      lastEventAt: TIMESTAMPS[1]!,
      caseNumber: 'EXP-1',
      customerName: null,
      salesOrderNumber: null,
      ownerUserId: null,
      status: 'open',
      phase: 'planning',
      started: true,
      delivered: false,
      closedAt: null,
      cancelledAt: null,
      steps: [],
      workItems: [],
      requests: [],
      incidents: [],
      counters: {
        openSteps: 0,
        openWorkItems: 0,
        openRequests: 0,
        openIncidents: 0,
        blockingRequests: 0,
        overdueWorkItems: 0,
      },
      ...partial,
    }) as ReplayCaseState;

  it('dice en qué evento va', () => {
    expect(describeFrame(state(), 1, 3)).toContain('evento 2 de 3');
  });

  it('un expediente sin eventos lo dice', () => {
    expect(describeFrame(state(), 0, 0)).toContain('sin eventos');
  });

  it('el tono refleja el problema del momento', () => {
    expect(caseStatusTone(state())).toBe('info');
    expect(caseStatusTone(state({ status: 'closed' }))).toBe('success');
    expect(caseStatusTone(state({ status: 'cancelled' }))).toBe('danger');
    expect(
      caseStatusTone(
        state({
          counters: {
            openSteps: 0,
            openWorkItems: 0,
            openRequests: 1,
            openIncidents: 0,
            blockingRequests: 1,
            overdueWorkItems: 0,
          },
        })
      )
    ).toBe('warning');
  });
});
