import { Prisma } from '@prisma/client';

/**
 * Idempotency ledger shared by the services that WRITE to Zoho
 * (`QuoteWriteRequest` for estimates, `SalesOrderWriteRequest` for sales orders).
 *
 * The client generates a `requestKey` once per user intention (form submission,
 * approved AI proposal). The unique constraint on `requestKey` is the atomic
 * guard against concurrent sends:
 *
 * 1. `insert()` claims the key with a `pending` row. A unique violation (P2002)
 *    means the key was already used, so the existing row decides:
 *    - replayable (e.g. `completed` with the local id) → the caller returns what
 *      the first request created, without calling Zoho again;
 *    - `pending` younger than the TTL → the request is still in flight: reject
 *      (HTTP 409) so a double click never produces two documents in Zoho;
 *    - `failed`, or `pending` older than the TTL (a crashed request) → retry under
 *      the same key after `reopen()`.
 * 2. Any other error while claiming propagates untouched (nothing reached Zoho).
 * 3. `markWriteRequestFailed` never hides the original error: a failure writing
 *    the ledger on the error path is swallowed.
 *
 * Every model keeps its own columns, so the store operations are passed in as
 * closures (the services keep their exact Prisma calls). `reopen()` may return
 * `false` when it is conditional and another retry won the race; the claim then
 * behaves as "in flight".
 */

export const DEFAULT_PENDING_WRITE_TTL_MS = 2 * 60_000;

/** Columns every write ledger row has. */
export interface WriteRequestLedgerRow {
  status: string;
  createdAt: Date;
}

export type ExistingWriteRequestDecision = 'replay' | 'in_progress' | 'retry';

export interface ExistingWriteRequestPolicy<Row extends WriteRequestLedgerRow> {
  nowMs: number;
  pendingTtlMs: number;
  isReplayable(row: Row): boolean;
}

/** Pure decision for a key that already has a ledger row. */
export function decideExistingWriteRequest<Row extends WriteRequestLedgerRow>(
  row: Row,
  policy: ExistingWriteRequestPolicy<Row>
): ExistingWriteRequestDecision {
  if (policy.isReplayable(row)) return 'replay';
  if (row.status === 'pending' && policy.nowMs - row.createdAt.getTime() < policy.pendingTtlMs) {
    return 'in_progress';
  }
  return 'retry';
}

/** True for Prisma's unique constraint violation (P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export interface ClaimWriteRequestOptions<Row extends WriteRequestLedgerRow> {
  /** Creates the `pending` row for the key (throws P2002 when the key exists). */
  insert(): Promise<unknown>;
  /** Reads the existing row of the key. */
  find(): Promise<Row | null>;
  /** Puts a failed/stale row back to `pending`; `false` = another retry won the race. */
  reopen(row: Row): Promise<unknown>;
  isReplayable(row: Row): boolean;
  /** Error thrown while the first request is still in flight. */
  inProgressError(row: Row): Error;
  /** Error thrown when the row vanished between the conflict and the read. */
  missingError(): Error;
  /** Optional guard: the key was reused for a different request (throw to reject). */
  assertSameRequest?(row: Row): void;
  pendingTtlMs?: number;
  now?: () => number;
}

export type WriteRequestClaim<Row> =
  | { kind: 'claimed' }
  | { kind: 'retry'; previous: Row }
  | { kind: 'replay'; row: Row };

/** Claims `requestKey` (see module comment). */
export async function claimWriteRequest<Row extends WriteRequestLedgerRow>(
  options: ClaimWriteRequestOptions<Row>
): Promise<WriteRequestClaim<Row>> {
  try {
    await options.insert();
    return { kind: 'claimed' };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const existing = await options.find();
  if (!existing) throw options.missingError();
  options.assertSameRequest?.(existing);
  const decision = decideExistingWriteRequest(existing, {
    nowMs: (options.now ?? Date.now)(),
    pendingTtlMs: options.pendingTtlMs ?? DEFAULT_PENDING_WRITE_TTL_MS,
    isReplayable: options.isReplayable,
  });
  if (decision === 'replay') return { kind: 'replay', row: existing };
  if (decision === 'in_progress') throw options.inProgressError(existing);
  const reopened = await options.reopen(existing);
  if (reopened === false) throw options.inProgressError(existing);
  return { kind: 'retry', previous: existing };
}

/** Ledger messages are bounded (the column is informative, not a log). */
export function ledgerErrorMessage(message: string, max = 500): string {
  return message.slice(0, max);
}

/** Marks the key failed on the error path; a ledger failure never masks the original error. */
export async function markWriteRequestFailed(update: () => Promise<unknown>): Promise<void> {
  try {
    await update();
  } catch {
    /* ledger is best-effort on failure */
  }
}
