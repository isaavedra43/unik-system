import { requireAuthenticatedUser } from '@/modules/auth/authorization';

export const runtime = 'nodejs';

export default async function AppHomePage() {
  const user = await requireAuthenticatedUser();

  return (
    <div>
      <div className="card">
        <h1>UNIK System</h1>
        <p className="muted">
          Bienvenido, {user.name} (<span className="mono">{user.username}</span>).
        </p>
        <p className="muted">
          Los módulos de negocio se irán habilitando en esta pantalla conforme se implementen.
        </p>
      </div>
    </div>
  );
}
