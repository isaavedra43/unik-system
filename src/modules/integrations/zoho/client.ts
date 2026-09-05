import { getZohoAccessToken } from './auth';
import { getZohoConfig } from './config';

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
 * @param path  Logical Inventory path, e.g. "/salesorders"
 * @param query Optional extra query parameters
 */
/** Max time to wait for a single Zoho API call before aborting. */
const ZOHO_REQUEST_TIMEOUT_MS = 30_000;

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

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    signal: AbortSignal.timeout(ZOHO_REQUEST_TIMEOUT_MS),
  });

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ZohoApiError(
      `Zoho GET ${path} returned a non-JSON response`,
      `GET ${path}`,
      response.status
    );
  }

  if (!response.ok) {
    throw new ZohoApiError(
      `Zoho GET ${path} failed with HTTP status ${response.status}`,
      `GET ${path}`,
      response.status
    );
  }

  const envelope = json as ZohoEnvelope;
  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    throw new ZohoApiError(
      `Zoho GET ${path} returned error code ${envelope.code}`,
      `GET ${path}`,
      response.status,
      envelope.code
    );
  }

  return json as T;
}
