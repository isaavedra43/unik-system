import { z } from 'zod';
import { getZohoConfig } from './config';
import { INTEGRATION_SOURCE_ZOHO } from '../integration-config-service';
import { logIntegrationApiCall } from '../integration-api-call-logger';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
});

const EXPIRY_MARGIN_MS = 60_000;

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
let refreshInFlight: Promise<string> | null = null;

/** Max time to wait for a Zoho OAuth token refresh. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

async function requestAccessToken(): Promise<string> {
  const config = getZohoConfig();

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  });

  const startedAt = Date.now();
  let response: Response;

  try {
    response = await fetch(`${config.accountsBaseUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method: 'POST',
      path: '/oauth/v2/token',
      durationMs,
      success: false,
      errorCode: isTimeout ? 'TIMEOUT' : 'FETCH_ERROR',
      responsePreview: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }

  if (!response.ok) {
    const durationMs = Date.now() - startedAt;
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method: 'POST',
      path: '/oauth/v2/token',
      httpStatus: response.status,
      durationMs,
      success: false,
      errorCode: 'HTTP_ERROR',
      responsePreview: `[HTTP ${response.status}] token refresh failed`,
    });
    throw new Error(`Zoho OAuth token request failed with HTTP status ${response.status}`);
  }

  const json: unknown = await response.json();
  const parsed = tokenResponseSchema.safeParse(json);

  if (!parsed.success) {
    const durationMs = Date.now() - startedAt;
    logIntegrationApiCall({
      source: INTEGRATION_SOURCE_ZOHO,
      method: 'POST',
      path: '/oauth/v2/token',
      httpStatus: response.status,
      durationMs,
      success: false,
      errorCode: 'INVALID_TOKEN_RESPONSE',
      responsePreview: 'token response missing access_token or expires_in',
    });
    throw new Error('Zoho OAuth token response did not contain a valid access token');
  }

  const durationMs = Date.now() - startedAt;
  logIntegrationApiCall({
    source: INTEGRATION_SOURCE_ZOHO,
    method: 'POST',
    path: '/oauth/v2/token',
    httpStatus: response.status,
    durationMs,
    success: true,
    responsePreview: `[token refreshed, expires in ${parsed.data.expires_in}s]`,
  });

  tokenCache = {
    accessToken: parsed.data.access_token,
    expiresAt: Date.now() + parsed.data.expires_in * 1000,
  };

  return tokenCache.accessToken;
}

/**
 * Returns a valid Zoho access token.
 * Reuses the in-memory cached token while it is still valid (with a safety
 * margin before expiry) and refreshes it automatically when needed.
 * Concurrent callers share a single in-flight refresh request.
 */
export async function getZohoAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - EXPIRY_MARGIN_MS) {
    return tokenCache.accessToken;
  }

  if (!refreshInFlight) {
    refreshInFlight = requestAccessToken().finally(() => {
      refreshInFlight = null;
    });
  }

  return refreshInFlight;
}
