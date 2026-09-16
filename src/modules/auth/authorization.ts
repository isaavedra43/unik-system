import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Role, RolePermission, User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { SESSION_COOKIE_NAME, SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import {
  assertKnownPermission,
  isKnownPermission,
  PermissionKey,
} from '@/modules/auth/permissions';
import { hashSessionToken } from '@/modules/auth/session-service';

/**
 * Server-side authorization helpers. DENY BY DEFAULT: a user only has a
 * permission when one of their active roles grants it, or when they hold the
 * super_admin role (which bypasses the permission list entirely so future
 * permissions apply automatically).
 *
 * Roles and permissions are loaded from PostgreSQL on every request — never
 * from the cookie — so administrative changes apply immediately.
 */

export interface CurrentUser {
  id: string;
  username: string;
  name: string;
  email: string | null;
  mustChangePassword: boolean;
  roleKeys: string[];
  permissionKeys: PermissionKey[];
  isSuperAdmin: boolean;
  /**
   * True only for an AI identity (`User.isBot`). Bot scope is never inferred from role keys:
   * a person given an `agent_*` role is still a person. Absent = a person.
   */
  isBot?: boolean;
}

export interface CurrentSession {
  sessionId: string;
  user: CurrentUser;
}

/**
 * Cross-instance brand: Next.js compiles a server module once per webpack
 * layer, so this class exists several times in the same process and a plain
 * `instanceof` misses an error thrown by another copy (which would turn a
 * "no tienes permisos" into an HTTP 500). `Symbol.for` is process-wide.
 */
const AUTHORIZATION_ERROR_BRAND: unique symbol = Symbol.for('unik.auth.authorizationError');

export class AuthorizationError extends Error {
  readonly [AUTHORIZATION_ERROR_BRAND] = true;

  constructor(message = 'No tienes permisos para realizar esta acción') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export function isAuthorizationError(err: unknown): err is AuthorizationError {
  if (err instanceof AuthorizationError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[AUTHORIZATION_ERROR_BRAND] === true
  );
}

/** A user row loaded with `roles → role → permissions`, as the projection needs it. */
export type UserWithRoles = Pick<
  User,
  'id' | 'username' | 'name' | 'email' | 'mustChangePassword'
> &
  Partial<Pick<User, 'isBot'>> & {
    roles: {
      role: Pick<Role, 'key' | 'isActive'> & {
        permissions: Pick<RolePermission, 'permissionKey'>[];
      };
    }[];
  };

/**
 * Projects a user with their roles into the authorization shape: only active
 * roles count, permission keys are de-duplicated and restricted to the
 * code-first registry, and `isSuperAdmin` comes from an active super_admin role.
 * Pure: it does not check `isActive` of the user nor any session state.
 */
export function toCurrentUser(user: UserWithRoles): CurrentUser {
  const activeRoles = user.roles.map((ur) => ur.role).filter((role) => role.isActive);
  const roleKeys = activeRoles.map((role) => role.key);
  const permissionKeys = [
    ...new Set(activeRoles.flatMap((role) => role.permissions.map((p) => p.permissionKey))),
  ].filter((key): key is PermissionKey => isKnownPermission(key));

  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    mustChangePassword: user.mustChangePassword,
    roleKeys,
    permissionKeys,
    isSuperAdmin: roleKeys.includes(SUPER_ADMIN_ROLE_KEY),
    ...(user.isBot === true ? { isBot: true } : {}),
  };
}

/**
 * Loads an active user with their roles as a `CurrentUser`, for background work
 * done on behalf of the person who requested it (e.g. a queued manual start).
 * Missing or inactive users → null. Roles come from PostgreSQL, never a cache.
 */
export async function loadActiveCurrentUser(userId: string): Promise<CurrentUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: { include: { permissions: true } } } } },
  });
  if (!user || !user.isActive) return null;
  return toCurrentUser(user);
}

/**
 * Resolves the current session from the HttpOnly cookie.
 * Valid session = token hash exists, not revoked, not expired, user active.
 */
export async function getCurrentSession(): Promise<CurrentSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  const session = await prisma.authSession.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: {
      user: {
        include: {
          roles: {
            include: {
              role: { include: { permissions: true } },
            },
          },
        },
      },
    },
  });

  if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  // Bot users (agents layer) never hold a session: login already refuses them; defense in depth.
  if (!session.user.isActive || session.user.isBot) {
    return null;
  }

  return {
    sessionId: session.id,
    user: toCurrentUser(session.user),
  };
}

/** Convenience: current user or null. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getCurrentSession();
  return session?.user ?? null;
}

/** Page/layout guard: redirects to /login when unauthenticated. */
export async function requireAuthenticatedUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  return user;
}

/** Pure permission check. Unknown keys are denied even for super_admin. */
export function hasPermission(user: CurrentUser, permissionKey: string): boolean {
  assertKnownPermission(permissionKey);
  if (user.isSuperAdmin) {
    return true;
  }
  return user.permissionKeys.includes(permissionKey as PermissionKey);
}

export function hasAnyPermission(user: CurrentUser, permissionKeys: string[]): boolean {
  return permissionKeys.some((key) => hasPermission(user, key));
}

export function hasAllPermissions(user: CurrentUser, permissionKeys: string[]): boolean {
  return permissionKeys.every((key) => hasPermission(user, key));
}

/** Throwing guards for Server Actions and services. Unknown keys throw. */
export function assertPermission(user: CurrentUser, permissionKey: string): void {
  if (!hasPermission(user, permissionKey)) {
    throw new AuthorizationError();
  }
}

export function assertAnyPermission(user: CurrentUser, permissionKeys: string[]): void {
  if (!hasAnyPermission(user, permissionKeys)) {
    throw new AuthorizationError();
  }
}

/**
 * Page-level guard: authenticated + permission, otherwise redirect.
 * Unknown permission keys throw before redirect.
 */
export async function requirePermission(permissionKey: string): Promise<CurrentUser> {
  assertKnownPermission(permissionKey);
  const user = await requireAuthenticatedUser();
  if (!hasPermission(user, permissionKey)) {
    redirect('/app');
  }
  return user;
}

export async function requireAnyPermission(permissionKeys: string[]): Promise<CurrentUser> {
  const user = await requireAuthenticatedUser();
  if (!hasAnyPermission(user, permissionKeys)) {
    redirect('/app');
  }
  return user;
}

export async function requireAllPermissions(permissionKeys: string[]): Promise<CurrentUser> {
  const user = await requireAuthenticatedUser();
  if (!hasAllPermissions(user, permissionKeys)) {
    redirect('/app');
  }
  return user;
}
