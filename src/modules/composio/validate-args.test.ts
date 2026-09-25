import { describe, expect, it } from 'vitest';
import { validateComposioArgs } from './validate-args';
import { shrinkJson } from './shrink-json';

const schema = {
  type: 'object',
  required: ['to', 'subject'],
  properties: {
    to: { type: 'string' },
    subject: { type: 'string' },
    max: { type: 'integer' },
    format: { type: 'string', enum: ['full', 'minimal'] },
    cc: { type: 'array' },
  },
  additionalProperties: false,
};

describe('validateComposioArgs', () => {
  it('accepts a valid call', () => {
    expect(validateComposioArgs(schema, { to: 'a@b.c', subject: 'Hola', max: 3 })).toEqual([]);
  });
  it('reports missing, wrong-type, unknown and enum errors', () => {
    const errors = validateComposioArgs(schema, { to: 5, max: 1.5, format: 'x', extra: 1 });
    expect(errors.join('|')).toMatch(/subject/);
    expect(errors.join('|')).toMatch(/"to"/);
    expect(errors.join('|')).toMatch(/"max"/);
    expect(errors.join('|')).toMatch(/"format"/);
    expect(errors.join('|')).toMatch(/"extra"/);
  });
  it('rejects non-object arguments', () => {
    expect(validateComposioArgs(schema, 'x')).toHaveLength(1);
    expect(validateComposioArgs(schema, [])).toHaveLength(1);
  });
  it('tolerates schemas without properties', () => {
    expect(validateComposioArgs({ type: 'object' }, { anything: 1 })).toEqual([]);
  });
});

describe('shrinkJson', () => {
  it('keeps small values untouched', () => {
    const r = shrinkJson({ a: 1 }, 1000);
    expect(r.truncated).toBe(false);
    expect(r.value).toEqual({ a: 1 });
  });
  it('bounds big arrays while keeping valid JSON and reporting what was omitted', () => {
    const big = {
      items: Array.from({ length: 500 }, (_, i) => ({ id: i, text: 'x'.repeat(200) })),
    };
    const r = shrinkJson(big, 8 * 1024);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBeLessThanOrEqual(8 * 1024);
    const items = (r.value as { items: unknown[] }).items;
    expect(items.at(-1)).toMatchObject({ _omitted: expect.any(Number) });
  });
});
