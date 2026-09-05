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

/**
 * Performs a GET request against the Zoho Inventory API.
 * Automatically resolves the access token, appends organization_id and
 * parses the JSON response. Only GET is supported in this phase.
 *
 * Every call is logged to IntegrationApiCall for the monitoring dashboard.
 *
 * @param path  Logical Inventory path, e.g. "/salesorders"
 * @param query Optional extra query parameters
 */
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

export async function zohoGet<T = unknown>(
  path: string,
  query?: Record<string, string>
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

  const startedAt = Date.now();
  let response: Response;

  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      signal: AbortSignal.timeout(ZOHO_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method: 'GET',
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
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method: 'GET',
      path,
      httpStatus: response.status,
      durationMs,
      success: false,
      errorCode: 'NON_JSON_RESPONSE',
      responsePreview: `[HTTP ${response.status}] non-JSON body`,
    });
    throw new ZohoApiError(
      `Zoho GET ${path} returned a non-JSON response`,
      `GET ${path}`,
      response.status
    );
  }

  if (!response.ok) {
    const durationMs = Date.now() - startedAt;
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method: 'GET',
      path,
      httpStatus: response.status,
      durationMs,
      success: false,
      errorCode: 'HTTP_ERROR',
      responsePreview: truncatePreview(json),
    });
    throw new ZohoApiError(
      `Zoho GET ${path} failed with HTTP status ${response.status}`,
      `GET ${path}`,
      response.status
    );
  }

  const envelope = json as ZohoEnvelope;
  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    const durationMs = Date.now() - startedAt;
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method: 'GET',
      path,
      httpStatus: response.status,
      durationMs,
      success: false,
      errorCode: `ZOHO_CODE_${envelope.code}`,
      responsePreview: truncatePreview(json),
    });
    throw new ZohoApiError(
      `Zoho GET ${path} returned error code ${envelope.code}`,
      `GET ${path}`,
      response.status,
      envelope.code
    );
  }

  const durationMs = Date.now() - startedAt;
  logIntegrationApiCall({
    source: INTEGRATION_SOURCE_ZOHO,
    method: 'GET',
    path,
    httpStatus: response.status,
    durationMs,
    success: true,
    responsePreview: truncatePreview(json),
  });

  return json as T;
}
