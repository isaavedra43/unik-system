import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived, signed public links to storage objects, used when a messaging
 * provider (Twilio) must fetch a media file from UNIK itself — the disk driver
 * and protected objects cannot hand out provider-signed URLs. The token carries
 * the object id, an expiry and an HMAC; served by GET /api/files/media/[token].
 */

const DEFAULT_TTL_SECONDS = 2 * 60 * 60;

function secret(): string {
  return (
    process.env.UNIK_SHARE_LINK_SECRET?.trim() ||
    process.env.UNIK_SECRETS_MASTER_KEY?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    'unik-media-share'
  );
}

function sign(objectId: string, expires: number): string {
  return createHmac('sha256', secret()).update(`media.${objectId}.${expires}`).digest('base64url').slice(0, 32);
}

export function buildMediaToken(objectId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const expires = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds);
  return `${objectId}.${expires}.${sign(objectId, expires)}`;
}

export function verifyMediaToken(rawToken: string): { objectId: string } | null {
  const token = decodeURIComponent(rawToken).replace(/[.,;:!?)\]]+$/, '');
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [objectId, expiresRaw, mac] = parts;
  const expires = Number(expiresRaw);
  if (!objectId || !Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return null;
  const expected = sign(objectId, expires);
  if (expected.length !== mac.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  } catch {
    return null;
  }
  return { objectId };
}

/** Path (relative to APP_URL) a provider can fetch for the next two hours. */
export function mediaSharePath(objectId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  return `/api/files/media/${buildMediaToken(objectId, ttlSeconds)}`;
}
