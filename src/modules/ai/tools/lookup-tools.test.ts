import { describe, expect, it } from 'vitest';
import { nearbyNumberVariants, normalizeOrderNumber, reconcileWithExpected } from './lookup-tools';

describe('normalizeOrderNumber', () => {
  it('extracts the numeric folio from the ways people write it', () => {
    expect(normalizeOrderNumber('OV-23354')).toBe('23354');
    expect(normalizeOrderNumber('ov 23354.')).toBe('23354');
    expect(normalizeOrderNumber('23354')).toBe('23354');
    expect(normalizeOrderNumber('Recolección')).toBeNull();
  });
});

describe('nearbyNumberVariants', () => {
  it('covers one wrong digit, swapped neighbours and one missing/extra digit', () => {
    const v = nearbyNumberVariants('23364');
    expect(v).toContain('23354'); // 6 → 5 (the handwritten case)
    expect(v).toContain('23634'); // swap
    expect(v).toContain('2364'); // dropped digit
    expect(v).toContain('233644'); // extra digit
    expect(v).not.toContain('23364');
    expect(new Set(v).size).toBe(v.length);
  });
});

describe('reconcileWithExpected', () => {
  it('corrects misread folios against the universe of the PDF and lists the ones without a note', () => {
    const expected = ['OV-23354', 'OV-23216', 'OV-23378', 'OV-23425', 'OV-23140'];
    const r = reconcileWithExpected(['23364', '23359', '23425', '23140', '99999'], expected);
    expect(r.expectedCount).toBe(5);
    expect(r.notInExpected).toEqual([
      { requested: '23364', likely: '23354' }, // 6 → 5
      { requested: '23359', likely: null }, // 23378 is two edits away: never "corrected" into it
      { requested: '99999', likely: null },
    ]);
    expect(r.expectedWithoutRequest).toEqual(['23216', '23378']);
  });
});
