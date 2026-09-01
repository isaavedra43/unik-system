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

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <Avatar name={user.name} size="lg" />
          <div>
            <h2 className="heading-3" style={{ margin: 0 }}>
              {user.name}
            </h2>
            <p className="text-muted" style={{ margin: 0, fontSize: '0.875rem' }}>
              {user.username}
              {user.email ? ` · ${user.email}` : ''}
            </p>
            <div style={{ marginTop: '0.5rem' }}>
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

      <h2 className="heading-3" style={{ marginBottom: '0.75rem' }}>
        Accesos rápidos
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        {canAccessAdmin ? (
          <Link
            href="/app/admin/access"
            className="card card-compact"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <span style={{ color: 'var(--unik-brand)' }}>
              <Icon name="users" size={24} />
            </span>
            <div>
              <strong className="text-strong">Usuarios y permisos</strong>
              <p className="text-muted" style={{ fontSize: '0.8125rem', margin: 0 }}>
                Administra cuentas y roles
              </p>
            </div>
          </Link>
        ) : null}

        <Link
          href="/app/account/security"
          className="card card-compact"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          <span style={{ color: 'var(--unik-brand)' }}>
            <Icon name="shield" size={24} />
          </span>
          <div>
            <strong className="text-strong">Seguridad de cuenta</strong>
            <p className="text-muted" style={{ fontSize: '0.8125rem', margin: 0 }}>
              Contraseña y sesiones
            </p>
          </div>
        </Link>
      </div>

      <h2 className="heading-3" style={{ marginBottom: '0.75rem' }}>
        Sistema operativo
      </h2>
      <div
        className="card card-compact"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.75rem' }}
      >
        <span className="status-dot status-dot-success" aria-hidden="true" />
        <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>Sistema online</span>
      </div>
    </div>
  );
}
