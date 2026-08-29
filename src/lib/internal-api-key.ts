import { timingSafeEqual } from 'crypto';

/**
 * Validates the X-UNIK-API-Key header against the UNIK_INTERNAL_API_KEY
 * environment variable using a timing-safe comparison.
 * Does not log or expose the API key.
 */
export function isInternalApiKeyValid(request: Request): boolean {
  const expectedKey = process.env.UNIK_INTERNAL_API_KEY;
  const providedKey = request.headers.get('X-UNIK-API-Key');

  if (!expectedKey || !providedKey) {
    return false;
  }

  if (expectedKey.length !== providedKey.length) {
    return false;
  }

  try {
    return timingSafeEqual(Buffer.from(expectedKey), Buffer.from(providedKey));
  } catch {
    return false;
  }
}
