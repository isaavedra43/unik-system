'use client';

import { useMemo, useState, useActionState } from 'react';
import { Avatar, Badge, Button, FormField, Input } from '@/components/ui/primitives';
import { Alert } from '@/components/ui/primitives';
import { Drawer, DropdownMenu, EmptyState, Modal, PageHeader } from '@/components/ui/composite';
import { Icon } from '@/components/ui/icons';
import {
  assignRolesAction,
  changeUserStatusAction,
  createUserAction,
  CreateUserFormState,
  resetPasswordAction,
  ResetPasswordFormState,
  SimpleFormState,
  updateUserAction,
} from '@/app/app/admin/users/actions';
import { UserView, RoleOption, UserPermissions } from './types';

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // ignore
        }
      }}
    >
      {copied ? 'Copiado' : 'Copiar'}
    </Button>
  );
}

function TemporaryPasswordNotice({ username, password }: { username: string; password: string }) {
  return (
    <div className="alert alert-success" style={{ marginTop: '1rem' }}>
      <strong>Contraseña temporal generada</strong>
      <p className="text-muted" style={{ margin: '0.35rem 0' }}>
        Usuario: <span className="mono">{username}</span>
      </p>
      <div className="temp-password-box">
        <span>{password}</span>
        <CopyButton value={password} />
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: '0.75rem' }}>
        Esta contraseña solo se mostrará una vez. El usuario deberá cambiarla al iniciar sesión.
      </p>
    </div>
  );
}

function formatLastAccess(iso: string | null) {
  if (!iso) return '—';
  const date = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60_000) return 'Hace unos segundos';
  if (diff < 3_600_000) return `Hace ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `Hace ${Math.floor(diff / 3_600_000)} h`;
  return date.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
}

const simpleInitial: SimpleFormState = { error: null, success: false };
const createInitial: CreateUserFormState = { error: null, created: null };
const resetInitial: ResetPasswordFormState = { error: null, temporaryPassword: null };

function CreateUserDrawer({
  open,
  onClose,
  roles,
}: {
  open: boolean;
  onClose: () => void;
  roles: RoleOption[];
}) {
  const [state, formAction, pending] = useActionState(createUserAction, createInitial);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Nuevo usuario"
      subtitle="El sistema generará una contraseña temporal automáticamente."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="create-user-form" isLoading={pending}>
            Crear usuario
          </Button>
        </>
      }
    >
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {state.created ? (
        <TemporaryPasswordNotice
          username={state.created.username}
          password={state.created.temporaryPassword}
        />
      ) : null}

      <form id="create-user-form" action={formAction}>
        <FormField label="Nombre completo" htmlFor="new-name">
          <Input id="new-name" name="name" type="text" required />
        </FormField>

        <FormField
          label="Usuario"
          htmlFor="new-username"
          help="Letras, números, puntos, guiones y guiones bajos."
        >
          <Input
            id="new-username"
            name="username"
            type="text"
            minLength={3}
            maxLength={50}
            pattern="[a-zA-Z0-9._-]+"
            required
          />
        </FormField>

        <FormField label="Correo" htmlFor="new-email" help="Opcional.">
          <Input id="new-email" name="email" type="email" />
        </FormField>

        <div className="form-field">
          <span className="form-label">Roles</span>
          {roles.map((role) => (
            <label key={role.id} className="checkbox-row">
              <input type="checkbox" name="roleIds" value={role.id} />
              {role.name}
            </label>
          ))}
        </div>
      </form>
    </Drawer>
  );
}

function EditUserDrawer({
  open,
  onClose,
  user,
}: {
  open: boolean;
  onClose: () => void;
  user: UserView;
}) {
  const [state, formAction, pending] = useActionState(updateUserAction, simpleInitial);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Editar usuario"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="edit-user-form" isLoading={pending}>
            Guardar
          </Button>
        </>
      }
    >
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {state.success ? <Alert variant="success">Usuario actualizado.</Alert> : null}

      <form id="edit-user-form" action={formAction}>
        <input type="hidden" name="userId" value={user.id} />
        <FormField label="Nombre" htmlFor="edit-name">
          <Input id="edit-name" name="name" type="text" defaultValue={user.name} required />
        </FormField>

        <FormField label="Correo" htmlFor="edit-email">
          <Input id="edit-email" name="email" type="email" defaultValue={user.email ?? ''} />
        </FormField>

        <FormField label="Usuario" htmlFor="edit-username">
          <Input
            id="edit-username"
            type="text"
            defaultValue={user.username}
            readOnly
            className="input-readonly"
          />
          <p className="form-help">El nombre de usuario no se puede cambiar.</p>
        </FormField>
      </form>
    </Drawer>
  );
}

function AssignRolesDrawer({
  open,
  onClose,
  user,
  roles,
}: {
  open: boolean;
  onClose: () => void;
  user: UserView;
  roles: RoleOption[];
}) {
  const [state, formAction, pending] = useActionState(assignRolesAction, simpleInitial);
  const assigned = new Set(user.roles.map((r) => r.id));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Administrar roles"
      subtitle={`Asigna los roles de ${user.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="assign-roles-form" isLoading={pending}>
            Guardar roles
          </Button>
        </>
      }
    >
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {state.success ? <Alert variant="success">Roles actualizados.</Alert> : null}

      <form id="assign-roles-form" action={formAction}>
        <input type="hidden" name="userId" value={user.id} />
        <div className="form-field">
          <span className="form-label">Roles</span>
          {roles.map((role) => (
            <label key={role.id} className="checkbox-row">
              <input
                type="checkbox"
                name="roleIds"
                value={role.id}
                defaultChecked={assigned.has(role.id)}
              />
              {role.name}
            </label>
          ))}
        </div>
      </form>
    </Drawer>
  );
}

function ResetPasswordModal({
  open,
  onClose,
  user,
}: {
  open: boolean;
  onClose: () => void;
  user: UserView;
}) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, resetInitial);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Restablecer contraseña"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="reset-password-form" variant="danger" isLoading={pending}>
            Restablecer
          </Button>
        </>
      }
    >
      <p className="text-muted" style={{ marginBottom: '1rem' }}>
        Se cerrarán todas las sesiones activas de <strong>{user.name}</strong>.
      </p>
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {state.temporaryPassword ? (
        <TemporaryPasswordNotice username={user.username} password={state.temporaryPassword} />
      ) : null}

      <form id="reset-password-form" action={formAction}>
        <input type="hidden" name="userId" value={user.id} />
      </form>
    </Modal>
  );
}

function DisableUserModal({
  open,
  onClose,
  user,
}: {
  open: boolean;
  onClose: () => void;
  user: UserView;
}) {
  const [state, formAction, pending] = useActionState(changeUserStatusAction, simpleInitial);
  const nextActive = !user.isActive;
  const title = nextActive ? 'Activar usuario' : 'Desactivar usuario';
  const message = nextActive
    ? `El usuario ${user.name} podrá iniciar sesión de nuevo.`
    : `El usuario ${user.name} perderá acceso inmediatamente y sus sesiones serán cerradas.`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="disable-user-form"
            variant={nextActive ? 'primary' : 'danger'}
            isLoading={pending}
          >
            Confirmar
          </Button>
        </>
      }
    >
      <p className="text-muted" style={{ marginBottom: '1rem' }}>
        {message}
      </p>
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}

      <form id="disable-user-form" action={formAction}>
        <input type="hidden" name="userId" value={user.id} />
        <input type="hidden" name="isActive" value={nextActive ? 'true' : 'false'} />
      </form>
    </Modal>
  );
}

function UserRowMenu({
  user,
  permissions,
  onEdit,
  onAssign,
  onReset,
  onToggle,
}: {
  user: UserView;
  permissions: UserPermissions;
  onEdit: (u: UserView) => void;
  onAssign: (u: UserView) => void;
  onReset: (u: UserView) => void;
  onToggle: (u: UserView) => void;
}) {
  const items: { label: string; onClick: () => void; icon: React.ReactNode }[] = [];
  if (permissions.canUpdate) {
    items.push({
      label: 'Editar',
      onClick: () => onEdit(user),
      icon: <Icon name="settings" size={16} />,
    });
  }
  if (permissions.canAssignRoles) {
    items.push({
      label: 'Administrar roles',
      onClick: () => onAssign(user),
      icon: <Icon name="users" size={16} />,
    });
  }
  if (permissions.canResetPassword) {
    items.push({
      label: 'Restablecer contraseña',
      onClick: () => onReset(user),
      icon: <Icon name="key" size={16} />,
    });
  }
  if (permissions.canChangeStatus) {
    items.push({
      label: user.isActive ? 'Desactivar' : 'Activar',
      onClick: () => onToggle(user),
      icon: <Icon name={user.isActive ? 'trash' : 'check'} size={16} />,
    });
  }

  if (items.length === 0) return null;

  return (
    <DropdownMenu trigger={<Icon name="moreVertical" size={18} />} items={items} align="right" />
  );
}

export function UserPanel({
  users,
  roles,
  permissions,
}: {
  users: UserView[];
  roles: RoleOption[];
  permissions: UserPermissions;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<UserView | null>(null);
  const [assigning, setAssigning] = useState<UserView | null>(null);
  const [resetting, setResetting] = useState<UserView | null>(null);
  const [toggling, setToggling] = useState<UserView | null>(null);

  const filtered = useMemo(() => {
    return users.filter((u) => {
      const matchesSearch =
        [u.name, u.username, u.email ?? ''].some((s) =>
          s.toLowerCase().includes(search.trim().toLowerCase())
        ) || u.roles.some((r) => r.name.toLowerCase().includes(search.trim().toLowerCase()));
      const matchesStatus =
        status === 'all' ||
        (status === 'active' && u.isActive) ||
        (status === 'inactive' && !u.isActive);
      const matchesRole = roleFilter === 'all' || u.roles.some((r) => r.id === roleFilter);
      return matchesSearch && matchesStatus && matchesRole;
    });
  }, [users, search, status, roleFilter]);

  return (
    <div>
      <PageHeader
        title="Usuarios"
        description="Personas con acceso a UNIK."
        actions={
          permissions.canCreate ? (
            <Button icon={<Icon name="plus" size={16} />} onClick={() => setCreateOpen(true)}>
              Nuevo usuario
            </Button>
          ) : null
        }
      />

      <div
        style={{
          display: 'flex',
          gap: '1rem',
          alignItems: 'flex-end',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: '260px', flex: 1 }}>
          <FormField label="Buscar usuario" htmlFor="user-search">
            <Input
              id="user-search"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nombre, usuario o correo"
            />
          </FormField>
        </div>
        <FormField label="Estado" htmlFor="user-status">
          <select
            id="user-status"
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'all' | 'active' | 'inactive')}
          >
            <option value="all">Todos</option>
            <option value="active">Activos</option>
            <option value="inactive">Inactivos</option>
          </select>
        </FormField>
        <FormField label="Rol" htmlFor="user-role">
          <select
            id="user-role"
            className="input"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
          >
            <option value="all">Todos</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="user"
          title={users.length === 0 ? 'No hay usuarios' : 'Sin resultados'}
          message={
            users.length === 0
              ? 'Agrega personas para darles acceso a UNIK.'
              : 'Ajusta los filtros para encontrar lo que buscas.'
          }
          action={
            permissions.canCreate ? (
              <Button onClick={() => setCreateOpen(true)} icon={<Icon name="plus" size={16} />}>
                Crear usuario
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Roles</th>
                <th>Último acceso</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((user) => (
                <tr key={user.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <Avatar name={user.name} />
                      <div>
                        <div className="text-strong">{user.name}</div>
                        <div className="text-muted text-small">
                          {user.username} · {user.email ?? 'sin correo'}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {user.roles.length === 0
                      ? '—'
                      : user.roles.map((r) => (
                          <Badge key={r.id} variant="weak" style={{ marginRight: '0.25rem' }}>
                            {r.name}
                          </Badge>
                        ))}
                  </td>
                  <td>{formatLastAccess(user.lastLoginAt)}</td>
                  <td>
                    <Badge
                      variant={user.isActive ? 'success' : 'danger'}
                      dot={user.isActive ? 'success' : 'danger'}
                    >
                      {user.isActive ? 'Activo' : 'Inactivo'}
                    </Badge>
                    {user.mustChangePassword ? (
                      <Badge variant="warning" style={{ marginLeft: '0.35rem' }}>
                        Cambio pendiente
                      </Badge>
                    ) : null}
                  </td>
                  <td>
                    <UserRowMenu
                      user={user}
                      permissions={permissions}
                      onEdit={setEditing}
                      onAssign={setAssigning}
                      onReset={setResetting}
                      onToggle={setToggling}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateUserDrawer open={createOpen} onClose={() => setCreateOpen(false)} roles={roles} />
      {editing ? (
        <EditUserDrawer open={Boolean(editing)} onClose={() => setEditing(null)} user={editing} />
      ) : null}
      {assigning ? (
        <AssignRolesDrawer
          open={Boolean(assigning)}
          onClose={() => setAssigning(null)}
          user={assigning}
          roles={roles}
        />
      ) : null}
      {resetting ? (
        <ResetPasswordModal
          open={Boolean(resetting)}
          onClose={() => setResetting(null)}
          user={resetting}
        />
      ) : null}
      {toggling ? (
        <DisableUserModal
          open={Boolean(toggling)}
          onClose={() => setToggling(null)}
          user={toggling}
        />
      ) : null}
    </div>
  );
}
