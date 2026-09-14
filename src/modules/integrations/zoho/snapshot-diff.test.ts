import { describe, expect, it } from 'vitest';
import { payloadChanged, stableStringify } from './snapshot-diff';

describe('snapshot payload diff', () => {
  it('ignores key order and undefined fields', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: 'x' }, e: undefined })).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(payloadChanged({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
  });

  it('detects a vendor balance change with the same last_modified_time (the frozen-balance bug)', () => {
    const stored = { contact_id: '4459650000000120206', last_modified_time: '2026-07-22T10:00:00-0600', outstanding_payable_amount: 330915, unused_credits_payable_amount: 0 };
    const incoming = { ...stored, outstanding_payable_amount: 516420, unused_credits_payable_amount: 50000 };
    expect(payloadChanged(stored, incoming)).toBe(true);
  });

  it('treats a JSON round-trip as unchanged', () => {
    const raw = { amount: 1850.5, name: 'AARON ROJAS', tags: ['a'], nested: { ok: true, none: null } };
    expect(payloadChanged(JSON.parse(JSON.stringify(raw)), raw)).toBe(false);
  });
});
