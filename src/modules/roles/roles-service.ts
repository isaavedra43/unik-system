import { prisma } from '@/lib/prisma';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import { CurrentUser } from '@/modules/auth/authorization';
import { isKnownPermission } from '@/modules/auth/permissions';
import { recordAuditEvent } from '@/modules/auth/audit-service';

export class RoleManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleManagementError';
  }
}

export interface RoleListItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  userCount: number;
  permissionCount: number;
  permissionKeys: string[];
}

export async function listRoles(): Promise<RoleListItem[]> {
  const roles = await prisma.role.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      _count: { select: { users: true, permissions: true } },
      permissions: true,
    },
  });

  return roles.map((role) => ({
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    isActive: role.isActive,
    userCount: role._count.users,
    permissionCount: role._count.permissions,
    permissionKeys: role.permissions.map((p) => p.permissionKey),
  }));
}

export interface RoleDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  permissionKeys: string[];
  userCount: number;
}

export async function getRoleById(roleId: string): Promise<RoleDetail | null> {
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: { permissions: true, _count: { select: { users: true } } },
  });
  if (!role) {
    return null;
  }
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    isActive: role.isActive,
    permissionKeys: role.permissions.map((p) => p.permissionKey),
    userCount: role._count.users,
  };
}

/**
 * Generates an immutable role key from the visible name:
 * lowercase, no accents, [a-z0-9_] only.
 */
function slugifyRoleKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

interface CreateRoleInput {
  name: string;
  description?: string | null;
}

export async function createRole(actor: CurrentUser, input: CreateRoleInput): Promise<string> {
  const name = input.name.trim();
  const key = slugifyRoleKey(name);

  if (key.length < 2) {
    throw new RoleManagementError('El nombre del rol es demasiado corto para generar una clave');
  }

  const existing = await prisma.role.findUnique({ where: { key } });
  if (existing) {
    throw new RoleManagementError(`Ya existe un rol con la clave generada "${key}"`);
  }

  const role = await prisma.$transaction(async (tx) => {
    const created = await tx.role.create({
      data: {
        key,
        name,
        description: input.description?.trim() || null,
      },
    });
    await recordAuditEvent(
      {
        actorUserId: actor.id,
        action: 'role.created',
        targetType: 'role',
        targetId: created.id,
        metadata: { key },
      },
      tx
    );
    return created;
  });

  return role.id;
}

interface UpdateRoleInput {
  name: string;
  description?: string | null;
}

/** Updates visible name/description. The key never changes. */
export async function updateRole(
  actor: CurrentUser,
  roleId: string,
  input: UpdateRoleInput
): Promise<void> {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) {
    throw new RoleManagementError('Rol no encontrado');
  }
  if (role.isSystem) {
    throw new RoleManagementError('Los roles de sistema no se pueden editar');
  }

  await prisma.$transaction(async (tx) => {
    await tx.role.update({
      where: { id: roleId },
      data: {
        name: input.name.trim(),
        description: input.description?.trim() || null,
      },
    });
    await recordAuditEvent(
      {
        actorUserId: actor.id,
        action: 'role.updated',
        targetType: 'role',
        targetId: roleId,
      },
      tx
    );
  });
}

/**
 * Deletes a CUSTOM role. System roles are protected, and roles with assigned
 * users must be unassigned first (no silent cascade).
 */
export async function deleteRole(actor: CurrentUser, roleId: string): Promise<void> {
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: { _count: { select: { users: true } } },
  });
  if (!role) {
    throw new RoleManagementError('Rol no encontrado');
  }
  if (role.isSystem || role.key === SUPER_ADMIN_ROLE_KEY) {
    throw new RoleManagementError('Los roles de sistema no se pueden eliminar');
  }
  if (role._count.users > 0) {
    throw new RoleManagementError(
      'El rol tiene usuarios asignados. Quita el rol de esos usuarios antes de eliminarlo.'
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.role.delete({ where: { id: roleId } });
    await recordAuditEvent(
      {
        actorUserId: actor.id,
        action: 'role.deleted',
        targetType: 'role',
        targetId: roleId,
        metadata: { key: role.key },
      },
      tx
    );
  });
}

/**
 * Replaces the permission set of a role. Every key must exist in the
 * code-first registry; unknown keys are rejected. super_admin never has
 * explicit permissions (it bypasses them).
 */
export async function saveRolePermissions(
  actor: CurrentUser,
  roleId: string,
  permissionKeys: string[]
): Promise<void> {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) {
    throw new RoleManagementError('Rol no encontrado');
  }
  if (role.isSystem || role.key === SUPER_ADMIN_ROLE_KEY) {
    throw new RoleManagementError('Los permisos de los roles de sistema no se pueden modificar');
  }

  const uniqueKeys = [...new Set(permissionKeys)];
  const unknown = uniqueKeys.filter((key) => !isKnownPermission(key));
  if (unknown.length > 0) {
    throw new RoleManagementError('Se recibieron permisos desconocidos');
  }

  await prisma.$transaction(async (tx) => {
    await tx.rolePermission.deleteMany({ where: { roleId } });
    if (uniqueKeys.length > 0) {
      await tx.rolePermission.createMany({
        data: uniqueKeys.map((permissionKey) => ({ roleId, permissionKey })),
      });
    }
    await recordAuditEvent(
      {
        actorUserId: actor.id,
        action: 'role.permissions_changed',
        targetType: 'role',
        targetId: roleId,
        metadata: { permissionKeys: uniqueKeys },
      },
      tx
    );
  });
}
