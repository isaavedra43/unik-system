import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * Characterization of the quote idempotency ledger (QuoteWriteRequest.requestKey) in createQuote:
 * replay returns the quote created the first time, a request still in flight is rejected, a Zoho
 * failure marks the key as failed and a failed/stale key can be retried. Prisma, the Zoho Books
 * calls, the normalizer and the audit log are mocked; nothing reaches Zoho.
 */

const { db, books, normalizer, quotes, audit } = vi.hoisted(() => ({
  db: {
    quoteWriteRequest: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn<(args: unknown) => Promise<unknown>>(async () => ({})),
    },
    contact: { findUnique: vi.fn() },
    product: { findMany: vi.fn() },
    integrationSnapshot: { upsert: vi.fn(), findFirst: vi.fn(async () => null) },
    integrationEntityState: { upsert: vi.fn(async () => ({})) },
    quote: { count: vi.fn(async () => 0) },
  },
  books: {
    createEstimate: vi.fn(),
    updateEstimate: vi.fn(),
    getEstimate: vi.fn(),
    markEstimateStatus: vi.fn(),
    emailEstimate: vi.fn(),
    getEstimatePdf: vi.fn(),
  },
  normalizer: { normalizeQuoteSnapshot: vi.fn(async () => ({ quoteId: 'quote-1' })) },
  quotes: { getQuoteById: vi.fn(async (id: string) => ({ id, estimateNumber: 'COT-00042' })) },
  audit: vi.fn(async () => undefined),
}));

vi.mock('@/lib/prisma', () => ({ prisma: db }));
vi.mock('@/modules/integrations/zoho/estimates', () => books);
vi.mock('@/modules/integrations/zoho/estimates-sync', () => ({
  SOURCE: 'zoho',
  ESTIMATES_ENTITY_TYPE: 'estimate',
}));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: audit }));
vi.mock('./quotes-service', () => quotes);
vi.mock('./quotes-normalizer', () => ({
  normalizeQuoteSnapshot: normalizer.normalizeQuoteSnapshot,
  // Test double of the tolerant payload reader: the ledger, not the parser, is under test here.
  extractEstimatePayload: (raw: unknown) => {
    const estimate = (raw as { estimate?: { estimate_id?: unknown } } | null)?.estimate;
    return estimate && typeof estimate.estimate_id === 'string'
      ? { data: estimate, error: null }
      : { data: null, error: 'sin estimate' };
  },
}));

import { ZohoApiError } from '@/modules/integrations/zoho/client';
import { QuoteWriteError, createQuote } from './quotes-write-service';
import type { QuoteFormInput } from './quotes-form-schema';

const actor = { id: 'user-1' };
const REQUEST_KEY = 'req-key-0001';

const formInput = (): QuoteFormInput => ({
  requestKey: REQUEST_KEY,
  customerId: '4600000300',
  date: '2026-09-15',
  items: [{ itemId: '4600000400', name: 'Porcelanato 60x60', quantity: 15, rate: 320 }],
});

const zohoResponse = {
  code: 0,
  message: 'La cotización se ha creado.',
  estimate: {
    estimate_id: '4600009001',
    estimate_number: 'COT-00042',
    status: 'draft',
    last_modified_time: '2026-09-15T10:00:00-0600',
  },
};

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`requestKey`)',
    {
      code: 'P2002',
      clientVersion: 'test',
    }
  );

const ledgerRow = (overrides: Record<string, unknown>) => ({
  id: 'ledger-1',
  requestKey: REQUEST_KEY,
  operation: 'create',
  userId: actor.id,
  quoteId: null,
  zohoEstimateId: null,
  status: 'pending',
  errorMessage: null,
  createdAt: new Date(),
  completedAt: null,
  ...overrides,
});

function ledgerUpdates(status: string) {
  return db.quoteWriteRequest.update.mock.calls
    .map((call) => call[0] as { where: { requestKey: string }; data: Record<string, unknown> })
    .filter((arg) => arg.data.status === status);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ZOHO_BOOKS_MOCK', 'false');
  db.quoteWriteRequest.create.mockResolvedValue(ledgerRow({}));
  db.contact.findUnique.mockResolvedValue({
    zohoContactId: '4600000300',
    contactType: 'customer',
    contactName: 'Constructora Norte',
  });
  db.product.findMany.mockResolvedValue([{ zohoItemId: '4600000400' }]);
  db.integrationSnapshot.upsert.mockImplementation(
    async (args: { create: { payload: unknown } }) => ({
      id: 'snap-1',
      payload: args.create.payload,
    })
  );
  books.createEstimate.mockResolvedValue(zohoResponse);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createQuote — first request', () => {
  it('claims the key, creates the estimate once in Zoho and completes the ledger with the new quote', async () => {
    const quote = await createQuote(actor, formInput());

    expect(quote).toMatchObject({ id: 'quote-1' });
    expect(db.quoteWriteRequest.create).toHaveBeenCalledWith({
      data: { requestKey: REQUEST_KEY, operation: 'create', userId: actor.id, status: 'pending' },
    });
    expect(books.createEstimate).toHaveBeenCalledTimes(1);
    const payload = books.createEstimate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ customer_id: '4600000300', date: '2026-09-15' });
    expect(payload).not.toHaveProperty('estimate_number');
    expect(payload.line_items).toEqual([
      expect.objectContaining({
        item_id: '4600000400',
        name: 'Porcelanato 60x60',
        quantity: 15,
        rate: 320,
        item_order: 1,
      }),
    ]);
    expect(normalizer.normalizeQuoteSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'snap-1', externalId: '4600009001' }),
      expect.objectContaining({ origin: 'created_in_unik', force: true })
    );
    expect(ledgerUpdates('completed')).toEqual([
      {
        where: { requestKey: REQUEST_KEY },
        data: expect.objectContaining({
          status: 'completed',
          quoteId: 'quote-1',
          zohoEstimateId: '4600009001',
        }),
      },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'quotes.created', targetId: 'quote-1' })
    );
  });
});

describe('createQuote — replay by requestKey', () => {
  it('returns the quote already created for that key without calling Zoho again', async () => {
    db.quoteWriteRequest.create.mockRejectedValue(uniqueViolation());
    db.quoteWriteRequest.findUnique.mockResolvedValue(
      ledgerRow({
        status: 'completed',
        quoteId: 'quote-1',
        zohoEstimateId: '4600009001',
        completedAt: new Date(),
      })
    );

    const quote = await createQuote(actor, formInput());

    expect(quote).toMatchObject({ id: 'quote-1' });
    expect(quotes.getQuoteById).toHaveBeenCalledWith('quote-1');
    expect(books.createEstimate).not.toHaveBeenCalled();
    expect(db.contact.findUnique).not.toHaveBeenCalled();
    expect(normalizer.normalizeQuoteSnapshot).not.toHaveBeenCalled();
    expect(db.quoteWriteRequest.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects a request still in flight (pending < 2 min) without calling Zoho or touching the ledger', async () => {
    db.quoteWriteRequest.create.mockRejectedValue(uniqueViolation());
    db.quoteWriteRequest.findUnique.mockResolvedValue(
      ledgerRow({ status: 'pending', createdAt: new Date(Date.now() - 10_000) })
    );

    const attempt = createQuote(actor, formInput());
    await expect(attempt).rejects.toBeInstanceOf(QuoteWriteError);
    await expect(attempt).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS', status: 409 });

    expect(books.createEstimate).not.toHaveBeenCalled();
    expect(db.quoteWriteRequest.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a failed key',
      ledgerRow({ status: 'failed', errorMessage: 'Zoho: error', completedAt: new Date() }),
    ],
    [
      'a stale pending key (≥ 2 min)',
      ledgerRow({ status: 'pending', createdAt: new Date(Date.now() - 3 * 60_000) }),
    ],
  ])('retries %s under the same key and calls Zoho once', async (_label, existing) => {
    db.quoteWriteRequest.create.mockRejectedValue(uniqueViolation());
    db.quoteWriteRequest.findUnique.mockResolvedValue(existing);

    const quote = await createQuote(actor, formInput());

    expect(quote).toMatchObject({ id: 'quote-1' });
    expect(ledgerUpdates('pending')).toEqual([
      {
        where: { requestKey: REQUEST_KEY },
        data: expect.objectContaining({ status: 'pending', errorMessage: null, completedAt: null }),
      },
    ]);
    expect(books.createEstimate).toHaveBeenCalledTimes(1);
    expect(ledgerUpdates('completed')).toHaveLength(1);
  });

  it('propagates unexpected ledger errors without calling Zoho', async () => {
    db.quoteWriteRequest.create.mockRejectedValue(new Error('connection lost'));

    await expect(createQuote(actor, formInput())).rejects.toThrow('connection lost');
    expect(db.quoteWriteRequest.findUnique).not.toHaveBeenCalled();
    expect(books.createEstimate).not.toHaveBeenCalled();
  });
});

describe('createQuote — failure marks the key as failed', () => {
  it('maps the Zoho error, marks the ledger failed and does not complete it', async () => {
    books.createEstimate.mockRejectedValue(
      new ZohoApiError('Zoho request failed', 'POST /estimates', 400, 1001, 'El cliente no existe')
    );

    const attempt = createQuote(actor, formInput());
    await expect(attempt).rejects.toBeInstanceOf(QuoteWriteError);
    await expect(attempt).rejects.toMatchObject({
      code: 'ZOHO_1001',
      status: 502,
      message: 'Zoho: El cliente no existe',
    });

    expect(ledgerUpdates('failed')).toEqual([
      {
        where: { requestKey: REQUEST_KEY },
        data: expect.objectContaining({
          status: 'failed',
          errorMessage: 'Zoho: El cliente no existe',
        }),
      },
    ]);
    expect(ledgerUpdates('completed')).toHaveLength(0);
    expect(normalizer.normalizeQuoteSnapshot).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('marks a timeout as failed and tells the user to check Zoho before retrying', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    books.createEstimate.mockRejectedValue(timeout);

    await expect(createQuote(actor, formInput())).rejects.toMatchObject({
      code: 'ZOHO_TIMEOUT',
      status: 504,
    });
    expect(ledgerUpdates('failed')).toHaveLength(1);
    expect(String(ledgerUpdates('failed')[0].data.errorMessage)).toContain(
      'Verifica en Zoho antes de reintentar'
    );
  });

  it('still reports the original error when marking the ledger failed also fails', async () => {
    books.createEstimate.mockRejectedValue(
      new ZohoApiError('Zoho request failed', 'POST /estimates', 429)
    );
    db.quoteWriteRequest.update.mockRejectedValueOnce(new Error('db down'));

    await expect(createQuote(actor, formInput())).rejects.toMatchObject({
      code: 'ZOHO_RATE_LIMIT',
      status: 503,
    });
  });

  it('rejects a product missing from the synced catalog before calling Zoho and marks the key failed', async () => {
    db.product.findMany.mockResolvedValue([]);

    await expect(createQuote(actor, formInput())).rejects.toMatchObject({
      code: 'PRODUCT_NOT_FOUND',
      status: 400,
    });
    expect(books.createEstimate).not.toHaveBeenCalled();
    expect(ledgerUpdates('failed')).toHaveLength(1);
  });
});

describe('createQuote — ZOHO_BOOKS_MOCK=true', () => {
  it('simulates the estimate locally (MOCK folio) and still completes the ledger', async () => {
    vi.stubEnv('ZOHO_BOOKS_MOCK', 'true');

    const quote = await createQuote(actor, formInput());

    expect(quote).toMatchObject({ id: 'quote-1' });
    expect(books.createEstimate).not.toHaveBeenCalled();
    const stored = (
      db.integrationSnapshot.upsert.mock.calls[0][0] as {
        create: { payload: { estimate: Record<string, unknown> } };
      }
    ).create.payload.estimate;
    expect(stored).toMatchObject({
      estimate_number: 'MOCK-00001',
      status: 'draft',
      customer_id: '4600000300',
      total: 4800,
    });
    expect(ledgerUpdates('completed')).toHaveLength(1);
  });
});
