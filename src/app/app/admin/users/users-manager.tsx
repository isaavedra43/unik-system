'use client';

import { useActionState, useState } from 'react';
import {
  assignRolesAction,
  changeUserStatusAction,
  createUserAction,
  CreateUserFormState,
  resetPasswordAction,
  ResetPasswordFormState,
  SimpleFormState,
  updateUserAction,
} from './actions';

export interface UserRow {
  id: string;
  name: string;
  username: string;
  email: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  roles: { id: string; key: string; name: string }[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RoleOption {
  id: string;
  key: string;
  name: string;
}

export interface UsersManagerPermissions {
  canCreate: boolean;
  canUpdate: boolean;
  canChangeStatus: boolean;
  canAssignRoles: boolean;
  canResetPassword: boolean;
}

const simpleInitial: SimpleFormState = { error: null, success: false };
const createInitial: CreateUserFormState = { error: null, created: null };
const resetInitial: ResetPasswordFormState = { error: null, temporaryPassword: null };

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? 'Copiado' : 'Copiar'}
    </button>
  );
}

function TemporaryPasswordNotice({ username, password }: { username: string; password: string }) {
  return (
    <div className="alert alert-success">
      <strong>Contraseña temporal generada</strong>
      <p className="muted" style={{ margin: '0.3rem 0 0' }}>
        Usuario: <span className="mono">{username}</span>
      </p>
      <div className="temp-password-box">
        <span>{password}</span>
        <CopyButton value={password} />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Esta contraseña solo se mostrará una vez. El usuario deberá cambiarla al iniciar sesión.
      </p>
    </div>
  );
}

function CreateUserForm({ roles }: { roles: RoleOption[] }) {
  const [state, formAction, pending] = useActionState(createUserAction, createInitial);
  const [open, setOpen] = useState(false);

  return (
    <div className="card">
      <div className="card-header">
        <h2>Crear usuario</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(!open)}>
          {open ? 'Ocultar' : 'Nuevo usuario'}
        </button>
      </div>

      {state.created ? (
        <TemporaryPasswordNotice
          username={state.created.username}
          password={state.created.temporaryPassword}
        />
      ) : null}

      {open ? (
        <form action={formAction}>
          {state.error ? <div className="alert alert-error">{state.error}</div> : null}

          <div className="grid-2">
            <div className="form-field">
              <label htmlFor="new-name">Nombre</label>
              <input id="new-name" name="name" type="text" className="input" required />
            </div>
            <div className="form-field">
              <label htmlFor="new-username">Usuario</label>
              <input
                id="new-username"
                name="username"
                type="text"
                className="input"
                minLength={3}
                maxLength={50}
                pattern="[a-zA-Z0-9._-]+"
                required
              />
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="new-email">Correo (opcional)</label>
            <input id="new-email" name="email" type="email" className="input" />
          </div>

          <div className="form-field">
            <label>Roles</label>
            {roles.map((role) => (
              <label key={role.id} className="checkbox-row">
                <input type="checkbox" name="roleIds" value={role.id} />
                {role.name} <span className="muted">({role.key})</span>
              </label>
            ))}
          </div>

          <p className="muted">
            El sistema generará una contraseña temporal segura automáticamente.
          </p>

          <button type="submit" className="btn" disabled={pending}>
            {pending ? 'Creando…' : 'Crear usuario'}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function EditUserForm({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(updateUserAction, simpleInitial);

  return (
    <form action={formAction}>
      {state.error ? <div className="alert alert-error">{state.error}</div> : null}
      {state.success ? <div className="alert alert-success">Usuario actualizado.</div> : null}

      <input type="hidden" name="userId" value={user.id} />
      <div className="grid-2">
        <div className="form-field">
          <label>Nombre</label>
          <input name="name" type="text" className="input" defaultValue={user.name} required />
        </div>
        <div className="form-field">
          <label>Correo (opcional)</label>
          <input name="email" type="email" className="input" defaultValue={user.email ?? ''} />
        </div>
      </div>
      <p className="muted">
        El usuario <span className="mono">{user.username}</span> no se puede cambiar.
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

function AssignRolesForm({
  user,
  roles,
  onClose,
}: {
  user: UserRow;
  roles: RoleOption[];
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(assignRolesAction, simpleInitial);
  const assigned = new Set(user.roles.map((role) => role.id));

  return (
    <form action={formAction}>
      {state.error ? <div className="alert alert-error">{state.error}</div> : null}
      {state.success ? <div className="alert alert-success">Roles actualizados.</div> : null}

      <input type="hidden" name="userId" value={user.id} />
      <div className="form-field">
        <label>Roles</label>
        {roles.map((role) => (
          <label key={role.id} className="checkbox-row">
            <input
              type="checkbox"
              name="roleIds"
              value={role.id}
              defaultChecked={assigned.has(role.id)}
            />
            {role.name} <span className="muted">({role.key})</span>
          </label>
        ))}
      </div>
      <div className="row-actions">
        <button type="submit" className="btn btn-sm" disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar roles'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </form>
  );
}

function StatusForm({ user }: { user: UserRow }) {
  const [state, formAction, pending] = useActionState(changeUserStatusAction, simpleInitial);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        const message = user.isActive
          ? `¿Desactivar a ${user.username}? Sus sesiones se cerrarán inmediatamente.`
          : `¿Reactivar a ${user.username}?`;
        if (!window.confirm(message)) {
          event.preventDefault();
        }
      }}
      style={{ display: 'inline' }}
    >
      <input type="hidden" name="userId" value={user.id} />
      <input type="hidden" name="isActive" value={user.isActive ? 'false' : 'true'} />
      {state.error ? <span className="alert alert-error">{state.error}</span> : null}
      <button
        type="submit"
        className={user.isActive ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm'}
        disabled={pending}
      >
        {pending ? '…' : user.isActive ? 'Desactivar' : 'Activar'}
      </button>
    </form>
  );
}

function ResetPasswordForm({ user }: { user: UserRow }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, resetInitial);

  return (
    <div style={{ display: 'inline-block' }}>
      <form
        action={formAction}
        onSubmit={(event) => {
          if (
            !window.confirm(
              `¿Resetear la contraseña de ${user.username}? Todas sus sesiones se cerrarán.`
            )
          ) {
            event.preventDefault();
          }
        }}
        style={{ display: 'inline' }}
      >
        <input type="hidden" name="userId" value={user.id} />
        <button type="submit" className="btn btn-secondary btn-sm" disabled={pending}>
          {pending ? '…' : 'Reset contraseña'}
        </button>
      </form>
      {state.error ? <div className="alert alert-error">{state.error}</div> : null}
      {state.temporaryPassword ? (
        <TemporaryPasswordNotice username={user.username} password={state.temporaryPassword} />
      ) : null}
    </div>
  );
}

export function UsersManager({
  users,
  roles,
  permissions,
}: {
  users: UserRow[];
  roles: RoleOption[];
  permissions: UsersManagerPermissions;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);

  return (
    <div>
      <h1>Usuarios</h1>

      {permissions.canCreate ? <CreateUserForm roles={roles} /> : null}

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Usuario</th>
                <th>Correo</th>
                <th>Estado</th>
                <th>Roles</th>
                <th>Último acceso</th>
                <th>Creado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>
                    <span className="mono">{user.username}</span>
                  </td>
                  <td>{user.email ?? '—'}</td>
                  <td>
                    {user.isActive ? (
                      <span className="badge badge-success">Activo</span>
                    ) : (
                      <span className="badge badge-danger">Inactivo</span>
                    )}
                    {user.mustChangePassword ? (
                      <span className="badge badge-neutral">Cambio pendiente</span>
                    ) : null}
                  </td>
                  <td>
                    {user.roles.length > 0
                      ? user.roles.map((role) => (
                          <span key={role.id} className="badge badge-neutral">
                            {role.name}
                          </span>
                        ))
                      : '—'}
                  </td>
                  <td>
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('es-MX') : '—'}
                  </td>
                  <td>{new Date(user.createdAt).toLocaleDateString('es-MX')}</td>
                  <td>
                    <div className="row-actions">
                      {permissions.canUpdate ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setEditing(editing === user.id ? null : user.id);
                            setAssigning(null);
                          }}
                        >
                          Editar
                        </button>
                      ) : null}
                      {permissions.canAssignRoles ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setAssigning(assigning === user.id ? null : user.id);
                            setEditing(null);
                          }}
                        >
                          Roles
                        </button>
                      ) : null}
                      {permissions.canChangeStatus ? <StatusForm user={user} /> : null}
                      {permissions.canResetPassword ? <ResetPasswordForm user={user} /> : null}
                    </div>
                    {editing === user.id ? (
                      <div className="card" style={{ marginTop: '0.6rem' }}>
                        <EditUserForm user={user} onClose={() => setEditing(null)} />
                      </div>
                    ) : null}
                    {assigning === user.id ? (
                      <div className="card" style={{ marginTop: '0.6rem' }}>
                        <AssignRolesForm
                          user={user}
                          roles={roles}
                          onClose={() => setAssigning(null)}
                        />
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
