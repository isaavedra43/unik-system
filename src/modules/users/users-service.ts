import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runSerializableWithRetry } from '@/lib/prisma-retry';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import { AuthorizationError, CurrentUser } from '@/modules/auth/authorization';
import { generateTemporaryPassword, hashPassword } from '@/modules/auth/password';
import { normalizeUsername } from '@/modules/auth/username';
import { revokeAllUserSessions } from '@/modules/auth/session-service';
import { recordAuditEvent } from '@/modules/auth/audit-service';

export class UserManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserManagementError';
  }
}

export interface UserListItem {
  id: string;
  name: string;
  username: string;
  email: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  roles: { id: string; key: string; name: string }[];
  lastLoginAt: Date | null;
  createdAt: Date;
}

export async function listUsers(): Promise<UserListItem[]> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    include: { roles: { include: { role: true } } },
  });

  return users.map((user) => ({
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    roles: user.roles.map((ur) => ({ id: ur.role.id, key: ur.role.key, name: ur.role.name })),
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  }));
}

async function getRolesByIds(roleIds: string[]) {
  if (roleIds.length === 0) {
    return [];
  }
  return prisma.role.findMany({ where: { id: { in: roleIds } } });
}

function includesSuperAdmin(roles: { key: string }[]): boolean {
  return roles.some((role) => role.key === SUPER_ADMIN_ROLE_KEY);
}

async function targetIsSuperAdmin(userId: string): Promise<boolean> {
  const membership = await prisma.userRole.findFirst({
    where: { userId, role: { key: SUPER_ADMIN_ROLE_KEY } },
  });
  return membership !== null;
}

export interface CreateUserInput {
  name: string;
  username: string;
  email?: string | null;
  roleIds: string[];
}

export interface CreateUserResult {
  userId: string;
  temporaryPassword: string;
}

/**
 * Creates a user with a system-generated temporary password.
 * The plaintext temporary password is returned ONCE and never stored.
 */
export async function createUser(
  actor: CurrentUser,
  input: CreateUserInput
): Promise<CreateUserResult> {
  const username = normalizeUsername(input.username);
  const email = input.email?.trim().toLowerCase() || null;

  const roles = await getRolesByIds(input.roleIds);
  if (roles.length !== input.roleIds.length) {
    throw new UserManagementError('Alguno de los roles seleccionados no existe');
  }

  if (includesSuperAdmin(roles) && !actor.isSuperAdmin) {
    throw new AuthorizationError('Solo un super administrador puede asignar el rol super_admin');
  }

  const existingUsername = await prisma.user.findUnique({ where: { username } });
  if (existingUsername) {
    throw new UserManagementError('El nombre de usuario ya está en uso');
  }

  if (email) {
    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (existingEmail) {
      throw new UserManagementError('El correo ya está en uso');
    }
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: input.name.trim(),
        username,
        email,
        passwordHash,
        mustChangePassword: true,
      },
    });

    if (roles.length > 0) {
      await tx.userRole.createMany({
        data: roles.map((role) => ({ userId: created.id, roleId: role.id })),
      });
    }

    await recordAuditEvent(
      {
        actorUserId: actor.id,
        action: 'user.created',
        targetType: 'user',
        targetId: created.id,
        metadata: { username, roleKeys: roles.map((r) => r.key) },
      },
      tx
    );

    return created;
  });

  return { userId: user.id, temporaryPassword };
}

export interface UpdateUserInput {
  name: string;
  email?: string | null;
}

/** Updates name/email. Username is immutable from the UI. */
export async function updateUser(
  actor: CurrentUser,
  userId: string,
  input: UpdateUserInput
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new UserManagementError('Usuario no encontrado');
  }

  if ((await targetIsSuperAdmin(userId)) && !actor.isSuperAdmin) {
    throw new AuthorizationError(
      'Solo un super administrador puede modificar a otro super administrador'
    );
  }

  const email = input.email?.trim().toLowerCase() || null;
  if (email && email !== user.email) {
    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (existingEmail && existingEmail.id !== userId) {
      throw new UserManagementError('El correo ya está en uso');
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { name: input.name.trim(), email },
    });
    await recordAuditEvent(
      {
        actorUserId: actor.id,
        action: 'user.updated',
        targetType: 'user',
        targetId: userId,
      },
      tx
    );
  });
}

/**
 * Activates/deactivates a user. Deactivation revokes all their sessions in
 * the same SERIALIZABLE retried transaction to avoid a race that leaves zero
 * active super admins.
 */
export async function changeUserStatus(
  actor: CurrentUser,
  userId: string,
  isActive: boolean
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new UserManagementError('Usuario no encontrado');
  }

  if (!isActive && actor.id === userId) {
    throw new UserManagementError('No puedes desactivar tu propia cuenta');
  }

  const isTargetSuperAdmin = await targetIsSuperAdmin(userId);
  if (isTargetSuperAdmin && !actor.isSuperAdmin) {
    throw new AuthorizationError(
      'Solo un super administrador puede modificar a otro super administrador'
    );
  }

  try {
    await runSerializableWithRetry(prisma, async (tx) => {
      if (!isActive && isTargetSuperAdmin) {
        const activeSuperAdmins = await tx.user.count({
          where: {
            isActive: true,
            roles: { some: { role: { key: SUPER_ADMIN_ROLE_KEY } } },
          },
        });
        if (activeSuperAdmins <= 1) {
          throw new Error('LAST_SUPER_ADMIN');
        }
      }

      await tx.user.update({ where: { id: userId }, data: { isActive } });
      if (!isActive) {
        await tx.authSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await recordAuditEvent(
        {
          actorUserId: actor.id,
          action: isActive ? 'user.enabled' : 'user.disabled',
          targetType: 'user',
          targetId: userId,
        },
        tx
      );
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'LAST_SUPER_ADMIN') {
      throw new UserManagementError('No se puede desactivar al último super administrador activo');
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      throw new UserManagementError('No se puede desactivar al último super administrador activo');
    }
    throw error;
  }
}

/**
 * Replaces the role set of a user inside a SERIALIZABLE retried transaction.
 * Protections: only super_admin can grant/remove super_admin, and the last
 * active super_admin can never lose the role.
 */
export async function assignRoles(
  actor: CurrentUser,
  userId: string,
  roleIds: string[]
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new UserManagementError('Usuario no encontrado');
  }

  const newRoles = await getRolesByIds(roleIds);
  if (newRoles.length !== roleIds.length) {
    throw new UserManagementError('Alguno de los roles seleccionados no existe');
  }

  const hadSuperAdmin = await targetIsSuperAdmin(userId);
  const willHaveSuperAdmin = includesSuperAdmin(newRoles);

  if (hadSuperAdmin !== willHaveSuperAdmin && !actor.isSuperAdmin) {
    throw new AuthorizationError(
      'Solo un super administrador puede asignar o quitar el rol super_admin'
    );
  }

  if (hadSuperAdmin && !actor.isSuperAdmin) {
    throw new AuthorizationError(
      'Solo un super administrador puede modificar a otro super administrador'
    );
  }

  try {
    await runSerializableWithRetry(prisma, async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: userId },
        include: { roles: { include: { role: true } } },
      });
      if (!current) {
        throw new Error('USER_NOT_FOUND');
      }

      const currentHadSuperAdmin = current.roles.some((ur) => ur.role.key === SUPER_ADMIN_ROLE_KEY);

      if (currentHadSuperAdmin && !willHaveSuperAdmin && current.isActive) {
        const activeSuperAdmins = await tx.user.count({
          where: {
            isActive: true,
            roles: { some: { role: { key: SUPER_ADMIN_ROLE_KEY } } },
          },
        });
        if (activeSuperAdmins <= 1) {
          throw new Error('LAST_SUPER_ADMIN');
        }
      }

      const txRoles =
        roleIds.length > 0 ? await tx.role.findMany({ where: { id: { in: roleIds } } }) : [];
      const validRoleIds = new Set(txRoles.map((role) => role.id));
      if (validRoleIds.size !== roleIds.length) {
        throw new Error('ROLE_MISSING');
      }

      await tx.userRole.deleteMany({ where: { userId } });
      if (roleIds.length > 0) {
        await tx.userRole.createMany({
          data: roleIds.map((roleId) => ({ userId, roleId })),
        });
      }
      await recordAuditEvent(
        {
          actorUserId: actor.id,
          action: 'user.roles_changed',
          targetType: 'user',
          targetId: userId,
          metadata: { roleKeys: txRoles.map((r) => r.key) },
        },
        tx
      );
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'LAST_SUPER_ADMIN') {
      throw new UserManagementError(
        'No se puede quitar el rol super_admin al último super administrador activo'
      );
    }
    if (error instanceof Error && error.message === 'USER_NOT_FOUND') {
      throw new UserManagementError('Usuario no encontrado');
    }
    if (error instanceof Error && error.message === 'ROLE_MISSING') {
      throw new UserManagementError('Alguno de los roles seleccionados no existe');
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      throw new UserManagementError(
        'No se puede quitar el rol super_admin al último super administrador activo'
      );
    }
    throw error;
  }
}

export interface ResetPasswordResult {
  temporaryPassword: string;
}

/**
 * Admin password reset: generates a temporary password, forces a change on
 * next login and revokes ALL sessions of the target user.
 */
export async function resetUserPassword(
  actor: CurrentUser,
  userId: string
): Promise<ResetPasswordResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new UserManagementError('Usuario no encontrado');
  }

  if ((await targetIsSuperAdmin(userId)) && !actor.isSuperAdmin) {
    throw new AuthorizationError(
      'Solo un super administrador puede modificar a otro super administrador'
    );
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: new Date(),
      },
    });
    await tx.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordAuditEvent(
      {
        actorUserId: actor.id,
        action: 'user.password_reset',
        targetType: 'user',
        targetId: userId,
      },
      tx
    );
  });

  return { temporaryPassword };
}

export { revokeAllUserSessions };
