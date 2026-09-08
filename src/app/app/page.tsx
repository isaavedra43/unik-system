import { requireAuthenticatedUser, hasPermission } from '@/modules/auth/authorization';
import { Avatar, Badge } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/composite';
import Link from 'next/link';

export const runtime = 'nodejs';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Buenos días';
  if (hour < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

export default async function AppHomePage() {
  const user = await requireAuthenticatedUser();

  const canAccessAdmin = hasPermission(user, 'users.view') || hasPermission(user, 'roles.view');

  return (
    <div>
      <PageHeader title={`${greeting()}, ${user.name}`} description="Bienvenido a UNIK System." />

      <div className="card home-profile-card">
        <div className="home-profile-row">
          <Avatar name={user.name} size="lg" />
          <div className="home-profile-info">
            <h2 className="heading-3 home-profile-name">
              {user.name}
            </h2>
            <p className="text-muted home-profile-meta">
              {user.username}
              {user.email ? ` · ${user.email}` : ''}
            </p>
            <div className="home-profile-badges">
              {user.roleKeys.length > 0
                ? user.roleKeys.map((key) => (
                    <Badge key={key} variant="weak">
                      {key}
                    </Badge>
                  ))
                : null}
            </div>
          </div>
        </div>
      </div>

      <h2 className="heading-3 home-section-title">
        Accesos rápidos
      </h2>
      <div className="home-quick-grid">
        {canAccessAdmin ? (
          <Link
            href="/app/admin/access"
            className="card card-compact home-quick-card"
          >
            <span className="home-quick-icon" style={{ color: 'var(--unik-brand)' }}>
              <Icon name="users" size={24} />
            </span>
            <div className="home-quick-text">
              <strong className="text-strong">Usuarios y permisos</strong>
              <p className="text-muted home-quick-desc">
                Administra cuentas y roles
              </p>
            </div>
          </Link>
        ) : null}

        <Link
          href="/app/account/security"
          className="card card-compact home-quick-card"
        >
          <span className="home-quick-icon" style={{ color: 'var(--unik-brand)' }}>
            <Icon name="shield" size={24} />
          </span>
          <div className="home-quick-text">
            <strong className="text-strong">Seguridad de cuenta</strong>
            <p className="text-muted home-quick-desc">
              Contraseña y sesiones
            </p>
          </div>
        </Link>
      </div>

      <h2 className="heading-3 home-section-title">
        Sistema operativo
      </h2>
      <div className="card card-compact home-status-card">
        <span className="status-dot status-dot-success" aria-hidden="true" />
        <span className="home-status-text">Sistema online</span>
      </div>
    </div>
  );
}
