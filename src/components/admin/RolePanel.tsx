'use client';

import { useEffect, useState, useActionState } from 'react';
import { Badge, Button, FormField, Input } from '@/components/ui/primitives';
import { Alert } from '@/components/ui/primitives';
import { Drawer, DropdownMenu, EmptyState, Modal, PageHeader } from '@/components/ui/composite';
import { Icon } from '@/components/ui/icons';
import { PermissionGroup } from '@/modules/auth/permissions';
import { RoleListItem } from '@/modules/roles/roles-service';
import {
  createRoleAction,
  deleteRoleAction,
  savePermissionsAction,
  SimpleFormState,
  updateRoleAction,
} from '@/app/app/admin/roles/actions';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';

const simpleInitial: SimpleFormState = { error: null, success: false };

function CreateRoleDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(createRoleAction, simpleInitial);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Nuevo rol"
      subtitle="La clave se generará automáticamente desde el nombre."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="create-role-form" isLoading={pending}>
            Crear rol
          </Button>
        </>
      }
    >
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {state.success ? <Alert variant="success">Rol creado.</Alert> : null}

      <form id="create-role-form" action={formAction}>
        <FormField label="Nombre" htmlFor="new-role-name">
          <Input
            id="new-role-name"
            name="name"
            type="text"
            minLength={2}
            maxLength={100}
            required
          />
        </FormField>

        <FormField label="Descripción" htmlFor="new-role-description" help="Opcional.">
          <Input id="new-role-description" name="description" type="text" maxLength={300} />
        </FormField>
      </form>
    </Drawer>
  );
}

function EditRoleDrawer({
  open,
  onClose,
  role,
}: {
  open: boolean;
  onClose: () => void;
  role: RoleListItem;
}) {
  const [state, formAction, pending] = useActionState(updateRoleAction, simpleInitial);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Editar rol"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="edit-role-form" isLoading={pending}>
            Guardar
          </Button>
        </>
      }
    >
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {state.success ? <Alert variant="success">Rol actualizado.</Alert> : null}

      <form id="edit-role-form" action={formAction}>
        <input type="hidden" name="roleId" value={role.id} />
        <FormField label="Nombre" htmlFor="edit-role-name">
          <Input
            id="edit-role-name"
            name="name"
            type="text"
            defaultValue={role.name}
            minLength={2}
            maxLength={100}
            required
          />
        </FormField>

        <FormField label="Descripción" htmlFor="edit-role-description">
          <Input
            id="edit-role-description"
            name="description"
            type="text"
            defaultValue={role.description ?? ''}
            maxLength={300}
          />
        </FormField>

        <p className="form-help">
          Clave: <span className="mono">{role.key}</span> (inmutable)
        </p>
      </form>
    </Drawer>
  );
}

function DeleteRoleModal({
  open,
  onClose,
  role,
}: {
  open: boolean;
  onClose: () => void;
  role: RoleListItem;
}) {
  const [state, formAction, pending] = useActionState(deleteRoleAction, simpleInitial);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Eliminar rol"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="delete-role-form" variant="danger" isLoading={pending}>
            Eliminar
          </Button>
        </>
      }
    >
      <p className="text-muted" style={{ marginBottom: '1rem' }}>
        ¿Eliminar el rol <strong>{role.name}</strong>? Esta acción no se puede deshacer. Asegúrate
        de que no tenga usuarios asignados.
      </p>
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {state.success ? <Alert variant="success">Rol eliminado.</Alert> : null}

      <form id="delete-role-form" action={formAction}>
        <input type="hidden" name="roleId" value={role.id} />
      </form>
    </Modal>
  );
}

function RolePermissionDrawer({
  open,
  onClose,
  role,
  groups,
  readOnly,
}: {
  open: boolean;
  onClose: () => void;
  role: RoleListItem;
  groups: PermissionGroup[];
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState(savePermissionsAction, simpleInitial);
  const assigned = new Set<string>(role.permissionKeys);

  const isSystem = role.isSystem || role.key === SUPER_ADMIN_ROLE_KEY;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`Permisos del rol · ${role.name}`}
      size="lg"
      footer={
        readOnly || isSystem ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cerrar
            </Button>
            <Button type="submit" form="role-permissions-form" isLoading={pending}>
              Guardar cambios
            </Button>
          </>
        )
      }
    >
      <p className="text-muted" style={{ marginBottom: '1rem' }}>
        Clave: <span className="mono">{role.key}</span> · {role.userCount} usuario(s)
      </p>

      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {state.success ? <Alert variant="success">Permisos actualizados.</Alert> : null}

      {isSystem ? (
        <Alert variant="info" title="Acceso total">
          Este es un rol de sistema. Tiene todos los permisos y no se puede modificar.
        </Alert>
      ) : (
        <form id="role-permissions-form" action={formAction}>
          <input type="hidden" name="roleId" value={role.id} />
          {groups.map((group) => (
            <div key={group.group} className="card card-compact" style={{ marginBottom: '1rem' }}>
              <h3 className="heading-3" style={{ marginBottom: '0.75rem' }}>
                {group.group}
              </h3>
              {group.permissions.map((permission) => (
                <label
                  key={permission.key}
                  className="checkbox-row"
                  style={{ padding: '0.5rem 0' }}
                >
                  <input
                    type="checkbox"
                    name="permissionKeys"
                    value={permission.key}
                    defaultChecked={assigned.has(permission.key)}
                    disabled={readOnly || isSystem}
                  />
                  <span>
                    <strong className="text-strong">{permission.label}</strong>
                    <span className="text-muted" style={{ display: 'block', fontSize: '0.75rem' }}>
                      {permission.description}{' '}
                      <span className="mono" style={{ fontSize: '0.7rem' }}>
                        {permission.key}
                      </span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ))}
        </form>
      )}
    </Drawer>
  );
}

export function RolePanel({
  roles,
  permissionGroups,
  selectedRoleId,
  permissions,
}: {
  roles: RoleListItem[];
  permissionGroups: PermissionGroup[];
  selectedRoleId?: string;
  permissions: {
    canCreate: boolean;
    canUpdate: boolean;
    canDelete: boolean;
    canManagePermissions: boolean;
  };
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<RoleListItem | null>(null);
  const [deleting, setDeleting] = useState<RoleListItem | null>(null);
  const [detail, setDetail] = useState<RoleListItem | null>(null);

  useEffect(() => {
    if (selectedRoleId) {
      const found = roles.find((r) => r.id === selectedRoleId);
      if (found) setDetail(found);
    }
  }, [selectedRoleId, roles]);

  return (
    <div>
      <PageHeader
        title="Roles"
        description="Define qué puede ver y hacer cada tipo de usuario."
        actions={
          permissions.canCreate ? (
            <Button onClick={() => setCreateOpen(true)} icon={<Icon name="plus" size={16} />}>
              Nuevo rol
            </Button>
          ) : null
        }
      />

      {roles.length === 0 ? (
        <EmptyState
          icon="layers"
          title="No hay roles"
          message="Crea el primer rol para asignar permisos específicos."
          action={
            permissions.canCreate ? (
              <Button onClick={() => setCreateOpen(true)} icon={<Icon name="plus" size={16} />}>
                Crear rol
              </Button>
            ) : null
          }
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '1rem',
          }}
        >
          {roles.map((role) => (
            <div
              key={role.id}
              className="card card-compact"
              style={{ cursor: 'pointer', position: 'relative' }}
              onClick={() => setDetail(role)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setDetail(role);
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                }}
              >
                <div>
                  <div className="text-strong">{role.name}</div>
                  <div className="text-small text-muted">{role.key}</div>
                </div>
                {role.isSystem ? (
                  <Badge variant="info">Sistema</Badge>
                ) : (
                  <Badge variant="weak">Personalizado</Badge>
                )}
              </div>
              <p className="text-muted" style={{ marginTop: '0.5rem', fontSize: '0.8125rem' }}>
                {role.description ?? 'Sin descripción'}
              </p>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: '1rem',
                }}
              >
                <div className="text-small text-muted">
                  {role.userCount} usuario(s) ·{' '}
                  {role.isSystem ? 'Acceso total' : `${role.permissionCount} permiso(s)`}
                </div>
                <div onClick={(e) => e.stopPropagation()} role="none">
                  <DropdownMenu
                    trigger={<Icon name="moreVertical" size={18} />}
                    align="right"
                    items={
                      [
                        {
                          label: 'Ver permisos',
                          icon: <Icon name="settings" size={16} />,
                          onClick: () => setDetail(role),
                        },
                        permissions.canUpdate && !role.isSystem
                          ? {
                              label: 'Editar',
                              icon: <Icon name="settings" size={16} />,
                              onClick: () => setEditing(role),
                            }
                          : null,
                        permissions.canDelete && !role.isSystem
                          ? {
                              label: 'Eliminar',
                              icon: <Icon name="trash" size={16} />,
                              onClick: () => setDeleting(role),
                            }
                          : null,
                      ].filter(Boolean) as {
                        label: string;
                        icon: React.ReactNode;
                        onClick: () => void;
                      }[]
                    }
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <CreateRoleDrawer open={createOpen} onClose={() => setCreateOpen(false)} />
      {editing ? (
        <EditRoleDrawer open={Boolean(editing)} onClose={() => setEditing(null)} role={editing} />
      ) : null}
      {deleting ? (
        <DeleteRoleModal
          open={Boolean(deleting)}
          onClose={() => setDeleting(null)}
          role={deleting}
        />
      ) : null}
      {detail ? (
        <RolePermissionDrawer
          open={Boolean(detail)}
          onClose={() => setDetail(null)}
          role={detail}
          groups={permissionGroups}
          readOnly={!permissions.canManagePermissions}
        />
      ) : null}
    </div>
  );
}
