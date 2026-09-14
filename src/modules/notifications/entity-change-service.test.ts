import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { diffEntityFields, summarizeFieldChanges, formatChangeValue, type ChangeFieldSpec } from './entity-change-service';

interface Row {
  id: string;
  status: string | null;
  total: Prisma.Decimal | null;
  dueDate: Date | null;
  paid: boolean | null;
  updatedAt: Date;
}

const fields: ReadonlyArray<ChangeFieldSpec<Row>> = [
  { key: 'status', label: 'Estado' },
  { key: 'total', label: 'Total' },
  { key: 'dueDate', label: 'Vence' },
  { key: 'paid', label: 'Pagada' },
];

const base: Row = {
  id: 'a',
  status: 'draft',
  total: new Prisma.Decimal('100.50'),
  dueDate: new Date('2026-01-10T00:00:00Z'),
  paid: false,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('diffEntityFields', () => {
  it('ignores fields outside the spec and equal values (Decimal/Date aware)', () => {
    const after: Row = {
      ...base,
      total: new Prisma.Decimal('100.5'),
      dueDate: new Date('2026-01-10T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    };
    expect(diffEntityFields(base, after, fields)).toEqual({});
  });

  it('serializes changed values for JSON storage', () => {
    const after: Row = { ...base, status: 'sent', total: new Prisma.Decimal('120'), paid: true, dueDate: null };
    expect(diffEntityFields(base, after, fields)).toEqual({
      status: { before: 'draft', after: 'sent' },
      total: { before: '100.5', after: '120' },
      dueDate: { before: '2026-01-10T00:00:00.000Z', after: null },
      paid: { before: false, after: true },
    });
  });
});

describe('summarizeFieldChanges', () => {
  it('uses labels and human values, capped at three fields', () => {
    const after: Row = { ...base, status: 'sent', total: new Prisma.Decimal('120'), paid: true, dueDate: null };
    const changes = diffEntityFields(base, after, fields);
    expect(summarizeFieldChanges(base, after, changes, fields)).toBe(
      'Estado: draft → sent, Total: 100.5 → 120, Vence: 2026-01-10 → —'
    );
  });

  it('formats empty, boolean and Decimal values', () => {
    expect(formatChangeValue(null)).toBe('—');
    expect(formatChangeValue('')).toBe('—');
    expect(formatChangeValue(true)).toBe('Sí');
    expect(formatChangeValue(new Prisma.Decimal('3.10'))).toBe('3.1');
  });
});
