import { prisma } from '@/lib/prisma';
import { LOGIN_LOCK_MINUTES, MAX_LOGIN_ATTEMPTS } from '@/modules/auth/constants';
import { hashPassword, verifyPassword } from '@/modules/auth/password';
import { isEmailLike, normalizeUsername } from '@/modules/auth/username';
import {
  createSession,
  revokeAllUserSessions,
  revokeSessionByToken,
} from '@/modules/auth/session-service';
import { recordAuditEvent } from '@/modules/auth/audit-service';

/** Generic client-facing error message. Never reveal which part failed. */
export const GENERIC_LOGIN_ERROR = 'Usuario o contraseña incorrectos';
export const LOCKED_LOGIN_ERROR = 'Acceso temporalmente no disponible. Intenta de nuevo más tarde.';

/**
 * Pre-computed bcrypt hash used to equalize timing when the identifier does
 * not match any user (mitigates user enumeration via response timing).
 */
/**
 * Pre-computed bcrypt hash. It is not a secret — it exists only to keep the
 * bcrypt comparison constant-time for missing/inactive users, mitigating
 * user-enumeration by response timing. This is a fixed value, never generated
 * per request, and it is never logged or sent to the client.
 */
const DUMMY_HASH = '$2b$12$sx4lmBCHikDSe.KCLQ0oIulUOEwnMLGe9Rm3ekcLkMN8PjEBB3A6q';

type LoginResult =
  { ok: true; token: string; mustChangePassword: boolean } | { ok: false; error: string };

/**
 * Verifies credentials with account lockout and creates a DB session.
 * The caller (Server Action) is responsible for setting the cookie.
 */
export async function login(identifier: string, password: string): Promise<LoginResult> {
  const raw = identifier.trim().toLowerCase();
  const isEmail = isEmailLike(raw);

  const user = isEmail
    ? await prisma.user.findUnique({ where: { email: raw } })
    : await prisma.user.findUnique({ where: { username: normalizeUsername(raw) } });

  if (!user) {
    await verifyPassword(password, DUMMY_HASH);
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  if (!user.isActive) {
    await verifyPassword(password, DUMMY_HASH);
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    return { ok: false, error: LOCKED_LOGIN_ERROR };
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);

  if (!passwordOk) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= MAX_LOGIN_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60 * 1000) : null,
      },
    });
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
  });

  const session = await createSession(user.id);

  return { ok: true, token: session.token, mustChangePassword: user.mustChangePassword };
}

/** Revokes the session bound to the raw cookie token. */
export async function logout(token: string): Promise<void> {
  await revokeSessionByToken(token);
}

type ChangeOwnPasswordResult = { ok: true } | { ok: false; error: string };

/**
 * Changes the password of an authenticated user, verifying the current one.
 * All other sessions are revoked; the current session stays alive.
 */
export async function changeOwnPassword(
  userId: string,
  currentSessionId: string,
  currentPassword: string,
  newPassword: string
): Promise<ChangeOwnPasswordResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive) {
    return { ok: false, error: 'Sesión inválida' };
  }

  const currentOk = await verifyPassword(currentPassword, user.passwordHash);
  if (!currentOk) {
    return { ok: false, error: 'La contraseña actual es incorrecta' };
  }

  const newHash = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: newHash,
      mustChangePassword: false,
      passwordChangedAt: new Date(),
    },
  });

  await revokeAllUserSessions(user.id, currentSessionId);

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'auth.password_changed',
    targetType: 'user',
    targetId: user.id,
  });

  return { ok: true };
}

/**
 * Revokes every active session of the user (including the current one).
 * The caller clears the cookie and redirects to /login.
 */
export async function logoutAllDevices(userId: string): Promise<void> {
  await revokeAllUserSessions(userId);
  await recordAuditEvent({
    actorUserId: userId,
    action: 'auth.logout_all',
    targetType: 'user',
    targetId: userId,
  });
}
