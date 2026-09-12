import { safeFetch, EgressError } from '@/modules/extensions/safe-fetch';
import { logIntegrationApiCall } from '@/modules/integrations/integration-api-call-logger';

/**
 * Zoho Books adapter — creates official estimates (cotizaciones).
 *
 * Modes:
 *  - MOCK (`ZOHO_BOOKS_MOCK=true`, or unset while `ZOHO_BOOKS_ORGANIZATION_ID`
 *    is missing): nothing leaves the process; ids are simulated and flagged
 *    `mock: true`. A mock estimate is NOT a validated Books estimate.
 *  - REAL: POST {ZOHO_API_BASE_URL}/books/v3/estimates?organization_id=...
 *    through `safeFetch` (host allow-list derived from ZOHO_API_BASE_URL,
 *    30 s timeout) with the shared Zoho OAuth token (scope
 *    ZohoBooks.estimates.CREATE).
 *
 * Outcome after a timeout is UNCERTAIN: the estimate may exist in Books. The
 * caller must surface that for human reconciliation instead of retrying blindly.
 */

export const ZOHO_BOOKS_SOURCE = 'zoho_books';
const BOOKS_TIMEOUT_MS = 30_000;

export interface BooksEstimateLine {
  name: string;
  description?: string;
  quantity: number;
  rate: number;
}

export interface BooksEstimateInput {
  quoteId: string;
  customerName: string;
  zohoCustomerId?: string | null;
  currency: string;
  items: BooksEstimateLine[];
  notes?: string | null;
  /** Free reference printed on the estimate (e.g. internal quote id). */
  reference?: string;
}

export type BooksEstimateResult =
  | {
      ok: true;
      mock: boolean;
      estimateId: string;
      estimateNumber: string;
      url: string | null;
      uncertain?: false;
    }
  | { ok: false; uncertain: true; error: string }
  | { ok: false; uncertain: false; error: string; httpStatus?: number };

export interface ZohoBooksMode {
  mock: boolean;
  organizationId: string | null;
  reason: string;
}

/** Resolves the effective mode without throwing (safe to show in the UI). */
export type EnvLike = Record<string, string | undefined>;

export function getZohoBooksMode(env: EnvLike = process.env): ZohoBooksMode {
  const organizationId = env.ZOHO_BOOKS_ORGANIZATION_ID?.trim() || null;
  const flag = env.ZOHO_BOOKS_MOCK?.trim().toLowerCase();
  if (flag === 'true') return { mock: true, organizationId, reason: 'ZOHO_BOOKS_MOCK=true' };
  if (flag === 'false') {
    return {
      mock: false,
      organizationId,
      reason: organizationId
        ? 'ZOHO_BOOKS_MOCK=false'
        : 'ZOHO_BOOKS_MOCK=false pero falta ZOHO_BOOKS_ORGANIZATION_ID',
    };
  }
  if (!organizationId) {
    return {
      mock: true,
      organizationId,
      reason: 'Falta ZOHO_BOOKS_ORGANIZATION_ID (modo simulado)',
    };
  }
  return { mock: false, organizationId, reason: 'ZOHO_BOOKS_ORGANIZATION_ID configurado' };
}

/** Best-effort Books web URL (data-center suffix derived from the API host). */
function booksWebUrl(
  apiBaseUrl: string,
  organizationId: string,
  estimateId: string
): string | null {
  try {
    const host = new URL(apiBaseUrl).hostname; // www.zohoapis.com | www.zohoapis.eu | ...
    const suffix = host.split('.').slice(-1)[0] ?? 'com';
    return `https://books.zoho.${suffix}/app/${organizationId}#/estimates/${estimateId}`;
  } catch {
    return null;
  }
}

interface BooksDeps {
  getAccessToken: () => Promise<string>;
  getApiBaseUrl: () => string;
  fetchImpl?: typeof fetch;
  env?: EnvLike;
  now?: () => number;
  /** Tests only: DNS override and shorter timeout. */
  lookup?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
}

async function defaultDeps(): Promise<BooksDeps> {
  const [{ getZohoAccessToken }, { getZohoConfig }] = await Promise.all([
    import('@/modules/integrations/zoho/auth'),
    import('@/modules/integrations/zoho/config'),
  ]);
  return {
    getAccessToken: getZohoAccessToken,
    getApiBaseUrl: () => getZohoConfig().apiBaseUrl,
  };
}

function preview(body: Buffer): string {
  return body.toString('utf8').slice(0, 2048);
}

/**
 * Creates an estimate in Zoho Books (or simulates it in mock mode).
 * Never throws for provider errors: the result carries `ok`/`uncertain`.
 */
export async function createEstimate(
  input: BooksEstimateInput,
  deps?: Partial<BooksDeps>
): Promise<BooksEstimateResult> {
  const env = deps?.env ?? process.env;
  const mode = getZohoBooksMode(env);
  const now = deps?.now ?? Date.now;

  if (mode.mock) {
    const stamp = now().toString(36).toUpperCase();
    return {
      ok: true,
      mock: true,
      estimateId: `mock-${input.quoteId}-${stamp}`,
      estimateNumber: `MOCK-${stamp}`,
      url: null,
    };
  }
  if (!mode.organizationId) {
    return { ok: false, uncertain: false, error: mode.reason };
  }

  const resolved: BooksDeps = { ...(await defaultDeps()), ...deps };
  let apiBaseUrl: string;
  let token: string;
  try {
    apiBaseUrl = resolved.getApiBaseUrl();
    token = await resolved.getAccessToken();
  } catch (err) {
    return {
      ok: false,
      uncertain: false,
      error: `Configuración de Zoho incompleta: ${err instanceof Error ? err.message : 'error'}`,
    };
  }

  const path = '/books/v3/estimates';
  const url = new URL(`${apiBaseUrl.replace(/\/$/, '')}${path}`);
  url.searchParams.set('organization_id', mode.organizationId);
  const allowedHosts = [url.hostname];

  const payload: Record<string, unknown> = {
    customer_name: input.customerName,
    ...(input.zohoCustomerId ? { customer_id: input.zohoCustomerId } : {}),
    currency_code: input.currency,
    reference_number: input.reference ?? input.quoteId,
    ...(input.notes ? { notes: input.notes } : {}),
    line_items: input.items.map((item) => ({
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
      quantity: item.quantity,
      rate: item.rate,
    })),
  };

  const startedAt = now();
  try {
    const res = await safeFetch(
      url.toString(),
      {
        method: 'POST',
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      {
        allowedHosts,
        timeoutMs: resolved.timeoutMs ?? BOOKS_TIMEOUT_MS,
        maxResponseBytes: 1024 * 1024,
        ...(resolved.lookup ? { lookup: resolved.lookup } : {}),
      },
      resolved.fetchImpl
    );
    const durationMs = now() - startedAt;
    let json: {
      code?: number;
      message?: string;
      estimate?: { estimate_id?: string; estimate_number?: string };
    } = {};
    try {
      json = JSON.parse(res.body.toString('utf8')) as typeof json;
    } catch {
      json = {};
    }
    const success = res.status >= 200 && res.status < 300 && (json.code ?? 0) === 0;
    logIntegrationApiCall({
      source: ZOHO_BOOKS_SOURCE,
      method: 'POST',
      path,
      httpStatus: res.status,
      durationMs,
      success,
      errorCode: success ? undefined : `ZOHO_${json.code ?? res.status}`,
      responsePreview: preview(res.body),
    });
    if (!success || !json.estimate?.estimate_id) {
      return {
        ok: false,
        uncertain: false,
        error: json.message ?? `Zoho Books respondió HTTP ${res.status}`,
        httpStatus: res.status,
      };
    }
    return {
      ok: true,
      mock: false,
      estimateId: json.estimate.estimate_id,
      estimateNumber: json.estimate.estimate_number ?? json.estimate.estimate_id,
      url: booksWebUrl(apiBaseUrl, mode.organizationId, json.estimate.estimate_id),
    };
  } catch (err) {
    const durationMs = now() - startedAt;
    const isTimeout = err instanceof EgressError && err.code === 'timeout';
    logIntegrationApiCall({
      source: ZOHO_BOOKS_SOURCE,
      method: 'POST',
      path,
      durationMs,
      success: false,
      errorCode: isTimeout
        ? 'TIMEOUT'
        : err instanceof EgressError
          ? err.code.toUpperCase()
          : 'FETCH_ERROR',
    });
    if (isTimeout) {
      // The request may have reached Books: report as uncertain, never retry blindly.
      return {
        ok: false,
        uncertain: true,
        error: 'Tiempo de espera agotado: la cotización pudo haberse creado en Books',
      };
    }
    return {
      ok: false,
      uncertain: false,
      error: err instanceof Error ? err.message : 'Error de red hacia Zoho Books',
    };
  }
}
