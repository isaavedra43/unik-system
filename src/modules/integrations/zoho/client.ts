import { getZohoAccessToken } from './auth';
import { getZohoConfig } from './config';
import { INTEGRATION_SOURCE_ZOHO } from '../integration-config-service';
import { logIntegrationApiCall } from '../integration-api-call-logger';

export class ZohoApiError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly httpStatus?: number,
    public readonly zohoCode?: number
  ) {
    super(message);
    this.name = 'ZohoApiError';
  }
}

interface ZohoEnvelope {
  code?: number;
  message?: string;
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

interface LogZohoCallInput {
  method: string;
  path: string;
  httpStatus?: number;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  responsePreview?: string;
}

function logZohoCall(input: LogZohoCallInput): void {
  logIntegrationApiCall({
    source: INTEGRATION_SOURCE_ZOHO,
    ...input,
  });
}

async function fetchZoho<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  query?: Record<string, string>,
  body?: Record<string, unknown>
): Promise<T> {
  const config = getZohoConfig();
  const accessToken = await getZohoAccessToken();

  const url = new URL(`${config.apiBaseUrl}/inventory/v1${path}`);
  url.searchParams.set('organization_id', config.organizationId);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Zoho-oauthtoken ${accessToken}`,
  };
  let fetchBody: BodyInit | undefined;

  if (method === 'POST' || method === 'PUT') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    const payload = body ? JSON.stringify(body) : '{}';
    fetchBody = new URLSearchParams({ JSONString: payload });
  }

  const startedAt = Date.now();
  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers,
      body: fetchBody,
      signal: AbortSignal.timeout(ZOHO_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
    logZohoCall({
      method,
      path,
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
    logZohoCall({
      method,
      path,
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

  if (!response.ok) {
    const durationMs = Date.now() - startedAt;
    logZohoCall({
      method,
      path,
      httpStatus: response.status,
      durationMs,
      success: false,
      errorCode: 'HTTP_ERROR',
      responsePreview: truncatePreview(json),
    });
    throw new ZohoApiError(
      `Zoho ${method} ${path} failed with HTTP status ${response.status}`,
      `${method} ${path}`,
      response.status
    );
  }

  const envelope = json as ZohoEnvelope;
  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    const durationMs = Date.now() - startedAt;
    logZohoCall({
      method,
      path,
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
      envelope.code
    );
  }

  const durationMs = Date.now() - startedAt;
  logZohoCall({
    method,
    path,
    httpStatus: response.status,
    durationMs,
    success: true,
    responsePreview: truncatePreview(json),
  });

  return json as T;
}

/**
 * Performs a GET request against the Zoho Inventory API.
 * Automatically resolves the access token, appends organization_id and
 * parses the JSON response.
 *
 * @param path  Logical Inventory path, e.g. "/salesorders"
 * @param query Optional extra query parameters
 */
export async function zohoGet<T = unknown>(
  path: string,
  query?: Record<string, string>
): Promise<T> {
  return fetchZoho<T>('GET', path, query);
}

/**
 * Performs a POST request against the Zoho Inventory API.
 * The body is sent as `JSONString=...` with `Content-Type: application/x-www-form-urlencoded`
 * as required by Zoho Inventory v1.
 *
 * @param path Logical Inventory path, e.g. "/estimates"
 * @param body JSON-serializable request body
 */
export async function zohoPost<T = unknown>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  return fetchZoho<T>('POST', path, undefined, body);
}

/**
 * Performs a PUT request against the Zoho Inventory API.
 * Future helper; currently unused.
 */
export async function zohoPut<T = unknown>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  return fetchZoho<T>('PUT', path, undefined, body);
}

/**
 * Performs a DELETE request against the Zoho Inventory API.
 * Future helper; currently unused.
 */
export async function zohoDelete<T = unknown>(
  path: string,
  query?: Record<string, string>
): Promise<T> {
  return fetchZoho<T>('DELETE', path, query);
}
