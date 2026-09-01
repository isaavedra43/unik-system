import { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { hasPermission, requireAuthenticatedUser } from '@/modules/auth/authorization';
import { logoutAction } from './actions';

export const runtime = 'nodejs';

/**
 * Protected application shell. Real access control happens HERE server-side
 * (and again in every nested page/action) — never rely on hidden links alone.
 */
export default async function AppLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const user = await requireAuthenticatedUser();

  if (user.mustChangePassword) {
    redirect('/change-password');
  }

  const canSeeUsers = hasPermission(user, 'users.view');
  const canSeeRoles = hasPermission(user, 'roles.view');

  return (
    <div className="app-shell">
      <header className="app-header">
        <nav className="app-nav">
          <span className="app-header-brand">UNIK</span>
          <Link href="/app">Inicio</Link>
          {canSeeUsers ? <Link href="/app/admin/users">Usuarios</Link> : null}
          {canSeeRoles ? <Link href="/app/admin/roles">Roles y permisos</Link> : null}
        </nav>
        <div className="app-user">
          <Link href="/app/account/security">{user.name}</Link>
          <form action={logoutAction}>
            <button type="submit" className="btn btn-secondary btn-sm">
              Cerrar sesión
            </button>
          </form>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
