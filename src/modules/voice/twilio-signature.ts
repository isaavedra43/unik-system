import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Twilio webhook signature (X-Twilio-Signature).
 *
 * Twilio signs `url + params` (POST params sorted by key, concatenated as
 * key+value without separators) with HMAC-SHA1 using the account auth token
 * and encodes the digest in base64. We implement it ourselves so the voice
 * webhooks do not depend on the Twilio SDK being installed.
 */

export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string> = {}
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null | undefined
): boolean {
  if (!signature || !authToken) return false;
  const expected = computeTwilioSignature(authToken, url, params);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Rebuilds the public URL Twilio signed: `TWILIO_WEBHOOK_BASE_URL` + path +
 * query string of the received request. The proxy-facing origin is taken from
 * configuration, never from `Host` headers (which an attacker controls).
 */
export function buildSignedWebhookUrl(baseUrl: string, pathname: string, search: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${pathname}${search}`;
}

/** Converts form-encoded body params to a plain record (last value wins). */
export function formParamsToRecord(form: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) out[key] = value;
  return out;
}
