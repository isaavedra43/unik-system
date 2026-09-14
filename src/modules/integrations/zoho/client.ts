import { getZohoAccessToken } from './auth';
import { getZohoConfig } from './config';
import { INTEGRATION_SOURCE_ZOHO } from '../integration-config-service';
import { logIntegrationApiCall } from '../integration-api-call-logger';

export class ZohoApiError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly httpStatus?: number,
    public readonly zohoCode?: number,
    /** Human readable message returned by Zoho (safe to show to end users). */
    public readonly zohoMessage?: string
  ) {
    super(message);
    this.name = 'ZohoApiError';
  }
}

interface ZohoEnvelope {
  code?: number;
  message?: string;
}

/**
 * Zoho exposes several products on the same OAuth token and org id.
 * - inventory → https://www.zohoapis.com/inventory/v1  (sales orders, items, packages…)
 * - books     → https://www.zohoapis.com/books/v3      (estimates / cotizaciones)
 */
export type ZohoProduct = 'inventory' | 'books';

type ZohoMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface ZohoRequestOptions {
  product?: ZohoProduct;
  query?: Record<string, string>;
  /** JSON body. Zoho Books accepts raw JSON bodies with Content-Type application/json. */
  body?: unknown;
}

/** Max time to wait for a single Zoho API call before aborting. */
const ZOHO_REQUEST_TIMEOUT_MS = 30_000;

/** Truncates a JSON response for the API call log preview. */
function truncatePreview(json: unknown): string {
  try {
    const str = JSON.stringify(json);
    return str.length > 2048 ? str.slice(0, 2048) + '…[truncated]' : str;
  } catch {
    return '[unserializable]';
  }
}

function productBasePath(product: ZohoProduct): string {
  return product === 'books' ? '/books/v3' : '/inventory/v1';
}

function resolveOrganizationId(product: ZohoProduct): string {
  const config = getZohoConfig();
  if (product === 'books' && config.booksOrganizationId) return config.booksOrganizationId;
  return config.organizationId;
}

function buildUrl(product: ZohoProduct, path: string, query?: Record<string, string>): URL {
  const config = getZohoConfig();
  const url = new URL(`${config.apiBaseUrl}${productBasePath(product)}${path}`);
  url.searchParams.set('organization_id', resolveOrganizationId(product));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

/**
 * Core request helper shared by every verb. Resolves the access token, builds
 * the URL for the requested product, parses the JSON envelope and logs the
 * call to IntegrationApiCall for the monitoring dashboard.
 */
export async function zohoRequest<T = unknown>(
  method: ZohoMethod,
  path: string,
  options: ZohoRequestOptions = {}
): Promise<T> {
  const product = options.product ?? 'inventory';
  const accessToken = await getZohoAccessToken();
  const url = buildUrl(product, path, options.query);
  const logPath = product === 'books' ? `[books]${path}` : path;

  const startedAt = Date.now();
  let response: Response;

  try {
    const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${accessToken}` };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(ZOHO_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method,
      path: logPath,
      durationMs,
      success: false,
      errorCode: isTimeout ? 'TIMEOUT' : 'FETCH_ERROR',
      responsePreview: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    const durationMs = Date.now() - startedAt;
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method,
      path: logPath,
      httpStatus: response.status,
      durationMs,
      success: false,
      errorCode: 'NON_JSON_RESPONSE',
      responsePreview: `[HTTP ${response.status}] non-JSON body`,
    });
    throw new ZohoApiError(
      `Zoho ${method} ${path} returned a non-JSON response`,
      `${method} ${path}`,
      response.status
    );
  }

  const envelope = json as ZohoEnvelope;

  if (!response.ok) {
    const durationMs = Date.now() - startedAt;
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method,
      path: logPath,
      httpStatus: response.status,
      durationMs,
      success: false,
      errorCode: 'HTTP_ERROR',
      responsePreview: truncatePreview(json),
    });
    throw new ZohoApiError(
      `Zoho ${method} ${path} failed with HTTP status ${response.status}`,
      `${method} ${path}`,
      response.status,
      typeof envelope.code === 'number' ? envelope.code : undefined,
      typeof envelope.message === 'string' ? envelope.message : undefined
    );
  }

  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    const durationMs = Date.now() - startedAt;
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method,
      path: logPath,
      httpStatus: response.status,
      durationMs,
      success: false,
      errorCode: `ZOHO_CODE_${envelope.code}`,
      responsePreview: truncatePreview(json),
    });
    throw new ZohoApiError(
      `Zoho ${method} ${path} returned error code ${envelope.code}`,
      `${method} ${path}`,
      response.status,
      envelope.code,
      typeof envelope.message === 'string' ? envelope.message : undefined
    );
  }

  const durationMs = Date.now() - startedAt;
  logIntegrationApiCall({
    source: INTEGRATION_SOURCE_ZOHO,
    method,
    path: logPath,
    httpStatus: response.status,
    durationMs,
    success: true,
    responsePreview: truncatePreview(json),
  });

  return json as T;
}

/**
 * Performs a GET request against the Zoho Inventory API.
 * Kept as the backwards-compatible entry point used by every Inventory sync.
 *
 * @param path  Logical Inventory path, e.g. "/salesorders"
 * @param query Optional extra query parameters
 */
export async function zohoGet<T = unknown>(
  path: string,
  query?: Record<string, string>
): Promise<T> {
  return zohoRequest<T>('GET', path, { product: 'inventory', query });
}

/** Writes against Zoho Inventory (packages, shipment orders). */
export async function zohoPost<T = unknown>(path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  return zohoRequest<T>('POST', path, { product: 'inventory', body, query });
}

export async function zohoPut<T = unknown>(path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  return zohoRequest<T>('PUT', path, { product: 'inventory', body, query });
}

export async function zohoDelete<T = unknown>(path: string, query?: Record<string, string>): Promise<T> {
  return zohoRequest<T>('DELETE', path, { product: 'inventory', query });
}

// ---------------------------------------------------------------------------
// Zoho Books helpers (cotizaciones / estimates)
// ---------------------------------------------------------------------------

export async function zohoBooksGet<T = unknown>(
  path: string,
  query?: Record<string, string>
): Promise<T> {
  return zohoRequest<T>('GET', path, { product: 'books', query });
}

export async function zohoBooksPost<T = unknown>(
  path: string,
  body?: unknown,
  query?: Record<string, string>
): Promise<T> {
  return zohoRequest<T>('POST', path, { product: 'books', body, query });
}

export async function zohoBooksPut<T = unknown>(
  path: string,
  body?: unknown,
  query?: Record<string, string>
): Promise<T> {
  return zohoRequest<T>('PUT', path, { product: 'books', body, query });
}

export async function zohoBooksDelete<T = unknown>(
  path: string,
  query?: Record<string, string>
): Promise<T> {
  return zohoRequest<T>('DELETE', path, { product: 'books', query });
}

/**
 * Downloads a binary document (PDF) from Zoho Books. Zoho returns the PDF
 * bytes directly when `accept=pdf` is passed. Errors still arrive as JSON.
 */
export async function zohoBooksGetBinary(
  path: string,
  query?: Record<string, string>
): Promise<{ bytes: Uint8Array; contentType: string }> {
  return zohoGetBinary('books', path, query);
}

/**
 * Downloads a binary document (PDF) from any Zoho product. Zoho returns the
 * bytes directly when `accept=pdf` is passed; errors still arrive as JSON.
 */
export async function zohoGetBinary(
  product: ZohoProduct,
  path: string,
  query?: Record<string, string>
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const accessToken = await getZohoAccessToken();
  const url = buildUrl(product, path, { accept: 'pdf', ...(query ?? {}) });
  const logPath = product === 'books' ? `[books]${path}` : path;
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      signal: AbortSignal.timeout(ZOHO_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method: 'GET',
      path: logPath,
      durationMs: Date.now() - startedAt,
      success: false,
      errorCode: 'FETCH_ERROR',
      responsePreview: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';

  if (!response.ok || contentType.includes('application/json')) {
    let preview = `[HTTP ${response.status}]`;
    let zohoCode: number | undefined;
    let zohoMessage: string | undefined;
    try {
      const json = (await response.json()) as ZohoEnvelope;
      preview = truncatePreview(json);
      zohoCode = typeof json.code === 'number' ? json.code : undefined;
      zohoMessage = typeof json.message === 'string' ? json.message : undefined;
    } catch {
      /* keep preview */
    }
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method: 'GET',
      path: logPath,
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      success: false,
      errorCode: zohoCode !== undefined ? `ZOHO_CODE_${zohoCode}` : 'HTTP_ERROR',
      responsePreview: preview,
    });
    throw new ZohoApiError(
      `Zoho GET ${path} (pdf) failed with HTTP status ${response.status}`,
      `GET ${path}`,
      response.status,
      zohoCode,
      zohoMessage
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  logIntegrationApiCall({
    source: INTEGRATION_SOURCE_ZOHO,
    method: 'GET',
    path: logPath,
    httpStatus: response.status,
    durationMs: Date.now() - startedAt,
    success: true,
    responsePreview: `[binary ${contentType} ${bytes.byteLength} bytes]`,
  });

  return { bytes, contentType };
}
