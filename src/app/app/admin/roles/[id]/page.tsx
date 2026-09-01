import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasPermission, requirePermission } from '@/modules/auth/authorization';
import { getPermissionGroups } from '@/modules/auth/permissions';
import { getRoleById } from '@/modules/roles/roles-service';
import { PermissionsForm } from './permissions-form';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function RoleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission('roles.view');

  const { id } = await params;
  const role = await getRoleById(id);
  if (!role) {
    notFound();
  }

  const canManage = hasPermission(actor, 'roles.manage_permissions');
  const groups = getPermissionGroups().map((group) => ({
    group: group.group,
    permissions: group.permissions.map((p) => ({
      key: p.key,
      label: p.label,
      description: p.description,
    })),
  }));

  return (
    <div>
      <p>
        <Link href="/app/admin/roles">← Volver a roles</Link>
      </p>
      <h1>{role.name}</h1>
      <p className="muted">
        Clave: <span className="mono">{role.key}</span> · {role.userCount} usuario(s) asignado(s)
      </p>
      {role.description ? <p className="muted">{role.description}</p> : null}

      <div className="card">
        <h2>Permisos</h2>
        {role.isSystem ? (
          <div className="alert alert-warning">
            Este rol tiene acceso total automáticamente. No requiere permisos individuales y no se
            puede modificar.
          </div>
        ) : (
          <PermissionsForm
            roleId={role.id}
            groups={groups}
            assignedKeys={role.permissionKeys}
            readOnly={!canManage}
          />
        )}
      </div>
    </div>
  );
}
