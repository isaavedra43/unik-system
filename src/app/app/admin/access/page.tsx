import { redirect } from 'next/navigation';
import { hasPermission, requireAnyPermission } from '@/modules/auth/authorization';
import { getPermissionGroups } from '@/modules/auth/permissions';
import { listUsers } from '@/modules/users/users-service';
import { listRoles } from '@/modules/roles/roles-service';
import { PageHeader, TabNav } from '@/components/ui/composite';
import { UserPanel } from '@/components/admin/UserPanel';
import { RolePanel } from '@/components/admin/RolePanel';
import { UserView, RoleOption } from '@/components/admin/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AccessPageProps {
  searchParams: Promise<{ tab?: string; role?: string }>;
}

export default async function AdminAccessPage({ searchParams }: AccessPageProps) {
  const actor = await requireAnyPermission(['users.view', 'roles.view']);

  const canSeeUsers = hasPermission(actor, 'users.view');
  const canSeeRoles = hasPermission(actor, 'roles.view');
  const canCreateUsers = hasPermission(actor, 'users.create');
  const canUpdateUsers = hasPermission(actor, 'users.update');
  const canChangeUserStatus = hasPermission(actor, 'users.change_status');
  const canAssignRoles = hasPermission(actor, 'users.assign_roles');
  const canResetPassword = hasPermission(actor, 'users.reset_password');
  const canCreateRoles = hasPermission(actor, 'roles.create');
  const canUpdateRoles = hasPermission(actor, 'roles.update');
  const canDeleteRoles = hasPermission(actor, 'roles.delete');
  const canManagePermissions = hasPermission(actor, 'roles.manage_permissions');

  const { tab, role } = await searchParams;

  let activeTab = tab ?? 'users';
  if (activeTab === 'users' && !canSeeUsers) activeTab = 'roles';
  if (activeTab === 'roles' && !canSeeRoles) activeTab = 'users';
  if (activeTab !== 'users' && activeTab !== 'roles') activeTab = 'users';
  if (activeTab === 'users' && !canSeeUsers) redirect('/app');
  if (activeTab === 'roles' && !canSeeRoles) redirect('/app');

  const [rawUsers, rawRoles] = await Promise.all([
    canSeeUsers ? listUsers() : Promise.resolve([]),
    canSeeRoles ? listRoles() : Promise.resolve([]),
  ]);

  const users: UserView[] = rawUsers.map((u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    email: u.email,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    roles: u.roles,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  }));

  const roleOptions: RoleOption[] = rawRoles
    .filter((r) => r.isActive)
    .map((r) => ({ id: r.id, key: r.key, name: r.name }));

  const permissionGroups = canSeeRoles ? getPermissionGroups() : [];

  const tabs = [
    { id: 'users', label: 'Usuarios', href: '/app/admin/access?tab=users', disabled: !canSeeUsers },
    {
      id: 'roles',
      label: 'Roles y permisos',
      href: '/app/admin/access?tab=roles',
      disabled: !canSeeRoles,
    },
  ].filter((t) => !t.disabled);

  return (
    <div>
      <PageHeader
        title="Usuarios y permisos"
        description="Administra las cuentas, roles y accesos de UNIK."
      />
      <TabNav tabs={tabs} activeId={activeTab} />

      {activeTab === 'users' ? (
        <UserPanel
          users={users}
          roles={roleOptions}
          permissions={{
            canCreate: canCreateUsers,
            canUpdate: canUpdateUsers,
            canChangeStatus: canChangeUserStatus,
            canAssignRoles,
            canResetPassword,
          }}
        />
      ) : (
        <RolePanel
          roles={rawRoles}
          permissionGroups={permissionGroups}
          selectedRoleId={role}
          permissions={{
            canCreate: canCreateRoles,
            canUpdate: canUpdateRoles,
            canDelete: canDeleteRoles,
            canManagePermissions,
          }}
        />
      )}
    </div>
  );
}
