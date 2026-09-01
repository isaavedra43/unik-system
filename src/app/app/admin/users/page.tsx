import { hasPermission, requirePermission } from '@/modules/auth/authorization';
import { listUsers } from '@/modules/users/users-service';
import { listRoles } from '@/modules/roles/roles-service';
import { RoleOption, UserRow, UsersManager } from './users-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const actor = await requirePermission('users.view');

  const [users, roles] = await Promise.all([listUsers(), listRoles()]);

  const userRows: UserRow[] = users.map((user) => ({
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    roles: user.roles,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  }));

  const roleOptions: RoleOption[] = roles
    .filter((role) => role.isActive)
    .map((role) => ({ id: role.id, key: role.key, name: role.name }));

  return (
    <UsersManager
      users={userRows}
      roles={roleOptions}
      permissions={{
        canCreate: hasPermission(actor, 'users.create'),
        canUpdate: hasPermission(actor, 'users.update'),
        canChangeStatus: hasPermission(actor, 'users.change_status'),
        canAssignRoles: hasPermission(actor, 'users.assign_roles'),
        canResetPassword: hasPermission(actor, 'users.reset_password'),
      }}
    />
  );
}
