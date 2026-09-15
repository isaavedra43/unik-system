import { Prisma } from '@prisma/client';
import { OperationsError } from './errors';

/**
 * Human folio counters (EXP-, OC-, OP-, RC-, RFQ-, GX-, OPP-, NOM-).
 *
 * `Sequence {key, next}` stores the next value to hand out. The increment is a
 * single atomic statement inside the caller's transaction:
 *
 *   INSERT … VALUES (key, 2) ON CONFLICT (key) DO UPDATE SET next = next + 1
 *   RETURNING next - 1
 *
 * It never raises a unique violation (a P2002 inside a PostgreSQL transaction
 * aborts it) and the row lock it takes serializes concurrent producers of the
 * same key until their transactions end, so two commits never share a number.
 * A rolled-back transaction also rolls back its increment: folios have no gaps
 * caused by rejected commands.
 */

const KEY_PATTERN = /^[a-z][a-z0-9_.:-]{0,79}$/;
const PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}-?$/;

export function assertSequenceKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new OperationsError('invalid_payload', `Clave de consecutivo inválida: "${key}"`);
  }
}

/** 'EXP' | 'EXP-' + 123 + pad 6 → 'EXP-000123'. Numbers wider than `pad` are not truncated. */
export function formatSequenceNumber(prefix: string, value: number, pad = 6): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new OperationsError('invalid_payload', `Prefijo de folio inválido: "${prefix}"`);
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new OperationsError('invalid_payload', `Consecutivo inválido: ${value}`);
  }
  const base = prefix.endsWith('-') ? prefix : `${prefix}-`;
  return `${base}${String(value).padStart(Math.max(0, Math.min(pad, 12)), '0')}`;
}

/** Atomically takes the next integer of `key` inside `tx` (first call returns 1). */
export async function nextSequenceValue(
  tx: Prisma.TransactionClient,
  key: string
): Promise<number> {
  assertSequenceKey(key);
  const rows = await tx.$queryRaw<Array<{ value: number | bigint }>>`
    INSERT INTO "Sequence" ("key", "next", "updatedAt")
    VALUES (${key}, 2, NOW())
    ON CONFLICT ("key") DO UPDATE
      SET "next" = "Sequence"."next" + 1, "updatedAt" = NOW()
    RETURNING ("next" - 1) AS "value"`;
  const raw = rows[0]?.value;
  const value = typeof raw === 'bigint' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Sequence "${key}" returned an invalid value`);
  }
  return value;
}

/** Takes the next value and formats it: `{ value: 123, number: 'EXP-000123' }`. */
export async function nextSequence(
  tx: Prisma.TransactionClient,
  key: string,
  prefix: string,
  pad = 6
): Promise<{ value: number; number: string }> {
  // Validate the prefix before consuming a value.
  formatSequenceNumber(prefix, 1, pad);
  const value = await nextSequenceValue(tx, key);
  return { value, number: formatSequenceNumber(prefix, value, pad) };
}

/** `nextNumber(tx, 'case', 'EXP')` → 'EXP-000123'. */
export async function nextNumber(
  tx: Prisma.TransactionClient,
  key: string,
  prefix: string,
  pad = 6
): Promise<string> {
  return (await nextSequence(tx, key, prefix, pad)).number;
}
