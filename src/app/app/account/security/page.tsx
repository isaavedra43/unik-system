import { requireAuthenticatedUser } from '@/modules/auth/authorization';
import { ChangeOwnPasswordForm, LogoutAllDevicesForm } from './security-forms';

export const runtime = 'nodejs';

export default async function AccountSecurityPage() {
  const user = await requireAuthenticatedUser();

  return (
    <div>
      <h1>Mi cuenta</h1>
      <div className="card">
        <h2>Perfil</h2>
        <p>
          {user.name} — <span className="mono">{user.username}</span>
        </p>
        {user.email ? <p className="muted">{user.email}</p> : null}
        <p className="muted">
          Roles:{' '}
          {user.roleKeys.length > 0
            ? user.roleKeys.map((key) => (
                <span key={key} className="badge badge-neutral">
                  {key}
                </span>
              ))
            : 'Sin roles'}
        </p>
      </div>

      <div className="card">
        <h2>Cambiar mi contraseña</h2>
        <ChangeOwnPasswordForm />
      </div>

      <div className="card">
        <h2>Sesiones</h2>
        <p className="muted">
          Revoca todas las sesiones activas de tu cuenta en todos los dispositivos.
        </p>
        <LogoutAllDevicesForm />
      </div>
    </div>
  );
}
