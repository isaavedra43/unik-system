import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * toCurrentUser (role → permission projection) and getCurrentSession, which
 * must keep resolving sessions exactly as before the extraction.
 */

const { cookieGet, findSession } = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  findSession: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: cookieGet })) }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));
vi.mock('@/lib/prisma', () => ({ prisma: { authSession: { findUnique: findSession } } }));

import { getCurrentSession, toCurrentUser, type UserWithRoles } from './authorization';
import { SESSION_COOKIE_NAME, SUPER_ADMIN_ROLE_KEY } from './constants';
import { PERMISSION_REGISTRY } from './permissions';
import { hashSessionToken } from './session-service';

const [permA, permB, permC] = PERMISSION_REGISTRY.map((p) => p.key);

function role(key: string, permissions: string[], isActive = true): UserWithRoles['roles'][number] {
  return {
    role: { key, isActive, permissions: permissions.map((permissionKey) => ({ permissionKey })) },
  };
}

function user(roles: UserWithRoles['roles']): UserWithRoles {
  return {
    id: 'u1',
    username: 'ana',
    name: 'Ana Pérez',
    email: 'ana@unik.test',
    mustChangePassword: false,
    roles,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toCurrentUser', () => {
  it('proyecta sólo roles activos y deduplica los permisos', () => {
    const current = toCurrentUser(
      user([
        role('ventas', [permA, permB]),
        role('almacen', [permA]),
        role('viejo', [permC], false),
      ])
    );

    expect(current).toEqual({
      id: 'u1',
      username: 'ana',
      name: 'Ana Pérez',
      email: 'ana@unik.test',
      mustChangePassword: false,
      roleKeys: ['ventas', 'almacen'],
      permissionKeys: [permA, permB],
      isSuperAdmin: false,
    });
  });

  it('descarta permisos que no existen en el registro', () => {
    const current = toCurrentUser(user([role('ventas', [permA, 'no.existe'])]));
    expect(current.permissionKeys).toEqual([permA]);
  });

  it('marca isSuperAdmin sólo con un rol super_admin activo', () => {
    expect(toCurrentUser(user([role(SUPER_ADMIN_ROLE_KEY, [])])).isSuperAdmin).toBe(true);

    const inactive = toCurrentUser(user([role(SUPER_ADMIN_ROLE_KEY, [permA], false)]));
    expect(inactive.isSuperAdmin).toBe(false);
    expect(inactive.roleKeys).toEqual([]);
    expect(inactive.permissionKeys).toEqual([]);
  });

  it('usuario sin roles no tiene permisos', () => {
    const current = toCurrentUser(user([]));
    expect(current.roleKeys).toEqual([]);
    expect(current.permissionKeys).toEqual([]);
    expect(current.isSuperAdmin).toBe(false);
  });
});

describe('getCurrentSession', () => {
  const dbUser = () => ({
    ...user([role('ventas', [permA]), role('viejo', [permB], false)]),
    isActive: true,
    passwordHash: 'hash',
  });

  function session(overrides: Record<string, unknown> = {}) {
    return {
      id: 's1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: dbUser(),
      ...overrides,
    };
  }

  it('sin cookie devuelve null sin consultar la base', async () => {
    cookieGet.mockReturnValueOnce(undefined);

    expect(await getCurrentSession()).toBeNull();
    expect(cookieGet).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
    expect(findSession).not.toHaveBeenCalled();
  });

  it('con sesión válida devuelve el usuario proyectado por toCurrentUser', async () => {
    cookieGet.mockReturnValueOnce({ value: 'token-1' });
    const row = session();
    findSession.mockResolvedValueOnce(row);

    const result = await getCurrentSession();

    expect(result).toEqual({ sessionId: 's1', user: toCurrentUser(row.user) });
    expect(result?.user.permissionKeys).toEqual([permA]);
    expect(findSession).toHaveBeenCalledWith({
      where: { tokenHash: hashSessionToken('token-1') },
      include: {
        user: { include: { roles: { include: { role: { include: { permissions: true } } } } } },
      },
    });
  });

  it.each([
    ['revocada', { revokedAt: new Date() }],
    ['expirada', { expiresAt: new Date(Date.now() - 1000) }],
    ['de usuario inactivo', { user: { ...dbUser(), isActive: false } }],
  ])('sesión %s devuelve null', async (_label, overrides) => {
    cookieGet.mockReturnValueOnce({ value: 'token-1' });
    findSession.mockResolvedValueOnce(session(overrides));

    expect(await getCurrentSession()).toBeNull();
  });

  it('token desconocido devuelve null', async () => {
    cookieGet.mockReturnValueOnce({ value: 'token-x' });
    findSession.mockResolvedValueOnce(null);

    expect(await getCurrentSession()).toBeNull();
  });
});
