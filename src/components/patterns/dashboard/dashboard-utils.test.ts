import { describe, expect, it } from 'vitest';
import {
  ALERT_SEVERITY_LABEL,
  deltaIntent,
  describeDelta,
  describeStatusStrip,
  formatShare,
  limitItems,
  segmentShare,
  successRateTone,
  toDate,
  totalSegments,
  type StatusSegment,
} from './dashboard-utils';

describe('successRateTone', () => {
  it('maps the success rate to a status tone by threshold', () => {
    expect(successRateTone(100)).toBe('success');
    expect(successRateTone(95.1)).toBe('success');
    expect(successRateTone(95)).toBe('warning');
    expect(successRateTone(80.5)).toBe('warning');
    expect(successRateTone(80)).toBe('danger');
    expect(successRateTone(0)).toBe('danger');
  });

  it('stays neutral without data instead of signaling a false status', () => {
    expect(successRateTone(null)).toBe('default');
    expect(successRateTone(undefined)).toBe('default');
    expect(successRateTone(Number.NaN)).toBe('default');
  });
});

describe('deltaIntent', () => {
  it('maps direction to intent by default', () => {
    expect(deltaIntent({ value: '5%', direction: 'up' })).toBe('positive');
    expect(deltaIntent({ value: '5%', direction: 'down' })).toBe('negative');
    expect(deltaIntent({ value: '0%', direction: 'flat' })).toBe('neutral');
  });

  it('respects an explicit intent for "lower is better" metrics', () => {
    expect(deltaIntent({ value: '3', direction: 'up', intent: 'negative' })).toBe('negative');
  });
});

describe('describeDelta', () => {
  it('builds a Spanish sentence for screen readers', () => {
    expect(describeDelta({ value: '12%', direction: 'up', label: 'vs. semana anterior' })).toBe(
      'Aumentó 12% vs. semana anterior'
    );
    expect(describeDelta({ value: 4, direction: 'down' })).toBe('Disminuyó 4');
    expect(describeDelta({ value: '', direction: 'flat' })).toBe('Sin cambio');
  });
});

describe('status strip helpers', () => {
  const segments: StatusSegment[] = [
    { key: 'open', label: 'Abiertos', count: 6, tone: 'info' },
    { key: 'blocked', label: 'Bloqueados', count: 1, tone: 'danger' },
    { key: 'done', label: 'Cerrados', count: 3, tone: 'success' },
    { key: 'void', label: 'Cancelados', count: 0, tone: 'muted' },
  ];

  it('totals only positive finite counts', () => {
    expect(totalSegments(segments)).toBe(10);
    expect(
      totalSegments([
        { key: 'a', label: 'A', count: -2, tone: 'brand' },
        { key: 'b', label: 'B', count: Number.NaN, tone: 'brand' },
        { key: 'c', label: 'C', count: 2, tone: 'brand' },
      ])
    ).toBe(2);
  });

  it('computes shares safely', () => {
    expect(segmentShare(1, 3)).toBe(33.3);
    expect(segmentShare(5, 0)).toBe(0);
    expect(segmentShare(0, 10)).toBe(0);
    expect(formatShare(33.3)).toBe('33.3%');
  });

  it('describes the distribution skipping empty segments', () => {
    expect(describeStatusStrip(segments, 'Expedientes por fase')).toBe(
      'Expedientes por fase: 10 en total. Abiertos 6 (60%), Bloqueados 1 (10%), Cerrados 3 (30%).'
    );
  });

  it('describes an empty distribution', () => {
    expect(describeStatusStrip([], 'Entregas')).toBe('Entregas: sin registros.');
  });
});

describe('limitItems', () => {
  const items = ['a', 'b', 'c', 'd'];

  it('returns everything without a valid max', () => {
    expect(limitItems(items)).toEqual({ visible: items, hidden: 0 });
    expect(limitItems(items, 10)).toEqual({ visible: items, hidden: 0 });
    expect(limitItems(items, Number.NaN)).toEqual({ visible: items, hidden: 0 });
  });

  it('cuts to max and counts the rest', () => {
    expect(limitItems(items, 2)).toEqual({ visible: ['a', 'b'], hidden: 2 });
    expect(limitItems(items, 0)).toEqual({ visible: [], hidden: 4 });
  });
});

describe('toDate', () => {
  it('parses ISO strings and dates, rejecting invalid input', () => {
    expect(toDate('2026-09-15T10:00:00.000Z')?.toISOString()).toBe('2026-09-15T10:00:00.000Z');
    const now = new Date();
    expect(toDate(now)).toBe(now);
    expect(toDate('no es fecha')).toBeNull();
    expect(toDate(undefined)).toBeNull();
  });
});

it('labels every alert severity in Spanish', () => {
  expect(ALERT_SEVERITY_LABEL).toEqual({
    info: 'Información',
    warning: 'Advertencia',
    danger: 'Crítica',
  });
});
