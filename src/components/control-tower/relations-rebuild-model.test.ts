import { describe, expect, it } from 'vitest';

import {
  describeRebuildStatus,
  isRebuildRunning,
  rebuildButtonLabel,
  relationsRebuildTotals,
  type RelationsRebuildStatus,
} from './relations-rebuild-model';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const status = (patch: Partial<RelationsRebuildStatus> = {}): RelationsRebuildStatus => ({
  id: 'job1',
  status: 'completed',
  progress: 100,
  createdAtIso: minutesAgo(30),
  completedAtIso: minutesAgo(25),
  lastError: null,
  totals: null,
  ...patch,
});

describe('relationsRebuildTotals', () => {
  it('suma los totales de todas las fuentes del resumen', () => {
    expect(
      relationsRebuildTotals({
        sources: {
          trips: { scanned: 10, edges: 20, created: 5, reopened: 1 },
          suppliers: { scanned: 4, edges: 4, created: 2, reopened: 0 },
        },
      })
    ).toEqual({ scanned: 14, edges: 24, created: 7, reopened: 1 });
  });

  it('ignora lo que no sea un número finito en vez de romper', () => {
    expect(
      relationsRebuildTotals({
        sources: {
          a: { scanned: 5, edges: 'muchas', created: null, reopened: Number.NaN },
          b: 'no es un objeto',
        },
      })
    ).toEqual({ scanned: 5, edges: 0, created: 0, reopened: 0 });
  });

  it('devuelve null cuando el resultado del trabajo no tiene la forma esperada', () => {
    expect(relationsRebuildTotals(null)).toBeNull();
    expect(relationsRebuildTotals('texto')).toBeNull();
    expect(relationsRebuildTotals({})).toBeNull();
    expect(relationsRebuildTotals({ sources: 42 })).toBeNull();
  });
});

describe('isRebuildRunning', () => {
  it('sólo pendiente o en curso cuentan como en marcha', () => {
    expect(isRebuildRunning(null)).toBe(false);
    expect(isRebuildRunning(status({ status: 'pending' }))).toBe(true);
    expect(isRebuildRunning(status({ status: 'running' }))).toBe(true);
    expect(isRebuildRunning(status({ status: 'completed' }))).toBe(false);
    expect(isRebuildRunning(status({ status: 'failed' }))).toBe(false);
  });
});

describe('describeRebuildStatus', () => {
  it('dice cuando nunca se ha reconstruido', () => {
    expect(describeRebuildStatus(null, NOW)).toBe(
      'La proyección del grafo nunca se ha reconstruido'
    );
  });

  it('usa el momento de encolado mientras está pendiente o en curso', () => {
    expect(describeRebuildStatus(status({ status: 'pending' }), NOW)).toBe(
      'Hay una reconstrucción encolada hace 30 min'
    );
    expect(describeRebuildStatus(status({ status: 'running' }), NOW)).toBe(
      'Hay una reconstrucción en curso desde hace 30 min'
    );
  });

  it('usa el momento de término cuando ya acabó', () => {
    expect(describeRebuildStatus(status(), NOW)).toBe('Última reconstrucción completa hace 25 min');
    expect(describeRebuildStatus(status({ status: 'failed' }), NOW)).toBe(
      'La última reconstrucción falló hace 25 min'
    );
    expect(describeRebuildStatus(status({ status: 'cancelled' }), NOW)).toBe(
      'La última reconstrucción se canceló hace 25 min'
    );
  });

  it('un trabajo sin fecha de término cae al momento de encolado', () => {
    expect(describeRebuildStatus(status({ completedAtIso: null }), NOW)).toBe(
      'Última reconstrucción completa hace 30 min'
    );
  });

  it('un estado desconocido se muestra tal cual en vez de mentir', () => {
    expect(describeRebuildStatus(status({ status: 'raro' }), NOW)).toBe(
      'Última reconstrucción (raro) hace 25 min'
    );
  });
});

describe('rebuildButtonLabel', () => {
  it('sin selección ofrece todas las fuentes y concuerda en número', () => {
    expect(rebuildButtonLabel(0, 17, false)).toBe('Reconstruir las 17 fuentes');
    expect(rebuildButtonLabel(1, 17, false)).toBe('Reconstruir 1 fuente');
    expect(rebuildButtonLabel(3, 17, false)).toBe('Reconstruir 3 fuentes');
  });

  it('mientras encola no ofrece volver a pedirlo', () => {
    expect(rebuildButtonLabel(0, 17, true)).toBe('Encolando…');
  });
});
