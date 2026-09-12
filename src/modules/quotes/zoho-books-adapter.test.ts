import { describe, it, expect, vi, beforeEach } from 'vitest';

const logged: Array<Record<string, unknown>> = [];
vi.mock('@/modules/integrations/integration-api-call-logger', () => ({
  logIntegrationApiCall: (input: Record<string, unknown>) => {
    logged.push(input);
  },
}));

import { createEstimate, getZohoBooksMode } from './zoho-books-adapter';

const input = {
  quoteId: 'q1',
  customerName: 'ACME',
  currency: 'MXN',
  items: [{ name: 'Tornillo', quantity: 2, rate: 10 }],
};

const realDeps = {
  getAccessToken: async () => 'token',
  getApiBaseUrl: () => 'https://www.zohoapis.com',
  lookup: async () => ['8.8.8.8'],
  timeoutMs: 50,
};

beforeEach(() => {
  logged.length = 0;
});

describe('Zoho Books adapter — mode', () => {
  it('defaults to mock when the organization id is missing', () => {
    expect(getZohoBooksMode({}).mock).toBe(true);
    expect(getZohoBooksMode({ ZOHO_BOOKS_ORGANIZATION_ID: '1' }).mock).toBe(false);
    expect(
      getZohoBooksMode({ ZOHO_BOOKS_ORGANIZATION_ID: '1', ZOHO_BOOKS_MOCK: 'true' }).mock
    ).toBe(true);
  });

  it('returns simulated ids flagged mock and never calls the network', async () => {
    const fetchImpl = vi.fn();
    const res = await createEstimate(input, { env: { ZOHO_BOOKS_MOCK: 'true' }, fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mock).toBe(true);
      expect(res.estimateId).toMatch(/^mock-q1-/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged).toHaveLength(0);
  });
});

describe('Zoho Books adapter — real mode', () => {
  const env = { ZOHO_BOOKS_ORGANIZATION_ID: '777', ZOHO_BOOKS_MOCK: 'false' };

  it('POSTs the estimate with the OAuth token and maps the response', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({ code: 0, estimate: { estimate_id: 'E-1', estimate_number: 'EST-0001' } }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    };
    const res = await createEstimate(input, { ...realDeps, env, fetchImpl });
    expect(res).toMatchObject({
      ok: true,
      mock: false,
      estimateId: 'E-1',
      estimateNumber: 'EST-0001',
    });
    expect(captured!.url).toBe('https://www.zohoapis.com/books/v3/estimates?organization_id=777');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Zoho-oauthtoken token');
    const body = JSON.parse(String(captured!.init.body));
    expect(body.line_items).toEqual([{ name: 'Tornillo', quantity: 2, rate: 10 }]);
    expect(body.customer_name).toBe('ACME');
    expect(logged[0]).toMatchObject({
      source: 'zoho_books',
      method: 'POST',
      success: true,
      httpStatus: 201,
    });
  });

  it('reports provider errors without throwing', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ code: 1001, message: 'Customer not found' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    const res = await createEstimate(input, { ...realDeps, env, fetchImpl });
    expect(res).toMatchObject({
      ok: false,
      uncertain: false,
      error: 'Customer not found',
      httpStatus: 400,
    });
    expect(logged[0]).toMatchObject({ success: false, errorCode: 'ZOHO_1001' });
  });

  it('marks a timeout after POST as uncertain (estimate may exist remotely)', async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const res = await createEstimate(input, { ...realDeps, env, fetchImpl });
    expect(res).toMatchObject({ ok: false, uncertain: true });
    expect(logged[0]).toMatchObject({ success: false, errorCode: 'TIMEOUT' });
  });

  it('refuses hosts outside the Zoho API base', async () => {
    const fetchImpl = vi.fn();
    const res = await createEstimate(input, {
      ...realDeps,
      env,
      fetchImpl,
      getApiBaseUrl: () => 'http://localhost:3000',
    });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
