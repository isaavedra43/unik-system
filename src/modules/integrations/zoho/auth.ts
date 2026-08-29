import { z } from 'zod';
import { getZohoConfig } from './config';

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

async function requestAccessToken(): Promise<string> {
  const config = getZohoConfig();

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch(`${config.accountsBaseUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new Error(`Zoho OAuth token request failed with HTTP status ${response.status}`);
  }

  const json: unknown = await response.json();
  const parsed = tokenResponseSchema.safeParse(json);

  if (!parsed.success) {
    throw new Error('Zoho OAuth token response did not contain a valid access token');
  }

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
