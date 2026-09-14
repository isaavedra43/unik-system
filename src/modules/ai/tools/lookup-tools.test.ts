import { describe, expect, it } from 'vitest';
import { nearbyNumberVariants, normalizeOrderNumber } from './lookup-tools';

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
