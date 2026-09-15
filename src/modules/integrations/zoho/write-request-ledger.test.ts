import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  DEFAULT_PENDING_WRITE_TTL_MS,
  claimWriteRequest,
  decideExistingWriteRequest,
  isUniqueViolation,
  ledgerErrorMessage,
  markWriteRequestFailed,
  type WriteRequestLedgerRow,
} from './write-request-ledger';

/**
 * Generic Zoho write ledger: replay of a completed key, rejection while the
 * first request is still in flight, retry of a failed or stale key (including
 * a lost conditional reopen), propagation of unexpected errors and the
 * best-effort failure mark.
 */

interface Row extends WriteRequestLedgerRow {
  requestKey: string;
  documentId: string | null;
}

const NOW = Date.parse('2026-09-15T12:00:00.000Z');

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`requestKey`)', {
    code: 'P2002',
    clientVersion: 'test',
  });

const row = (overrides: Partial<Row>): Row => ({
  requestKey: 'key-1',
  status: 'pending',
  createdAt: new Date(NOW - 10_000),
  documentId: null,
  ...overrides,
});

class InFlight extends Error {}
class Missing extends Error {}

function store(existing: Row | null, options: { insertError?: unknown; reopenResult?: unknown } = {}) {
  return {
    insert: vi.fn(async () => {
      if (options.insertError) throw options.insertError;
      return {};
    }),
    find: vi.fn(async () => existing),
    reopen: vi.fn(async () => options.reopenResult ?? {}),
    isReplayable: (r: Row) => r.status === 'completed' && Boolean(r.documentId),
    inProgressError: () => new InFlight('en curso'),
    missingError: () => new Missing('sin fila'),
    now: () => NOW,
  };
}

describe('decideExistingWriteRequest', () => {
  const policy = { nowMs: NOW, pendingTtlMs: DEFAULT_PENDING_WRITE_TTL_MS, isReplayable: (r: Row) => r.status === 'completed' && Boolean(r.documentId) };

  it('replays a completed row with its document', () => {
    expect(decideExistingWriteRequest(row({ status: 'completed', documentId: 'doc-1' }), policy)).toBe('replay');
  });

  it('retries a completed row without document (nothing to return)', () => {
    expect(decideExistingWriteRequest(row({ status: 'completed', documentId: null }), policy)).toBe('retry');
  });

  it('treats a pending row younger than the TTL as in flight', () => {
    expect(decideExistingWriteRequest(row({ createdAt: new Date(NOW - DEFAULT_PENDING_WRITE_TTL_MS + 1) }), policy)).toBe('in_progress');
  });

  it('retries a pending row exactly at the TTL (crashed request)', () => {
    expect(decideExistingWriteRequest(row({ createdAt: new Date(NOW - DEFAULT_PENDING_WRITE_TTL_MS) }), policy)).toBe('retry');
  });

  it('retries a failed row', () => {
    expect(decideExistingWriteRequest(row({ status: 'failed' }), policy)).toBe('retry');
  });
});

describe('claimWriteRequest', () => {
  it('claims a new key without reading the ledger', async () => {
    const s = store(null);
    await expect(claimWriteRequest(s)).resolves.toEqual({ kind: 'claimed' });
    expect(s.insert).toHaveBeenCalledTimes(1);
    expect(s.find).not.toHaveBeenCalled();
    expect(s.reopen).not.toHaveBeenCalled();
  });

  it('replays the row of a completed key', async () => {
    const existing = row({ status: 'completed', documentId: 'doc-1' });
    const s = store(existing, { insertError: uniqueViolation() });
    await expect(claimWriteRequest(s)).resolves.toEqual({ kind: 'replay', row: existing });
    expect(s.reopen).not.toHaveBeenCalled();
  });

  it('rejects a key still in flight without reopening it', async () => {
    const s = store(row({ status: 'pending' }), { insertError: uniqueViolation() });
    await expect(claimWriteRequest(s)).rejects.toBeInstanceOf(InFlight);
    expect(s.reopen).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', row({ status: 'failed' })],
    ['stale pending', row({ status: 'pending', createdAt: new Date(NOW - 3 * 60_000) })],
  ])('reopens a %s key and hands it back for a retry', async (_label, existing) => {
    const s = store(existing, { insertError: uniqueViolation() });
    await expect(claimWriteRequest(s)).resolves.toEqual({ kind: 'retry', previous: existing });
    expect(s.reopen).toHaveBeenCalledWith(existing);
  });

  it('behaves as in flight when a conditional reopen lost the race', async () => {
    const s = store(row({ status: 'failed' }), { insertError: uniqueViolation(), reopenResult: false });
    await expect(claimWriteRequest(s)).rejects.toBeInstanceOf(InFlight);
  });

  it('honours a custom TTL', async () => {
    const s = { ...store(row({ status: 'pending', createdAt: new Date(NOW - 20_000) }), { insertError: uniqueViolation() }), pendingTtlMs: 10_000 };
    await expect(claimWriteRequest(s)).resolves.toMatchObject({ kind: 'retry' });
  });

  it('runs the same-request guard before deciding', async () => {
    const s = {
      ...store(row({ status: 'completed', documentId: 'doc-1' }), { insertError: uniqueViolation() }),
      assertSameRequest: () => {
        throw new Error('llave reutilizada');
      },
    };
    await expect(claimWriteRequest(s)).rejects.toThrow('llave reutilizada');
  });

  it('propagates unexpected insert errors without reading the ledger', async () => {
    const s = store(null, { insertError: new Error('connection lost') });
    await expect(claimWriteRequest(s)).rejects.toThrow('connection lost');
    expect(s.find).not.toHaveBeenCalled();
  });

  it('reports a row that vanished between the conflict and the read', async () => {
    const s = store(null, { insertError: uniqueViolation() });
    await expect(claimWriteRequest(s)).rejects.toBeInstanceOf(Missing);
  });
});

describe('helpers', () => {
  it('recognizes only P2002 as a unique violation', () => {
    expect(isUniqueViolation(uniqueViolation())).toBe(true);
    expect(
      isUniqueViolation(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 'test' }))
    ).toBe(false);
    expect(isUniqueViolation(new Error('P2002'))).toBe(false);
  });

  it('bounds the stored message', () => {
    expect(ledgerErrorMessage('x'.repeat(900))).toHaveLength(500);
    expect(ledgerErrorMessage('abc', 2)).toBe('ab');
  });

  it('swallows a failure while marking the key failed', async () => {
    await expect(markWriteRequestFailed(async () => { throw new Error('db down'); })).resolves.toBeUndefined();
    const update = vi.fn(async () => ({}));
    await markWriteRequestFailed(update);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
