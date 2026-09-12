import { describe, it, expect } from 'vitest';
import { resolveDateRange, DATE_SHORTCUTS, dateRangeSchema } from './date-helpers';

describe('resolveDateRange — year shortcuts ("este año" used to fail Zod validation)', () => {
  it('accepts this_year and last_year in the schema', () => {
    expect(DATE_SHORTCUTS).toContain('this_year');
    expect(DATE_SHORTCUTS).toContain('last_year');
    expect(dateRangeSchema.safeParse('this_year').success).toBe(true);
    expect(dateRangeSchema.safeParse('last_year').success).toBe(true);
    expect(dateRangeSchema.safeParse('this_decade').success).toBe(false);
  });

  it('this_year spans Jan 1 of the current year to today', () => {
    const { from, to } = resolveDateRange('this_year');
    const year = new Date().getUTCFullYear();
    expect(from!.toISOString()).toBe(`${year}-01-01T00:00:00.000Z`);
    expect(to!.getUTCFullYear()).toBeGreaterThanOrEqual(year - 1);
    expect(to!.getTime()).toBeGreaterThan(from!.getTime());
  });

  it('last_year spans the whole previous calendar year', () => {
    const { from, to } = resolveDateRange('last_year');
    const y = from!.getUTCFullYear();
    expect(from!.toISOString()).toBe(`${y}-01-01T00:00:00.000Z`);
    expect(to!.toISOString()).toBe(`${y}-12-31T23:59:59.999Z`);
  });
});
