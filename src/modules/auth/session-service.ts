import { createHash, randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';
import { AUTH_SESSION_TTL_HOURS } from '@/modules/auth/constants';

/**
 * PostgreSQL-backed sessions. The raw token travels only inside the HttpOnly
 * cookie; the database stores exclusively its SHA-256 hash.
 */

/** Generates a cryptographically secure random session token. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex hash of a session token. The raw token is never persisted. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreatedSession {
  sessionId: string;
  token: string;
  expiresAt: Date;
}

/** Creates a session row and returns the raw token for the cookie. */
export async function createSession(userId: string): Promise<CreatedSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000);

  const session = await prisma.authSession.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
    },
  });

  return { sessionId: session.id, token, expiresAt };
}

/** Revokes the session matching the raw token, if it exists. */
export async function revokeSessionByToken(token: string): Promise<void> {
  await prisma.authSession.updateMany({
    where: { tokenHash: hashSessionToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revokes every active session of a user. When exceptSessionId is provided,
 * that session is kept alive (used for "change my password" keeping the
 * current device logged in).
 */
export async function revokeAllUserSessions(
  userId: string,
  exceptSessionId?: string
): Promise<number> {
  const result = await prisma.authSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}
