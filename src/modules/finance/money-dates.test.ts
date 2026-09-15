import { describe, expect, it } from 'vitest';
import {
  addDaysToKey,
  daysBetweenKeys,
  isDateKey,
  isPeriodKey,
  localDateKey,
  periodBounds,
  periodKeyOfKey,
  previousPeriodKey,
  toDateKey,
  toDbDate,
  weekStartKey,
} from './finance-dates';
import {
  allocateMoney,
  D,
  formatMxn,
  moneyEquals,
  moneyString,
  nonNegativeMoneySchema,
  parseMoney,
  positiveMoneySchema,
  roundMoney,
  sumMoney,
} from './money';

describe('money', () => {
  it('parses numbers, numeric strings with symbols and decimals; rejects the rest', () => {
    expect(parseMoney(12.5)?.toFixed(2)).toBe('12.50');
    expect(parseMoney('$1,234.56')?.toFixed(2)).toBe('1234.56');
    expect(parseMoney(D('7.1'))?.toFixed(1)).toBe('7.1');
    expect(parseMoney('-3')?.toFixed(0)).toBe('-3');
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney(Number.NaN)).toBeNull();
    expect(parseMoney(Infinity)).toBeNull();
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney({})).toBeNull();
  });

  it('rounds half up to cents and sums exactly', () => {
    expect(roundMoney('2.345').toFixed(2)).toBe('2.35');
    expect(roundMoney('2.344').toFixed(2)).toBe('2.34');
    expect(roundMoney('-2.345').toFixed(2)).toBe('-2.35');
    expect(sumMoney(['0.1', '0.2', null, undefined]).toFixed(2)).toBe('0.30');
    expect(moneyString('10')).toBe('10.00');
    expect(moneyEquals('10.004', '10')).toBe(true);
    expect(moneyEquals('10.006', '10')).toBe(false);
  });

  it('allocates proportionally with the residue on the largest remainders', () => {
    const parts = allocateMoney('100', [1, 1, 1]);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['33.34', '33.33', '33.33']);
    expect(sumMoney(parts).toFixed(2)).toBe('100.00');
    expect(allocateMoney('10', [0, 0]).map((p) => p.toFixed(2))).toEqual(['5.00', '5.00']);
    expect(allocateMoney('0.05', [2, 1]).map((p) => p.toFixed(2))).toEqual(['0.03', '0.02']);
    expect(allocateMoney('10', [])).toEqual([]);
  });

  it('validates positive and non-negative amounts', () => {
    expect(positiveMoneySchema.parse('12.345').toFixed(2)).toBe('12.35');
    expect(positiveMoneySchema.safeParse(0).success).toBe(false);
    expect(positiveMoneySchema.safeParse('x').success).toBe(false);
    expect(nonNegativeMoneySchema.parse(0).toFixed(2)).toBe('0.00');
    expect(nonNegativeMoneySchema.safeParse(-1).success).toBe(false);
    expect(nonNegativeMoneySchema.safeParse('1e20').success).toBe(false);
  });

  it('formats in Mexican pesos', () => {
    expect(formatMxn('1234.5')).toContain('1,234.50');
  });
});

describe('finance dates', () => {
  it('validates date and period keys', () => {
    expect(isDateKey('2026-09-15')).toBe(true);
    expect(isDateKey('2026-02-30')).toBe(false);
    expect(isDateKey('2028-02-29')).toBe(true);
    expect(isDateKey('2026-9-15')).toBe(false);
    expect(isDateKey(20260915)).toBe(false);
    expect(isPeriodKey('2026-09')).toBe(true);
    expect(isPeriodKey('2026-13')).toBe(false);
  });

  it('uses the local day of Mexico City for instants', () => {
    expect(localDateKey(new Date('2026-09-15T05:00:00.000Z'))).toBe('2026-09-14');
    expect(localDateKey(new Date('2026-09-15T06:00:00.000Z'))).toBe('2026-09-15');
    expect(toDateKey('2026-09-15T05:00:00.000Z')).toBe('2026-09-14');
    expect(toDateKey('2026-09-15')).toBe('2026-09-15');
  });

  it('round-trips keys through UTC-midnight storage dates', () => {
    expect(toDbDate('2026-09-15').toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(periodKeyOfKey(toDbDate('2026-09-30'))).toBe('2026-09');
    expect(periodKeyOfKey('2026-09-01')).toBe('2026-09');
    expect(() => toDbDate('2026-02-30')).toThrow();
  });

  it('adds days, measures distances and finds period bounds and weeks', () => {
    expect(addDaysToKey('2026-02-27', 2)).toBe('2026-03-01');
    expect(addDaysToKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetweenKeys('2026-09-01', '2026-09-15')).toBe(14);
    expect(daysBetweenKeys('2026-09-15', '2026-09-01')).toBe(-14);
    const feb = periodBounds('2028-02');
    expect([feb.startKey, feb.endKey]).toEqual(['2028-02-01', '2028-02-29']);
    expect(feb.nextStart.toISOString()).toBe('2028-03-01T00:00:00.000Z');
    expect(previousPeriodKey('2026-01')).toBe('2025-12');
    expect(weekStartKey('2026-09-13')).toBe('2026-09-07'); // Sunday → Monday before
    expect(weekStartKey('2026-09-14')).toBe('2026-09-14'); // Monday
  });
});
