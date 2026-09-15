import type { Prisma } from '@prisma/client';

/**
 * Transaction-scoped advisory locks (PostgreSQL `pg_advisory_xact_lock`).
 *
 * Serialize work that has no single row to lock: the unapplied remainder of a
 * Zoho payment spread over several obligations, postings against the close of
 * a day or month, the creation of a sales order from a quotation. The lock is
 * released at COMMIT / ROLLBACK and is re-entrant inside the same transaction.
 *
 * Keys are hashed with `hashtext`; take several keys in the order returned by
 * `lockOrder` (sorted, unique) so two transactions never wait on each other in
 * opposite order. A shared lock only conflicts with an exclusive one of the
 * same key.
 *
 * `$executeRaw` is used on purpose: `pg_advisory_xact_lock` returns `void`,
 * which `$queryRaw` cannot deserialize.
 */

export type AdvisoryLockMode = 'exclusive' | 'shared';

type RawDb = Pick<Prisma.TransactionClient, '$executeRaw'>;

/** Sorted, unique, non-empty keys (deadlock-free acquisition order). */
export function lockOrder(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter((key) => key.length > 0))].sort();
}

export async function lockAdvisoryKeys(
  tx: RawDb,
  keys: readonly string[],
  mode: AdvisoryLockMode = 'exclusive'
): Promise<void> {
  for (const key of lockOrder(keys)) {
    if (mode === 'shared') {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${key}))`;
    } else {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    }
  }
}
