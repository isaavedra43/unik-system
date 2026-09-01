import { hasPermission, requirePermission } from '@/modules/auth/authorization';
import { listRoles } from '@/modules/roles/roles-service';
import { RolesManager } from './roles-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AdminRolesPage() {
  const actor = await requirePermission('roles.view');

  const roles = await listRoles();

  return (
    <RolesManager
      roles={roles}
      permissions={{
        canCreate: hasPermission(actor, 'roles.create'),
        canUpdate: hasPermission(actor, 'roles.update'),
        canDelete: hasPermission(actor, 'roles.delete'),
        canManagePermissions: hasPermission(actor, 'roles.manage_permissions'),
      }}
    />
  );
}
