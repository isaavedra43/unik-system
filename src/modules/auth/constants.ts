/**
 * Central authentication constants. Single source of truth: do not duplicate
 * these values anywhere else in the codebase.
 */

/** Failed login attempts before the account is temporarily locked. */
export const MAX_LOGIN_ATTEMPTS = 5;

/** Minutes an account stays locked after too many failed login attempts. */
export const LOGIN_LOCK_MINUTES = 15;

/** Session lifetime in hours. */
export const AUTH_SESSION_TTL_HOURS = 12;

/** Name of the HttpOnly session cookie. */
export const SESSION_COOKIE_NAME = 'unik_session';

/** Key of the system super admin role. Immutable. */
export const SUPER_ADMIN_ROLE_KEY = 'super_admin';

/** Minimum password length (characters). */
export const PASSWORD_MIN_LENGTH = 12;

/** Maximum password length in UTF-8 bytes (bcrypt limit ~72 bytes). */
export const PASSWORD_MAX_BYTES = 72;
