import { prisma } from '@/lib/prisma';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import { isKnownPermission, type PermissionKey } from '@/modules/auth/permissions';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Builds a CurrentUser for trusted, non-cookie contexts (MCP server, jobs).
 * Same role → permission resolution as getCurrentSession(), so every tool
 * gate (permissions, approvals, audit) behaves exactly like in the UI.
 */
export async function loadUserActor(where: { id?: string; username?: string }): Promise<CurrentUser | null> {
  const user = await prisma.user.findFirst({
    where: { ...(where.id ? { id: where.id } : {}), ...(where.username ? { username: where.username } : {}), isActive: true },
    include: { roles: { include: { role: { include: { permissions: true } } } } },
  });
  if (!user) return null;
  const activeRoles = user.roles.map((ur) => ur.role).filter((role) => role.isActive);
  const roleKeys = activeRoles.map((role) => role.key);
  const permissionKeys = [...new Set(activeRoles.flatMap((role) => role.permissions.map((p) => p.permissionKey)))].filter(
    (key): key is PermissionKey => isKnownPermission(key)
  );
  const { resolveTenantId } = await import('@/modules/agents/tenancy');
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    mustChangePassword: user.mustChangePassword,
    roleKeys,
    permissionKeys,
    isSuperAdmin: roleKeys.includes(SUPER_ADMIN_ROLE_KEY),
    tenantId: await resolveTenantId(user.id),
  };
}
