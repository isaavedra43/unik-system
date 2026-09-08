/**
 * CODE-FIRST PERMISSION REGISTRY.
 *
 * This file is the single source of truth for every permission key that can
 * be assigned to a role. Permissions are NOT stored as a Prisma table or
 * enum; RolePermission rows persist plain permissionKey strings which are
 * validated against this registry before being written.
 *
 * To add permissions for a future module (no schema migration needed):
 * 1. Create `src/modules/<module>/permissions.ts` exporting PermissionDefinition[].
 * 2. Import and spread it into PERMISSION_REGISTRY below.
 * 3. Protect pages/actions with requirePermission('<module>.<action>').
 * 4. Assign the new permissions to roles from /app/admin/roles.
 */

export interface PermissionDefinition {
  /** Stable machine key, e.g. 'users.view'. Never rename after release. */
  key: string;
  /** Human group used to cluster permissions in the roles UI. */
  group: string;
  /** Short human label. */
  label: string;
  /** Longer human description. */
  description: string;
}

export const USERS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'users.view',
    group: 'Usuarios',
    label: 'Ver usuarios',
    description: 'Permite visualizar los usuarios del sistema',
  },
  {
    key: 'users.create',
    group: 'Usuarios',
    label: 'Crear usuarios',
    description: 'Permite crear nuevos usuarios',
  },
  {
    key: 'users.update',
    group: 'Usuarios',
    label: 'Editar usuarios',
    description: 'Permite editar nombre y correo de los usuarios',
  },
  {
    key: 'users.change_status',
    group: 'Usuarios',
    label: 'Activar/desactivar usuarios',
    description: 'Permite activar o desactivar usuarios',
  },
  {
    key: 'users.assign_roles',
    group: 'Usuarios',
    label: 'Asignar roles',
    description: 'Permite asignar o quitar roles a los usuarios',
  },
  {
    key: 'users.reset_password',
    group: 'Usuarios',
    label: 'Resetear contraseña',
    description: 'Permite generar una contraseña temporal para un usuario',
  },
];

export const ROLES_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'roles.view',
    group: 'Roles y permisos',
    label: 'Ver roles',
    description: 'Permite visualizar los roles del sistema',
  },
  {
    key: 'roles.create',
    group: 'Roles y permisos',
    label: 'Crear roles',
    description: 'Permite crear nuevos roles',
  },
  {
    key: 'roles.update',
    group: 'Roles y permisos',
    label: 'Editar roles',
    description: 'Permite editar el nombre y la descripción de los roles',
  },
  {
    key: 'roles.delete',
    group: 'Roles y permisos',
    label: 'Eliminar roles',
    description: 'Permite eliminar roles personalizados sin usuarios asignados',
  },
  {
    key: 'roles.manage_permissions',
    group: 'Roles y permisos',
    label: 'Gestionar permisos',
    description: 'Permite asignar o quitar permisos a los roles',
  },
];

import { SALES_ORDERS_PERMISSIONS } from '@/modules/sales/permissions';
import { INTEGRATIONS_PERMISSIONS } from '@/modules/integrations/permissions';
import { AI_PERMISSIONS } from '@/modules/ai/permissions';

/** Every known permission. Future modules spread their definitions here. */
export const PERMISSION_REGISTRY: PermissionDefinition[] = [
  ...USERS_PERMISSIONS,
  ...ROLES_PERMISSIONS,
  ...SALES_ORDERS_PERMISSIONS,
  ...INTEGRATIONS_PERMISSIONS,
  ...AI_PERMISSIONS,
];

const REGISTRY_KEYS = new Set(PERMISSION_REGISTRY.map((p) => p.key));

/** Strongly typed union of every known permission key. */
export type PermissionKey = (typeof PERMISSION_REGISTRY)[number]['key'];

/** Returns true when the key exists in the code-first registry. */
export function isKnownPermission(key: string): key is PermissionKey {
  return REGISTRY_KEYS.has(key);
}

/** Throws if the key is not registered. Call before authorizing. */
export function assertKnownPermission(key: string): asserts key is PermissionKey {
  if (!REGISTRY_KEYS.has(key)) {
    throw new Error(`Unknown permission key: ${key}`);
  }
}

/** Filters an arbitrary list down to known permission keys. */
export function filterKnownPermissions(keys: string[]): PermissionKey[] {
  return keys.filter((key): key is PermissionKey => REGISTRY_KEYS.has(key));
}

export interface PermissionGroup {
  group: string;
  permissions: PermissionDefinition[];
}

/** Registry grouped for the roles UI, preserving declaration order. */
export function getPermissionGroups(): PermissionGroup[] {
  const groups: PermissionGroup[] = [];
  const byName = new Map<string, PermissionGroup>();
  for (const permission of PERMISSION_REGISTRY) {
    let group = byName.get(permission.group);
    if (!group) {
      group = { group: permission.group, permissions: [] };
      byName.set(permission.group, group);
      groups.push(group);
    }
    group.permissions.push(permission);
  }
  return groups;
}
