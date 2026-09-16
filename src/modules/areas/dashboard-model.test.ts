import { describe, expect, it } from 'vitest';
import type { AreaDashboardPayload } from './area-server-registry';
import { elapsedSince, relativeSince } from './area-time';
import {
  DASHBOARD_SNAPSHOT_TTL_MS,
  applyLiveTiles,
  freshnessLabel,
  isDashboardEmpty,
  isSnapshotFresh,
  liveTileIds,
  sourceLabel,
  uncoveredLiveTileIds,
} from './dashboard-model';

const NOW = new Date('2026-09-15T18:00:00.000Z');

function payload(overrides: Partial<AreaDashboardPayload> = {}): AreaDashboardPayload {
  return {
    areaKey: 'compras',
    tiles: [
      { id: 'open', label: 'Trabajos abiertos', value: '12', live: true, hint: 'A cargo ahora' },
      { id: 'overdue', label: 'Vencidos', value: '3', tone: 'danger', live: true },
      { id: 'incidents', label: 'Incidencias abiertas', value: '1', tone: 'warning' },
    ],
    charts: [],
    alerts: [],
    computedAt: '2026-09-15T17:57:00.000Z',
    source: 'snapshot',
    note: null,
    ...overrides,
  };
}

describe('relativeSince', () => {
  it('reads seconds, minutes, hours and days in Spanish', () => {
    expect(relativeSince('2026-09-15T17:59:30.000Z', NOW)).toBe('hace un momento');
    expect(relativeSince('2026-09-15T17:57:00.000Z', NOW)).toBe('hace 3 min');
    expect(relativeSince('2026-09-15T16:00:00.000Z', NOW)).toBe('hace 2 h');
    expect(relativeSince('2026-09-11T18:00:00.000Z', NOW)).toBe('hace 4 d');
  });

  it('never prints a negative age when the clocks disagree', () => {
    expect(relativeSince('2026-09-15T18:00:30.000Z', NOW)).toBe('hace un momento');
  });

  it('says so instead of guessing when the instant is unreadable', () => {
    expect(relativeSince('no es una fecha', NOW)).toBe('sin fecha');
    expect(relativeSince(null, NOW)).toBe('sin fecha');
    expect(relativeSince('2026-09-15T17:57:00.000Z', 'reloj roto')).toBe('sin fecha');
    expect(elapsedSince(undefined, NOW)).toBeNull();
  });

  it('accepts the clock the server passes down (ISO string) as well as a Date', () => {
    expect(relativeSince('2026-09-15T17:57:00.000Z', NOW.toISOString())).toBe('hace 3 min');
    expect(relativeSince('2026-09-15T17:57:00.000Z', NOW.getTime())).toBe('hace 3 min');
  });
});

describe('freshnessLabel', () => {
  it('states how old the numbers are', () => {
    expect(freshnessLabel('2026-09-15T17:57:00.000Z', NOW)).toBe('Actualizado hace 3 min');
    expect(freshnessLabel(NOW, NOW)).toBe('Actualizado hace un momento');
    expect(freshnessLabel('roto', NOW)).toBe('Sin fecha de actualización');
  });

  it('marks where a snapshot came from', () => {
    expect(sourceLabel('snapshot')).toBe('desde la última proyección');
    expect(sourceLabel('live')).toBeNull();
  });
});

describe('isSnapshotFresh', () => {
  it('accepts a snapshot inside the refresh window and rejects an older one', () => {
    expect(isSnapshotFresh('2026-09-15T17:56:00.000Z', NOW)).toBe(true);
    expect(isSnapshotFresh('2026-09-15T17:54:59.000Z', NOW)).toBe(false);
    expect(isSnapshotFresh(new Date(NOW.getTime() - DASHBOARD_SNAPSHOT_TTL_MS), NOW)).toBe(false);
  });

  it('treats a missing or unreadable instant as stale', () => {
    expect(isSnapshotFresh(null, NOW)).toBe(false);
    expect(isSnapshotFresh('ayer', NOW)).toBe(false);
  });

  it('keeps a snapshot from the future (clock skew) usable', () => {
    expect(isSnapshotFresh(new Date(NOW.getTime() + 30_000), NOW)).toBe(true);
  });
});

describe('applyLiveTiles', () => {
  it('replaces the value, tone and hint of the live tiles only', () => {
    const merged = applyLiveTiles(payload(), [
      { id: 'open', value: '15' },
      { id: 'overdue', value: '0', tone: 'success', hint: 'Nada fuera de tiempo' },
      { id: 'incidents', value: '99' },
    ]);
    expect(merged.tiles[0]).toMatchObject({ value: '15', hint: 'A cargo ahora', live: true });
    expect(merged.tiles[1]).toMatchObject({
      value: '0',
      tone: 'success',
      hint: 'Nada fuera de tiempo',
    });
    // Not a live tile: the snapshot value stays even though a patch arrived.
    expect(merged.tiles[2]).toMatchObject({ value: '1', tone: 'warning' });
    expect(merged.tiles[2].live).toBeUndefined();
  });

  it('drops the live mark of a tile nobody could recompute', () => {
    const merged = applyLiveTiles(payload(), [{ id: 'open', value: '15' }]);
    expect(merged.tiles[1]).toMatchObject({ value: '3', live: false });
  });

  it('does not mutate the payload it receives', () => {
    const original = payload();
    const merged = applyLiveTiles(original, [{ id: 'open', value: '15' }]);
    expect(original.tiles[0].value).toBe('12');
    expect(merged).not.toBe(original);
  });

  it('lists the tiles that need a live value', () => {
    expect(liveTileIds(payload())).toEqual(['open', 'overdue']);
    expect(liveTileIds(null)).toEqual([]);
  });
});

describe('isDashboardEmpty', () => {
  it('is empty without a payload or without anything to show', () => {
    expect(isDashboardEmpty(null)).toBe(true);
    expect(isDashboardEmpty(payload({ tiles: [], charts: [], alerts: [] }))).toBe(true);
    expect(isDashboardEmpty(payload())).toBe(false);
  });
});

describe('uncoveredLiveTileIds', () => {
  it('names the live tiles nobody recomputed', () => {
    expect(uncoveredLiveTileIds(payload(), [{ id: 'open', value: '15' }])).toEqual(['overdue']);
  });

  it('is empty when every live tile has its patch', () => {
    expect(
      uncoveredLiveTileIds(payload(), [
        { id: 'open', value: '15' },
        { id: 'overdue', value: '0' },
      ])
    ).toEqual([]);
  });

  it('ignores tiles that never claimed to be live', () => {
    expect(uncoveredLiveTileIds(payload({ tiles: [] }), [])).toEqual([]);
    expect(uncoveredLiveTileIds(null, [])).toEqual([]);
  });
});
