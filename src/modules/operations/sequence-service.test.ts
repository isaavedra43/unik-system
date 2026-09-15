import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { OperationsError } from './errors';
import {
  formatSequenceNumber,
  nextNumber,
  nextSequence,
  nextSequenceValue,
} from './sequence-service';
import { RAW_NOT_HANDLED, addRawHandler, createOpsFake } from './testing/fixtures';

function setup() {
  const fake = createOpsFake();
  return { fake, tx: fake.client as unknown as Prisma.TransactionClient };
}

describe('formatSequenceNumber', () => {
  it('pads with zeros and adds the dash when missing', () => {
    expect(formatSequenceNumber('EXP', 123)).toBe('EXP-000123');
    expect(formatSequenceNumber('OC-', 7, 4)).toBe('OC-0007');
    expect(formatSequenceNumber('RFQ', 1234567, 6)).toBe('RFQ-1234567');
  });

  it('rejects invalid prefixes and values', () => {
    expect(() => formatSequenceNumber('exp', 1)).toThrow(OperationsError);
    expect(() => formatSequenceNumber('EXP', 0)).toThrow(OperationsError);
    expect(() => formatSequenceNumber('EXP', 1.5)).toThrow(OperationsError);
  });
});

describe('nextNumber', () => {
  it('hands out consecutive numbers per key, starting at 1', async () => {
    const { tx } = setup();
    expect(await nextNumber(tx, 'case', 'EXP')).toBe('EXP-000001');
    expect(await nextNumber(tx, 'case', 'EXP')).toBe('EXP-000002');
    expect(await nextNumber(tx, 'procurement_order', 'OC')).toBe('OC-000001');
    expect(await nextSequence(tx, 'case', 'EXP')).toEqual({ value: 3, number: 'EXP-000003' });
  });

  it('uses a single atomic upsert statement with RETURNING', async () => {
    const { fake, tx } = setup();
    const seen: Array<{ sql: string; values: unknown[] }> = [];
    addRawHandler(fake, (query) => {
      seen.push({ sql: query.sql, values: query.values });
      return RAW_NOT_HANDLED;
    });
    await nextSequenceValue(tx, 'case');
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toMatch(/INSERT INTO "Sequence"/);
    expect(seen[0].sql).toMatch(/ON CONFLICT \("key"\) DO UPDATE/);
    expect(seen[0].sql).toMatch(/RETURNING/);
    expect(seen[0].values).toEqual(['case']);
  });

  it('accepts bigint values returned by the driver', async () => {
    const { fake, tx } = setup();
    addRawHandler(fake, () => [{ value: BigInt(41) }]);
    expect(await nextNumber(tx, 'case', 'EXP')).toBe('EXP-000041');
  });

  it('validates key and prefix before consuming a value', async () => {
    const { fake, tx } = setup();
    await expect(nextNumber(tx, 'Case Key', 'EXP')).rejects.toBeInstanceOf(OperationsError);
    await expect(nextNumber(tx, 'case', 'exp')).rejects.toBeInstanceOf(OperationsError);
    expect(fake.rows('sequence')).toHaveLength(0);
  });

  it('fails loudly when the statement returns nothing', async () => {
    const { fake, tx } = setup();
    addRawHandler(fake, () => []);
    await expect(nextSequenceValue(tx, 'case')).rejects.toThrow(/invalid value/);
  });
});
