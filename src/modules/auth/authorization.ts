import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
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
}

export interface CurrentSession {
  sessionId: string;
  user: CurrentUser;
}

export class AuthorizationError extends Error {
  constructor(message = 'No tienes permisos para realizar esta acción') {
    super(message);
    this.name = 'AuthorizationError';
  }
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
  if (!session.user.isActive) {
    return null;
  }

  const activeRoles = session.user.roles.map((ur) => ur.role).filter((role) => role.isActive);
  const roleKeys = activeRoles.map((role) => role.key);
  const permissionKeys = [
    ...new Set(activeRoles.flatMap((role) => role.permissions.map((p) => p.permissionKey))),
  ].filter((key): key is PermissionKey => isKnownPermission(key));

  return {
    sessionId: session.id,
    user: {
      id: session.user.id,
      username: session.user.username,
      name: session.user.name,
      email: session.user.email,
      mustChangePassword: session.user.mustChangePassword,
      roleKeys,
      permissionKeys,
      isSuperAdmin: roleKeys.includes(SUPER_ADMIN_ROLE_KEY),
    },
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
