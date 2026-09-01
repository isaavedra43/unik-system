'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { createRoleAction, deleteRoleAction, SimpleFormState, updateRoleAction } from './actions';

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  userCount: number;
  permissionCount: number;
}

export interface RolesManagerPermissions {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canManagePermissions: boolean;
}

const simpleInitial: SimpleFormState = { error: null, success: false };

function CreateRoleForm() {
  const [state, formAction, pending] = useActionState(createRoleAction, simpleInitial);
  const [open, setOpen] = useState(false);

  return (
    <div className="card">
      <div className="card-header">
        <h2>Crear rol</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(!open)}>
          {open ? 'Ocultar' : 'Nuevo rol'}
        </button>
      </div>

      {state.success ? <div className="alert alert-success">Rol creado.</div> : null}

      {open ? (
        <form action={formAction}>
          {state.error ? <div className="alert alert-error">{state.error}</div> : null}

          <div className="grid-2">
            <div className="form-field">
              <label htmlFor="role-name">Nombre</label>
              <input id="role-name" name="name" type="text" className="input" required />
              <p className="muted">
                La clave se generará automáticamente y no podrá cambiarse después.
              </p>
            </div>
            <div className="form-field">
              <label htmlFor="role-description">Descripción (opcional)</label>
              <input id="role-description" name="description" type="text" className="input" />
            </div>
          </div>

          <button type="submit" className="btn" disabled={pending}>
            {pending ? 'Creando…' : 'Crear rol'}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function EditRoleForm({ role, onClose }: { role: RoleRow; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(updateRoleAction, simpleInitial);

  return (
    <form action={formAction}>
      {state.error ? <div className="alert alert-error">{state.error}</div> : null}
      {state.success ? <div className="alert alert-success">Rol actualizado.</div> : null}

      <input type="hidden" name="roleId" value={role.id} />
      <div className="grid-2">
        <div className="form-field">
          <label>Nombre</label>
          <input name="name" type="text" className="input" defaultValue={role.name} required />
        </div>
        <div className="form-field">
          <label>Descripción</label>
          <input
            name="description"
            type="text"
            className="input"
            defaultValue={role.description ?? ''}
          />
        </div>
      </div>
      <p className="muted">
        Clave: <span className="mono">{role.key}</span> (inmutable)
      </p>
      <div className="row-actions">
        <button type="submit" className="btn btn-sm" disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </form>
  );
}

function DeleteRoleForm({ role }: { role: RoleRow }) {
  const [state, formAction, pending] = useActionState(deleteRoleAction, simpleInitial);

  return (
    <div style={{ display: 'inline-block' }}>
      <form
        action={formAction}
        onSubmit={(event) => {
          if (
            !window.confirm(`¿Eliminar el rol "${role.name}"? Esta acción no se puede deshacer.`)
          ) {
            event.preventDefault();
          }
        }}
        style={{ display: 'inline' }}
      >
        <input type="hidden" name="roleId" value={role.id} />
        <button type="submit" className="btn btn-danger btn-sm" disabled={pending}>
          {pending ? '…' : 'Eliminar'}
        </button>
      </form>
      {state.error ? <div className="alert alert-error">{state.error}</div> : null}
    </div>
  );
}

export function RolesManager({
  roles,
  permissions,
}: {
  roles: RoleRow[];
  permissions: RolesManagerPermissions;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div>
      <h1>Roles y permisos</h1>

      {permissions.canCreate ? <CreateRoleForm /> : null}

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Clave</th>
                <th>Descripción</th>
                <th>Tipo</th>
                <th>Usuarios</th>
                <th>Permisos</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.id}>
                  <td>{role.name}</td>
                  <td>
                    <span className="mono">{role.key}</span>
                  </td>
                  <td>{role.description ?? '—'}</td>
                  <td>
                    {role.isSystem ? (
                      <span className="badge badge-neutral">Sistema</span>
                    ) : (
                      <span className="badge">Personalizado</span>
                    )}
                  </td>
                  <td>{role.userCount}</td>
                  <td>{role.isSystem ? 'Todos' : role.permissionCount}</td>
                  <td>
                    {role.isActive ? (
                      <span className="badge badge-success">Activo</span>
                    ) : (
                      <span className="badge badge-danger">Inactivo</span>
                    )}
                  </td>
                  <td>
                    <div className="row-actions">
                      {permissions.canManagePermissions || permissions.canUpdate ? (
                        <Link
                          href={`/app/admin/roles/${role.id}`}
                          className="btn btn-secondary btn-sm"
                        >
                          Permisos
                        </Link>
                      ) : null}
                      {permissions.canUpdate && !role.isSystem ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setEditing(editing === role.id ? null : role.id)}
                        >
                          Editar
                        </button>
                      ) : null}
                      {permissions.canDelete && !role.isSystem ? (
                        <DeleteRoleForm role={role} />
                      ) : null}
                    </div>
                    {editing === role.id ? (
                      <div className="card" style={{ marginTop: '0.6rem' }}>
                        <EditRoleForm role={role} onClose={() => setEditing(null)} />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
