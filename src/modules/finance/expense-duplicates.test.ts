import { describe, expect, it } from 'vitest';
import {
  buildDuplicateKey,
  duplicateIdentityChanged,
  duplicateSearchWindow,
  evaluateDuplicateStatus,
  findDuplicateMatches,
  normalizeSupplierName,
  supplierKeyOf,
  type DuplicateCandidate,
  type DuplicateSubject,
} from './expense-duplicates';

const candidate = (overrides: Partial<DuplicateCandidate> & { id: string }): DuplicateCandidate => ({
  number: `GX-${overrides.id}`,
  amount: '1000.00',
  dateKey: '2026-09-10',
  supplierId: null,
  supplierNameFree: 'Gasolinera Pemex del Valle',
  receiptHash: null,
  status: 'posted',
  duplicateStatus: 'none',
  ...overrides,
});

const subject: DuplicateSubject = {
  amount: '1000.00',
  dateKey: '2026-09-10',
  supplierNameFree: 'GASOLINERA PEMEX DEL VALLE, S.A. de C.V.',
};

describe('supplier normalization and keys', () => {
  it('normalizes accents, punctuation and legal suffixes', () => {
    expect(normalizeSupplierName('Papelería  Lozano, S.A. de C.V.')).toBe('papeleria lozano');
    expect(normalizeSupplierName('Fletes Rápidos S de RL de CV')).toBe('fletes rapidos');
    expect(normalizeSupplierName('SA')).toBe('sa');
    expect(normalizeSupplierName(null)).toBe('');
  });

  it('prefers the supplier id', () => {
    expect(supplierKeyOf({ supplierId: 's1', supplierNameFree: 'x' })).toBe('s:s1');
    expect(supplierKeyOf({ supplierNameFree: 'Ferretería Sol' })).toBe('n:ferreteria sol');
    expect(supplierKeyOf({})).toBe('');
  });

  it('builds amount|date|supplier only with an amount and a valid date', () => {
    expect(buildDuplicateKey(subject)).toBe('1000.00|2026-09-10|n:gasolinera pemex del valle');
    expect(buildDuplicateKey({ ...subject, amount: 0 })).toBeNull();
    expect(buildDuplicateKey({ ...subject, dateKey: '2026-02-31' })).toBeNull();
    expect(buildDuplicateKey({ amount: '5', dateKey: '2026-09-10' })).toBe('5.00|2026-09-10|');
  });
});

describe('findDuplicateMatches', () => {
  it('finds an exact duplicate (same key)', () => {
    const matches = findDuplicateMatches(subject, [candidate({ id: '1' })]);
    expect(matches).toEqual([expect.objectContaining({ expenseId: '1', kind: 'exact', amountDiffPct: 0, daysApart: 0 })]);
  });

  it('a receipt with the same hash is a duplicate whatever the amount says', () => {
    const matches = findDuplicateMatches({ ...subject, amount: '10', receiptHash: 'h1' }, [
      candidate({ id: '1', amount: '999', dateKey: '2026-01-01', receiptHash: 'h1', supplierNameFree: 'otro' }),
    ]);
    expect(matches[0]).toMatchObject({ kind: 'receipt', expenseId: '1' });
  });

  it('fuzzy: ±1 % of the larger amount within ±3 days', () => {
    const matches = findDuplicateMatches({ ...subject, amount: '1010.00' }, [
      candidate({ id: 'in-1pct', amount: '1000.00', dateKey: '2026-09-13' }),
      candidate({ id: 'out-amount', amount: '999.00', dateKey: '2026-09-10' }),
      candidate({ id: 'out-days', amount: '1010.00', dateKey: '2026-09-14' }),
    ]);
    expect(matches.map((m) => [m.expenseId, m.kind])).toEqual([['in-1pct', 'fuzzy']]);
    expect(matches[0].amountDiffPct).toBeCloseTo(0.0099, 4);
    expect(matches[0].daysApart).toBe(3);
  });

  it('suppliers must be compatible (same, or one unknown)', () => {
    const matches = findDuplicateMatches({ ...subject, amount: '1005' }, [
      candidate({ id: 'other', supplierNameFree: 'Ferretería Sol' }),
      candidate({ id: 'unknown', supplierNameFree: null }),
      candidate({ id: 'by-id', supplierId: 's9', supplierNameFree: null }),
    ]);
    expect(matches.map((m) => m.expenseId)).toEqual(['unknown']);
  });

  it('ignores itself, rejected expenses and confirmed duplicates; orders receipt → exact → fuzzy', () => {
    const matches = findDuplicateMatches({ ...subject, id: 'self', receiptHash: 'h' }, [
      candidate({ id: 'self' }),
      candidate({ id: 'rejected', status: 'rejected' }),
      candidate({ id: 'dup', duplicateStatus: 'confirmed_duplicate' }),
      candidate({ id: 'fuzzy', amount: '1002', dateKey: '2026-09-11' }),
      candidate({ id: 'exact' }),
      candidate({ id: 'receipt', receiptHash: 'h', amount: '3' }),
    ]);
    expect(matches.map((m) => m.expenseId)).toEqual(['receipt', 'exact', 'fuzzy']);
  });

  it('search window covers every fuzzy candidate', () => {
    const window = duplicateSearchWindow({ ...subject, amount: '1000' });
    expect(window).toMatchObject({ fromKey: '2026-09-07', toKey: '2026-09-13' });
    expect(window?.minAmount.toFixed(2)).toBe('990.00');
    expect(window?.maxAmount.toFixed(2)).toBe('1010.11');
    // 1010.10 vs 1000: diff 10.10 / 1010.10 < 1 % → must be inside the window
    expect(findDuplicateMatches({ ...subject, amount: '1000' }, [candidate({ id: 'edge', amount: '1010.10' })])).toHaveLength(1);
    expect(duplicateSearchWindow({ ...subject, dateKey: 'x' })).toBeNull();
  });
});

describe('duplicate state', () => {
  const match = findDuplicateMatches(subject, [candidate({ id: 'orig' })]);

  it('marks suspect with the first match, none without matches', () => {
    expect(evaluateDuplicateStatus({ matches: match, previousStatus: 'none', identityChanged: true })).toEqual({
      status: 'suspect',
      duplicateOfId: 'orig',
    });
    expect(evaluateDuplicateStatus({ matches: [], previousStatus: 'suspect', identityChanged: false })).toEqual({
      status: 'none',
      duplicateOfId: null,
    });
  });

  it('keeps a confirmed decision while the identity does not change', () => {
    expect(evaluateDuplicateStatus({ matches: match, previousStatus: 'confirmed_unique', identityChanged: false }).status).toBe(
      'confirmed_unique'
    );
    expect(
      evaluateDuplicateStatus({ matches: [], previousStatus: 'confirmed_duplicate', previousDuplicateOfId: 'orig', identityChanged: false })
    ).toEqual({ status: 'confirmed_duplicate', duplicateOfId: 'orig' });
    expect(evaluateDuplicateStatus({ matches: match, previousStatus: 'confirmed_unique', identityChanged: true }).status).toBe('suspect');
  });

  it('detects identity changes', () => {
    const base = { amount: '10.00', dateKey: '2026-09-10', supplierNameFree: 'A', receiptHash: null };
    expect(duplicateIdentityChanged(base, { ...base, amount: '10' })).toBe(false);
    expect(duplicateIdentityChanged(base, { ...base, supplierNameFree: ' a ' })).toBe(false);
    expect(duplicateIdentityChanged(base, { ...base, amount: '10.01' })).toBe(true);
    expect(duplicateIdentityChanged(base, { ...base, dateKey: '2026-09-11' })).toBe(true);
    expect(duplicateIdentityChanged(base, { ...base, supplierId: 's1' })).toBe(true);
    expect(duplicateIdentityChanged(base, { ...base, receiptHash: 'h' })).toBe(true);
  });
});
