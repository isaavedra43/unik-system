import { requireAuthenticatedUser } from '@/modules/auth/authorization';
import { ChangeOwnPasswordForm, LogoutAllDevicesForm } from './security-forms';

export const runtime = 'nodejs';

export default async function AccountSecurityPage() {
  const user = await requireAuthenticatedUser();

  return (
    <div>
      <h1 className="page-title">Mi seguridad</h1>
      <p className="page-description" style={{ marginBottom: '1.5rem' }}>
        Gestiona tu contraseña y sesiones activas.
      </p>

      <div className="card">
        <h2 className="heading-3" style={{ marginBottom: '1rem' }}>
          Perfil
        </h2>
        <p>
          <span className="text-strong">{user.name}</span>{' '}
          <span className="text-muted" style={{ fontFamily: 'var(--unik-font-mono)' }}>
            {user.username}
          </span>
        </p>
        {user.email ? <p className="text-muted">{user.email}</p> : null}
      </div>

      <div className="card">
        <h2 className="heading-3" style={{ marginBottom: '1rem' }}>
          Cambiar mi contraseña
        </h2>
        <ChangeOwnPasswordForm />
      </div>

      <div className="card">
        <h2 className="heading-3" style={{ marginBottom: '1rem' }}>
          Sesiones
        </h2>
        <LogoutAllDevicesForm />
      </div>
    </div>
  );
}
